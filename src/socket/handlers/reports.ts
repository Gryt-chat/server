import consola from "consola";
import { mayViewChannel } from "../../services/channelPermissions";
import type { HandlerContext, EventHandlerMap } from "./types";
import { requireAuth, requireOutranks, requirePermission } from "../middleware/auth";
import { evictUser, resolveGrytUserId } from "../../moderation/evict";
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
  getFilesByIds,
  insertUserReport,
  hasUserReportedUser,
  getAggregatedPendingUserReports,
  resolveUserReportsFor,
} from "../../db";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";

const RL_REPORT: RateLimitRule = { limit: 10, windowMs: 60_000, scorePerAction: 2, maxScore: 10, scoreDecayMs: 5_000 };
const RL_REPORT_ADMIN: RateLimitRule = { limit: 30, windowMs: 60_000, scorePerAction: 1, maxScore: 15, scoreDecayMs: 3_000 };

/**
 * How much a reporter may write. Required, not optional: a report with nothing
 * attached tells a moderator to go and look without saying where.
 */
const REASON_MAX = 1000;

export function registerReportHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, serverId, clientsInfo, sfuClient } = ctx;

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

        const auth = await requireAuth(socket, payload, { permission: "report_messages" });
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
          message_attachments: message.attachments,
          message_sender_server_id: message.sender_server_id,
          message_sender_nickname: senderUser?.nickname ?? null,
        });

        socket.emit("report:submitted", { messageId: payload.messageId });

        insertServerAudit({
          actorServerUserId: auth.tokenPayload.serverUserId,
          action: "message_report",
          target: payload.messageId,
          meta: { conversationId: payload.conversationId },
        }).catch((e) => consola.warn("audit log write failed", e));
      } catch (err) {
        consola.error("chat:report failed", err);
        socket.emit("chat:error", "Failed to submit report");
      }
    },

    /**
     * Report a person rather than one thing they said — somebody following you
     * between channels, whose every message is fine on its own.
     *
     * No rank check: reporting somebody who outranks you is exactly the report
     * that must not be refused. Hierarchy applies on the moderator side.
     *
     * **Nothing reaches the reported person.** No event, no marker, no error
     * naming a reason — a report that announces itself invites retaliation.
     */
    "user:report": async (payload: {
      accessToken: string;
      serverUserId: string;
      reason: string;
    }) => {
      try {
        const rl = rlCheck("user:report", RL_REPORT);
        if (!rl.allowed) {
          socket.emit("chat:error", {
            error: "rate_limited",
            retryAfterMs: rl.retryAfterMs,
            message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.`,
          });
          return;
        }

        const reason = typeof payload?.reason === "string" ? payload.reason.trim() : "";
        if (!payload?.serverUserId || !payload?.accessToken || !reason) {
          socket.emit("chat:error", "Invalid report payload");
          return;
        }
        if (reason.length > REASON_MAX) {
          socket.emit("chat:error", `Keep the reason under ${REASON_MAX} characters.`);
          return;
        }

        const auth = await requireAuth(socket, payload, { permission: "report_messages" });
        if (!auth) return;

        if (payload.serverUserId === auth.tokenPayload.serverUserId) {
          socket.emit("chat:error", "You cannot report yourself");
          return;
        }

        const target = await getUserByServerId(payload.serverUserId);
        if (!target) {
          socket.emit("chat:error", "User not found");
          return;
        }

        const alreadyReported = await hasUserReportedUser(
          payload.serverUserId,
          auth.tokenPayload.serverUserId,
        );
        if (alreadyReported) {
          socket.emit("report:user_already_reported", { serverUserId: payload.serverUserId });
          return;
        }

        await insertUserReport({
          reported_server_user_id: payload.serverUserId,
          reported_nickname: target.nickname ?? null,
          reporter_server_user_id: auth.tokenPayload.serverUserId,
          reporter_nickname: auth.tokenPayload.nickname ?? null,
          reason,
        });

        socket.emit("report:user_submitted", { serverUserId: payload.serverUserId });

        /* The reason is not written to the audit log. It is somebody's account
         * of being harassed, and the log is read by everybody holding
         * `view_audit_log` — a wider set than the reports queue's. The report
         * row is where it belongs. */
        insertServerAudit({
          actorServerUserId: auth.tokenPayload.serverUserId,
          action: "user_report",
          target: payload.serverUserId,
        }).catch((e) => consola.warn("audit log write failed", e));
      } catch (err) {
        consola.error("user:report failed", err);
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

        const auth = await requireAuth(socket, payload, { permission: "view_reports" });
        if (!auth) return;

        const aggregated = await getAggregatedPendingReports();

        /* Reports about people ride along on the same event rather than
         * getting one of their own. They are two halves of one queue, a
         * moderator opens both at once, and a separate event would have meant
         * a second round trip and a second badge counting the same worry. */
        const userReports = await getAggregatedPendingUserReports();

        // `view_reports` is not `read_messages`, so a moderator below a
        // channel's scope would otherwise read its existence and a line of what
        // was said out of the queue. Dropped rather than redacted.
        //
        // The cost: if nobody who can moderate can see the channel, nobody is
        // told about the report at all.
        const readable = await Promise.all(
          aggregated.map((r) =>
            mayViewChannel(r.conversation_id, auth.tokenPayload.serverUserId, auth.tokenPayload.grytUserId),
          ),
        );
        const visibleReports = aggregated.filter((_, i) => readable[i]);

        const allFileIds = new Set<string>();
        for (const r of visibleReports) {
          if (r.message_attachments) r.message_attachments.forEach((id) => allFileIds.add(id));
        }
        const fileMap = allFileIds.size > 0 ? await getFilesByIds([...allFileIds]) : new Map();

        socket.emit("reports:list", {
          serverId,
          userReports: userReports.map((r) => ({
            reportedServerUserId: r.reported_server_user_id,
            reportedNickname: r.reported_nickname,
            reportCount: r.report_count,
            reporters: r.reporters,
            reasons: r.reasons.map((x) => ({
              reporterServerUserId: x.reporter_server_user_id,
              reporterNickname: x.reporter_nickname,
              reason: x.reason,
              createdAt: x.created_at,
            })),
            firstReportedAt: r.first_reported_at,
            reportIds: r.report_ids,
          })),
          reports: visibleReports.map((r) => ({
            messageId: r.message_id,
            conversationId: r.conversation_id,
            messageText: r.message_text,
            attachments: r.message_attachments ?? null,
            enrichedAttachments: r.message_attachments?.map((id) => {
              const f = fileMap.get(id);
              if (!f) return { file_id: id, mime: null, size: null, original_name: null, width: null, height: null, has_thumbnail: false };
              return {
                file_id: f.file_id,
                mime: f.mime,
                size: f.size,
                original_name: f.original_name,
                width: f.width,
                height: f.height,
                has_thumbnail: !!f.thumbnail_key,
              };
            }) ?? null,
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

        const auth = await requireAuth(socket, payload, { permission: "manage_reports" });
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
          }).catch((e) => consola.warn("audit log write failed", e));

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
          }).catch((e) => consola.warn("audit log write failed", e));

          socket.emit("reports:resolved", {
            messageId: payload.messageId,
            action: "delete",
          });
        } else if (payload.action === "delete_all_and_ban") {
          if (!payload.senderServerUserId) {
            socket.emit("server:error", { error: "invalid_payload", message: "senderServerUserId required for ban." });
            return;
          }

          // This path had no hierarchy check, so the reports panel could ban
          // the owner — through a different screen than the one that refuses.
          if (!(await requireOutranks(socket, auth, payload.senderServerUserId, "ban"))) return;

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

          // Same eviction as server:ban. This used to be its own inline copy of
          // the ban-and-disconnect, which meant a ban issued from the reports
          // panel skipped whatever the real one learned to do.
          const targetGrytUserId = await resolveGrytUserId(
            clientsInfo,
            payload.senderServerUserId,
          );

          if (targetGrytUserId) {
            const banReason = "Banned via report review (all messages deleted)";
            await banUser(targetGrytUserId, auth.tokenPayload.serverUserId, banReason);
            await evictUser({
              io,
              clientsInfo,
              serverId,
              sfuClient,
              targetServerUserId: payload.senderServerUserId,
              targetGrytUserId,
              action: "ban",
              reason: banReason,
            });
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
          }).catch((e) => consola.warn("audit log write failed", e));

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

    /**
     * Close every open report about one person, with or without acting.
     *
     * `manage_reports` gets you the card, not the buttons — kicking asks for
     * `kick_members` and banning for `ban_members`, the same as the member
     * list. A queue that did more than the screen next to it is how the message
     * queue could once ban the owner.
     */
    "reports:resolve_user": async (payload: {
      accessToken: string;
      reportedServerUserId: string;
      action: "dismiss" | "kick" | "ban";
      reason?: string;
    }) => {
      try {
        const rl = rlCheck("reports:resolve_user", RL_REPORT_ADMIN);
        if (!rl.allowed) {
          socket.emit("server:error", {
            error: "rate_limited",
            retryAfterMs: rl.retryAfterMs,
            message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.`,
          });
          return;
        }

        if (!payload?.reportedServerUserId || !payload?.action || !payload?.accessToken) {
          socket.emit("server:error", { error: "invalid_payload", message: "Missing required fields." });
          return;
        }
        if (!["dismiss", "kick", "ban"].includes(payload.action)) {
          socket.emit("server:error", { error: "invalid_payload", message: "Unknown action." });
          return;
        }

        const auth = await requireAuth(socket, payload, { permission: "manage_reports" });
        if (!auth) return;

        if (payload.action === "dismiss") {
          const closed = await resolveUserReportsFor(
            payload.reportedServerUserId,
            "dismissed",
            auth.tokenPayload.serverUserId,
          );

          insertServerAudit({
            actorServerUserId: auth.tokenPayload.serverUserId,
            action: "user_report_dismiss",
            target: payload.reportedServerUserId,
            meta: { closed },
          }).catch((e) => consola.warn("audit log write failed", e));

          socket.emit("reports:user_resolved", {
            reportedServerUserId: payload.reportedServerUserId,
            action: "dismiss",
          });
          return;
        }

        const action = payload.action;
        if (!requirePermission(socket, auth, action === "ban" ? "ban_members" : "kick_members")) return;
        if (!(await requireOutranks(socket, auth, payload.reportedServerUserId, action))) return;

        /* Resolved before the eviction rather than after. Eviction disconnects
         * sockets and can throw partway through; a report left pending after
         * the person is already gone puts a card in the queue that no button
         * can clear. */
        await resolveUserReportsFor(
          payload.reportedServerUserId,
          "actioned",
          auth.tokenPayload.serverUserId,
        );

        const targetGrytUserId = await resolveGrytUserId(
          clientsInfo,
          payload.reportedServerUserId,
        );

        if (targetGrytUserId) {
          const reason =
            payload.reason?.trim()?.slice(0, REASON_MAX) ||
            (action === "ban" ? "Banned via report review" : "Kicked via report review");

          /* The ban row is written before the eviction so a reconnect cannot
           * land in the gap between the two — the same order `server:ban`
           * uses. */
          if (action === "ban") {
            await banUser(targetGrytUserId, auth.tokenPayload.serverUserId, reason);
          }

          await evictUser({
            io,
            clientsInfo,
            serverId,
            sfuClient,
            targetServerUserId: payload.reportedServerUserId,
            targetGrytUserId,
            action,
            reason,
          });
        }

        insertServerAudit({
          actorServerUserId: auth.tokenPayload.serverUserId,
          action: action === "ban" ? "user_report_ban" : "user_report_kick",
          target: payload.reportedServerUserId,
          meta: { evicted: !!targetGrytUserId },
        }).catch((e) => consola.warn("audit log write failed", e));

        socket.emit("reports:user_resolved", {
          reportedServerUserId: payload.reportedServerUserId,
          action,
        });

        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
      } catch (err) {
        consola.error("reports:resolve_user failed", err);
        socket.emit("server:error", { error: "resolve_failed", message: "Failed to resolve report." });
      }
    },
  };
}
