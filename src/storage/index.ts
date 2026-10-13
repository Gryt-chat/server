import { Readable } from "stream";

interface PutObjectCommon {
  bucket: string;
  key: string;
  contentType?: string;
  aclPublicRead?: boolean;
}

/** `sourcePath` is so a large upload is never held in RAM. The union makes the
    two exclusive at compile time rather than by a runtime check. */
export type PutObjectParams =
  | (PutObjectCommon & { body: Buffer | Uint8Array | Blob | string; sourcePath?: never })
  | (PutObjectCommon & { sourcePath: string; body?: never });

export interface GetObjectParams {
  bucket: string;
  key: string;
  range?: string;
}

export interface GetObjectResult {
  Body: Readable | undefined;
  ContentType?: string;
  ContentLength?: number;
  ContentRange?: string;
}

interface StorageBackend {
  ensureBucket(bucket: string): Promise<void>;
  putObject(params: PutObjectParams): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getObject(params: GetObjectParams): Promise<any>;
  getObjectSignedUrl(params: { bucket: string; key: string; expiresInSeconds?: number }): Promise<string>;
  deleteObject(params: { bucket: string; key: string }): Promise<void>;
}

/** The image worker defaults to the same name, so the two agree when neither is told. */
export const DEFAULT_FILESYSTEM_BUCKET = "gryt";

let _backend: StorageBackend | null = null;

function getBackend(): StorageBackend {
  if (!_backend) throw new Error("Storage not initialized. Call initStorage() first.");
  return _backend;
}

/**
 * Set when a server is still configured for S3, which went in 1.11.0. Starting anyway would
 * look healthy and show every file uploaded before as missing.
 */
export function leftoverS3Settings(): string[] {
  const named = (process.env.STORAGE_BACKEND || "").trim().toLowerCase();
  const left = ["S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].filter((k) => (process.env[k] || "").trim());
  return named && named !== "filesystem" ? [`STORAGE_BACKEND=${named}`, ...left] : left;
}

/** Uploads turned off by whoever runs the server. DISABLE_S3 is the old name. */
export function uploadsDisabled(): boolean {
  return ["DISABLE_UPLOADS", "DISABLE_S3"].some((k) => (process.env[k] || "").trim().toLowerCase() === "true");
}

/** What a member is told when a file can't be stored, so they can pass it on. */
export const STORAGE_NOT_CONFIGURED = {
  error: "s3_not_configured",
  message: "This server can't store files yet, so pictures and files can't be sent here. Let whoever runs it know that file storage isn't set up.",
} as const;
export const STORAGE_DISABLED = {
  error: "s3_disabled",
  message: "File uploads are turned off on this server. Let whoever runs it know if you need them.",
} as const;

export function initStorage(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("./filesystem") as typeof import("./filesystem");
  fs.initFilesystem();
  // The bucket is only a folder under DATA_DIR, and every route refuses without one.
  if (!(process.env.S3_BUCKET || "").trim()) process.env.S3_BUCKET = DEFAULT_FILESYSTEM_BUCKET;
  _backend = fs;
}

export function ensureBucket(bucket: string): Promise<void> {
  return getBackend().ensureBucket(bucket);
}

export function putObject(params: PutObjectParams): Promise<void> {
  return getBackend().putObject(params);
}

export async function getObject(params: GetObjectParams): Promise<GetObjectResult> {
  const result = await getBackend().getObject(params);
  const body = result.Body;
  let readable: Readable | undefined;

  if (body === undefined || body === null) {
    readable = undefined;
  } else if (body instanceof Readable) {
    readable = body;
  } else if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    readable = Readable.from(body);
  } else {
    readable = undefined;
  }

  return {
    Body: readable,
    ContentType: result.ContentType,
    ContentLength: result.ContentLength,
    ContentRange: result.ContentRange,
  };
}

export function getObjectSignedUrl(params: { bucket: string; key: string; expiresInSeconds?: number }): Promise<string> {
  return getBackend().getObjectSignedUrl(params);
}

export function deleteObject(params: { bucket: string; key: string }): Promise<void> {
  return getBackend().deleteObject(params);
}

export async function getObjectAsBuffer(params: GetObjectParams): Promise<Buffer> {
  const result = await getObject(params);
  if (!result.Body) throw new Error(`Empty body for ${params.key}`);
  const chunks: Buffer[] = [];
  for await (const chunk of result.Body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
