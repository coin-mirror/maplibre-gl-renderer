import MapScreenshotServer from "./server";
import { cpus } from "os";
import process from "process";

let server: MapScreenshotServer | null = null;
let isShuttingDown = false;
let shutdownTimeout: NodeJS.Timeout | null = null;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) {
    console.log(`Already shutting down, ignoring ${signal}`);
    return;
  }
  
  isShuttingDown = true;
  console.log(`Received ${signal}, starting graceful shutdown...`);
  
  // Set a timeout for forced shutdown
  shutdownTimeout = setTimeout(() => {
    console.error("Graceful shutdown timeout, forcing exit");
    process.exit(1);
  }, 45000); // 45 seconds timeout
  
  try {
    if (server) {
      console.log("Stopping server...");
      await server.stop();
      console.log("Server stopped successfully");
    }
    
    if (shutdownTimeout) {
      clearTimeout(shutdownTimeout);
    }
    
    console.log("Graceful shutdown completed");
    process.exit(0);
  } catch (error) {
    console.error("Error during graceful shutdown:", error);
    process.exit(1);
  }
}

async function startServer() {
  try {
    console.log("Starting MapLibre GL Renderer Server...");
    
    const workerCount = process.env.WORKER_COUNT && !isNaN(parseInt(process.env.WORKER_COUNT))
      ? parseInt(process.env.WORKER_COUNT)
      : Math.max(1, Math.min(cpus().length, 4)); // Limit to reasonable number
    
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    
    console.log(`Configuration: ${workerCount} workers, port ${port}`);
    
    server = new MapScreenshotServer("map.html", port, workerCount);

    // Register signal handlers for graceful shutdown
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));
    
    // Handle uncaught exceptions
    process.on("uncaughtException", (error) => {
      console.error("Uncaught Exception:", error);
      console.error("Stack:", error.stack);
      
      // Attempt graceful shutdown
      if (!isShuttingDown) {
        gracefulShutdown("uncaughtException");
      } else {
        process.exit(1);
      }
    });
    
    // Handle unhandled promise rejections
    process.on("unhandledRejection", (reason, promise) => {
      console.error("Unhandled Rejection at:", promise, "reason:", reason);
      
      // Attempt graceful shutdown for critical rejections
      if (!isShuttingDown) {
        gracefulShutdown("unhandledRejection");
      }
    });
    
    // Handle warning events
    process.on("warning", (warning) => {
      console.warn("Node.js Warning:", warning.name, warning.message);
      if (warning.stack) {
        console.warn("Stack:", warning.stack);
      }
    });
    
    // Start the server
    await server.start();
    console.log(`Server successfully started on port ${port} with ${workerCount} workers`);
    
    // Keep the process alive and monitor memory usage
    const memoryCheckInterval = setInterval(() => {
      if (isShuttingDown) {
        clearInterval(memoryCheckInterval);
        return;
      }
      
      const memUsage = process.memoryUsage();
      const memUsedMB = Math.round(memUsage.rss / 1024 / 1024);
      
      // Log memory usage if it's high
      if (memUsedMB > 1024) { // More than 1GB
        console.warn(`High memory usage: ${memUsedMB}MB RSS`);
      }
      
      // Force garbage collection if available
      if (global.gc && memUsedMB > 1536) { // More than 1.5GB
        console.log("Running garbage collection...");
        global.gc();
      }
    }, 60000); // Check every minute
    
  } catch (error) {
    console.error("Failed to start server:", error);
    console.error("Stack:", error instanceof Error ? error.stack : "No stack trace");
    
    // Attempt cleanup before exit
    try {
      if (server) {
        await server.stop();
      }
    } catch (cleanupError) {
      console.error("Error during cleanup:", cleanupError);
    }
    
    process.exit(1);
  }
}

// Start the server
startServer();
