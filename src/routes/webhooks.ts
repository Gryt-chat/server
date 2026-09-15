import express from "express";
import type { NextFunction, Request, Response } from "express";

import {
  createWebhook,
  deleteWebhook,
  getWebhookByIdAndToken,
  getWebhookById,
  insertMessage,
  listAllWebhooks,
  updateWebhook,
} from "../db";
import { requireBearerToken } from "../middleware/requireBearerToken";
import { ensurePermission } from "../middleware/requirePermission";
import { visibleChannelIds } from "../services/channelPermissions";
import { fileReadVerdict } from "../services/fileAccess";
import { resolveWebhookMedia, fallbackText, realMediaDeps, type MediaDeps } from "../services/webhookMedia";
import { broadcastChatNew } from "../socket";
import { appendCachedMessage } from "../socket/utils/messageCache";
import { MESSAGE_TOO_LONG } from "../utils/messageLimits";
import { checkRateLimit, type RateLimitRule } from "../utils/rateLimiter";
import {
  WEBHOOK_LIMITS,
  problemsFrom,
  unknownKeys,
  webhookCreateSchema,
  webhookMessageSchema,
  webhookUpdateSchema,
} from "./webhookSchemas";
import type { z } from "zod";

const RL_WEBHOOK_SEND: RateLimitRule = {
  limit: 30,
  windowMs: 60_000,
  banMs: 60_000,
  scorePerAction: 1,
  maxScore: 15,
  scoreDecayMs: 2000,
};

export const webhooksRouter = express.Router();

/** Swapped in tests, which can't reach a public host. */
let mediaDeps: MediaDeps = realMediaDeps;
export function setWebhookMediaDepsForTests(deps: MediaDeps | null): void {
  mediaDeps = deps ?? realMediaDeps;
}

function invalidPayload(res: Response, error: z.ZodError): void {
  const problems = problemsFrom(error);
  // The two refusals a text-only payload could get before cards keep their old shape.
  if (problems.length === 1 && problems[0].code === "empty_message") {
    res.status(400).json({ error: "empty_message", message: "Send text, cards or both." });
    return;
  }
  if (problems.length === 1 && problems[0].path === "text" && problems[0].code === "too_long") {
    res.status(400).json(MESSAGE_TOO_LONG);
    return;
  }
  res.status(400).json({
    error: "invalid_payload",
    message: problems.length === 1 ? "The payload has 1 problem." : `The payload has ${problems.length} problems.`,
    problems,
  });
}

function displayNameFrom(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed.slice(0, WEBHOOK_LIMITS.displayName) : undefined;
}

// ── Public: incoming webhook message ─────────────────────────────
// POST /api/webhooks/:webhookId/:token
webhooksRouter.post(
  "/:webhookId/:token",
  express.json({ limit: "256kb" }),
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

        // Everything is checked before anything is fetched.
        const parsed = webhookMessageSchema.safeParse(req.body ?? {}, { reportInput: true });
        if (!parsed.success) {
          invalidPayload(res, parsed.error);
          return;
        }
        const body = parsed.data;

        const media = await resolveWebhookMedia(webhook.webhook_id, body, mediaDeps);
        const text = body.text ?? "";
        const cards = media.cards;
        const usesFallback = !text && cards.length > 0;
        const displayName = displayNameFrom(body.display_name);

        const created = await insertMessage({
          conversation_id: webhook.channel_id,
          sender_server_id: `webhook:${webhook.webhook_id}`,
          text: usesFallback ? fallbackText(cards) : text,
          attachments: null,
          reactions: null,
          reply_to_message_id: null,
          cards: cards.length > 0 ? cards : null,
          text_fallback: usesFallback,
          sender_display_name: displayName ?? null,
          sender_avatar_file_id: media.avatarFileId,
          media_file_ids: media.mediaFileIds,
        });

        // The same record history reads back, so a reload shows what the live message showed.
        const stored = {
          ...created,
          sender_nickname: displayName ?? webhook.display_name,
          sender_avatar_file_id: media.avatarFileId ?? webhook.avatar_file_id ?? undefined,
        };
        appendCachedMessage(created.conversation_id, stored);
        broadcastChatNew({ ...stored, created_at: created.created_at.toISOString() });

        res.status(200).json({
          message_id: created.message_id,
          conversation_id: created.conversation_id,
          warnings: [...unknownKeys(req.body), ...media.warnings],
        });
      })
      .catch(next);
  },
);

// ── Protected: webhook management ────────────────────────────────

/** An avatar is readable by every member, so it has to be a file the admin could
    already read. Otherwise naming an id here would publish it. */
async function mayUseAvatar(req: Request, fileId: string | null): Promise<boolean> {
  if (!fileId) return true;
  const verdict = await fileReadVerdict(fileId, req.tokenPayload?.serverUserId, req.tokenPayload?.grytUserId);
  return verdict === "allowed";
}

function requireAdmin(req: Request, res: Response): Promise<boolean> {
  return ensurePermission(req, res, "manage_webhooks");
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

        // `manage_webhooks` is not `manage_channels` and carries no rank, so
        // without this it reads the id of every hidden channel with a webhook.
        const visible = await visibleChannelIds(
          req.tokenPayload?.serverUserId,
          req.tokenPayload?.grytUserId,
        );
        const readable = webhooks.filter((w) => !w.channel_id || visible.has(w.channel_id));

        res.json({ items: readable.map((w) => ({ ...w, created_at: w.created_at.toISOString(), updated_at: w.updated_at.toISOString() })) });
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
        const parsed = webhookCreateSchema.safeParse(req.body ?? {}, { reportInput: true });
        if (!parsed.success) { invalidPayload(res, parsed.error); return; }
        const channelId = parsed.data.channel_id;
        const displayName = displayNameFrom(parsed.data.display_name) ?? "Webhook";
        const avatarFileId = parsed.data.avatar_file_id ?? null;
        if (!(await mayUseAvatar(req, avatarFileId))) { res.status(404).json({ error: "file_not_found" }); return; }

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
        const parsed = webhookUpdateSchema.safeParse(req.body ?? {}, { reportInput: true });
        if (!parsed.success) { invalidPayload(res, parsed.error); return; }
        const updates: { display_name?: string; channel_id?: string; avatar_file_id?: string | null } = {};
        if (parsed.data.display_name !== undefined) updates.display_name = parsed.data.display_name.trim().slice(0, WEBHOOK_LIMITS.displayName);
        if (parsed.data.channel_id !== undefined) updates.channel_id = parsed.data.channel_id;
        if (parsed.data.avatar_file_id !== undefined) updates.avatar_file_id = parsed.data.avatar_file_id;
        if (!(await mayUseAvatar(req, updates.avatar_file_id ?? null))) { res.status(404).json({ error: "file_not_found" }); return; }

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
