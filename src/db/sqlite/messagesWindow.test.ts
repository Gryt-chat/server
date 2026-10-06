import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "./connection";
import { insertMessage, listMessages, listMessagesAfter } from "./messages";

/** The two halves of a jump to an old message (GRYT-1686): `listMessages` before it and
    `listMessagesAfter` past it, which together must cover the channel with no gap or repeat. */

let dir: string;
const CONV = "channel-window";
const START = Date.UTC(2026, 9, 1, 8, 0, 0);
const at = (i: number) => new Date(START + i * 60_000);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-window-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  for (let i = 0; i < 30; i++) {
    await insertMessage({ conversation_id: CONV, message_id: `m${String(i).padStart(2, "0")}`, sender_server_id: "u_a", text: `message ${i}`, attachments: null, reactions: null, created_at: at(i) });
  }
  // A thread reply in the middle, which neither half may return.
  await insertMessage({ conversation_id: CONV, message_id: "reply", sender_server_id: "u_a", text: "reply", attachments: null, reactions: null, thread_id: "t1", created_at: new Date(at(12).getTime() + 1) });
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("listMessagesAfter", () => {
  it("returns the next messages oldest first, starting after the point", async () => {
    const page = await listMessagesAfter(CONV, 5, at(10));
    assert.deepEqual(page.map((m) => m.message_id), ["m11", "m12", "m13", "m14", "m15"]);
  });

  it("leaves out thread replies", async () => {
    const page = await listMessagesAfter(CONV, 30, at(12));
    assert.ok(!page.some((m) => m.message_id === "reply"));
  });

  it("comes back short at the newest message", async () => {
    const page = await listMessagesAfter(CONV, 10, at(25));
    assert.deepEqual(page.map((m) => m.message_id), ["m26", "m27", "m28", "m29"]);
  });

  it("joins with listMessages around a message without a gap or a repeat", async () => {
    const older = await listMessages(CONV, 4, at(15));
    const newer = await listMessagesAfter(CONV, 4, at(15));
    assert.deepEqual(
      [...older, ...newer].map((m) => m.message_id),
      ["m11", "m12", "m13", "m14", "m16", "m17", "m18", "m19"],
    );
  });

  it("walks from the oldest message to the newest in pages", async () => {
    const seen: string[] = [];
    let cursor = new Date(START - 1);
    for (;;) {
      const page = await listMessagesAfter(CONV, 7, cursor);
      seen.push(...page.map((m) => m.message_id));
      if (page.length < 7) break;
      cursor = page[page.length - 1].created_at;
    }
    assert.equal(seen.length, 30);
    assert.equal(new Set(seen).size, 30);
  });
});
