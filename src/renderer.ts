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

declare global {
  interface Window {
    createMapImage: (
      style: MapStyle,
      viewport: MapPosition,
      options: {
        width: number;
        height: number;
        pixelRatio?: number;
        format?: string;
        quality?: number;
      },
    ) => Promise<string>;
  }
}

class WebMaplibreGLRenderer {
  private browser = new RendererBrowser({
    timeout: 30000,
    waitUntil: "networkidle0",
    maxRetries: 3,
    retryDelay: 2000,
  });
  private page: Page | null = null;
  private isInitialized: boolean = false;
  private htmlPath: string = "";

  constructor() {
    // Browser crash handling is now managed by RendererBrowser class
  }

  // Get Map Image as a Buffer
  async getMapImage(
    style: MapStyle,
    viewport: MapPosition,
    options: Partial<{
      width: number;
      height: number;
      quality: number;
      format: "png" | "jpeg" | "webp";
      pixelRatio: number;
    }> = {},
    abortSignal?: AbortSignal,
  ): Promise<Buffer> {
    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.attemptMapImageGeneration(style, viewport, options, abortSignal);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.error(`Map image generation attempt ${attempt} failed:`, lastError.message);

        if (abortSignal?.aborted) {
          throw new Error("Map image generation aborted.");
        }

        // Check if it's a browser-related error that might be recoverable
        if (this.isBrowserRelatedError(lastError) && attempt < maxRetries) {
          console.log(`Attempting to recover and retry (${attempt}/${maxRetries})...`);
          await this.handleBrowserError();
          continue;
        }

        // If it's the last attempt or non-recoverable error, throw
        if (attempt === maxRetries) {
          throw lastError;
        }
      }
    }

    throw lastError || new Error("Unknown error during map image generation");
  }

  private async attemptMapImageGeneration(
    style: MapStyle,
    viewport: MapPosition,
    options: Partial<{
      width: number;
      height: number;
      quality: number;
      format: "png" | "jpeg" | "webp";
      pixelRatio: number;
    }> = {},
    abortSignal?: AbortSignal,
  ): Promise<Buffer> {
    await this.ensurePageReady();

    if (!this.page) {
      throw new Error("No active browser page. Take screenshot failed.");
    }

    const exportOptions = {
      style,
      viewport,
      options: {
        width: 1000,
        height: 1000,
        format: "png",
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

      try {
        // Set a timeout for the operation
        const timeoutId = setTimeout(() => {
          reject(new Error("Map image generation timeout"));
        }, 60000);

        const result = await this.page!.evaluate((exportOptions) => {
          return window.createMapImage(
            exportOptions.style,
            exportOptions.viewport,
            exportOptions.options,
          );
        }, exportOptions);

        clearTimeout(timeoutId);

        if (abortSignal) {
          abortSignal.onabort = null;
        }

        if (abortSignal?.aborted) {
          return reject(new Error("Map image generation aborted."));
        }

        const [_, base64] = result.split(",");
        resolve(Buffer.from(base64 as string, "base64"));
      } catch (error) {
        if (abortSignal) {
          abortSignal.onabort = null;
        }
        reject(error);
      }
    });
  }

  private isBrowserRelatedError(error: Error): boolean {
    const browserErrorPatterns = [
      "Browser has been closed",
      "Protocol error",
      "Target closed",
      "Session closed",
      "Connection closed",
      "disconnected",
      "crash",
      "detached",
      "Cannot find context",
    ];

    return browserErrorPatterns.some(pattern => 
      error.message.toLowerCase().includes(pattern.toLowerCase())
    );
  }

  private async handleBrowserError(): Promise<void> {
    console.log("Handling browser error - reinitializing page...");
    
    // Close current page if it exists
    if (this.page) {
      try {
        await this.page.close();
      } catch (error) {
        console.warn("Error closing page during recovery:", error);
      }
      this.page = null;
    }

    // Reset initialization flag
    this.isInitialized = false;

    // Wait a moment before retrying
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  private async ensurePageReady(): Promise<void> {
    if (!this.isInitialized || !this.page) {
      await this.initializePage();
    }

    // Additional health check
    try {
      if (this.page && this.page.isClosed()) {
        console.log("Page is closed, reinitializing...");
        this.page = null;
        this.isInitialized = false;
        await this.initializePage();
      }
    } catch (error) {
      console.warn("Error checking page health:", error);
      this.page = null;
      this.isInitialized = false;
      await this.initializePage();
    }
  }

  private async initializePage(): Promise<void> {
    if (!this.htmlPath) {
      throw new Error("HTML path not set. Call initWithHTML first.");
    }

    console.log("Initializing new page...");
    
    try {
      await this.browser.isReady();
      this.page = await this.browser.newPage();
      
      if (!this.page) {
        throw new Error("Failed to create new browser page");
      }

      const session = await this.page.createCDPSession();
      await session.send(`Emulation.setFocusEmulationEnabled`, {
        enabled: true,
      });

      // Load file directly via file:// protocol
      await this.page.goto(`file://${this.htmlPath}`, {
        timeout: 30000,
        waitUntil: "networkidle0",
      });

      // Verify the page is ready
      const mapExists = await this.page.evaluate(() => {
        // @ts-ignore
        return !!window.createMapImage;
      });
      
      if (!mapExists) {
        throw new Error("No createMapImage Function found. Page initialization failed.");
      }

      this.isInitialized = true;
      console.log("Page initialized successfully");
    } catch (error) {
      this.page = null;
      this.isInitialized = false;
      throw new Error(
        `Error initializing page: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async initWithHTML(filePath: string): Promise<void> {
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`HTML file not found: ${filePath}`);
      }

      this.htmlPath = path.resolve(filePath);
      this.isInitialized = false;
      
      // Initialize the page immediately
      await this.initializePage();
    } catch (error) {
      throw new Error(
        `Error loading HTML: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const browserHealthy = await this.browser.isBrowserHealthy();
      const pageHealthy = this.page && !this.page.isClosed();
      
      return browserHealthy && !!pageHealthy && this.isInitialized;
    } catch (error) {
      console.warn("Health check failed:", error);
      return false;
    }
  }

  async cleanup(): Promise<void> {
    console.log("Cleaning up renderer...");
    
    if (this.page) {
      try {
        await this.page.close();
        console.log("Page closed");
      } catch (error) {
        console.warn("Error closing page:", error);
      }
      this.page = null;
    }
    
    this.isInitialized = false;
    
    try {
      await this.browser.close();
      console.log("Browser closed");
    } catch (error) {
      console.warn("Error closing browser:", error);
    }
  }
}

export default WebMaplibreGLRenderer;
