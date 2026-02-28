import { createReadStream, existsSync } from "fs";
import { mkdir, readFile, stat, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { Readable } from "stream";

let dataDir: string | null = null;

export function initFilesystem(): void {
  dataDir = process.env.DATA_DIR || "./data";
}

function getDataDir(): string {
  if (!dataDir) throw new Error("Filesystem storage not initialized. Call initFilesystem() first.");
  return dataDir;
}

function resolvePath(bucket: string, key: string): string {
  return join(getDataDir(), bucket, key);
}

export async function ensureBucket(bucket: string): Promise<void> {
  const dir = join(getDataDir(), bucket);
  await mkdir(dir, { recursive: true });
}

export async function putObject(params: {
  bucket: string;
  key: string;
  body: Buffer | Uint8Array | Blob | string;
  contentType?: string;
  aclPublicRead?: boolean;
}): Promise<void> {
  const filePath = resolvePath(params.bucket, params.key);
  await mkdir(dirname(filePath), { recursive: true });

  let data: Buffer | Uint8Array;
  if (Buffer.isBuffer(params.body) || params.body instanceof Uint8Array) {
    data = params.body;
  } else if (typeof params.body === "string") {
    data = Buffer.from(params.body);
  } else {
    const arrayBuffer = await (params.body as Blob).arrayBuffer();
    data = Buffer.from(arrayBuffer);
  }

  await writeFile(filePath, data);

  if (params.contentType) {
    await writeFile(filePath + ".meta", JSON.stringify({ contentType: params.contentType }));
  }
}

export async function getObject(params: {
  bucket: string;
  key: string;
  range?: string;
}): Promise<{
  Body: Readable | undefined;
  ContentType?: string;
  ContentLength?: number;
  ContentRange?: string;
}> {
  const filePath = resolvePath(params.bucket, params.key);

  if (!existsSync(filePath)) {
    const err = new Error(`Object not found: ${params.key}`);
    (err as NodeJS.ErrnoException).code = "NoSuchKey";
    throw err;
  }

  let contentType: string | undefined;
  const metaPath = filePath + ".meta";
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(await readFile(metaPath, "utf-8"));
      contentType = meta.contentType;
    } catch {
      // ignore meta read errors
    }
  }

  const stats = await stat(filePath);
  const totalSize = stats.size;

  if (params.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(params.range);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
      const stream = createReadStream(filePath, { start, end });
      return {
        Body: stream,
        ContentType: contentType,
        ContentLength: end - start + 1,
        ContentRange: `bytes ${start}-${end}/${totalSize}`,
      };
    }
  }

  const stream = createReadStream(filePath);
  return {
    Body: stream,
    ContentType: contentType,
    ContentLength: totalSize,
  };
}

export async function getObjectSignedUrl(_params: {
  bucket: string;
  key: string;
  expiresInSeconds?: number;
}): Promise<string> {
  throw new Error("Signed URLs are not supported with filesystem storage");
}

export async function deleteObject(params: { bucket: string; key: string }): Promise<void> {
  const filePath = resolvePath(params.bucket, params.key);
  try {
    await unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  try {
    await unlink(filePath + ".meta");
  } catch {
    // meta file may not exist
  }
}
