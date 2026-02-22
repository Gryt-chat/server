import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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
  });
}

export async function putObject(params: { bucket: string; key: string; body: Buffer | Uint8Array | Blob | string; contentType?: string; aclPublicRead?: boolean; }): Promise<void> {
  const client = getS3();
  const cmd = new PutObjectCommand({
    Bucket: params.bucket,
    Key: params.key,
    Body: params.body as any,
    ContentType: params.contentType,
    ACL: params.aclPublicRead ? "public-read" : undefined,
  } as any);
  await client.send(cmd);
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