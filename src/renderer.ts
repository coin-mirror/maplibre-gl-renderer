import puppeteer, {
  Browser,
  Page,
  type Viewport,
  type ScreenshotOptions,
  type PuppeteerLifeCycleEvent,
} from "puppeteer";
import path from "path";
import fs from "fs";

interface LoaderOptions {
  timeout: number;
  waitUntil: PuppeteerLifeCycleEvent | PuppeteerLifeCycleEvent[];
  viewport?: Viewport;
}

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
  private readonly options: LoaderOptions;
  private browser: Browser | null;
  private page: Page | null;

  constructor(options: Partial<LoaderOptions> = {}) {
    const defaultOptions: LoaderOptions = {
      timeout: 30000,
      waitUntil: "networkidle0",
      viewport: {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        hasTouch: false,
        isLandscape: true,
        isMobile: false,
      },
    };

    this.options = { ...defaultOptions, ...options };
    this.browser = null;
    this.page = null;
  }

  private async initBrowser(): Promise<void> {
    if (!this.browser) {
      const gpuArgs = [
        "--use-gl=angle",
        "--enable-webgl",
        "--ignore-gpu-blocklist",
        "--enable-gpu-rasterization",
        "--enable-accelerated-2d-canvas",
        "--enable-accelerated-compositing",
        "--enable-threaded-compositing",
        "--enable-oop-rasterization",
        "--enable-zero-copy",
        "--no-first-run",
        "--no-zygote",
        "--shared-memory-size=8192",
        "--font-render-hinting=none", // Disable, since not needed
      ];

      this.browser = await puppeteer.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          ...gpuArgs,
          `--window-size=${this.options.viewport?.width || 1024},${
            this.options.viewport?.height || 768
          }`,
          "--allow-file-access-from-files",
          // WARN: This ignores potential issues with CORS and our self-signed certs
          "--disable-web-security",
          "--ignore-certificate-errors",
        ],
        env:
          process.env.NODE_ENV === "production"
            ? {
                ...process.env,
                DISPLAY: ":99",
              }
            : undefined,
      });

      this.page = await this.browser.newPage();

      // GPU/WebGL Status logging
      if (this.page) {
        await this.logRenderingInfo();
      }

      // Viewport setzen
      if (this.options.viewport) {
        await this.setViewport(this.options.viewport);
      }

      this.page.on("console", (msg) => console.log("Browser Log:", msg.text()));
      this.page.on("pageerror", (error) => {
        console.error("JavaScript Error:", error.message);
      });

      this.page.setDefaultNavigationTimeout(this.options.timeout);
    }
  }

  private async logRenderingInfo(): Promise<void> {
    if (!this.page) return;

    try {
      // WebGL Availability and Info
      const webglInfo = await this.page.evaluate(() => {
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            const canvas = document.createElement("canvas");

            // Try WebGL2 first
            let gl = canvas.getContext("webgl2", {
              failIfMajorPerformanceCaveat: false,
              antialias: false,
              preserveDrawingBuffer: false,
            });
            const isWebGL2 = !!gl;

            // If WebGL2 is not available, try WebGL1
            if (!gl) {
              // @ts-ignore
              gl =
                canvas.getContext("webgl", {
                  failIfMajorPerformanceCaveat: false,
                  antialias: false,
                  preserveDrawingBuffer: false,
                }) ||
                canvas.getContext("experimental-webgl", {
                  failIfMajorPerformanceCaveat: false,
                  antialias: false,
                  preserveDrawingBuffer: false,
                });
            }

            if (gl) {
              const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
              resolve({
                version: isWebGL2 ? "WebGL 2.0" : "WebGL 1.0",
                vendor: debugInfo
                  ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
                  : gl.getParameter(gl.VENDOR),
                renderer: debugInfo
                  ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
                  : gl.getParameter(gl.RENDERER),
                shadingLanguageVersion: gl.getParameter(
                  gl.SHADING_LANGUAGE_VERSION,
                ),
                maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
                extensions: gl.getSupportedExtensions(),
              });
            }

            resolve(null);
          }, 1000);
        });
      });
      if (process.env.DEBUG_GPU) console.log("WebGL Info:", webglInfo);

      // Chrome GPU Info
      const gpuInfo = await this.page.evaluate(() => {
        // @ts-ignore
        return window.chrome?.gpuInfo;
      });
      if (process.env.DEBUG_GPU) console.log("Chrome GPU Info:", gpuInfo);
    } catch (error) {
      console.warn("Error collecting rendering information:", error);
    }
  }

  private async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }

  // Screenshot Funktion die einen Buffer zurückgibt
  async takeScreenshot(
    options: Partial<ScreenshotOptions> = {},
  ): Promise<Buffer> {
    if (!this.page)
      throw new Error("No active browser page. Take screenshot failed.");

    const defaultOptions: ScreenshotOptions = {
      type: "webp",
      fullPage: true,
      encoding: "binary",
      quality: 100,
    };

    const screenshotOptions: ScreenshotOptions = {
      ...defaultOptions,
      ...options,
    };

    return (await this.page.screenshot(screenshotOptions)) as Buffer;
  }

  // Viewport Control
  async setViewport(viewport: Partial<Viewport>): Promise<void> {
    if (!this.page)
      throw new Error("No active browser page. Set viewport failed.");

    const currentViewport = this.page.viewport();
    if (!currentViewport)
      throw new Error("No viewport found. Setting viewport failed.");
    const newViewport: Viewport = {
      ...currentViewport,
      ...viewport,
    };

    await this.page.setViewport(newViewport);

    // Wait until the map has adjusted to the new size
    await this.page.evaluate(() => {
      // @ts-ignore
      const map = window.map;
      if (map) {
        map.resize();
        return new Promise((resolve) => {
          map.once("idle", resolve);
        });
      }
    });
  }

  async getViewport(): Promise<Viewport | null> {
    if (!this.page) return null;
    return this.page.viewport();
  }

  // Map Interaktions-Methoden
  async getMapPosition(): Promise<MapPosition> {
    if (!this.page)
      throw new Error("No active browser page. Get map position failed.");

    return await this.page.evaluate(() => {
      // @ts-ignore
      const map = window.map;
      if (!map)
        throw new Error("No Maplibre instance found. Get map position failed.");

      return {
        center: map.getCenter().toArray(),
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      };
    });
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

      const promise = new Promise((resolve, reject) => {
        const onError = (e: Error) => {
          console.error("Map error:", e);
          reject(e);
          map.off("idle", onDone);
        };
        const onDone = () => {
          resolve(true);
          map.off("error", onError);
        };
        map.once("error", onError);
        map.once("idle", onDone);
      });

      if (styleData.url) {
        map.setStyle(styleData.url);
      } else if (styleData.json) {
        map.setStyle(styleData.json);
      }

      return promise;
    }, style);

    // Warten bis der Style geladen ist
    await this.waitForMapReady();
  }

  async waitForMapReady(): Promise<void> {
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

  async loadHTML(filePath: string): Promise<string> {
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`HTML file not found: ${filePath}`);
      }

      const absolutePath = path.resolve(filePath);

      await this.initBrowser();

      if (!this.page)
        throw new Error("No browser page initialized. Load HTML failed.");

      // Load file directly via file:// protocol
      await this.page.goto(`file://${absolutePath}`, {
        waitUntil: this.options.waitUntil,
      });

      await this.waitForMapReady();

      const content = await this.page.content();
      return content;
    } catch (error) {
      throw new Error(
        `Error loading HTML: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async cleanup(): Promise<void> {
    await this.closeBrowser();
  }
}

export default WebMaplibreGLRenderer;
