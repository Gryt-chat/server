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
 * A message from a client plugin to the server plugin with the same id
 * (GRYT-939).
 *
 * **Everything arriving here was written by a member's client**, which makes
 * this and `packages/reports` the only two places on the server where a
 * stranger's bytes are parsed. They joined, so they are not anonymous, and that
 * is worth much less than it sounds — an invite is not a character reference.
 *
 * So this refuses four things before a plugin sees anything:
 *
 * - a member who is not authenticated
 * - a plugin id this server does not run, or runs and is not listening on
 * - a topic that is not a short plain routing key
 * - a payload over the cap, or one that cannot be JSON at all
 *
 * Past that the bytes are the plugin's problem, and the docs say so. There is
 * no schema here on purpose: what a plugin pair says to itself is its own
 * protocol, and a transport with opinions about the payload is a transport
 * plugin authors work around.
 */

/*
 * Per member, per plugin. Presence updates are the expected traffic and they
 * are occasional — somebody launching a game, somebody putting it down. This is
 * loose enough that a plugin polling every few seconds is fine and tight enough
 * that a client cannot use a plugin channel as an unmetered pipe into the
 * server.
 */
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
        /*
         * Authenticated first, before anything is parsed. A plugin channel is
         * not a way to reach the server without joining, and the member id is
         * what the receiving plugin is told — a message that could not say who
         * sent it would be useless to every plugin that has a reason to care.
         */
        const auth = await requireAuth(socket, payload);
        if (!auth) return;

        const pluginId = typeof payload?.pluginId === "string" ? payload.pluginId.trim() : "";
        if (!pluginId) return;

        /*
         * Refused before the rate limit is charged and before the payload is
         * measured. A client with a plugin the server does not run will send on
         * every change forever, and that is not the member misbehaving — it is
         * two halves of a pair that were never introduced.
         */
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

        /*
         * The plugin id is stamped from what was validated above, and the
         * member from the connection — never from the payload. Otherwise one
         * plugin's client half could address another plugin's server half, or
         * claim to be somebody else, and the pairing would be a suggestion.
         */
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
