import { serve } from "bun";
import type { BunRequest } from "bun";
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
  signal: AbortSignal;
}

class MapScreenshotServer {
  private server: Bun.Server | null = null;

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
    this.htmlPath = htmlPath;
    this.port = port;
    this.rendererCount = rendererCount;
    this.renderQueue = new PQueue({ concurrency: rendererCount });
    this.renderers = new Array(rendererCount).fill(null);

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
    this.server = serve({
      port: this.port,
      idleTimeout: 255,
      routes: {
        "/health": () => {
          if (!this.renderers.length || this.renderers.every((r) => !r)) {
            return new Response(
              JSON.stringify({
                status: "error",
                error: "Renderers not initialized",
              }),
              {
                status: 500,
                headers: {
                  "Content-Type": "application/json",
                },
              },
            );
          }

          const queueStatus = {
            inQueue: this.renderQueue.size,
            inProgress: this.renderQueue.pending,
            totalWorkers: this.rendererCount,
          };
          return new Response(
            JSON.stringify({ status: "ok", queue: queueStatus }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
              },
            },
          );
        },

        "/render": async (req: BunRequest) => {
          const body = await req.json();
          const validationResult = RequestSchema.safeParse(body);

          if (!validationResult.success) {
            return new Response(
              JSON.stringify({
                status: "error",
                error: "Invalid Request Format",
                details: validationResult.error.format(),
              }),
              {
                status: 400,
                headers: {
                  "Content-Type": "application/json",
                },
              },
            );
          }

          req.signal.onabort = () => {
            console.log("Request cancelled");
          };

          try {
            const screenshot = await this.addToRenderQueue(
              validationResult.data,
              req.signal,
            );

            return new Response(screenshot, {
              headers: {
                "Content-Type": `image/${
                  validationResult.data.format || "webp"
                }`,
                "Content-Length": screenshot.length.toString(),
                "Last-Modified": new Date().toUTCString(),
                "Content-Encoding": "identity",
              },
            });
          } catch (error) {
            if (
              (error instanceof Error && error.name === "AbortError") ||
              !!req.signal.aborted
            ) {
              console.log(
                "Request cancelled:",
                error instanceof Error ? error.message : error,
              );
              return new Response("Request cancelled", {
                status: 499,
              });
            }

            console.error("Image Generation failed:", error);

            return new Response("Image Generation failed", {
              status: 500,
              headers: {
                "Content-Type": "text/plain",
              },
            });
          }
        },

        "/status/queue": () => {
          return new Response(
            JSON.stringify({
              availableRenderers: this.rendererCount,
              size: this.renderQueue.size,
              pending: this.renderQueue.pending,
              isProcessing: this.isProcessing,
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
              },
            },
          );
        },
      },
    });
  }

  private addToRenderQueue(
    body: RequestBody,
    signal: AbortSignal,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const task: RenderTask = { body, resolve, reject, signal };

      this.renderQueue.add(() => this.processRenderTask(task)).catch(reject);
    });
  }

  private async processRenderTask(task: RenderTask): Promise<void> {
    // If the task has been aborted, reject immediately
    if (task.signal.aborted) {
      return task.reject(new Error("Task was aborted before processing"));
    }

    const rendererIndex = this.getNextRendererIndex();

    try {
      await this.initRenderer(rendererIndex);
      const renderer = this.renderers[rendererIndex];

      if (!renderer) {
        return task.reject(new Error("Renderer not initialized, hard crash"));
      }

      console.log(`Processing task on renderer #${rendererIndex}...`);

      // Check for abort signal before each async operation
      if (task.signal.aborted) {
        return task.reject(new Error("Task was aborted during processing"));
      }

      setTimeout(() => {
        task.reject(new Error("Timeout"));
      }, 180000);

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

      // Check for abort signal again
      if (task.signal.aborted) {
        return task.reject(new Error("Task was aborted during map setup"));
      }

      // Wait until the style is loaded
      await renderer.waitForMapRendered();

      // Check for abort signal again
      if (task.signal.aborted) {
        return task.reject(new Error("Task was aborted during map rendering"));
      }

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
          `Critical error in renderer ${rendererIndex}... Cleaning up and restarting`,
        );
        await this.renderers[rendererIndex]?.cleanup().catch((err) => {
          console.error("Error cleaning up renderer:", err);
        });
        this.renderers[rendererIndex] = null;
        this.renderers[rendererIndex] = new WebMaplibreGLRenderer(this.browser);

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
