import type { Page } from "puppeteer";
import path from "path";
import fs from "fs";
import { RendererBrowser } from "./browser";

interface MapPosition {
  center: [number, number];
  zoom: number;
  bearing?: number;
  pitch?: number;
}

interface MapStyle {
  url?: string;
  json?: object;
}

class WebMaplibreGLRenderer {
  private page: Page | null = null;

  constructor(private browser: RendererBrowser) {}

  // Get Map Image as a Buffer
  async getMapImage(
    style: MapStyle,
    viewport: MapPosition,
    options: Partial<{
      width: number;
      height: number;
      quality: number;
      timeoutMs: number;
      format: "png" | "jpeg" | "webp";
      pixelRatio: number;
    }> = {},
    abortSignal?: AbortSignal,
  ): Promise<Buffer> {
    if (!this.page)
      throw new Error("No active browser page. Take screenshot failed.");

    const exportOptions = {
      style,
      viewport,
      options: {
        width: 1000,
        height: 1000,
        format: "png",
        timeoutMs: 30000,
        pixelRatio: 1,
        ...options,
        quality: Math.max(Math.min((options.quality || 100) / 100, 1), 0),
      },
    };

    return new Promise<Buffer>(async (resolve, reject) => {
      const abortHandler = () => {
        reject(new Error("Map image generation aborted."));
      };

      if (abortSignal) {
        abortSignal.onabort = abortHandler;
      }

      const result = await this.page!.evaluate(async (exportOptions) => {
        // @ts-ignore
        const createMapImage = window.createMapImage;
        if (!createMapImage)
          throw new Error(
            "No createMapImage Function found. Image creation failed.",
          );

        return createMapImage(
          exportOptions.style,
          exportOptions.viewport,
          exportOptions.options,
        );
      }, exportOptions);

      if (abortSignal) {
        abortSignal.onabort = null;
      }

      if (abortSignal?.aborted) {
        return;
      }

      const [_, base64] = result.split(",");
      resolve(Buffer.from(base64 as string, "base64"));
    });
  }

  async initWithHTML(filePath: string): Promise<void> {
    await this.browser.isReady();

    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`HTML file not found: ${filePath}`);
      }

      const absolutePath = path.resolve(filePath);

      this.page = await this.browser.newPage();
      if (!this.page)
        throw new Error("No browser page initialized. Load HTML failed.");

      const session = await this.page.createCDPSession();
      await session.send(`Emulation.setFocusEmulationEnabled`, {
        enabled: true,
      });

      // Load file directly via file:// protocol
      await this.page.goto(`file://${absolutePath}`, {
        timeout: 10000,
        waitUntil: "networkidle0",
      });

      const mapExists = await this.page.evaluate(() => {
        // @ts-ignore
        return !!window.createMapImage;
      });
      if (!mapExists)
        throw new Error("No createMapImage Function found. Load HTML failed.");
    } catch (error) {
      throw new Error(
        `Error loading HTML: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async cleanup(): Promise<void> {
    if (!this.page) return;
    await this.page.close();
  }
}

export default WebMaplibreGLRenderer;
