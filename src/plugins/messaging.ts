/**
 * A pipe between a client plugin and the server plugin with the same id. Unlike
 * the rest of this folder, what arrives here is a member's own bytes.
 */

import { copyForHandler, type PluginGuard } from "./guard";
import { pluginRefs } from "./refs";

/** A routing key, not a message: it ends up in log lines and a Map key. */
export const MAX_TOPIC_LENGTH = 64;
const TOPIC = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;

/** More than a presence or scoreboard needs, and far less than a way to push a
    file past the upload path's checks. */
export const MAX_PAYLOAD_BYTES = 8 * 1024;

export type TopicResult = { ok: true; topic: string } | { ok: false; reason: string };

/** Pure, so the rule can be read and tested without a socket. */
export function readTopic(value: unknown): TopicResult {
  if (typeof value !== "string") return { ok: false, reason: "a topic is required" };
  const topic = value.trim();
  if (!topic) return { ok: false, reason: "a topic is required" };
  if (topic.length > MAX_TOPIC_LENGTH) {
    return { ok: false, reason: `a topic may be at most ${MAX_TOPIC_LENGTH} characters` };
  }
  if (!TOPIC.test(topic)) {
    return {
      ok: false,
      reason: "a topic may contain letters, digits, dot, dash, colon and underscore, starting with a letter or digit",
    };
  }
  return { ok: true, topic };
}

/** Not covered by the size cap: `[[[[…]]]]` reaches thousands of levels inside
    eight kilobytes, and breaks `structuredClone` on the way to each handler. */
export const MAX_PAYLOAD_DEPTH = 8;

/** Also not covered by the size cap: eight kilobytes of `{"a":1,"b":1,…}` is
    several thousand keys. */
export const MAX_PAYLOAD_NODES = 512;

/** Not exploited by parsing but by what a plugin does next: the obvious deep
    merge walks into it. Refused rather than stripped. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type PayloadResult = { ok: true; bytes: number } | { ok: false; reason: string };

/** Structure only; the plugin checks the meaning. Iterative on purpose: a
    recursive depth check overflows on exactly the input it refuses. */
export function inspectPayload(data: unknown): PayloadResult {
  /* Structure first: `JSON.stringify` recurses, so a deep payload throws a
     RangeError that reads as "cannot be sent as JSON". */
  const stack: { value: unknown; depth: number }[] = [{ value: data, depth: 0 }];
  let nodes = 0;

  while (stack.length > 0) {
    const { value, depth } = stack.pop() as { value: unknown; depth: number };

    nodes += 1;
    if (nodes > MAX_PAYLOAD_NODES) {
      return { ok: false, reason: `a message may contain at most ${MAX_PAYLOAD_NODES} values` };
    }

    if (typeof value === "string") {
      /* A lone surrogate survives JSON as an escape and breaks whatever
         re-encodes it downstream. Nothing sends one by accident. */
      if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) {
        return { ok: false, reason: "that payload contains malformed text" };
      }
      continue;
    }

    if (value === null || typeof value !== "object") continue;

    if (depth >= MAX_PAYLOAD_DEPTH) {
      return { ok: false, reason: `a message may nest at most ${MAX_PAYLOAD_DEPTH} deep` };
    }

    if (Array.isArray(value)) {
      for (const entry of value) stack.push({ value: entry, depth: depth + 1 });
      continue;
    }

    /* `Object.keys`, not `for…in`, so an inherited key is not counted as one of
       this object's. */
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key)) {
        return { ok: false, reason: `a message may not contain a "${key}" key` };
      }
      stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 });
    }
  }

  /* Bytes, not characters: one emoji is four. A throw is a circular structure
     and `undefined` encodes to nothing; both refused rather than delivered. */
  let json: string | undefined;
  try {
    json = JSON.stringify(data);
  } catch {
    return { ok: false, reason: "that payload cannot be sent as JSON" };
  }
  if (json === undefined) {
    return { ok: false, reason: "that payload cannot be sent as JSON" };
  }

  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_PAYLOAD_BYTES) {
    return { ok: false, reason: `a message may be at most ${MAX_PAYLOAD_BYTES} bytes` };
  }
  return { ok: true, bytes };
}


/** What a server plugin receives. */
export interface IncomingPluginMessage {
  topic: string;
  /** Not validated beyond its size: a member's own bytes, and the plugin's to
      check. */
  data: unknown;
  /** Who sent it, as their id on this server. */
  userId: string;
  nickname: string | null;
}

export type PluginMessageHandler = (message: IncomingPluginMessage) => void | Promise<void>;

/** Where an outgoing message goes. */
export type SendTarget =
  /** Everybody connected. The default, and what a presence plugin wants. */
  | "everyone"
  /** These members, by their id on this server. Silently skips anybody offline. */
  | readonly string[];

export interface PluginMessaging {
  /** Hear what the client half of this plugin sends. */
  on(topic: string, handler: PluginMessageHandler): void;
  /** False when refused, with the reason in the log. Not a promise: there is no
      delivery to wait for. */
  send(topic: string, data: unknown, target?: SendTarget): boolean;
}

export interface MessageBusLogger {
  warn(message: string): void;
}

export interface PluginMessageBus {
  subscribe(pluginId: string, topic: string, handler: PluginMessageHandler): void;
  /** One message in from a client. Returns whether any plugin was listening. */
  deliver(pluginId: string, message: IncomingPluginMessage): boolean;
  /** Whether any loaded plugin is listening for this id at all. */
  isListening(pluginId: string): boolean;
  remove(pluginId: string): void;
  stats(): { plugins: string[]; subscriptions: number };
}

interface Subscription {
  pluginId: string;
  topic: string;
  handler: PluginMessageHandler;
}

export function createMessageBus(guard: PluginGuard): PluginMessageBus {
  /* Keyed on the plugin, not the topic: "does anybody serve this id" is the
     first question and the common answer is no. */
  const byPlugin = new Map<string, Subscription[]>();

  function remove(pluginId: string): void {
    byPlugin.delete(pluginId);
  }

  guard.onDisable(remove);

  return {
    subscribe(pluginId, topic, handler) {
      if (guard.isDisabled(pluginId)) return;
      const list = byPlugin.get(pluginId) ?? [];
      list.push({ pluginId, topic, handler });
      byPlugin.set(pluginId, list);
    },

    deliver(pluginId, message) {
      const list = byPlugin.get(pluginId);
      if (!list || list.length === 0) return false;

      /* Copied before iterating, because a handler may subscribe or be disabled
         during the loop. */
      let delivered = false;
      for (const sub of [...list]) {
        if (sub.topic !== message.topic) continue;
        delivered = true;
        guard.call(pluginId, `message ${message.topic}`, () =>
          sub.handler(copyForHandler(message)),
        );
      }
      return delivered;
    },

    isListening: (pluginId) => (byPlugin.get(pluginId)?.length ?? 0) > 0,

    remove,

    stats() {
      let count = 0;
      for (const list of byPlugin.values()) count += list.length;
      return { plugins: [...byPlugin.keys()].sort(), subscriptions: count };
    },
  };
}

/** One name in both directions: a plugin pair's protocol is the topic. */
export const PLUGIN_MESSAGE_EVENT = "plugin:message";

/** Build the API object handed to one plugin. */
export function createMessaging(
  pluginId: string,
  bus: PluginMessageBus,
  logger: MessageBusLogger,
): PluginMessaging {
  return {
    on(topic, handler) {
      const parsed = readTopic(topic);
      if (!parsed.ok) {
        /* Thrown rather than ignored. A subscription to a topic that can never
           be sent is silence a plugin author would spend an afternoon on. */
        throw new Error(`plugin ${pluginId} subscribed to an invalid topic: ${parsed.reason}`);
      }
      bus.subscribe(pluginId, parsed.topic, handler);
    },

    send(topic, data, target = "everyone") {
      const refs = pluginRefs();
      if (!refs) {
        logger.warn(`plugin ${pluginId} sent a message before the server was accepting connections`);
        return false;
      }

      const parsed = readTopic(topic);
      if (!parsed.ok) {
        logger.warn(`plugin ${pluginId} tried to send on an invalid topic: ${parsed.reason}`);
        return false;
      }

      const size = inspectPayload(data);
      if (!size.ok) {
        logger.warn(`plugin ${pluginId} tried to send a message it cannot: ${size.reason}`);
        return false;
      }

      const wanted = target === "everyone" ? null : new Set(target);
      const envelope = { pluginId, topic: parsed.topic, data };

      for (const [clientId, ci] of Object.entries(refs.clientsInfo)) {
        /* Somebody mid-join has a temporary id and no member behind it yet. */
        if (!ci.serverUserId || ci.serverUserId.startsWith("temp_")) continue;
        if (wanted && !wanted.has(ci.serverUserId)) continue;
        refs.io.sockets.sockets.get(clientId)?.emit(PLUGIN_MESSAGE_EVENT, envelope);
      }

      return true;
    },
  };
}
