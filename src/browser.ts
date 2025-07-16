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
  maxRetries?: number;
  retryDelay?: number;
}

export class RendererBrowser {
  private readonly options: LoaderOptions;
  browser: Browser | null = null;
  private isReadyPromise: Promise<void> | null = null;
  private isShuttingDown: boolean = false;
  private retryCount: number = 0;
  private restartPromise: Promise<void> | null = null;

  constructor(options: Partial<LoaderOptions> = {}) {
    const defaultOptions: LoaderOptions = {
      timeout: 30000,
      waitUntil: "networkidle0",
      maxRetries: 3,
      retryDelay: 5000,
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
    this.initializeBrowser();
  }

  private initializeBrowser(): void {
    this.isReadyPromise = new Promise(async (resolve, reject) => {
      try {
        await this.initBrowser();
        this.isReadyPromise = null;
        console.log("Browser ready");
        resolve();
      } catch (error) {
        console.error("Failed to initialize browser:", error);
        this.isReadyPromise = null;
        reject(error);
      }
    });
  }

  public async isReady(): Promise<void> {
    if (this.isShuttingDown) {
      throw new Error("Browser is shutting down");
    }
    
    if (this.restartPromise) {
      console.log("Waiting for browser restart to complete...");
      await this.restartPromise;
    }
    
    if (!this.isReadyPromise) return;
    return await this.isReadyPromise;
  }

  private async initBrowser(): Promise<void> {
    if (this.isShuttingDown) {
      throw new Error("Cannot initialize browser during shutdown");
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch (error) {
        console.warn("Error closing existing browser:", error);
      }
      this.browser = null;
    }

    const gpuArgs = [
      // Automatic fallback to software WebGL has been deprecated. We flag to
      // opt in to lower security guarantees for trusted content.
      "--enable-unsafe-swiftshader",
      "--use-gl=swiftshader",

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

    const stabilityArgs = [
      // Stability improvements
      "--disable-extensions",
      "--disable-plugins",
      "--disable-default-apps",
      "--disable-background-networking",
      "--disable-background-downloads",
      "--disable-crash-reporter",
      "--disable-component-update",
      "--disable-sync",
      "--disable-translate",
      "--disable-ipc-flooding-protection",
      "--max-memory-usage=1024",
    ];

    try {
      this.browser = await puppeteer.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          ...gpuArgs,
          ...stabilityArgs,
          `--window-size=${this.options.viewport?.width || 1024},${
            this.options.viewport?.height || 768
          }`,

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
        protocolTimeout: 360_000,
        env:
          process.env.NODE_ENV === "production"
            ? {
                ...process.env,
                DISPLAY: ":99",
              }
            : undefined,
      });

      // Set up browser crash detection and restart mechanism
      this.setupBrowserEventHandlers();
      this.retryCount = 0; // Reset retry count on successful init
    } catch (error) {
      console.error("Failed to launch browser:", error);
      throw error;
    }
  }

  private setupBrowserEventHandlers(): void {
    if (!this.browser) return;

    this.browser.on("disconnected", () => {
      if (this.isShuttingDown) {
        console.log("Browser disconnected during shutdown - expected");
        return;
      }
      
      console.error("Browser disconnected unexpectedly! Attempting restart...");
      this.handleBrowserCrash();
    });

    this.browser.on("targetcreated", () => {
      console.log("New browser target created");
    });

    this.browser.on("targetdestroyed", () => {
      console.log("Browser target destroyed");
    });
  }

  private async handleBrowserCrash(): Promise<void> {
    if (this.isShuttingDown || this.restartPromise) {
      return;
    }

    this.restartPromise = this.restartBrowser();
    await this.restartPromise;
    this.restartPromise = null;
  }

  private async restartBrowser(): Promise<void> {
    if (this.retryCount >= this.options.maxRetries!) {
      console.error(`Max retry attempts (${this.options.maxRetries}) reached. Browser restart failed.`);
      throw new Error(`Browser restart failed after ${this.options.maxRetries} attempts`);
    }

    this.retryCount++;
    console.log(`Restarting browser (attempt ${this.retryCount}/${this.options.maxRetries})...`);

    try {
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, this.options.retryDelay));
      
      // Clean up existing browser
      if (this.browser) {
        try {
          await this.browser.close();
        } catch (error) {
          console.warn("Error closing crashed browser:", error);
        }
        this.browser = null;
      }

      // Reinitialize browser
      await this.initBrowser();
      console.log(`Browser successfully restarted (attempt ${this.retryCount})`);
    } catch (error) {
      console.error(`Browser restart attempt ${this.retryCount} failed:`, error);
      if (this.retryCount < this.options.maxRetries!) {
        // Try again
        await this.restartBrowser();
      } else {
        throw error;
      }
    }
  }

  public async newPage(): Promise<Page> {
    await this.isReady(); // Ensure browser is ready
    
    if (!this.browser) throw new Error("Browser not initialized");
    
    try {
      const newPage = await this.browser.newPage();

      if (newPage) {
        await this.logRenderingInfo(newPage);
        this.setupPageEventHandlers(newPage);
      }

      newPage.setDefaultNavigationTimeout(this.options.timeout);
      return newPage;
    } catch (error) {
      console.error("Failed to create new page:", error);
      
      // If browser seems to be dead, trigger restart
      if (error instanceof Error && 
          (error.message.includes("Browser has been closed") || 
           error.message.includes("Protocol error"))) {
        console.log("Browser appears to be dead, triggering restart...");
        await this.handleBrowserCrash();
        // Try once more after restart
        if (this.browser) {
          return await this.browser.newPage();
        }
      }
      
      throw error;
    }
  }

  private setupPageEventHandlers(page: Page): void {
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.error("Browser Console Error:", msg.text());
      } else if (process.env.DEBUG_BROWSER) {
        console.log("Browser Log:", msg.text());
      }
    });
    
    page.on("pageerror", (error) => {
      console.error("Browser Page Error:", error.name, error.message, error.stack);
    });

    page.on("crash", () => {
      console.error("Page crashed! This may indicate browser instability.");
    });

    page.on("error", (error) => {
      console.error("Page error:", error);
    });
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

  public async isBrowserHealthy(): Promise<boolean> {
    if (!this.browser) return false;
    
    try {
      const pages = await this.browser.pages();
      return pages.length >= 0; // Basic connectivity check
    } catch (error) {
      console.warn("Browser health check failed:", error);
      return false;
    }
  }

  public async close(): Promise<void> {
    this.isShuttingDown = true;
    
    // Wait for any ongoing restart to complete
    if (this.restartPromise) {
      try {
        await this.restartPromise;
      } catch (error) {
        console.warn("Error waiting for browser restart during shutdown:", error);
      }
    }

    if (this.browser) {
      try {
        await this.browser.close();
        console.log("Browser closed successfully");
      } catch (error) {
        console.error("Error closing browser:", error);
      } finally {
        this.browser = null;
      }
    }
  }
}
