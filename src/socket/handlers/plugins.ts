import consola from "consola";

import { pluginMessages } from "../../plugins";
import {
  MAX_PAYLOAD_BYTES,
  PLUGIN_MESSAGE_EVENT,
  inspectPayload,
  readTopic,
} from "../../plugins/messaging";
import { checkRateLimit, type RateLimitRule } from "../../utils/rateLimiter";
import { requireAuth } from "../middleware/auth";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * Everything arriving here was written by a member's client. Checks the sender,
 * the plugin id, the topic and the payload size, and nothing about the shape.
 */

/* Per member, per plugin. Loose enough for a plugin polling every few seconds,
   tight enough that a plugin channel is not an unmetered pipe. */
const RL_PLUGIN_MESSAGE: RateLimitRule = {
  limit: 30,
  windowMs: 10_000,
  scorePerAction: 0.5,
  maxScore: 10,
  scoreDecayMs: 2_000,
};

interface PluginMessagePayload {
  accessToken?: string;
  pluginId?: unknown;
  topic?: unknown;
  data?: unknown;
}

export function registerPluginHandlers(ctx: HandlerContext): EventHandlerMap {
  const { socket, clientId, clientsInfo } = ctx;

  return {
    [PLUGIN_MESSAGE_EVENT]: async (payload: PluginMessagePayload) => {
      try {
        /* Before anything is parsed: a plugin channel is not a way to reach the
           server without joining, and the plugin is told who sent it. */
        const auth = await requireAuth(socket, payload);
        if (!auth) return;

        const pluginId = typeof payload?.pluginId === "string" ? payload.pluginId.trim() : "";
        if (!pluginId) return;

        /* Before the rate limit is charged: a client with a plugin the server
           does not run sends forever, and that is not the member misbehaving. */
        const bus = pluginMessages();
        if (!bus.isListening(pluginId)) return;

        const rl = checkRateLimit(
          `plugin:message:${pluginId}`,
          auth.tokenPayload.serverUserId,
          undefined,
          RL_PLUGIN_MESSAGE,
        );
        if (!rl.allowed) {
          socket.emit("plugin:error", {
            error: "rate_limited",
            pluginId,
            retryAfterMs: rl.retryAfterMs,
            message: "Too many plugin messages. Slow down.",
          });
          return;
        }

        const topic = readTopic(payload?.topic);
        if (!topic.ok) {
          socket.emit("plugin:error", { error: "invalid_topic", pluginId, message: topic.reason });
          return;
        }

        const size = inspectPayload(payload?.data);
        if (!size.ok) {
          socket.emit("plugin:error", {
            error: "invalid_payload",
            pluginId,
            limit: MAX_PAYLOAD_BYTES,
            message: size.reason,
          });
          return;
        }

        /* Both stamped by the caller, never read from the payload, or one
           plugin's client half could address another's server half. */
        bus.deliver(pluginId, {
          topic: topic.topic,
          data: payload?.data,
          userId: auth.tokenPayload.serverUserId,
          nickname: clientsInfo[clientId]?.nickname ?? null,
        });
      } catch (err) {
        consola.error("plugin:message failed", err);
      }
    },
  };
}
