import consola from "consola";
import express from "express";
import type { Router, Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";

import { putObject, deleteObject } from "../storage";
import { requireBearerToken } from "../middleware/requireBearerToken";
import { broadcastCustomEmojisUpdate } from "../socket";
import {
  DEFAULT_EMOJI_MAX_BYTES,
  getEmoji,
  getServerConfig,
  getServerRole,
  insertEmoji,
  listEmojis,
} from "../db";
import { processEmojiToOptimizedImage } from "../utils/emojiProcessing";
import { EMOJI_NAME_RE } from "./emojiShared";

const BTTV_API = "https://api.betterttv.net/3";
const BTTV_CDN = "https://cdn.betterttv.net/emote";

interface BttvEmoteInput {
  id: string;
  code: string;
  imageType: string;
  name: string;
}

export function registerBttvRoutes(router: Router): void {
  router.get(
    "/bttv/file/:emoteId",
    (req: Request, res: Response, next: NextFunction): void => {
      const emoteId = String(req.params.emoteId);
      if (!emoteId || !/^[a-f0-9]{20,30}$/.test(emoteId)) {
        res.status(400).json({ error: "invalid_emote_id" });
        return;
      }

      Promise.resolve()
        .then(async () => {
          const cfg = await getServerConfig().catch(() => null);
          const maxEmojiBytes = cfg?.emoji_max_bytes ?? DEFAULT_EMOJI_MAX_BYTES;

          const cdnResp = await fetch(`${BTTV_CDN}/${emoteId}/3x`);
          if (!cdnResp.ok) {
            res.status(cdnResp.status).json({
              error: "bttv_cdn_fetch_failed",
              message: `CDN returned ${cdnResp.status}`,
            });
            return;
          }

          const arrayBuf = await cdnResp.arrayBuffer();
          const bytes = Buffer.from(arrayBuf);

          if (bytes.length > maxEmojiBytes) {
            res.status(413).json({
              error: "emoji_too_large",
              message: `Emoji is larger than max allowed (${maxEmojiBytes} bytes).`,
              bytes: bytes.length,
              maxBytes: maxEmojiBytes,
            });
            return;
          }

          const contentType = cdnResp.headers.get("content-type") ?? "application/octet-stream";
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Content-Length", String(bytes.length));
          res.setHeader("Content-Type", contentType);
          res.end(bytes);
        })
        .catch(next);
    },
  );

  router.get(
    "/bttv/emote/:emoteId",
    (req: Request, res: Response, next: NextFunction): void => {
      const emoteId = String(req.params.emoteId);
      if (!emoteId || !/^[a-f0-9]{20,30}$/.test(emoteId)) {
        res.status(400).json({ error: "invalid_emote_id" });
        return;
      }

      const tryFetch = async (path: string): Promise<Record<string, unknown> | null> => {
        const resp = await fetch(`${BTTV_API}${path}`);
        if (!resp.ok) return null;
        const json = await resp.json().catch(() => null);
        if (!json || typeof json !== "object") return null;
        return json as Record<string, unknown>;
      };

      Promise.resolve()
        .then(async () => {
          const data =
            (await tryFetch(`/emotes/shared/${emoteId}`)) ??
            (await tryFetch(`/emotes/${emoteId}`));

          if (!data) {
            res.status(404).json({ error: "not_found", message: "BetterTTV emote not found." });
            return;
          }

          const id = typeof data.id === "string" ? data.id : emoteId;
          const code = typeof data.code === "string" ? data.code : "";
          const imageType = typeof data.imageType === "string" ? data.imageType : "png";
          const animated =
            (typeof data.animated === "boolean")
              ? data.animated
              : imageType.toLowerCase() === "gif";

          if (!code) {
            res.status(502).json({ error: "invalid_bttv_response", message: "BetterTTV returned an invalid emote payload." });
            return;
          }

          res.json({
            emote: {
              id,
              code,
              imageType,
              animated,
            },
          });
        })
        .catch(next);
    },
  );

  router.get(
    "/bttv/user/:userId",
    (_req: Request, res: Response, next: NextFunction): void => {
      const userId = String(_req.params.userId);
      if (!userId || !/^[a-f0-9]{20,30}$/.test(userId)) {
        res.status(400).json({ error: "invalid_user_id" });
        return;
      }

      Promise.resolve()
        .then(async () => {
          const resp = await fetch(`${BTTV_API}/users/${userId}`);
          if (!resp.ok) {
            res.status(resp.status).json({ error: "bttv_fetch_failed", message: `BetterTTV returned ${resp.status}` });
            return;
          }
          const data = await resp.json();
          const channelEmotes = (data.channelEmotes || []).map((e: Record<string, unknown>) => ({
            id: e.id,
            code: e.code,
            imageType: e.imageType,
            animated: e.animated,
          }));
          const sharedEmotes = (data.sharedEmotes || []).map((e: Record<string, unknown>) => ({
            id: e.id,
            code: e.code,
            imageType: e.imageType,
            animated: e.animated,
          }));
          res.json({
            username: data.displayName || data.name,
            channelEmotes,
            sharedEmotes,
          });
        })
        .catch(next);
    },
  );

  router.post(
    "/bttv/import",
    requireBearerToken,
    express.json(),
    (req: Request, res: Response, next: NextFunction): void => {
      const serverUserId = req.tokenPayload?.serverUserId;
      if (!serverUserId) { res.status(401).json({ error: "auth_required" }); return; }

      const bucket = process.env.S3_BUCKET as string;
      if (!bucket) { res.status(500).json({ error: "s3_not_configured" }); return; }

      const emotes: BttvEmoteInput[] = req.body?.emotes;
      if (!Array.isArray(emotes) || emotes.length === 0) {
        res.status(400).json({ error: "emotes_required", message: "Provide an array of emotes to import." });
        return;
      }
      Promise.resolve()
        .then(async () => {
          const role = await getServerRole(serverUserId);
          if (role !== "owner" && role !== "admin") {
            res.status(403).json({ error: "forbidden", message: "Only admins can import emojis." });
            return;
          }

          const existingEmojis = await listEmojis();
          const usedNames = new Set(existingEmojis.map(e => e.name));
          const results: Array<{ name: string; file_id?: string; ok: boolean; error?: string; message?: string }> = [];

          for (const emote of emotes) {
            const name = emote.name?.trim();
            if (!name || !EMOJI_NAME_RE.test(name)) {
              results.push({ name: name || emote.code, ok: false, error: "invalid_name", message: "Invalid emoji name." });
              continue;
            }
            if (!emote.id || !/^[a-f0-9]{20,30}$/.test(emote.id)) {
              results.push({ name, ok: false, error: "invalid_bttv_id", message: "Invalid BetterTTV emote ID." });
              continue;
            }

            try {
              const existingEmoji = usedNames.has(name) ? await getEmoji(name) : null;
              if (existingEmoji) {
                consola.debug("[BttvImport] Replacing existing emoji:", name);
                await deleteObject({ bucket, key: existingEmoji.s3_key }).catch((e) => consola.warn("S3 delete failed", e));
              }

              const cdnResp = await fetch(`${BTTV_CDN}/${emote.id}/3x`);
              if (!cdnResp.ok) {
                results.push({ name, ok: false, error: "cdn_fetch_failed", message: `CDN returned ${cdnResp.status}` });
                continue;
              }
              const arrayBuf = await cdnResp.arrayBuffer();
              const imgBuffer = Buffer.from(arrayBuf);

              const sourceMime = emote.imageType === "gif" ? "image/gif"
                : emote.imageType === "webp" ? "image/webp"
                : "image/png";
              const { processed, ext, contentType } = await processEmojiToOptimizedImage(imgBuffer, sourceMime);

              const fileId = uuidv4();
              const key = `emojis/${name}.${ext}`;
              await putObject({ bucket, key, body: processed, contentType });
              await insertEmoji({ name, file_id: fileId, s3_key: key, uploaded_by_server_user_id: serverUserId });

              usedNames.add(name);
              results.push({ name, file_id: fileId, ok: true });
            } catch (err) {
              console.error("[BttvImport] Failed to import emote:", emote.code, err);
              results.push({ name, ok: false, error: "processing_failed", message: "Failed to process image." });
            }
          }

          const successCount = results.filter(r => r.ok).length;
          if (successCount > 0) broadcastCustomEmojisUpdate();
          res.status(successCount > 0 ? 201 : 400).json({ results });
        })
        .catch(next);
    },
  );
}
