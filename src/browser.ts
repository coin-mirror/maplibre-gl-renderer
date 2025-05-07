import puppeteer, {
  Browser,
  Page,
  type Viewport,
  type PuppeteerLifeCycleEvent,
} from "puppeteer";

interface LoaderOptions {
  timeout: number;
  waitUntil: PuppeteerLifeCycleEvent | PuppeteerLifeCycleEvent[];
  viewport?: Viewport;
}

export class RendererBrowser {
  private readonly options: LoaderOptions;
  browser: Browser | null = null;
  private isReadyPromise: Promise<void> | null = null;

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
    this.isReadyPromise = new Promise(async (resolve) => {
      await this.initBrowser();
      this.isReadyPromise = null;
      console.log("Browser ready");
      resolve();
    });
  }

  public async isReady(): Promise<void> {
    if (!this.isReadyPromise) return;
    return await this.isReadyPromise;
  }

  private async initBrowser(): Promise<void> {
    if (!this.browser) {
      const gpuArgs = [
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

          // Automatic fallback to software WebGL has been deprecated. We flag to
          // opt in to lower security guarantees for trusted content.
          "--enable-unsafe-swiftshader",

          // Disable background tabs throttling:
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",

          // Required to access local files
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
    }
  }

  public async newPage(): Promise<Page> {
    if (!this.browser) throw new Error("Browser not initialized");
    const newPage = await this.browser.newPage();

    if (newPage) {
      await this.logRenderingInfo(newPage);
    }

    newPage.on("console", (msg) => console.log("Browser Log:", msg.text()));
    newPage.on("pageerror", (error) => {
      console.error("Browser Error:", error.name, error.message, error.stack);
    });
    newPage.setDefaultNavigationTimeout(this.options.timeout);

    return newPage;
  }

  private async logRenderingInfo(page: Page): Promise<void> {
    try {
      // WebGL Availability and Info
      const webglInfo = await page.evaluate(() => {
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
      const gpuInfo = await page.evaluate(() => {
        // @ts-ignore
        return window.chrome?.gpuInfo;
      });
      if (process.env.DEBUG_GPU) console.log("Chrome GPU Info:", gpuInfo);
    } catch (error) {
      console.warn("Error collecting rendering information:", error);
    }
  }

  public async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
