import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

export async function startTestImageWorker(): Promise<() => Promise<void>> {
  const entry = process.env.GRYT_TEST_IMAGE_WORKER_ENTRY ?? join(process.cwd(), ".worker-tests/dist/index.js");
  if (!existsSync(entry)) throw new Error("Build the image-worker fixture and set GRYT_TEST_IMAGE_WORKER_ENTRY before running raster integration tests.");
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing temporary health port");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const child = spawn(process.execPath, [entry], {
    env: { PATH: process.env.PATH, NODE_ENV: "development", DATA_DIR: process.env.DATA_DIR, S3_BUCKET: process.env.S3_BUCKET,
      STORAGE_BACKEND: "filesystem", HEALTH_PORT: String(address.port), IMAGE_WORKER_POLL_MS: "250" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (bytes: Buffer) => { output = (output + bytes.toString()).slice(-8000); });
  child.stderr.on("data", (bytes: Buffer) => { output = (output + bytes.toString()).slice(-8000); });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  };
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(output);
      if (output.includes("Polling started")) return stop;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Image-worker fixture did not start: ${output}`);
  } catch (error) {
    await stop();
    throw error;
  }
}
