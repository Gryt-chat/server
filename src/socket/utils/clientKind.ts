export type ClientKind = "desktop" | "web" | "ios" | "android" | "other";

/** Coarse enough to log without writing the user agent itself down (GRYT-1356).
    No app sends a platform field yet, so this reads the networking stack's default agent. */
export function classifyClientKind(userAgent: string | undefined | null): ClientKind {
  if (!userAgent) return "other";
  const ua = userAgent.toLowerCase();

  if (ua.includes("electron/")) return "desktop";
  if (ua.includes("mozilla/")) return "web";
  if (ua.includes("okhttp")) return "android";
  if (ua.includes("cfnetwork") || ua.includes("darwin")) return "ios";

  return "other";
}
