import consola from "consola";

/* Whether the image worker can clear quarantine: it says so on /health once it has its jail
   (GRYT-1664). Asked every minute; any doubt reads as no, which keeps the old path. */
const REFRESH_MS = 60_000;

let clears = false;
let timer: NodeJS.Timeout | null = null;

export function workerClearsQuarantine(): boolean {
  return clears;
}

export async function refreshWorkerCapabilities(url = process.env.IMAGE_WORKER_URL, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!url) return (clears = false);
  try {
    const res = await fetchImpl(`${url.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(5_000) });
    const body = res.ok ? ((await res.json()) as { capabilities?: unknown }) : null;
    const next = Array.isArray(body?.capabilities) && body.capabilities.includes("quarantine-v1");
    if (next !== clears) consola.info(`[uploads] Quarantine through the image worker ${next ? "on" : "off"}`);
    return (clears = next);
  } catch {
    return (clears = false);
  }
}

export function startWorkerCapabilityPolling(): void {
  if (timer) return;
  void refreshWorkerCapabilities();
  timer = setInterval(() => void refreshWorkerCapabilities(), REFRESH_MS);
  timer.unref();
}
