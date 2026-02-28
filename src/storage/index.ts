import { Readable } from "stream";

export interface PutObjectParams {
  bucket: string;
  key: string;
  body: Buffer | Uint8Array | Blob | string;
  contentType?: string;
  aclPublicRead?: boolean;
}

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

let _backend: StorageBackend | null = null;

function getBackend(): StorageBackend {
  if (!_backend) throw new Error("Storage not initialized. Call initStorage() first.");
  return _backend;
}

export function initStorage(): void {
  const storageType = (process.env.STORAGE_BACKEND || "s3").toLowerCase();
  if (storageType === "filesystem") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("./filesystem") as typeof import("./filesystem");
    fs.initFilesystem();
    _backend = fs;
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const s3 = require("./s3") as typeof import("./s3");
    s3.initS3();
    _backend = s3;
  }
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
  } else if (typeof body.transformToByteArray === "function") {
    const bytes: Uint8Array = await body.transformToByteArray();
    readable = Readable.from(Buffer.from(bytes));
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
