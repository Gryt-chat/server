import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite, getSqliteDb } from "./connection";
import { insertMessage } from "./messages";
import {
  countUnreadByConversation,
  deleteReadMarkers,
  listReadMarkers,
  setReadMarker,
} from "./readMarkers";

/** A real database, like card.test.ts: the counting is a join and a string compare,
    and neither is worth faking. */
let dir: string;

const ALICE = "alice";
const BOB = "bob";

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-read-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  delete process.env.DATA_DIR;
  /* The connection stays open, there being no close for it, and Windows will not unlink
     an open file. Every db test here fails its cleanup that way; the OS sweeps temp. */
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Failing a suite on its own cleanup hides the result it just produced.
  }
});

/** created_at is given, so the order is the test's rather than the clock's. */
async function say(conversation: string, sender: string, at: string, extra: { thread_id?: string } = {}) {
  const stored = await insertMessage({
    conversation_id: conversation,
    sender_server_id: sender,
    text: `from ${sender} at ${at}`,
    attachments: null,
    reactions: null,
    created_at: new Date(at),
    ...extra,
  });
  return stored.message_id;
}

describe("read markers", () => {
  it("counts nothing for a conversation nobody has opened", async () => {
    await say("c-untouched", BOB, "2026-01-01T00:00:00.000Z");
    const counts = await countUnreadByConversation(ALICE);
    assert.equal(counts["c-untouched"], undefined, "a channel never opened is lighting up");
    assert.deepEqual(await listReadMarkers(ALICE), []);
  });

  it("counts what arrived after the marker, and not the marker itself", async () => {
    const first = await say("c-basic", BOB, "2026-01-02T00:00:00.000Z");
    await say("c-basic", BOB, "2026-01-02T00:00:01.000Z");
    await say("c-basic", BOB, "2026-01-02T00:00:02.000Z");

    assert.equal(await setReadMarker({ serverUserId: ALICE, conversationId: "c-basic", messageId: first }), true);
    const counts = await countUnreadByConversation(ALICE);
    assert.equal(counts["c-basic"], 2);
  });

  it("does not count your own messages", async () => {
    const first = await say("c-mine", BOB, "2026-01-03T00:00:00.000Z");
    await setReadMarker({ serverUserId: ALICE, conversationId: "c-mine", messageId: first });
    await say("c-mine", ALICE, "2026-01-03T00:00:01.000Z");
    assert.equal((await countUnreadByConversation(ALICE))["c-mine"], undefined);

    await say("c-mine", BOB, "2026-01-03T00:00:02.000Z");
    assert.equal((await countUnreadByConversation(ALICE))["c-mine"], 1, "somebody else's message is not counted");
  });

  it("leaves thread replies to the thread's own count", async () => {
    const root = await say("c-thread", BOB, "2026-01-04T00:00:00.000Z");
    await setReadMarker({ serverUserId: ALICE, conversationId: "c-thread", messageId: root });
    await say("c-thread", BOB, "2026-01-04T00:00:01.000Z", { thread_id: "t-1" });
    assert.equal((await countUnreadByConversation(ALICE))["c-thread"], undefined);
  });

  it("only ever moves forwards", async () => {
    const a = await say("c-back", BOB, "2026-01-05T00:00:00.000Z");
    const b = await say("c-back", BOB, "2026-01-05T00:00:01.000Z");

    await setReadMarker({ serverUserId: ALICE, conversationId: "c-back", messageId: b });
    assert.equal((await countUnreadByConversation(ALICE))["c-back"], undefined);

    /* The second device finished last but had read less. Without the guard this would
       reopen a conversation somebody had already cleared. */
    const moved = await setReadMarker({ serverUserId: ALICE, conversationId: "c-back", messageId: a });
    assert.equal(moved, false, "the marker went backwards");
    assert.equal((await countUnreadByConversation(ALICE))["c-back"], undefined);
  });

  it("breaks a same-millisecond tie on the message id", async () => {
    const same = "2026-01-06T00:00:00.000Z";
    const ids = [await say("c-tie", BOB, same), await say("c-tie", BOB, same), await say("c-tie", BOB, same)];
    const sorted = [...ids].sort();

    await setReadMarker({ serverUserId: ALICE, conversationId: "c-tie", messageId: sorted[0] });
    /* Ids are random UUIDs, so this is the only ordering the pair has. Comparing on
       created_at alone would count all three or none. */
    assert.equal((await countUnreadByConversation(ALICE))["c-tie"], 2);

    await setReadMarker({ serverUserId: ALICE, conversationId: "c-tie", messageId: sorted[2] });
    assert.equal((await countUnreadByConversation(ALICE))["c-tie"], undefined);
  });

  it("moves nothing for a message this server does not have", async () => {
    const real = await say("c-ghost", BOB, "2026-01-07T00:00:00.000Z");
    await setReadMarker({ serverUserId: ALICE, conversationId: "c-ghost", messageId: real });
    await say("c-ghost", BOB, "2026-01-07T00:00:01.000Z");

    assert.equal(
      await setReadMarker({ serverUserId: ALICE, conversationId: "c-ghost", messageId: "not-a-message" }),
      false,
    );
    assert.equal((await countUnreadByConversation(ALICE))["c-ghost"], 1, "an unknown id disturbed the marker");
  });

  it("keeps the marker when the message it points at is deleted", async () => {
    const first = await say("c-gone", BOB, "2026-01-08T00:00:00.000Z");
    await say("c-gone", BOB, "2026-01-08T00:00:01.000Z");
    await setReadMarker({ serverUserId: ALICE, conversationId: "c-gone", messageId: first });

    getSqliteDb().prepare(`DELETE FROM messages WHERE conversation_id = ? AND message_id = ?`).run("c-gone", first);

    /* No foreign key here, deliberately: deleting the message somebody stopped at must
       not forget where they were. With a cascade this would read as caught up. */
    assert.equal((await listReadMarkers(ALICE)).some((m) => m.conversation_id === "c-gone"), true);
    assert.equal((await countUnreadByConversation(ALICE))["c-gone"], 1);
  });

  it("stores the message's own time, not the time of the read", async () => {
    const at = "2026-01-09T12:34:56.000Z";
    const id = await say("c-when", BOB, at);
    await setReadMarker({ serverUserId: ALICE, conversationId: "c-when", messageId: id });

    const marker = (await listReadMarkers(ALICE)).find((m) => m.conversation_id === "c-when");
    assert.equal(marker?.read_through_at, at, "the marker is not the message's timestamp");
    assert.equal(marker?.read_through_message_id, id);
  });

  it("keeps people apart, and forgets one on request", async () => {
    const id = await say("c-two", BOB, "2026-01-10T00:00:00.000Z");
    await say("c-two", BOB, "2026-01-10T00:00:01.000Z");
    await setReadMarker({ serverUserId: ALICE, conversationId: "c-two", messageId: id });

    assert.equal((await listReadMarkers(BOB)).some((m) => m.conversation_id === "c-two"), false);

    assert.equal(await deleteReadMarkers(ALICE, "c-two"), 1);
    assert.equal((await countUnreadByConversation(ALICE))["c-two"], undefined);
    assert.ok((await listReadMarkers(ALICE)).length > 0, "every marker went, not just the one asked for");
  });
});
