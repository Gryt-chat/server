import { S3Client, S3ServiceException, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand, CreateBucketCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { Agent as HttpAgent } from "http";
import { Agent as HttpsAgent } from "https";

let s3: S3Client | null = null;

export function getS3(): S3Client {
  if (!s3) throw new Error("S3 client not initialized. Call initS3() first.");
  return s3;
}

export function initS3(): void {
  const region = process.env.S3_REGION || "auto";
  const endpoint = process.env.S3_ENDPOINT; // e.g. https://s3.amazonaws.com or https://<accountid>.r2.cloudflarestorage.com or http://localhost:9000
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === "true"; // needed for MinIO or some self-hosted

  s3 = new S3Client({
    region,
    endpoint,
    forcePathStyle,
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
    requestHandler: new NodeHttpHandler({
      httpAgent: new HttpAgent({ maxSockets: 5000, keepAlive: true }),
      httpsAgent: new HttpsAgent({ maxSockets: 5000, keepAlive: true }),
      socketAcquisitionWarningTimeout: 10_000,
    }),
  });
}

export async function ensureBucket(bucket: string): Promise<void> {
  const client = getS3();
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (err) {
    if (
      (err instanceof Error && (err.name === "NotFound" || err.name === "NoSuchBucket")) ||
      (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404)
    ) {
      console.log(`[S3] Bucket "${bucket}" does not exist, creating…`);
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      console.log(`[S3] Bucket "${bucket}" created`);
    } else {
      throw err;
    }
  }
}

// At most 10,000 parts and none under 5 MB, so the object ceiling is part size
// times 10,000 — which is why a constant part size is a cap in disguise.
const MAX_PARTS = 10_000;
const PART_TARGET = Math.floor(MAX_PARTS * 0.95); // 5% headroom for rounding
const MIN_PART_SIZE = 8 * 1024 * 1024;
// queueSize * partSize is what is held in memory at once, so bound that rather
// than the part count.
const MAX_IN_FLIGHT = 64 * 1024 * 1024;

/** A fixed 8 MB part caps the object at 80 GB. Sized to the file: 500 GB needs
    ~53 MB parts and 5 TB, S3's own ceiling, needs ~550 MB. */
export function multipartPlan(size: number): { partSize: number; queueSize: number } {
  const needed = Math.ceil(size / PART_TARGET);
  const partSize = Math.max(MIN_PART_SIZE, Math.ceil(needed / (1024 * 1024)) * 1024 * 1024);
  const queueSize = Math.max(1, Math.min(4, Math.floor(MAX_IN_FLIGHT / partSize)));
  return { partSize, queueSize };
}

/** Not `PutObjectCommand`: a single PUT caps at 5 GB and cannot be retried once
    its stream is consumed. This retries parts and aborts on failure. */
async function putObjectFromPath(params: { bucket: string; key: string; sourcePath: string; contentType?: string; aclPublicRead?: boolean; }): Promise<void> {
  const client = getS3();
  const { size } = await stat(params.sourcePath);
  console.log("[S3] putObject (streamed):", { bucket: params.bucket, key: params.key, contentType: params.contentType, bodySize: size });

  const { partSize, queueSize } = multipartPlan(size);
  const stream = createReadStream(params.sourcePath);
  try {
    const upload = new Upload({
      client,
      params: {
        Bucket: params.bucket,
        Key: params.key,
        Body: stream,
        ContentType: params.contentType,
        ACL: params.aclPublicRead ? "public-read" : undefined,
      },
      queueSize,
      partSize,
      leavePartsOnError: false,
    });
    await upload.done();
    console.log("[S3] putObject success:", params.key);
  } catch (err) {
    console.error("[S3] putObject failed:", params.key, err);
    throw err;
  } finally {
    // Upload consumes the stream, but destroy it explicitly so a failure part
    // way through does not leave the descriptor open until GC gets to it.
    stream.destroy();
  }
}

export async function putObject(params: { bucket: string; key: string; body?: Buffer | Uint8Array | Blob | string; sourcePath?: string; contentType?: string; aclPublicRead?: boolean; }): Promise<void> {
  if (params.sourcePath) {
    return putObjectFromPath({ ...params, sourcePath: params.sourcePath });
  }
  const client = getS3();
  const bodySize = Buffer.isBuffer(params.body) || params.body instanceof Uint8Array ? params.body.length : typeof params.body === "string" ? params.body.length : "unknown";
  console.log("[S3] putObject:", { bucket: params.bucket, key: params.key, contentType: params.contentType, bodySize });
  const cmd = new PutObjectCommand({
    Bucket: params.bucket,
    Key: params.key,
    Body: params.body,
    ContentType: params.contentType,
    ACL: params.aclPublicRead ? "public-read" : undefined,
  });
  try {
    await client.send(cmd);
    console.log("[S3] putObject success:", params.key);
  } catch (err) {
    console.error("[S3] putObject failed:", params.key, err);
    throw err;
  }
}

export async function getObjectSignedUrl(params: { bucket: string; key: string; expiresInSeconds?: number }): Promise<string> {
  const client = getS3();
  const cmd = new GetObjectCommand({ Bucket: params.bucket, Key: params.key });
  return getSignedUrl(client, cmd, { expiresIn: params.expiresInSeconds ?? 900 });
} 

export async function getObject(params: { bucket: string; key: string; range?: string }) {
  const client = getS3();
  const cmd = new GetObjectCommand({ Bucket: params.bucket, Key: params.key, Range: params.range });
  return client.send(cmd);
}

export async function deleteObject(params: { bucket: string; key: string }): Promise<void> {
  const client = getS3();
  const cmd = new DeleteObjectCommand({ Bucket: params.bucket, Key: params.key });
  await client.send(cmd);
}