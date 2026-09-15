import express from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { consola } from "consola";

type Refusal = { status: number; body: { error: string; message: string } };

// body-parser marks its errors with `type` and an HTTP `status`; both are the client's fault.
export function bodyParserRefusal(err: unknown): Refusal | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { type?: unknown; status?: unknown; expose?: unknown };
  if (typeof e.type !== "string" || typeof e.status !== "number") return null;
  if (e.type === "entity.parse.failed") {
    return { status: 400, body: { error: "invalid_json", message: "The body isn't valid JSON." } };
  }
  if (e.type === "entity.too.large") {
    const limit = (err as { limit?: unknown }).limit;
    const over = typeof limit === "number" ? ` The limit is ${Math.round(limit / 1024)} KB.` : "";
    return { status: 413, body: { error: "body_too_large", message: `The body is too large.${over}` } };
  }
  if (e.expose === true && e.status >= 400 && e.status < 500) {
    return { status: e.status, body: { error: "invalid_body", message: String((err as Error).message) } };
  }
  return null;
}

/** The app-wide JSON parser, skipped for requests whose route parses with its own limit. */
export function jsonBodyExcept(skip: (req: Request) => boolean, options: { limit: string }): RequestHandler {
  const parse = express.json(options);
  return (req, res, next) => (skip(req) ? next() : parse(req, res, next));
}

export function apiErrorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const refusal = bodyParserRefusal(err);
  if (refusal) {
    res.status(refusal.status).json(refusal.body);
    return;
  }
  const e = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : {};
  if (e.code === "LIMIT_FILE_SIZE") {
    res.status(413).json({ error: "file_too_large", message: "File too large." });
    return;
  }
  if (typeof e.message === "string" && e.message.toLowerCase().includes("unsupported")) {
    res.status(400).json({ error: "invalid_file", message: e.message });
    return;
  }
  consola.error(err);
  const message = typeof e.message === "string" && e.message.trim().length > 0 ? e.message : "Internal Server Error";
  const errorCode =
    typeof e.error === "string" && e.error.trim().length > 0
      ? e.error
      : typeof e.code === "string" && e.code.trim().length > 0
      ? e.code
      : "internal_error";
  res.status(500).json({ error: errorCode, message });
}
