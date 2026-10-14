import { createWriteStream, existsSync } from "fs";
import { mkdir, rename, rm, stat, statfs, writeFile } from "fs/promises";
import { dirname, join, normalize, sep } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

import consola from "consola";

import { leftoverS3Settings, uploadsFolder } from "./index";

/** Same name the compose storage-migrate step writes, so either one finishing counts for both. */
export const IMPORT_MARKER = ".migrated-from-minio";

export interface S3Object {
  key: string;
  size: number;
}

/** What the import reads from. The real one is the AWS SDK; tests pass a fake. */
export interface S3Source {
  list(): AsyncIterable<S3Object>;
  get(key: string): Promise<{ body: Readable; contentType?: string }>;
}

export class ImportError extends Error {}

function bucketDir(): string {
  const bucket = uploadsFolder();
  return join(process.env.DATA_DIR || "./data", bucket);
}

/** True when this server still has S3 settings and its files haven't been copied to disk yet. */
export function needsS3Import(): boolean {
  return leftoverS3Settings().length > 0 && !existsSync(join(bucketDir(), IMPORT_MARKER));
}

/** A key that can't become a path under the bucket folder, or would collide with a .meta file. */
function unsafeKey(key: string): boolean {
  if (!key || key.endsWith("/")) return false;
  const clean = normalize(key);
  return key.includes("\\") || key.endsWith(".meta") || key.startsWith("/") || clean.startsWith("..") || clean.split(sep).includes("..");
}

/**
 * Copies every object in the old bucket into DATA_DIR/<S3_BUCKET>, with a .meta file for its
 * content type, then writes the marker. Safe to run again: files already copied are skipped.
 */
export async function importFromS3(source: S3Source, log: (line: string) => void = (l) => consola.info(l)): Promise<{ copied: number; skipped: number }> {
  const out = bucketDir();
  await mkdir(out, { recursive: true });

  const objects: S3Object[] = [];
  for await (const object of source.list()) {
    if (object.key.endsWith("/")) continue;
    if (unsafeKey(object.key)) throw new ImportError(`The key ${object.key} can't be stored as a file. Nothing was changed.`);
    objects.push(object);
  }
  const bytes = objects.reduce((sum, o) => sum + o.size, 0);
  const free = await statfs(out).then((s) => s.bavail * s.bsize).catch(() => Number.POSITIVE_INFINITY);
  if (free < bytes + 10 * 1024 * 1024) {
    throw new ImportError(`Not enough space: ${Math.ceil(bytes / 1048576)} MB to copy and ${Math.floor(free / 1048576)} MB free.`);
  }

  log(`Copying ${objects.length} files (${Math.ceil(bytes / 1048576)} MB) from S3 to ${out}. The bucket itself isn't changed.`);
  let copied = 0;
  let skipped = 0;
  for (const object of objects) {
    const dest = join(out, object.key);
    const done = await stat(dest).then((s) => s.size === object.size && existsSync(dest + ".meta")).catch(() => false);
    if (done) {
      skipped++;
      continue;
    }
    await mkdir(dirname(dest), { recursive: true });
    const { body, contentType } = await source.get(object.key);
    const partial = dest + ".importing";
    await pipeline(body, createWriteStream(partial));
    const size = (await stat(partial)).size;
    if (size !== object.size) {
      await rm(partial, { force: true });
      throw new ImportError(`${object.key} came back as ${size} bytes, and the bucket says ${object.size}.`);
    }
    await rename(partial, dest);
    await writeFile(dest + ".meta", JSON.stringify({ contentType: contentType || "application/octet-stream" }));
    copied++;
    if (copied % 500 === 0) log(`Copied ${copied} of ${objects.length - skipped}.`);
  }

  await writeFile(join(out, IMPORT_MARKER), `copied from S3 by the server on ${new Date().toISOString()}, ${objects.length} files\n`);
  log(`Done: ${copied} copied, ${skipped} already there. Uploads are on disk from now on.`);
  return { copied, skipped };
}

/** The AWS SDK, loaded only when there's something to import. */
export async function s3SourceFromEnv(): Promise<S3Source> {
  const sdk = await import("@aws-sdk/client-s3");
  const bucket = uploadsFolder();
  const client = new sdk.S3Client({
    region: process.env.S3_REGION || "auto",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials:
      process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
        ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
        : undefined,
  });
  return {
    async *list() {
      let token: string | undefined;
      do {
        const page = await client.send(new sdk.ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
        for (const item of page.Contents ?? []) {
          if (item.Key) yield { key: item.Key, size: item.Size ?? 0 };
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    },
    async get(key) {
      const res = await client.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!res.Body) throw new ImportError(`S3 returned no body for ${key}.`);
      return { body: res.Body as Readable, contentType: res.ContentType };
    },
  };
}
