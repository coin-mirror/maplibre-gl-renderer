import MapScreenshotServer from "./server";
import { cpus } from "os";
import process from "process";

async function startServer() {
  const server = new MapScreenshotServer(
    "map.html",
    process.env.PORT ? parseInt(process.env.PORT) : 3000,
    !process.env.WORKER_COUNT || isNaN(parseInt(process.env.WORKER_COUNT))
      ? cpus().length
      : parseInt(process.env.WORKER_COUNT),
  );

  process.on("SIGINT", async () => {
    console.log("Server will be stopped...");
    await server.stop();
    console.log("Tschau!");
    process.exit(0);
  });

  try {
    await server.start();
  } catch (error) {
    console.error("Server could not be started:", error);
    process.exit(1);
  }
}

startServer();
