import { createHash } from "node:crypto";

import consola from "consola";
import { v4 as uuidv4 } from "uuid";

import {
  getFile,
  getWebhookMediaFileId,
  insertFile,
  insertImageJob,
  isFileReferencedByMessage,
  setWebhookMediaFileId,
} from "../db";
import type { StoredWebhookCard } from "../db";
import type { PayloadWarning, WebhookCardInput, WebhookMessageInput } from "../routes/webhookSchemas";
import { colorToHex } from "../routes/webhookSchemas";
import { storageForUpload } from "../routes/uploadStorage";
import { putObject } from "../storage";
import { validateImage } from "../utils/imageValidation";
import { fetchFollowingSafely } from "../utils/safePreviewFetch";

/** The whole request's picture fetching, so a slow host can't hold a webhook call open. */
export const MEDIA_DEADLINE_MS = 12_000;
export const MEDIA_CONCURRENCY = 4;
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const ICON_MAX_BYTES = 1024 * 1024;
/** Over every picture in one message, after identical URLs are merged. */
export const MEDIA_TOTAL_MAX_BYTES = 32 * 1024 * 1024;

export type ImageFormat = "png" | "jpeg" | "gif" | "webp";

const MIME: Record<ImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export type FetchOutcome =
  | { ok: true; bytes: Buffer }
  | { ok: false; code: "blocked" | "fetch_failed" | "too_large" | "timeout" };

export interface MediaDeps {
  fetchBytes(url: string, signal: AbortSignal, maxBytes: number): Promise<FetchOutcome>;
  storeImage(webhookId: string, bytes: Buffer, format: ImageFormat, width: number, height: number): Promise<string>;
}

/** Which picture it is, where it sits in the payload, and how big it may be. */
interface MediaSlot {
  path: string;
  url: string;
  maxBytes: number;
}

/** From the bytes, never the Content-Type header. SVG and everything else is refused. */
export function sniffImageFormat(bytes: Buffer): ImageFormat | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("latin1") === "GIF87a" || bytes.subarray(0, 6).toString("latin1") === "GIF89a")) return "gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

async function fetchBytesSafely(url: string, signal: AbortSignal, maxBytes: number): Promise<FetchOutcome> {
  try {
    const result = await fetchFollowingSafely(url, signal, "image/png,image/jpeg,image/webp,image/gif;q=0.9,*/*;q=0.1");
    if ("blocked" in result) return { ok: false, code: "blocked" };
    const { res } = result;
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, code: "fetch_failed" };
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body.cancel().catch(() => {});
      return { ok: false, code: "too_large" };
    }

    // Counted as it arrives, since Content-Length is a claim and can be missing.
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, code: "too_large" };
      }
      chunks.push(value);
    }
    return { ok: true, bytes: Buffer.concat(chunks) };
  } catch (err) {
    if (signal.aborted) return { ok: false, code: "timeout" };
    consola.debug("webhook media fetch failed", { url, err });
    return { ok: false, code: "fetch_failed" };
  }
}

/** One stored file per distinct picture a webhook sends. Only reused while a message still points at it,
    since an unreferenced file may be swept at any moment. */
async function storeWebhookImage(webhookId: string, bytes: Buffer, format: ImageFormat, width: number, height: number): Promise<string> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const known = await getWebhookMediaFileId(webhookId, sha256);
  if (known && (await getFile(known)) && (await isFileReferencedByMessage(known))) return known;

  const bucket = process.env.S3_BUCKET as string;
  const fileId = uuidv4();
  const storage = storageForUpload({ sealed: false, fileId, mimetype: MIME[format], originalName: `webhook.${format}` });
  await putObject({ bucket, key: storage.key, body: bytes, contentType: storage.storedMime });
  await insertFile({
    file_id: fileId,
    s3_key: storage.key,
    mime: storage.storedMime,
    size: bytes.length,
    width,
    height,
    thumbnail_key: null,
    original_name: storage.originalName,
    // Not null: an unowned file with no references reads as a legacy upload any member may open.
    uploaded_by_server_user_id: `webhook:${webhookId}`,
    created_at: new Date(),
  });
  if (storage.queueImageJob) {
    await insertImageJob({ file_id: fileId, raw_s3_key: storage.key, raw_content_type: storage.storedMime, raw_bytes: bytes.length })
      .catch((e: unknown) => consola.warn("Failed to queue webhook image job", e));
  }
  await setWebhookMediaFileId(webhookId, sha256, fileId);
  return fileId;
}

export const realMediaDeps: MediaDeps = { fetchBytes: fetchBytesSafely, storeImage: storeWebhookImage };

const WARNING_TEXT: Record<string, string> = {
  blocked: "That address isn't allowed, so the picture was left out.",
  fetch_failed: "The picture couldn't be downloaded, so it was left out.",
  too_large: "The picture is over the size limit, so it was left out.",
  timeout: "The picture took too long to download, so it was left out.",
  unsupported_type: "Only PNG, JPEG, WebP and GIF pictures are accepted, so it was left out.",
  invalid_image: "The picture couldn't be read, so it was left out.",
  media_budget: "The message's pictures went over 32 MB together, so this one was left out.",
  store_failed: "The picture couldn't be stored, so it was left out.",
};

function slotsFor(body: WebhookMessageInput): MediaSlot[] {
  const slots: MediaSlot[] = [];
  if (body.avatar_url) slots.push({ path: "avatar_url", url: body.avatar_url, maxBytes: ICON_MAX_BYTES });
  (body.cards ?? []).forEach((card, i) => {
    if (card.author?.icon_url) slots.push({ path: `cards[${i}].author.icon_url`, url: card.author.icon_url, maxBytes: ICON_MAX_BYTES });
    if (card.thumbnail_url) slots.push({ path: `cards[${i}].thumbnail_url`, url: card.thumbnail_url, maxBytes: IMAGE_MAX_BYTES });
    if (card.image_url) slots.push({ path: `cards[${i}].image_url`, url: card.image_url, maxBytes: IMAGE_MAX_BYTES });
    if (card.footer?.icon_url) slots.push({ path: `cards[${i}].footer.icon_url`, url: card.footer.icon_url, maxBytes: ICON_MAX_BYTES });
  });
  return slots;
}

async function inPool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  });
  await Promise.all(runners);
}

export interface ResolvedWebhookMedia {
  avatarFileId?: string;
  cards: StoredWebhookCard[];
  /** Every file the message shows, for the reference table. */
  mediaFileIds: string[];
  warnings: PayloadWarning[];
}

/** Fetches and stores every picture once, then builds the cards with file ids in place of URLs.
    A picture that fails is dropped with a warning; the message still posts. */
export async function resolveWebhookMedia(
  webhookId: string,
  body: WebhookMessageInput,
  deps: MediaDeps = realMediaDeps,
  deadlineMs = MEDIA_DEADLINE_MS,
): Promise<ResolvedWebhookMedia> {
  const slots = slotsFor(body);
  const warnings: PayloadWarning[] = [];
  // Keyed with the limit too, so a URL used as both an icon and an image is held to each limit.
  const keyOf = (slot: MediaSlot) => `${slot.maxBytes}\u0000${slot.url}`;
  const byUrl = new Map<string, { url: string; maxBytes: number; fileId?: string; code?: string }>();
  for (const slot of slots) byUrl.set(keyOf(slot), { url: slot.url, maxBytes: slot.maxBytes });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  let budget = MEDIA_TOTAL_MAX_BYTES;

  try {
    await inPool([...byUrl.values()], MEDIA_CONCURRENCY, async (entry) => {
      if (controller.signal.aborted) { entry.code = "timeout"; return; }
      const fetched = await deps.fetchBytes(entry.url, controller.signal, entry.maxBytes);
      if (!fetched.ok) { entry.code = fetched.code; return; }
      const format = sniffImageFormat(fetched.bytes);
      if (!format) { entry.code = "unsupported_type"; return; }
      if (fetched.bytes.length > budget) { entry.code = "media_budget"; return; }
      budget -= fetched.bytes.length;
      const checked = await validateImage(fetched.bytes, { animated: true });
      if (!checked.valid) { entry.code = "invalid_image"; return; }
      try {
        entry.fileId = await deps.storeImage(webhookId, fetched.bytes, format, checked.width, checked.height);
      } catch (err) {
        consola.warn("webhook media store failed", err);
        entry.code = "store_failed";
      }
    });
  } finally {
    clearTimeout(timer);
  }

  const fileFor = (path: string, url: string | undefined): string | undefined => {
    if (!url) return undefined;
    const slot = slots.find((s) => s.path === path)!;
    const entry = byUrl.get(keyOf(slot))!;
    if (!entry.fileId) {
      const code = entry.code ?? "fetch_failed";
      warnings.push({ path, code, message: WARNING_TEXT[code] ?? WARNING_TEXT.fetch_failed });
      return undefined;
    }
    return entry.fileId;
  };

  const avatarFileId = fileFor("avatar_url", body.avatar_url);
  const cards = (body.cards ?? []).map((card, i) => storedCard(card, i, fileFor));
  const mediaFileIds = [...new Set([avatarFileId, ...cards.flatMap(fileIdsOf)].filter((id): id is string => !!id))];
  return { avatarFileId, cards, mediaFileIds, warnings };
}

function storedCard(
  card: WebhookCardInput,
  i: number,
  fileFor: (path: string, url: string | undefined) => string | undefined,
): StoredWebhookCard {
  const out: StoredWebhookCard = {};
  if (card.title) out.title = card.title;
  if (card.url) out.url = card.url;
  if (card.description) out.description = card.description;
  const color = colorToHex(card.color);
  if (color) out.color = color;
  if (card.author) {
    const icon = fileFor(`cards[${i}].author.icon_url`, card.author.icon_url);
    out.author = { name: card.author.name, ...(card.author.url ? { url: card.author.url } : {}), ...(icon ? { icon_file_id: icon } : {}) };
  }
  if (card.fields?.length) out.fields = card.fields.map((f) => ({ name: f.name, value: f.value, inline: f.inline }));
  const thumbnail = fileFor(`cards[${i}].thumbnail_url`, card.thumbnail_url);
  if (thumbnail) out.thumbnail_file_id = thumbnail;
  const image = fileFor(`cards[${i}].image_url`, card.image_url);
  if (image) out.image_file_id = image;
  if (card.footer) {
    const icon = fileFor(`cards[${i}].footer.icon_url`, card.footer.icon_url);
    out.footer = { text: card.footer.text, ...(icon ? { icon_file_id: icon } : {}) };
  }
  if (card.timestamp) out.timestamp = new Date(card.timestamp).toISOString();
  return out;
}

function fileIdsOf(card: StoredWebhookCard): (string | undefined)[] {
  return [card.author?.icon_file_id, card.thumbnail_file_id, card.image_file_id, card.footer?.icon_file_id];
}

/** What a client that can't draw cards shows instead. Neutered so it can't ping or unfurl there. */
export function fallbackText(cards: StoredWebhookCard[]): string {
  const first = cards[0];
  const label = first?.title ?? first?.author?.name ?? (cards.length === 1 ? "Posted a card" : `Posted ${cards.length} cards`);
  const more = first?.title || first?.author?.name ? (cards.length > 1 ? ` (+${cards.length - 1} more)` : "") : "";
  return `${label}${more}`.replace(/@/g, "@\u200b").replace(/:\/\//g, ":\u200b//").slice(0, 4000);
}
