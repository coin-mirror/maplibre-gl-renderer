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
    options: Partial<{
      type: "png" | "jpeg" | "webp";
      quality: number;
    }> = {},
  ): Promise<Buffer> {
    if (!this.page)
      throw new Error("No active browser page. Take screenshot failed.");

    const exportOptions = {
      type: "webp",
      quality: 100,
      ...options,
    };

    const dataBufferAsBase64 = await this.page!.evaluate(
      async (exportOptions) => {
        // @ts-ignore
        const map = window.map;
        if (!map)
          throw new Error(
            "No Maplibre instance found. Take screenshot failed.",
          );

        const canvas = map.getCanvas() as HTMLCanvasElement;
        if (!canvas)
          throw new Error("No canvas found. Take screenshot failed.");

        const dataUrl = canvas.toDataURL(
          exportOptions.type ? `image/${exportOptions.type}` : "image/webp",
          exportOptions.quality ?? 100,
        );

        return dataUrl;
      },
      exportOptions,
    );

    const [_, base64] = dataBufferAsBase64.split(",");
    return Buffer.from(base64 as string, "base64");
  }

  async setMapSize(viewport: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
  }): Promise<void> {
    if (!this.page)
      throw new Error("No active browser page. Set map size failed.");

    return await this.page!.evaluate((viewport) => {
      // @ts-ignore
      const map = window.map;
      if (!map) throw new Error("No map instance found.");

      const container = map.getContainer();
      if (!container) throw new Error("No container found.");

      container.style.width = `${viewport.width}px`;
      container.style.height = `${viewport.height}px`;
      map.setPixelRatio(viewport.deviceScaleFactor ?? 1);

      // Trigger resize event!
      map.resize();
    }, viewport);
  }

  async setMapPosition(position: Partial<MapPosition>): Promise<void> {
    if (!this.page)
      throw new Error("No active browser page. Set map position failed.");

    await this.page.evaluate((pos) => {
      // @ts-ignore
      const map = window.map;
      if (!map)
        throw new Error("No Maplibre instance found. Set map position failed.");

      map.jumpTo(pos);
    }, position);
  }

  async setMapStyle(style: MapStyle): Promise<void> {
    if (!this.page)
      throw new Error("No active browser page. Set map style failed.");

    await this.page.evaluate((styleData) => {
      // @ts-ignore
      const map = window.map;
      if (!map)
        throw new Error("No Maplibre instance found. Set map style failed.");

      if (styleData.url) {
        map.setStyle(styleData.url);
      } else if (styleData.json) {
        map.setStyle(styleData.json);
      }
    }, style);
  }

  async waitForMapRendered(): Promise<void> {
    if (!this.page)
      throw new Error("No active browser page. Wait for map idle failed.");

    await this.page.evaluate(() => {
      return new Promise((resolve) => {
        // @ts-ignore
        const map = window.map;
        if (!map)
          throw new Error(
            "No Maplibre instance found. Wait for map idle failed.",
          );

        if (!map.loaded()) {
          map.once("idle", resolve);
        } else {
          resolve(undefined);
        }
      });
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
        return !!window.map;
      });
      if (!mapExists)
        throw new Error("No Maplibre instance found. Load HTML failed.");
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
