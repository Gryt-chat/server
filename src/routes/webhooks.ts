import express from "express";
import type { NextFunction, Request, Response } from "express";

import {
  createWebhook,
  deleteWebhook,
  getServerRole,
  getWebhookByIdAndToken,
  getWebhookById,
  insertMessage,
  listAllWebhooks,
  updateWebhook,
} from "../db";
import { requireBearerToken } from "../middleware/requireBearerToken";
import { broadcastChatNew } from "../socket";
import { checkRateLimit, type RateLimitRule } from "../utils/rateLimiter";

const RL_WEBHOOK_SEND: RateLimitRule = {
  limit: 30,
  windowMs: 60_000,
  banMs: 60_000,
  scorePerAction: 1,
  maxScore: 15,
  scoreDecayMs: 2000,
};

export const webhooksRouter = express.Router();

// ── Public: incoming webhook message ─────────────────────────────
// POST /api/webhooks/:webhookId/:token
webhooksRouter.post(
  "/:webhookId/:token",
  express.json(),
  (req: Request, res: Response, next: NextFunction): void => {
    const { webhookId, token } = req.params as { webhookId: string; token: string };
    Promise.resolve()
      .then(async () => {
        const rl = checkRateLimit("webhook:send", webhookId, webhookId, RL_WEBHOOK_SEND);
        if (!rl.allowed) {
          res.status(429).json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs });
          return;
        }

        const webhook = await getWebhookByIdAndToken(webhookId, token);
        if (!webhook) {
          res.status(404).json({ error: "not_found", message: "Unknown webhook." });
          return;
        }

        if (!webhook.channel_id) {
          res.status(400).json({ error: "no_channel", message: "Webhook has no channel configured." });
          return;
        }

        const body = req.body as Record<string, unknown> | undefined;
        const text = typeof body?.text === "string" ? body.text.trim() : "";
        if (!text) {
          res.status(400).json({ error: "empty_message", message: "Message text is required." });
          return;
        }
        if (text.length > 4000) {
          res.status(400).json({ error: "message_too_long", message: "Max 4000 characters." });
          return;
        }

        const displayName = typeof body?.display_name === "string" && body.display_name.trim()
          ? body.display_name.trim().slice(0, 64)
          : webhook.display_name;

        const senderServerId = `webhook:${webhook.webhook_id}`;

        const created = await insertMessage({
          conversation_id: webhook.channel_id,
          sender_server_id: senderServerId,
          text,
          attachments: null,
          reactions: null,
          reply_to_message_id: null,
        });

        const enriched = {
          ...created,
          created_at: created.created_at.toISOString(),
          sender_nickname: displayName,
          sender_avatar_file_id: webhook.avatar_file_id ?? undefined,
        };

        broadcastChatNew(enriched);

        res.status(200).json({
          message_id: created.message_id,
          conversation_id: created.conversation_id,
        });
      })
      .catch(next);
  },
);

// ── Protected: webhook management ────────────────────────────────

function requireAdmin(req: Request, res: Response): Promise<boolean> {
  const serverUserId = req.tokenPayload?.serverUserId;
  if (!serverUserId) {
    res.status(401).json({ error: "auth_required" });
    return Promise.resolve(false);
  }
  return getServerRole(serverUserId).then((role) => {
    if (role !== "owner" && role !== "admin") {
      res.status(403).json({ error: "forbidden", message: "Only admins can manage webhooks." });
      return false;
    }
    return true;
  });
}

// GET /api/webhooks
webhooksRouter.get(
  "/",
  requireBearerToken,
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve()
      .then(async () => {
        if (!await requireAdmin(req, res)) return;
        const webhooks = await listAllWebhooks();
        res.json({ items: webhooks.map((w) => ({ ...w, created_at: w.created_at.toISOString(), updated_at: w.updated_at.toISOString() })) });
      })
      .catch(next);
  },
);

// POST /api/webhooks (create)
webhooksRouter.post(
  "/",
  requireBearerToken,
  express.json(),
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve()
      .then(async () => {
        if (!await requireAdmin(req, res)) return;
        const body = req.body as Record<string, unknown> | undefined;
        const channelId = typeof body?.channel_id === "string" ? body.channel_id.trim() : "";
        const displayName = typeof body?.display_name === "string" && body.display_name.trim()
          ? body.display_name.trim().slice(0, 64)
          : "Webhook";
        const avatarFileId = typeof body?.avatar_file_id === "string" ? body.avatar_file_id : null;

        const serverUserId = req.tokenPayload!.serverUserId;
        const webhook = await createWebhook(channelId, displayName, serverUserId, avatarFileId);
        const host = req.headers.host || "localhost";
        const proto = req.protocol || "http";
        const url = `${proto}://${host}/api/webhooks/${webhook.webhook_id}/${webhook.token}`;

        res.status(201).json({
          ...webhook,
          created_at: webhook.created_at.toISOString(),
          updated_at: webhook.updated_at.toISOString(),
          url,
        });
      })
      .catch(next);
  },
);

// GET /api/webhooks/:webhookId (details)
webhooksRouter.get(
  "/:webhookId",
  requireBearerToken,
  (req: Request, res: Response, next: NextFunction): void => {
    const { webhookId } = req.params as { webhookId: string };
    Promise.resolve()
      .then(async () => {
        if (!await requireAdmin(req, res)) return;
        const webhook = await getWebhookById(webhookId);
        if (!webhook) { res.status(404).json({ error: "not_found" }); return; }
        const host = req.headers.host || "localhost";
        const proto = req.protocol || "http";
        const url = `${proto}://${host}/api/webhooks/${webhook.webhook_id}/${webhook.token}`;
        res.json({ ...webhook, created_at: webhook.created_at.toISOString(), updated_at: webhook.updated_at.toISOString(), url });
      })
      .catch(next);
  },
);

// PATCH /api/webhooks/:webhookId (update)
webhooksRouter.patch(
  "/:webhookId",
  requireBearerToken,
  express.json(),
  (req: Request, res: Response, next: NextFunction): void => {
    const { webhookId } = req.params as { webhookId: string };
    Promise.resolve()
      .then(async () => {
        if (!await requireAdmin(req, res)) return;
        const body = req.body as Record<string, unknown> | undefined;
        const updates: { display_name?: string; channel_id?: string; avatar_file_id?: string | null } = {};
        if (typeof body?.display_name === "string") updates.display_name = body.display_name.trim().slice(0, 64);
        if (typeof body?.channel_id === "string") updates.channel_id = body.channel_id;
        if (body?.avatar_file_id === null) updates.avatar_file_id = null;
        else if (typeof body?.avatar_file_id === "string") updates.avatar_file_id = body.avatar_file_id;

        const updated = await updateWebhook(webhookId, updates);
        if (!updated) { res.status(404).json({ error: "not_found" }); return; }
        res.json({ ...updated, created_at: updated.created_at.toISOString(), updated_at: updated.updated_at.toISOString() });
      })
      .catch(next);
  },
);

// DELETE /api/webhooks/:webhookId
webhooksRouter.delete(
  "/:webhookId",
  requireBearerToken,
  (req: Request, res: Response, next: NextFunction): void => {
    const { webhookId } = req.params as { webhookId: string };
    Promise.resolve()
      .then(async () => {
        if (!await requireAdmin(req, res)) return;
        const deleted = await deleteWebhook(webhookId);
        if (!deleted) { res.status(404).json({ error: "not_found" }); return; }
        res.json({ ok: true });
      })
      .catch(next);
  },
);
