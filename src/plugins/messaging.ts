/**
 * A pipe between a client plugin and the server plugin with the same id
 * (GRYT-939).
 *
 * The Minecraft-mod shape: a plugin on the client, the same plugin on the
 * server, and the server's copy is what makes everybody else's client show
 * whatever it is. Gryt carries `{ topic, data }` and stays out of the rest —
 * what a plugin pair says to itself is its own protocol, and a transport that
 * had opinions about the payload would be a transport plugin authors worked
 * around.
 *
 * ## The security note here is not the one from the other files
 *
 * Everywhere else in this folder the warning is that a plugin is trusted code
 * the operator installed. This is the opposite direction. **What arrives here
 * was written by a member's client**, which is arbitrary and
 * attacker-controllable — the same class of input as `packages/reports`, and
 * the only other place on this server where a stranger's bytes are parsed.
 *
 * They joined, so they are not anonymous. That is worth much less than it
 * sounds: an invite is not a character reference, and the natural way to write
 * a server plugin is to trust the shape of what its own client half sends.
 *
 * So the caps live here rather than in every plugin. A topic is short and
 * plain, a payload is small, and a member cannot send faster than a person
 * would. Everything past that is the plugin's to check, and the docs say so.
 *
 * ## Namespacing
 *
 * The plugin id is stamped by the caller from the connection, never read out
 * of the payload. Otherwise one plugin's client half could address another
 * plugin's server half, and the pairing would be a suggestion.
 */

import { copyForHandler, type PluginGuard } from "./guard";
import { pluginRefs } from "./refs";

/**
 * A topic is a routing key, not a message.
 *
 * Short and plain on purpose: it ends up in log lines and in a Map key, and a
 * plugin wanting to say something long has a whole payload to say it in.
 */
export const MAX_TOPIC_LENGTH = 64;
const TOPIC = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;

/**
 * How big one message may be, measured as the JSON that would be sent.
 *
 * Eight kilobytes is far more than any presence or scoreboard needs and far
 * less than a way to push a file through a channel that has none of the
 * checks the upload path has. A plugin wanting to move something large should
 * be moving a URL.
 */
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

/**
 * How deep a payload may nest.
 *
 * Eight is more than any presence or scoreboard shape needs and shallow enough
 * that nothing downstream has to survive a structure built to be walked. The
 * size cap alone does not cover this: `[[[[…]]]]` reaches thousands of levels
 * well inside eight kilobytes, and the thing that breaks is not this server —
 * it is `structuredClone` on the way to each handler, and every plugin that
 * does the obvious recursive thing with what it was handed.
 */
export const MAX_PAYLOAD_DEPTH = 8;

/**
 * How many values a payload may contain.
 *
 * Also not covered by the size cap: eight kilobytes of `{"a":1,"b":1,…}` is
 * several thousand keys, which is a payload built to be expensive rather than
 * one built to say something.
 */
export const MAX_PAYLOAD_NODES = 512;

/**
 * Keys that are not data.
 *
 * `JSON.parse` does not set a prototype from a `__proto__` key, so nothing here
 * is exploited by parsing. It is exploited by what a plugin does next: the
 * obvious way to merge an update into stored state is a deep merge, and a deep
 * merge written the obvious way walks straight into it.
 *
 * Refused rather than stripped. A plugin receiving a payload quietly missing a
 * key it sent would be a worse afternoon than one told its payload was refused,
 * and nobody sends these on purpose.
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type PayloadResult = { ok: true; bytes: number } | { ok: false; reason: string };

/**
 * Whether this payload is safe to carry, and small enough.
 *
 * **The transport checks the structure. The plugin checks the meaning.** That
 * line is where it is because a transport that validated payload *contents*
 * would be a transport plugin authors worked around — but a payload that is
 * expensive or dangerous to *handle* is not the plugin's problem to discover,
 * because by the time it discovers it, it has already handled it.
 *
 * The walk is iterative rather than recursive on purpose. A recursive check for
 * "is this too deeply nested" overflows on exactly the input it exists to
 * refuse.
 */
export function inspectPayload(data: unknown): PayloadResult {
  /*
   * Structure first, size second. `JSON.stringify` recurses internally, so a
   * deeply nested payload can throw a RangeError there — which would come back
   * as "cannot be sent as JSON" and send somebody looking for the wrong
   * problem.
   */
  const stack: { value: unknown; depth: number }[] = [{ value: data, depth: 0 }];
  let nodes = 0;

  while (stack.length > 0) {
    const { value, depth } = stack.pop() as { value: unknown; depth: number };

    nodes += 1;
    if (nodes > MAX_PAYLOAD_NODES) {
      return { ok: false, reason: `a message may contain at most ${MAX_PAYLOAD_NODES} values` };
    }

    if (typeof value === "string") {
      /* A lone surrogate is half a character. It survives JSON as an escape and
         then breaks whatever tries to render or re-encode it downstream, and
         nothing sends one by accident. */
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

    /* `Object.keys` rather than `for…in`, so an inherited key cannot be counted
       as one of this object's — and `getOwnPropertyNames` is not needed because
       anything that came through JSON has no non-enumerable ones. */
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key)) {
        return { ok: false, reason: `a message may not contain a "${key}" key` };
      }
      stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 });
    }
  }

  /*
   * Measured in bytes rather than characters, because the limit is about what
   * crosses the wire and one emoji is four of them. `JSON.stringify` throwing
   * is a circular structure, and `undefined` is what it returns for a value
   * that encodes to nothing — both are refused rather than delivered as a
   * message whose data silently vanished.
   */
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
  /**
   * Whatever the client plugin sent. **Not validated beyond its size** — this
   * is the member's own bytes and a server plugin has to check it.
   */
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
  /**
   * Send to the client halves of this plugin. Returns false when the message
   * was refused — too big, or a topic that is not one — and says why in the log.
   *
   * Not a promise: this hands the message to socket.io and returns. There is no
   * delivery to wait for and nothing useful to do about a client that is not
   * listening.
   */
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
  /* Keyed on the plugin rather than on the topic, because the first question
     asked of this is always "does anybody serve this id" — a client sending to
     a plugin the server does not run is the common case and has to be cheap. */
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

/**
 * The event a client plugin's message arrives on and leaves on. One name in
 * both directions: a plugin pair's protocol is the topic, not the event.
 */
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
