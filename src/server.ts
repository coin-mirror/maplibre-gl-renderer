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

  private renderers: (WebMaplibreGLRenderer | null)[] = [];
  private currentRendererIndex: number = 0;
  private htmlPath: string;
  private port: number;
  private renderQueue: PQueue;
  private isProcessing: boolean = false;
  private rendererCount: number;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private isShuttingDown: boolean = false;

  constructor(
    htmlPath: string,
    port: number = 3000,
    rendererCount: number = 1,
  ) {
    this.htmlPath = htmlPath;
    this.port = port;
    this.rendererCount = rendererCount;
    this.renderQueue = new PQueue({
      concurrency: rendererCount,
      timeout: 180000, // 3 minutes timeout
      throwOnTimeout: true,
    });
    this.renderers = new Array(rendererCount).fill(null);

    this.setupRoutes();
    this.startHealthMonitoring();
  }

  private async initRenderer(index: number): Promise<void> {
    if (this.isShuttingDown) return;

    try {
      if (this.renderers[index]) {
        console.log(`Cleaning up existing renderer ${index}`);
        await this.renderers[index]!.cleanup().catch(console.warn);
        this.renderers[index] = null;
      }

      console.log(`Initializing renderer ${index}...`);
      this.renderers[index] = new WebMaplibreGLRenderer();
      await this.renderers[index]!.initWithHTML(this.htmlPath);
      console.log(`Map-Renderer ${index} ready`);
    } catch (error) {
      console.error(`Failed to initialize renderer ${index}:`, error);
      this.renderers[index] = null;
      throw error;
    }
  }

  private startHealthMonitoring(): void {
    // Check renderer health every 30 seconds
    this.healthCheckInterval = setInterval(async () => {
      if (this.isShuttingDown) return;

      await this.performHealthCheck();
    }, 30000);
  }

  private async performHealthCheck(): Promise<void> {
    for (let i = 0; i < this.rendererCount; i++) {
      if (this.isShuttingDown) return;

      const renderer = this.renderers[i];
      if (!renderer) continue;

      try {
        const isHealthy = await renderer.healthCheck();
        if (!isHealthy) {
          console.warn(`Renderer ${i} failed health check, reinitializing...`);
          await this.reinitializeRenderer(i);
        }
      } catch (error) {
        console.error(`Health check failed for renderer ${i}:`, error);
        await this.reinitializeRenderer(i);
      }
    }
  }

  private async reinitializeRenderer(index: number): Promise<void> {
    if (this.isShuttingDown) return;

    console.log(`Reinitializing renderer ${index}...`);
    try {
      await this.initRenderer(index);
    } catch (error) {
      console.error(`Failed to reinitialize renderer ${index}:`, error);
      // Mark as null so it will be retried later
      this.renderers[index] = null;
    }
  }

  private getNextRendererIndex(): number {
    // Find a healthy renderer
    let attempts = 0;

    do {
      this.currentRendererIndex =
        (this.currentRendererIndex + 1) % this.rendererCount;
      attempts++;

      if (this.renderers[this.currentRendererIndex]) {
        return this.currentRendererIndex;
      }
    } while (attempts < this.rendererCount);

    // If no healthy renderer found, return the next index anyway
    // The processRenderTask will handle initialization
    return this.currentRendererIndex;
  }

  private setupRoutes(): void {
    this.server = serve({
      port: this.port,
      idleTimeout: 255,
      routes: {
        "/health": () => {
          const healthyRenderers = this.renderers.filter(
            (r) => r !== null,
          ).length;
          const queueStatus = {
            inQueue: this.renderQueue.size,
            inProgress: this.renderQueue.pending,
            totalWorkers: this.rendererCount,
            healthyRenderers: healthyRenderers,
            isShuttingDown: this.isShuttingDown,
          };

          const isHealthy = healthyRenderers > 0 && !this.isShuttingDown;

          return new Response(
            JSON.stringify({
              status: isHealthy ? "ok" : "degraded",
              queue: queueStatus,
              message: isHealthy
                ? "Service is healthy"
                : `Service degraded: ${healthyRenderers}/${this.rendererCount} renderers healthy`,
            }),
            {
              status: isHealthy ? 200 : 503,
              headers: {
                "Content-Type": "application/json",
              },
            },
          );
        },

        "/render": async (req: BunRequest) => {
          if (this.isShuttingDown) {
            return new Response("Service is shutting down", {
              status: 503,
              headers: {
                "Content-Type": "text/plain",
              },
            });
          }

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
          const healthyRenderers = this.renderers.filter(
            (r) => r !== null,
          ).length;
          return new Response(
            JSON.stringify({
              availableRenderers: this.rendererCount,
              healthyRenderers: healthyRenderers,
              size: this.renderQueue.size,
              pending: this.renderQueue.pending,
              isProcessing: this.isProcessing,
              isShuttingDown: this.isShuttingDown,
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

      this.renderQueue
        .add(() => this.processRenderTask(task), {
          priority: 0,
        })
        .catch(reject);
    });
  }

  private async processRenderTask(task: RenderTask): Promise<void> {
    // If the task has been aborted, reject immediately
    if (task.signal.aborted || this.isShuttingDown) {
      return task.reject(
        new Error("Task was aborted or service is shutting down"),
      );
    }

    const rendererIndex = this.getNextRendererIndex();
    let renderer = this.renderers[rendererIndex];

    try {
      // Ensure renderer is initialized
      if (!renderer) {
        console.log(`Renderer ${rendererIndex} not available, initializing...`);
        await this.initRenderer(rendererIndex);
        renderer = this.renderers[rendererIndex];

        if (!renderer) {
          throw new Error(`Failed to initialize renderer ${rendererIndex}`);
        }
      }

      console.log(`Processing task on renderer #${rendererIndex}...`);

      // Check for abort signal before processing
      if (task.signal.aborted) {
        return task.reject(new Error("Task was aborted during processing"));
      }

      // Set up a timeout for the rendering task
      const timeoutId = setTimeout(() => {
        task.reject(new Error("Rendering timeout - operation took too long"));
      }, 120000); // 2 minutes

      try {
        const screenshot = await renderer.getMapImage(
          task.body.style as any,
          {
            center: task.body.center,
            zoom: task.body.zoom,
            pitch: task.body.pitch || 0,
            bearing: task.body.bearing || 0,
          },
          {
            format: task.body.format || "webp",
            quality: task.body.quality ?? 100,
            width: task.body.width || 1920,
            height: task.body.height || 1080,
            pixelRatio: task.body.ratio || 1,
          },
          task.signal,
        );

        clearTimeout(timeoutId);
        task.resolve(screenshot);
      } catch (renderError) {
        clearTimeout(timeoutId);
        throw renderError;
      }
    } catch (error) {
      console.error(`Error in renderer ${rendererIndex}:`, error);

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Check if this is a critical error that requires renderer restart
      if (this.isCriticalError(errorMessage)) {
        console.error(
          `Critical error in renderer ${rendererIndex}... Cleaning up and marking for restart`,
        );

        // Clean up the problematic renderer
        if (this.renderers[rendererIndex]) {
          await this.renderers[rendererIndex]!.cleanup().catch((err) => {
            console.error("Error cleaning up renderer:", err);
          });
          this.renderers[rendererIndex] = null;
        }

        // Try to reinitialize immediately for next request
        this.reinitializeRenderer(rendererIndex).catch((err) => {
          console.error(
            `Failed to reinitialize renderer ${rendererIndex}:`,
            err,
          );
        });
      }

      task.reject(error);
    }
  }

  private isCriticalError(errorMessage: string): boolean {
    const criticalErrorPatterns = [
      "disconnected",
      "crash",
      "timeout",
      "detached",
      "Browser has been closed",
      "Protocol error",
      "Target closed",
      "Session closed",
      "Connection closed",
    ];

    return criticalErrorPatterns.some((pattern) =>
      errorMessage.toLowerCase().includes(pattern.toLowerCase()),
    );
  }

  async start(): Promise<void> {
    if (this.isShuttingDown) {
      throw new Error("Cannot start server during shutdown");
    }

    try {
      console.log(`Starting server with ${this.rendererCount} renderers...`);

      // Initialize all renderers
      const initPromises = [];
      for (let i = 0; i < this.rendererCount; i++) {
        initPromises.push(
          this.initRenderer(i).catch((error) => {
            console.error(`Failed to initialize renderer ${i}:`, error);
            // Don't fail the entire startup if one renderer fails
            return null;
          }),
        );
      }

      await Promise.all(initPromises);

      const healthyRenderers = this.renderers.filter((r) => r !== null).length;
      console.log(
        `Server started with ${healthyRenderers}/${this.rendererCount} healthy renderers`,
      );

      if (healthyRenderers === 0) {
        throw new Error("No renderers could be initialized");
      }
    } catch (error) {
      console.error("Server Start failed:", error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    console.log("Stopping server...");
    this.isShuttingDown = true;

    // Stop health monitoring
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Stop accepting new tasks
    this.renderQueue.pause();

    // Wait for current tasks to complete (with timeout)
    try {
      await Promise.race([
        this.renderQueue.onIdle(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Shutdown timeout")), 30000),
        ),
      ]);
    } catch (error) {
      console.warn("Some tasks may not have completed during shutdown:", error);
    }

    // Clean up all renderers
    console.log("Cleaning up renderers...");
    const cleanupPromises = this.renderers.map(async (renderer, index) => {
      if (renderer) {
        try {
          await renderer.cleanup();
          console.log(`Renderer ${index} cleaned up`);
        } catch (error) {
          console.error(`Error cleaning up renderer ${index}:`, error);
        }
      }
    });

    await Promise.all(cleanupPromises);
    this.renderers = new Array(this.rendererCount).fill(null);

    console.log("Server stopped successfully");
  }
}

export default MapScreenshotServer;
