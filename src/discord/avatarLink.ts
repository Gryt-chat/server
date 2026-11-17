import { createHmac, timingSafeEqual } from "node:crypto";

import express from "express";
import sharp from "sharp";

import { getDiscordBridge, getFile, isExcludedFromBridge } from "../db";
import { waitOutOfQuarantine } from "../services/quarantineUpload";
import { getObjectAsBuffer, uploadsFolder } from "../storage";
import { MAX_INPUT_PIXELS } from "../utils/imageValidation";

/** Discord fetches a webhook's picture itself, later and from its own servers, so it needs a public link that doesn't expire. */
function base(): string | null {
  const raw = process.env.EXTERNAL_HOST?.trim();
  if (!raw) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    return u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** Keyed by the bot token, which never leaves the server: a link can't be made up, and a new token retires the old ones. */
function sign(serverUserId: string, fileId: string, key: string): string {
  return createHmac("sha256", key).update(`discord-avatar:${serverUserId}:${fileId}`).digest("base64url").slice(0, 32);
}

/** A member's picture as Discord can load it, or nothing when this server has no public https address. */
export function discordAvatarLink(serverUserId: string, fileId: string | null | undefined): string | undefined {
  const b = base();
  const key = getDiscordBridge()?.bot_token;
  if (!b || !key || !fileId) return undefined;
  return `${b}/api/discord/avatar/${encodeURIComponent(serverUserId)}/${encodeURIComponent(fileId)}/${sign(serverUserId, fileId, key)}.png`;
}

export const discordAvatarRouter = express.Router();

discordAvatarRouter.get("/:user/:file/:sig.png", (req, res, next) => {
  const { user, file, sig } = req.params as { user: string; file: string; sig: string };
  const key = getDiscordBridge()?.bot_token;
  const want = key ? Buffer.from(sign(user, file, key)) : null;
  const got = Buffer.from(sig);
  if (!want || want.length !== got.length || !timingSafeEqual(want, got) || isExcludedFromBridge("gryt", user)) {
    res.status(404).end();
    return;
  }
  void (async () => {
    const found = await getFile(file);
    // Never a file the image worker hasn't passed yet.
    const meta = found ? await waitOutOfQuarantine(file, found, getFile, 0) : null;
    const objectKey = meta && meta !== "refused" ? (meta.thumbnail_key ?? meta.s3_key) : null;
    if (!objectKey) {
      res.status(404).end();
      return;
    }
    const raw = await getObjectAsBuffer({ bucket: uploadsFolder(), key: objectKey });
    const png = await sharp(raw, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS }).resize(128, 128, { fit: "cover" }).png().toBuffer();
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(png);
  })().catch(next);
});
