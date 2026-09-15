import type { Request } from "express";

/** Routes that parse JSON with their own limit, so the app-wide 2 MB parser has to leave them alone. */
export const OWN_JSON_PARSERS: ReadonlyArray<{ method: string; path: string }> = [
  { method: "POST", path: "/api/webhooks/:webhookId/:token" },
  { method: "POST", path: "/api/webhooks" },
  { method: "PATCH", path: "/api/webhooks/:webhookId" },
  { method: "PATCH", path: "/api/emojis/:name" },
  { method: "POST", path: "/api/emojis/bttv/import" },
];

// Express matches routes case-insensitively and with an optional trailing slash, so this does too.
function toPattern(path: string): RegExp {
  const body = path
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${body}/?$`, "i");
}

const matchers = OWN_JSON_PARSERS.map(({ method, path }) => ({ method, pattern: toPattern(path) }));

export function parsesOwnJson(req: Pick<Request, "method" | "path">): boolean {
  return matchers.some((m) => m.method === req.method && m.pattern.test(req.path));
}
