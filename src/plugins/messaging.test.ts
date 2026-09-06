import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import { createPluginGuard, FAILURES_BEFORE_DISABLE, type GuardLogger } from "./guard";
import {
  MAX_PAYLOAD_BYTES,
  MAX_TOPIC_LENGTH,
  createMessageBus,
  createMessaging,
  measurePayload,
  readTopic,
  type IncomingPluginMessage,
} from "./messaging";
import { clearPluginRefs, setPluginRefs } from "./refs";
import type { Clients } from "../types";

/**
 * The pipe between a client plugin and the server plugin with the same id
 * (GRYT-939).
 *
 * The security question here points the other way from the rest of this folder.
 * Everywhere else the note is that a plugin is code the operator installed and
 * trusts. What arrives *here* was written by a member's client — arbitrary and
 * attacker-controllable, the same class of input as `packages/reports`.
 *
 * So the cases that matter are the ones a plugin author would not think to
 * write: a payload nobody could send, a topic that is not one, and one plugin
 * addressing another's half.
 */

function recorder(): GuardLogger & { warns: string[]; errors: string[] } {
  const warns: string[] = [];
  const errors: string[] = [];
  return { warns, errors, warn: (m) => warns.push(m), error: (m) => errors.push(m) };
}

const message = (over: Partial<IncomingPluginMessage> = {}): IncomingPluginMessage => ({
  topic: "presence",
  data: { playing: "Factorio" },
  userId: "user_1",
  nickname: "Sivert",
  ...over,
});

/* ── topics ─────────────────────────────────────────────────────────────── */

describe("a topic", () => {
  it("is kept when it is a plain routing key", () => {
    for (const topic of ["presence", "score.update", "a", "game:started", "x_y-z", "A1"]) {
      assert.deepEqual(readTopic(topic), { ok: true, topic }, `refused ${topic}`);
    }
  });

  it("is trimmed rather than refused for whitespace around it", () => {
    assert.deepEqual(readTopic("  presence  "), { ok: true, topic: "presence" });
  });

  it("is refused when it is not a string, or is empty", () => {
    for (const junk of [undefined, null, 42, {}, [], "", "   "]) {
      assert.equal(readTopic(junk).ok, false, `allowed ${JSON.stringify(junk)}`);
    }
  });

  /* It ends up in a log line and a Map key. A plugin with something long to say
     has a whole payload to say it in. */
  it("is refused when it is too long", () => {
    assert.equal(readTopic("x".repeat(MAX_TOPIC_LENGTH)).ok, true);
    assert.equal(readTopic("x".repeat(MAX_TOPIC_LENGTH + 1)).ok, false);
  });

  it("is refused when it carries anything that is not a routing key", () => {
    for (const topic of ["with space", "new\nline", "slash/es", "quote\"s", "emoji🎧", "-leading"]) {
      assert.equal(readTopic(topic).ok, false, `allowed ${JSON.stringify(topic)}`);
    }
  });

  it("says why, so a plugin author is not guessing", () => {
    const long = readTopic("x".repeat(MAX_TOPIC_LENGTH + 1));
    assert.match(long.ok === false ? long.reason : "", new RegExp(String(MAX_TOPIC_LENGTH)));
  });
});

/* ── payloads ───────────────────────────────────────────────────────────── */

describe("a payload", () => {
  it("is measured as the bytes that would cross the wire", () => {
    const result = measurePayload({ a: "b" });
    assert.ok(result.ok);
    assert.equal(result.bytes, JSON.stringify({ a: "b" }).length);
  });

  /* One emoji is four bytes and one character. Measuring characters would let a
     payload through at four times the cap. */
  it("counts bytes, not characters", () => {
    const emoji = measurePayload("🎧".repeat(MAX_PAYLOAD_BYTES / 4));
    assert.equal(emoji.ok, false, "a payload of emoji got through on its character count");
  });

  it("refuses one over the cap", () => {
    assert.equal(measurePayload("x".repeat(MAX_PAYLOAD_BYTES - 10)).ok, true);
    assert.equal(measurePayload("x".repeat(MAX_PAYLOAD_BYTES + 1)).ok, false);
  });

  /* Both would otherwise arrive as a message whose data had silently vanished,
     which is worse than a refusal because the plugin runs. */
  it("refuses one that cannot be JSON", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.equal(measurePayload(circular).ok, false);
  });

  it("refuses one that encodes to nothing", () => {
    assert.equal(measurePayload(undefined).ok, false);
    assert.equal(measurePayload(() => {}).ok, false);
  });

  it("allows the ordinary shapes", () => {
    for (const data of [null, 0, false, "", [], {}, { nested: { deep: [1, 2, 3] } }]) {
      assert.equal(measurePayload(data).ok, true, `refused ${JSON.stringify(data)}`);
    }
  });
});

/* ── delivery ───────────────────────────────────────────────────────────── */

describe("delivering a message to a plugin", () => {
  it("reaches the handler on the matching topic", () => {
    const bus = createMessageBus(createPluginGuard(recorder()));
    const seen: IncomingPluginMessage[] = [];
    bus.subscribe("presence", "presence", (m) => void seen.push(m));

    assert.equal(bus.deliver("presence", message()), true);
    assert.deepEqual(seen.map((m) => m.data), [{ playing: "Factorio" }]);
  });

  it("does not reach a different topic", () => {
    const bus = createMessageBus(createPluginGuard(recorder()));
    let called = false;
    bus.subscribe("presence", "score", () => void (called = true));

    assert.equal(bus.deliver("presence", message()), false);
    assert.equal(called, false);
  });

  /* The whole point of the namespace. Without it one plugin's client half could
     address another plugin's server half. */
  it("does not reach a different plugin", () => {
    const bus = createMessageBus(createPluginGuard(recorder()));
    let called = false;
    bus.subscribe("scoreboard", "presence", () => void (called = true));

    assert.equal(bus.deliver("presence", message()), false);
    assert.equal(called, false);
  });

  it("reaches every handler that asked for the topic", () => {
    const bus = createMessageBus(createPluginGuard(recorder()));
    const seen: string[] = [];
    bus.subscribe("presence", "presence", () => void seen.push("first"));
    bus.subscribe("presence", "presence", () => void seen.push("second"));

    bus.deliver("presence", message());

    assert.deepEqual(seen, ["first", "second"]);
  });

  it("hands each handler its own copy", () => {
    const bus = createMessageBus(createPluginGuard(recorder()));
    let secondSaw: unknown;
    bus.subscribe("presence", "presence", (m) => {
      (m.data as Record<string, unknown>).playing = "rewritten";
    });
    bus.subscribe("presence", "presence", (m) => void (secondSaw = m.data));

    bus.deliver("presence", message());

    assert.deepEqual(secondSaw, { playing: "Factorio" });
  });

  it("knows whether anybody is listening for a plugin at all", () => {
    const bus = createMessageBus(createPluginGuard(recorder()));
    assert.equal(bus.isListening("presence"), false);
    bus.subscribe("presence", "presence", () => {});
    assert.equal(bus.isListening("presence"), true);
  });
});

/*
 * The failure count is shared with the event bus, which is why the guard was
 * pulled out at all. A plugin throwing five times on events and five times on
 * messages has thrown ten times.
 */
describe("a plugin that throws on a message", () => {
  it("does not reach the code that delivered it", () => {
    const bus = createMessageBus(createPluginGuard(recorder()));
    bus.subscribe("presence", "presence", () => {
      throw new Error("nope");
    });

    assert.doesNotThrow(() => bus.deliver("presence", message()));
  });

  it("is caught when it rejects, too", async () => {
    const log = recorder();
    const bus = createMessageBus(createPluginGuard(log));
    bus.subscribe("presence", "presence", async () => {
      throw new Error("later");
    });

    bus.deliver("presence", message());
    await new Promise((r) => setImmediate(r));

    assert.equal(log.warns.length, 1);
    assert.match(log.warns[0], /presence/);
  });

  it("stops being called once it has thrown enough", () => {
    const log = recorder();
    const bus = createMessageBus(createPluginGuard(log));
    let calls = 0;
    bus.subscribe("presence", "presence", () => {
      calls += 1;
      throw new Error("always");
    });

    for (let i = 0; i < FAILURES_BEFORE_DISABLE + 5; i++) bus.deliver("presence", message());

    assert.equal(calls, FAILURES_BEFORE_DISABLE);
    assert.equal(log.errors.length, 1);
  });
});

/* ── sending out ────────────────────────────────────────────────────────── */

describe("sending to the client halves", () => {
  const sent: { clientId: string; event: string; payload: unknown }[] = [];

  function connect(clients: Record<string, string>) {
    sent.length = 0;
    const clientsInfo: Clients = {};
    for (const [clientId, serverUserId] of Object.entries(clients)) {
      clientsInfo[clientId] = { serverUserId } as Clients[string];
    }
    const io = {
      sockets: {
        sockets: {
          get: (clientId: string) => ({
            emit: (event: string, payload: unknown) => void sent.push({ clientId, event, payload }),
          }),
        },
      },
    } as never;
    setPluginRefs({ io, serverId: "test", clientsInfo, sfuClient: null });
  }

  beforeEach(() => clearPluginRefs());

  it("goes to everybody by default", () => {
    connect({ a: "user_1", b: "user_2" });
    const bus = createMessageBus(createPluginGuard(recorder()));

    const ok = createMessaging("presence", bus, recorder()).send("presence", { playing: "Doom" });

    assert.equal(ok, true);
    assert.deepEqual(sent.map((s) => s.clientId), ["a", "b"]);
    assert.deepEqual(sent[0].payload, {
      pluginId: "presence",
      topic: "presence",
      data: { playing: "Doom" },
    });
  });

  it("goes only to the members named", () => {
    connect({ a: "user_1", b: "user_2", c: "user_3" });
    const bus = createMessageBus(createPluginGuard(recorder()));

    createMessaging("presence", bus, recorder()).send("presence", {}, ["user_1", "user_3"]);

    assert.deepEqual(sent.map((s) => s.clientId), ["a", "c"]);
  });

  /* Somebody mid-join has a temporary id and no member behind it. Sending to
     them is sending to nobody, and the id would be meaningless to a plugin. */
  it("skips a connection that has not joined yet", () => {
    connect({ a: "user_1", pending: "temp_abc" });
    const bus = createMessageBus(createPluginGuard(recorder()));

    createMessaging("presence", bus, recorder()).send("presence", {});

    assert.deepEqual(sent.map((s) => s.clientId), ["a"]);
  });

  it("refuses a payload over the cap rather than sending part of it", () => {
    connect({ a: "user_1" });
    const log = recorder();
    const bus = createMessageBus(createPluginGuard(recorder()));

    const ok = createMessaging("presence", bus, log).send("presence", "x".repeat(MAX_PAYLOAD_BYTES + 1));

    assert.equal(ok, false);
    assert.equal(sent.length, 0);
    assert.match(log.warns[0], /presence/);
  });

  it("refuses a topic that is not one", () => {
    connect({ a: "user_1" });
    const bus = createMessageBus(createPluginGuard(recorder()));

    assert.equal(createMessaging("presence", bus, recorder()).send("not a topic", {}), false);
    assert.equal(sent.length, 0);
  });

  /* Plugins load before the first connection, so a plugin sending from an
     import-time timer would otherwise reach a null io. */
  it("refuses before the socket layer is up", () => {
    const log = recorder();
    const bus = createMessageBus(createPluginGuard(recorder()));

    assert.equal(createMessaging("presence", bus, log).send("presence", {}), false);
    assert.match(log.warns[0], /before the server was accepting connections/);
  });

  it("stamps the plugin id from the plugin, not from anything sent", () => {
    connect({ a: "user_1" });
    const bus = createMessageBus(createPluginGuard(recorder()));

    createMessaging("scoreboard", bus, recorder()).send("presence", { pluginId: "presence" });

    assert.equal((sent[0].payload as { pluginId: string }).pluginId, "scoreboard");
  });
});

describe("subscribing to a topic that could never be sent", () => {
  /* Silence a plugin author would spend an afternoon on, so it throws instead. */
  it("throws rather than going quiet", () => {
    const bus = createMessageBus(createPluginGuard(recorder()));
    const messaging = createMessaging("presence", bus, recorder());

    assert.throws(() => messaging.on("not a topic", () => {}), /invalid topic/);
    assert.equal(bus.isListening("presence"), false);
  });
});
