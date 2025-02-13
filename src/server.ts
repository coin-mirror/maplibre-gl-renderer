import express from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import WebMaplibreGLRenderer from "./renderer";
import PQueue from "p-queue";
import { RendererBrowser } from "./browser";

const StyleSchema = z
  .object({
    version: z.number(),
    sprite: z
      .string()
      .or(z.object({ id: z.string(), url: z.string() }).array())
      .optional(),
    light: z.object({ color: z.string() }).optional(),
    glyphs: z.string().optional(),
    sources: z.record(z.any()),
    layers: z.array(z.any()),
    terrain: z.record(z.any()).optional(),
  })
  .passthrough();

const RequestSchema = z.object({
  width: z.number().int().min(10).max(6000).default(1920).optional(),
  height: z.number().int().min(10).max(6000).default(1080).optional(),
  ratio: z.number().min(0).max(8).default(1).optional(),
  center: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
  zoom: z.number().min(0).max(22),
  pitch: z.number().min(0).max(85).default(0).optional(),
  bearing: z.number().min(-180).max(180).default(0).optional(),
  format: z.enum(["png", "jpeg", "webp"]).default("webp").optional(),
  quality: z.number().min(0).max(100).default(100).optional(),
  optimize: z.boolean().default(false).optional(),
  style: StyleSchema,
});

type RequestBody = z.infer<typeof RequestSchema>;

interface RenderTask {
  body: RequestBody;
  resolve: (value: Buffer) => void;
  reject: (reason: any) => void;
}

class MapScreenshotServer {
  private app;
  private browser = new RendererBrowser({
    timeout: 30000,
    waitUntil: "networkidle0",
  });
  private renderers: (WebMaplibreGLRenderer | null)[] = [];
  private currentRendererIndex: number = 0;
  private htmlPath: string;
  private port: number;
  private renderQueue: PQueue;
  private isProcessing: boolean = false;
  private rendererCount: number;

  constructor(
    htmlPath: string,
    port: number = 3000,
    rendererCount: number = 1,
  ) {
    this.app = express();
    this.htmlPath = htmlPath;
    this.port = port;
    this.rendererCount = rendererCount;
    this.renderQueue = new PQueue({ concurrency: rendererCount });
    this.renderers = new Array(rendererCount).fill(null);

    // JSON Body Parser
    this.app.use(express.json({ limit: "50mb" }));

    this.browser.browser?.on("disconnected", () => {
      console.log("Browser disconnected. Let's try to restart...");
      this.restart();
    });

    this.setupRoutes();
  }

  private async initRenderer(index: number): Promise<void> {
    if (!this.renderers[index]) {
      this.renderers[index] = new WebMaplibreGLRenderer(this.browser);

      await this.renderers[index]!.initWithHTML(this.htmlPath);
      console.log(`Map-Renderer ${index} ready`);
    }
  }

  private getNextRendererIndex(): number {
    this.currentRendererIndex =
      (this.currentRendererIndex + 1) % this.rendererCount;
    return this.currentRendererIndex;
  }

  private setupRoutes(): void {
    // Health Check
    this.app.get("/health", (req: Request, res: Response): any => {
      if (!this.renderers.length || this.renderers.every((r) => !r)) {
        return res.status(500).json({ error: "Renderer not initialized" });
      }

      const queueStatus = {
        pending: this.renderQueue.size,
        isProcessing: this.isProcessing,
      };
      res.status(200).json({ status: "ok", queue: queueStatus });
    });

    // Screenshot Endpoint
    this.app.post(
      "/render",
      async (req: Request, res: Response): Promise<any> => {
        try {
          // Validate Request Body
          const validationResult = RequestSchema.safeParse(req.body);

          if (!validationResult.success) {
            return res.status(400).json({
              error: "Invalid Request Format",
              details: validationResult.error.format(),
            });
          }

          // Process on Queue
          const screenshot = await this.addToRenderQueue(validationResult.data);

          res.set({
            "Content-Type": `image/${validationResult.data.format || "webp"}`,
            "Content-Length": screenshot.length,
            "Last-Modified": new Date().toUTCString(),
            "Content-Encoding": "identity",
          });

          return res.end(screenshot, "binary");
        } catch (error) {
          console.error("Image Generation failed:", error);
          res.status(500).json({
            error: "Image Generation failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );

    // Queue Status Endpoint
    this.app.get("/status/queue", (req: Request, res: Response) => {
      res.json({
        availableRenderers: this.rendererCount,
        size: this.renderQueue.size,
        pending: this.renderQueue.pending,
        isProcessing: this.isProcessing,
      });
    });
  }

  private addToRenderQueue(body: RequestBody): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const task: RenderTask = { body, resolve, reject };

      this.renderQueue.add(() => this.processRenderTask(task)).catch(reject);
    });
  }

  private async processRenderTask(task: RenderTask): Promise<void> {
    const rendererIndex = this.getNextRendererIndex();

    try {
      await this.initRenderer(rendererIndex);
      const renderer = this.renderers[rendererIndex];

      if (!renderer) {
        throw new Error("Renderer not initialized, hard crash");
      }

      console.log(`Processing task on renderer #${rendererIndex}...`);

      await Promise.all([
        renderer.setMapSize({
          width: task.body.width || 1920,
          height: task.body.height || 1080,
          deviceScaleFactor: task.body.ratio || 1,
        }),
        renderer.setMapPosition({
          center: task.body.center,
          zoom: task.body.zoom,
          pitch: task.body.pitch || 0,
          bearing: task.body.bearing || 0,
        }),
        renderer.setMapStyle({ json: task.body.style }),
      ]);

      // Wait until the style is loaded
      await renderer.waitForMapRendered();

      const screenshot = await renderer.getMapImage({
        type: task.body.format || "webp",
        quality: task.body.quality ?? 100,
      });

      task.resolve(screenshot);
    } catch (error) {
      console.error(`Error in renderer ${rendererIndex}:`, error);

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (
        errorMessage.includes("disconnected") ||
        errorMessage.includes("crash") ||
        errorMessage.includes("Timeout") ||
        errorMessage.includes("detached")
      ) {
        console.error(
          `Critical error in renderer ${rendererIndex}... Cleaning up`,
        );
        await this.renderers[rendererIndex]?.cleanup();
        this.renderers[rendererIndex] = null;

        return task.reject(new Error("Critical error in renderer"));
      }

      task.reject(error);
    }
  }

  async start(): Promise<void> {
    try {
      await this.browser.isReady();

      await Promise.all(
        this.renderers.map((_, index) => this.initRenderer(index)),
      );

      this.app.listen(this.port, () => {
        console.log(`Server running on port ${this.port}`);
      });
    } catch (error) {
      console.error("Server Start failed:", error);
      throw error;
    }
  }

  private async restart(): Promise<void> {
    console.log("Restarting browser and renderers...");
    await this.renderQueue.onIdle();

    console.log("Cleaning up browser");
    const closeBrowser = this.browser.close();

    this.renderers = new Array(this.rendererCount).fill(null);

    await closeBrowser;

    console.log("Creating new browser instance");
    this.browser = new RendererBrowser({
      timeout: 30000,
      waitUntil: "networkidle0",
    });

    await this.browser.isReady();

    await Promise.all(
      this.renderers.map((_, index) => this.initRenderer(index)),
    );

    console.log("Browser and renderers restarted. Ready to go!");
  }

  async stop(): Promise<void> {
    const closeBrowser = this.browser.close();

    this.renderers = new Array(this.rendererCount).fill(null);

    await closeBrowser;
  }
}

export default MapScreenshotServer;
