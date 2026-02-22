import consola from "consola";
import type { HandlerContext, EventHandlerMap } from "./types";
import { requireAuth } from "../middleware/auth";
import { syncAllClients, broadcastMemberList } from "../utils/clients";
import {
  getMessageById,
  getUserByServerId,
  insertReport,
  getAggregatedPendingReports,
  resolveAllReportsForMessage,
  deleteMessage,
  deleteAllMessagesByUser,
  hasUserReportedMessage,
  insertServerAudit,
  banUser,
} from "../../db/scylla";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";

const RL_REPORT: RateLimitRule = { limit: 10, windowMs: 60_000, scorePerAction: 2, maxScore: 10, scoreDecayMs: 5_000 };
const RL_REPORT_ADMIN: RateLimitRule = { limit: 30, windowMs: 60_000, scorePerAction: 1, maxScore: 15, scoreDecayMs: 3_000 };

export function registerReportHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, serverId, clientsInfo } = ctx;

  function rlCheck(event: string, rule: RateLimitRule) {
    const ip = ctx.getClientIp();
    const userId = clientsInfo[clientId]?.serverUserId;
    return checkRateLimit(event, userId, ip, rule);
  }

  return {
    "chat:report": async (payload: {
      accessToken: string;
      conversationId: string;
      messageId: string;
    }) => {
      try {
        const rl = rlCheck("chat:report", RL_REPORT);
        if (!rl.allowed) {
          socket.emit("chat:error", {
            error: "rate_limited",
            retryAfterMs: rl.retryAfterMs,
            message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.`,
          });
          return;
        }

        if (!payload?.conversationId || !payload?.messageId || !payload?.accessToken) {
          socket.emit("chat:error", "Invalid report payload");
          return;
        }

        const auth = await requireAuth(socket, payload);
        if (!auth) return;

        const message = await getMessageById(payload.conversationId, payload.messageId);
        if (!message) {
          socket.emit("chat:error", "Message not found");
          return;
        }

        if (message.sender_server_id === auth.tokenPayload.serverUserId) {
          socket.emit("chat:error", "You cannot report your own message");
          return;
        }

        const alreadyReported = await hasUserReportedMessage(
          payload.messageId,
          auth.tokenPayload.serverUserId,
        );
        if (alreadyReported) {
          socket.emit("report:already_reported", { messageId: payload.messageId });
          return;
        }

        const senderUser = await getUserByServerId(message.sender_server_id);

        await insertReport({
          message_id: message.message_id,
          conversation_id: message.conversation_id,
          reporter_server_user_id: auth.tokenPayload.serverUserId,
          message_text: message.text,
          message_sender_server_id: message.sender_server_id,
          message_sender_nickname: senderUser?.nickname ?? null,
        });

        socket.emit("report:submitted", { messageId: payload.messageId });

        insertServerAudit({
          actorServerUserId: auth.tokenPayload.serverUserId,
          action: "message_report",
          target: payload.messageId,
          meta: { conversationId: payload.conversationId },
        }).catch(() => undefined);
      } catch (err) {
        consola.error("chat:report failed", err);
        socket.emit("chat:error", "Failed to submit report");
      }
    },

    "reports:list": async (payload: { accessToken: string }) => {
      try {
        const rl = rlCheck("reports:list", RL_REPORT_ADMIN);
        if (!rl.allowed) {
          socket.emit("server:error", {
            error: "rate_limited",
            retryAfterMs: rl.retryAfterMs,
            message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.`,
          });
          return;
        }

        const auth = await requireAuth(socket, payload, { requiredRole: "admin" });
        if (!auth) return;

        const aggregated = await getAggregatedPendingReports();
        socket.emit("reports:list", {
          serverId,
          reports: aggregated.map((r) => ({
            messageId: r.message_id,
            conversationId: r.conversation_id,
            messageText: r.message_text,
            senderServerUserId: r.message_sender_server_id,
            senderNickname: r.message_sender_nickname,
            reportCount: r.report_count,
            reporters: r.reporters,
            firstReportedAt: r.first_reported_at,
            reportIds: r.report_ids,
          })),
        });
      } catch (err) {
        consola.error("reports:list failed", err);
        socket.emit("server:error", { error: "reports_failed", message: "Failed to load reports." });
      }
    },

    "reports:resolve": async (payload: {
      accessToken: string;
      messageId: string;
      conversationId: string;
      action: "approve" | "delete" | "delete_all_and_ban";
      senderServerUserId?: string;
    }) => {
      try {
        const rl = rlCheck("reports:resolve", RL_REPORT_ADMIN);
        if (!rl.allowed) {
          socket.emit("server:error", {
            error: "rate_limited",
            retryAfterMs: rl.retryAfterMs,
            message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.`,
          });
          return;
        }

        if (!payload?.messageId || !payload?.action || !payload?.accessToken) {
          socket.emit("server:error", { error: "invalid_payload", message: "Missing required fields." });
          return;
        }

        const auth = await requireAuth(socket, payload, { requiredRole: "admin" });
        if (!auth) return;

        if (payload.action === "approve") {
          await resolveAllReportsForMessage(
            payload.messageId,
            "approved",
            auth.tokenPayload.serverUserId,
          );

          insertServerAudit({
            actorServerUserId: auth.tokenPayload.serverUserId,
            action: "report_approve",
            target: payload.messageId,
          }).catch(() => undefined);

          socket.emit("reports:resolved", {
            messageId: payload.messageId,
            action: "approve",
          });
        } else if (payload.action === "delete") {
          await resolveAllReportsForMessage(
            payload.messageId,
            "deleted",
            auth.tokenPayload.serverUserId,
          );
          await deleteMessage(payload.conversationId, payload.messageId);

          io.emit("chat:deleted", {
            conversation_id: payload.conversationId,
            message_id: payload.messageId,
          });

          insertServerAudit({
            actorServerUserId: auth.tokenPayload.serverUserId,
            action: "report_delete",
            target: payload.messageId,
            meta: { conversationId: payload.conversationId },
          }).catch(() => undefined);

          socket.emit("reports:resolved", {
            messageId: payload.messageId,
            action: "delete",
          });
        } else if (payload.action === "delete_all_and_ban") {
          if (!payload.senderServerUserId) {
            socket.emit("server:error", { error: "invalid_payload", message: "senderServerUserId required for ban." });
            return;
          }

          await resolveAllReportsForMessage(
            payload.messageId,
            "deleted",
            auth.tokenPayload.serverUserId,
          );

          const deletedMessages = await deleteAllMessagesByUser(payload.senderServerUserId);

          // Also resolve any other pending reports about this user's messages
          const allPending = await getAggregatedPendingReports();
          for (const report of allPending) {
            if (report.message_sender_server_id === payload.senderServerUserId) {
              await resolveAllReportsForMessage(
                report.message_id,
                "deleted",
                auth.tokenPayload.serverUserId,
              );
            }
          }

          // Broadcast deletions to all clients
          for (const del of deletedMessages) {
            io.emit("chat:deleted", {
              conversation_id: del.conversation_id,
              message_id: del.message_id,
            });
          }

          // Also broadcast a bulk purge event so clients can do a full refresh
          const affectedConversations = [...new Set(deletedMessages.map((d) => d.conversation_id))];
          io.emit("chat:purge_user", {
            sender_server_user_id: payload.senderServerUserId,
            affected_conversations: affectedConversations,
          });

          // Ban the user
          let targetGrytUserId: string | undefined;
          for (const ci of Object.values(clientsInfo)) {
            if (ci.serverUserId === payload.senderServerUserId && ci.grytUserId) {
              targetGrytUserId = ci.grytUserId;
              break;
            }
          }
          if (!targetGrytUserId) {
            const senderUser = await getUserByServerId(payload.senderServerUserId);
            targetGrytUserId = senderUser?.gryt_user_id;
          }

          if (targetGrytUserId) {
            await banUser(
              targetGrytUserId,
              auth.tokenPayload.serverUserId,
              "Banned via report review (all messages deleted)",
            );

            // Disconnect the banned user
            for (const [sid, s] of io.sockets.sockets) {
              const ci = clientsInfo[sid];
              if (ci?.serverUserId === payload.senderServerUserId) {
                (s as any).emit("server:kicked", { reason: "You were banned from the server." });
                s.disconnect(true);
              }
            }
          }

          insertServerAudit({
            actorServerUserId: auth.tokenPayload.serverUserId,
            action: "report_delete_all_and_ban",
            target: payload.senderServerUserId,
            meta: {
              deletedCount: deletedMessages.length,
              affectedConversations,
              banned: !!targetGrytUserId,
            },
          }).catch(() => undefined);

          socket.emit("reports:resolved", {
            messageId: payload.messageId,
            action: "delete_all_and_ban",
            deletedCount: deletedMessages.length,
          });

          syncAllClients(io, clientsInfo);
          broadcastMemberList(io, clientsInfo, serverId);
        }
      } catch (err) {
        consola.error("reports:resolve failed", err);
        socket.emit("server:error", { error: "resolve_failed", message: "Failed to resolve report." });
      }
    },
  };
}
