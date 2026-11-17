/* eslint-disable @typescript-eslint/no-restricted-types -- the request body is outside input, checked field by field below */
import express from "express";
import type { NextFunction, Request, Response } from "express";

import { clearDiscordBridge, getDiscordBridge, saveDiscordBridgeApp } from "../db";
import { applicationIdForToken, inviteUrl, startDiscordBridge, startDiscordCopy, stopDiscordBridge } from "../discord/bridge";
import { isSnowflake } from "../import/discord/dce";
import { requireBearerToken } from "../middleware/requireBearerToken";
import { requireOwner } from "./discordImport";

const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

/** The token never leaves the server once it's pasted. */
function view() {
  const b = getDiscordBridge();
  if (!b) return { configured: false };
  return {
    configured: true,
    applicationId: b.application_id,
    status: b.status,
    guild: b.guild_id ? { id: b.guild_id, name: b.guild_name } : null,
    inviteUrl: inviteUrl(b.application_id),
    direction: b.direction,
    copy: { status: b.copy_status, progress: b.copy_progress },
  };
}

export const discordBridgeRouter = express.Router();

discordBridgeRouter.use(requireBearerToken);
discordBridgeRouter.use((req, res, next) => {
  requireOwner(req, res, next).catch(next);
});

discordBridgeRouter.get("/", handle(async (_req, res) => {
  res.json(view());
}));

discordBridgeRouter.put("/", handle(async (req, res) => {
  const body = (req.body ?? {}) as { applicationId?: unknown; botToken?: unknown };
  const applicationId = typeof body.applicationId === "string" ? body.applicationId.trim() : "";
  const botToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
  if (!isSnowflake(applicationId) || !botToken || botToken.length > 200) {
    res.status(400).json({ error: "invalid_payload", message: "Paste the application ID and the bot token from the Discord Developer Portal." });
    return;
  }
  const owner = await applicationIdForToken(botToken);
  if (!owner) {
    res.status(400).json({ error: "token_invalid", message: "Discord didn't accept that bot token. Reset it under Bot and paste the new one." });
    return;
  }
  if (owner !== applicationId) {
    res.status(400).json({ error: "app_mismatch", message: "That token belongs to a different application than the ID you pasted." });
    return;
  }
  saveDiscordBridgeApp(applicationId, botToken);
  void startDiscordBridge();
  res.json(view());
}));

const DIRECTIONS = new Set(["to_gryt", "both", "to_discord"]);

discordBridgeRouter.post("/copy", handle(async (req, res) => {
  const direction = (req.body as { direction?: unknown } | undefined)?.direction;
  const serverUserId = req.tokenPayload?.serverUserId;
  if (typeof direction !== "string" || !DIRECTIONS.has(direction) || !serverUserId) {
    res.status(400).json({ error: "invalid_payload", message: "Pick which way the bridge goes." });
    return;
  }
  if (getDiscordBridge()?.status !== "linked") {
    res.status(409).json({ error: "not_linked", message: "Add the bot to your Discord server first." });
    return;
  }
  startDiscordCopy(direction as "to_gryt" | "both" | "to_discord", serverUserId);
  res.status(202).json(view());
}));

discordBridgeRouter.delete("/", handle(async (_req, res) => {
  await stopDiscordBridge();
  clearDiscordBridge();
  res.json(view());
}));
