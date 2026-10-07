import { createCipheriv, createHash, randomBytes } from "node:crypto";

import { getServerChannel, getServerConfig } from "../db";

/* A push's preview, sealed to the phone's key so the relay can't read it (GRYT-1688). AES-256-GCM:
   0x01 | nonce | ciphertext | tag, base64url; AAD "gryt-push-1|" + capability tag; JSON {t, s?, b}. */

export interface PushPreview {
  title: string;
  subtitle?: string;
  body: string;
}

/** 32 random bytes, base64url without padding. */
export const PREVIEW_KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const VERSION = 1;
const TITLE_MAX = 64;
const BODY_MAX = 140;

/** The relay puts the same tag on every push, so the phone knows the server, and seals bind to it. */
export function capabilityTag(capability: string): string {
  return createHash("sha256").update(capability).digest("hex").slice(0, 16);
}

export function sealPreview(previewKey: string, capability: string, preview: PushPreview): string {
  const key = Buffer.from(previewKey, "base64url");
  if (key.length !== 32) throw new Error("a preview key is 32 bytes");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`gryt-push-1|${capabilityTag(capability)}`));
  const plain = JSON.stringify({
    t: clip(preview.title, TITLE_MAX),
    ...(preview.subtitle ? { s: clip(preview.subtitle, TITLE_MAX) } : {}),
    b: clip(preview.body, BODY_MAX),
  });
  const sealed = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, sealed, cipher.getAuthTag()]).toString("base64url");
}

/** A message's first line as it reads: a mention link shows its label, and runs of space collapse. */
export function previewText(markdown: string | null | undefined, attachmentCount = 0): string {
  const readable = (markdown ?? "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find((line) => line.length > 0);
  if (readable) return clip(readable, BODY_MAX);
  if (attachmentCount === 1) return "Sent an attachment";
  if (attachmentCount > 1) return `Sent ${attachmentCount} attachments`;
  return "New message";
}

/** By code point, so an emoji is never cut in half. */
function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** "Alice", "#general · Gryt", and the first line. A DM leaves the channel out. */
export async function messagePreview(o: { sender: string | null | undefined; channelId?: string; body: string }): Promise<PushPreview> {
  const cfg = await getServerConfig().catch(() => null);
  const server = cfg?.display_name || process.env.SERVER_NAME || "Gryt";
  const channel = o.channelId ? (await getServerChannel(o.channelId).catch(() => null))?.name : null;
  return { title: o.sender || "Someone", subtitle: channel ? `#${channel} · ${server}` : server, body: o.body };
}
