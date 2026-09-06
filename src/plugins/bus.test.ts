import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FAILURES_BEFORE_DISABLE, createPluginBus, type BusLogger } from "./bus";

/**
 * What happens around the call, which is the whole point of the bus (GRYT-933).
 *
 * A plugin runs in this process. The events are plain objects and carrying them
 * is not interesting; what is interesting is that a broken plugin cannot fail
 * somebody's message send, cannot take the process down with an unhandled
 * rejection, and cannot tax every message forever.
 */

function recorder(): BusLogger & { warns: string[]; errors: string[] } {
  const warns: string[] = [];
  const errors: string[] = [];
  return { warns, errors, warn: (m) => warns.push(m), error: (m) => errors.push(m) };
}

const message = {
  messageId: "m1",
  channelId: "c1",
  userId: "u1",
  nickname: "Sivert",
  text: "hello",
  attachmentCount: 0,
  at: "2026-09-06T12:00:00.000Z",
};

describe("delivering an event", () => {
  it("reaches everybody subscribed to it", () => {
    const bus = createPluginBus(recorder());
    const seen: string[] = [];
    bus.subscribe("a", "message:created", () => void seen.push("a"));
    bus.subscribe("b", "message:created", () => void seen.push("b"));

    bus.emit("message:created", message);

    assert.deepEqual(seen, ["a", "b"]);
  });

  it("reaches nobody subscribed to something else", () => {
    const bus = createPluginBus(recorder());
    let called = false;
    bus.subscribe("a", "member:joined", () => void (called = true));

    bus.emit("message:created", message);

    assert.equal(called, false);
  });

  it("is fine with nobody listening", () => {
    const bus = createPluginBus(recorder());
    assert.doesNotThrow(() => bus.emit("message:created", message));
  });
});

/*
 * The one that decides whether two plugins can be trusted to run side by side.
 * Without a copy, the first handler rewrites the event for the second, and
 * which one wins depends on load order.
 */
describe("one plugin cannot rewrite the event for another", () => {
  it("hands each handler its own copy", () => {
    const bus = createPluginBus(recorder());
    let secondSaw = "";
    bus.subscribe("vandal", "message:created", (m) => {
      m.text = "rewritten";
    });
    bus.subscribe("victim", "message:created", (m) => void (secondSaw = m.text));

    bus.emit("message:created", message);

    assert.equal(secondSaw, "hello");
  });

  it("leaves the caller's object alone", () => {
    const bus = createPluginBus(recorder());
    bus.subscribe("vandal", "message:created", (m) => {
      m.text = "rewritten";
    });

    const payload = { ...message };
    bus.emit("message:created", payload);

    assert.equal(payload.text, "hello", "the emitting code's own object was modified");
  });
});

describe("a handler that throws", () => {
  it("does not reach the code that emitted", () => {
    const bus = createPluginBus(recorder());
    bus.subscribe("broken", "message:created", () => {
      throw new Error("nope");
    });

    assert.doesNotThrow(() => bus.emit("message:created", message));
  });

  it("does not stop the next plugin being called", () => {
    const bus = createPluginBus(recorder());
    let reached = false;
    bus.subscribe("broken", "message:created", () => {
      throw new Error("nope");
    });
    bus.subscribe("fine", "message:created", () => void (reached = true));

    bus.emit("message:created", message);

    assert.equal(reached, true, "a throw took out the plugin after it");
  });

  it("is logged with the plugin and the event named", () => {
    const log = recorder();
    const bus = createPluginBus(log);
    bus.subscribe("broken", "message:created", () => {
      throw new Error("nope");
    });

    bus.emit("message:created", message);

    assert.equal(log.warns.length, 1);
    assert.match(log.warns[0], /broken/);
    assert.match(log.warns[0], /message:created/);
    assert.match(log.warns[0], /nope/);
  });

  it("survives something thrown that is not an Error", () => {
    const log = recorder();
    const bus = createPluginBus(log);
    bus.subscribe("broken", "message:created", () => {
      throw "just a string";
    });

    assert.doesNotThrow(() => bus.emit("message:created", message));
    assert.match(log.warns[0], /just a string/);
  });
});

/*
 * A rejection is invisible to the try/catch around the call, and on Node's
 * default an unhandled one takes the process down. This is the failure that
 * would look like the server crashing at random under load.
 */
describe("a handler that rejects", () => {
  it("is caught rather than left unhandled", async () => {
    const log = recorder();
    const bus = createPluginBus(log);
    bus.subscribe("async-broken", "message:created", async () => {
      throw new Error("later");
    });

    bus.emit("message:created", message);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(log.warns.length, 1);
    assert.match(log.warns[0], /async-broken/);
    assert.match(log.warns[0], /later/);
  });

  it("counts towards the same total as a synchronous throw", async () => {
    const log = recorder();
    const bus = createPluginBus(log);
    bus.subscribe("mixed", "message:created", async () => {
      throw new Error("async");
    });

    for (let i = 0; i < FAILURES_BEFORE_DISABLE; i++) {
      bus.emit("message:created", message);
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.equal(log.errors.length, 1, "a plugin failing only asynchronously was never disabled");
  });
});

/*
 * Catching alone leaves a plugin that throws on every message writing a log
 * line and burning a call forever. Slow, noisy, and never fixed because nothing
 * ever gets worse enough to notice.
 */
describe("a plugin that throws every time", () => {
  it("stops being called", () => {
    const log = recorder();
    const bus = createPluginBus(log);
    let calls = 0;
    bus.subscribe("broken", "message:created", () => {
      calls += 1;
      throw new Error("always");
    });

    for (let i = 0; i < FAILURES_BEFORE_DISABLE + 5; i++) bus.emit("message:created", message);

    assert.equal(calls, FAILURES_BEFORE_DISABLE, "kept calling a plugin that had been disabled");
  });

  it("says so once, loudly, rather than every time", () => {
    const log = recorder();
    const bus = createPluginBus(log);
    bus.subscribe("broken", "message:created", () => {
      throw new Error("always");
    });

    for (let i = 0; i < FAILURES_BEFORE_DISABLE + 20; i++) bus.emit("message:created", message);

    assert.equal(log.errors.length, 1);
    assert.match(log.errors[0], /broken/);
    assert.equal(log.warns.length, FAILURES_BEFORE_DISABLE - 1, "the last failure warned as well as errored");
  });

  it("takes nobody else with it", () => {
    const bus = createPluginBus(recorder());
    let good = 0;
    bus.subscribe("broken", "message:created", () => {
      throw new Error("always");
    });
    bus.subscribe("fine", "message:created", () => void (good += 1));

    const emits = FAILURES_BEFORE_DISABLE + 5;
    for (let i = 0; i < emits; i++) bus.emit("message:created", message);

    assert.equal(good, emits);
  });

  it("cannot re-arm itself by subscribing again", () => {
    const bus = createPluginBus(recorder());
    let calls = 0;
    bus.subscribe("broken", "message:created", () => {
      calls += 1;
      throw new Error("always");
    });
    for (let i = 0; i < FAILURES_BEFORE_DISABLE; i++) bus.emit("message:created", message);

    bus.subscribe("broken", "message:created", () => void (calls += 1));
    bus.emit("message:created", message);

    assert.equal(calls, FAILURES_BEFORE_DISABLE);
  });

  /* And the subscription is not kept either. Refusing the call at emit would
     look the same from the outside while the map filled up with dead handlers
     from a plugin that re-subscribes on a timer. */
  it("does not accumulate subscriptions it will never call", () => {
    const bus = createPluginBus(recorder());
    bus.subscribe("broken", "message:created", () => {
      throw new Error("always");
    });
    for (let i = 0; i < FAILURES_BEFORE_DISABLE; i++) bus.emit("message:created", message);

    for (let i = 0; i < 5; i++) bus.subscribe("broken", "message:created", () => {});

    assert.deepEqual(bus.stats(), { plugins: [], disabled: ["broken"], subscriptions: 0 });
  });

  /*
   * The case the check inside the emit loop exists for, and the only one: the
   * list was snapshotted before the first handler ran, so a plugin's *second*
   * handler is still in the snapshot after the first one crossed the threshold
   * and had its subscriptions removed.
   */
  it("stops mid-emit, not just from the next event", () => {
    const bus = createPluginBus(recorder());
    let second = 0;
    bus.subscribe("broken", "message:created", () => {
      throw new Error("always");
    });
    bus.subscribe("broken", "message:created", () => void (second += 1));

    for (let i = 0; i < FAILURES_BEFORE_DISABLE; i++) bus.emit("message:created", message);

    assert.equal(
      second,
      FAILURES_BEFORE_DISABLE - 1,
      "the second handler ran on the emit that disabled the plugin",
    );
  });

  it("is not disabled by failures spread across several plugins", () => {
    const log = recorder();
    const bus = createPluginBus(log);
    for (let i = 0; i < FAILURES_BEFORE_DISABLE; i++) {
      bus.subscribe(`p${i}`, "message:created", () => {
        throw new Error("one each");
      });
    }

    bus.emit("message:created", message);

    assert.equal(log.errors.length, 0, "counted failures across plugins instead of per plugin");
    assert.equal(log.warns.length, FAILURES_BEFORE_DISABLE);
  });
});

describe("subscribing from inside a handler", () => {
  /* The list is copied before iterating, so somebody joining mid-emit does not
     shift the array under the loop and skip the plugin after them. */
  it("does not skip the plugin after the one that subscribed", () => {
    const bus = createPluginBus(recorder());
    const seen: string[] = [];
    bus.subscribe("a", "message:created", () => {
      seen.push("a");
      bus.subscribe("late", "message:created", () => void seen.push("late"));
    });
    bus.subscribe("b", "message:created", () => void seen.push("b"));

    bus.emit("message:created", message);

    assert.deepEqual(seen, ["a", "b"]);
  });
});

describe("removing a plugin", () => {
  it("stops it hearing anything", () => {
    const bus = createPluginBus(recorder());
    let calls = 0;
    bus.subscribe("a", "message:created", () => void (calls += 1));
    bus.subscribe("a", "member:joined", () => void (calls += 1));

    bus.remove("a");
    bus.emit("message:created", message);

    assert.equal(calls, 0);
    assert.deepEqual(bus.stats().plugins, []);
  });

  it("leaves the others subscribed", () => {
    const bus = createPluginBus(recorder());
    let kept = 0;
    bus.subscribe("a", "message:created", () => {});
    bus.subscribe("b", "message:created", () => void (kept += 1));

    bus.remove("a");
    bus.emit("message:created", message);

    assert.equal(kept, 1);
    assert.deepEqual(bus.stats().plugins, ["b"]);
  });
});

describe("what the startup log can say", () => {
  it("counts subscriptions and names the plugins", () => {
    const bus = createPluginBus(recorder());
    bus.subscribe("b", "message:created", () => {});
    bus.subscribe("a", "message:created", () => {});
    bus.subscribe("a", "member:left", () => {});

    assert.deepEqual(bus.stats(), { plugins: ["a", "b"], disabled: [], subscriptions: 3 });
  });

  it("names the disabled ones separately", () => {
    const bus = createPluginBus(recorder());
    bus.subscribe("broken", "message:created", () => {
      throw new Error("always");
    });
    for (let i = 0; i < FAILURES_BEFORE_DISABLE; i++) bus.emit("message:created", message);

    assert.deepEqual(bus.stats(), { plugins: [], disabled: ["broken"], subscriptions: 0 });
  });
});
