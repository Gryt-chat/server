import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../db/sqlite/connection";
import { deleteMessage, insertMessage } from "../db/sqlite/messages";
import { unreferencedAmong } from "./mediaSweep";

/**
 * A file can be attached to more than one message, since forwarding is enough,
 * and removing one another message shows is a broken image somebody else sees.
 */

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-delunref-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const post = (conversation: string, attachments: string[] | null) =>
  insertMessage({
    conversation_id: conversation,
    sender_server_id: "someone",
    text: "hello",
    attachments,
    reactions: null,
    reply_to_message_id: null,
  });

describe("unreferencedAmong", () => {
  it("does nothing when given nothing", async () => {
    assert.deepEqual(await unreferencedAmong([]), []);
  });

  /** Two messages carry the same file, and deleting one must leave the bytes
      alone. */
  it("keeps a file another message still points at", async () => {
    const shared = "file-shared";
    const a = await post("c1", [shared]);
    await post("c2", [shared]);

    await deleteMessage("c1", a.message_id);

    assert.deepEqual(
      await unreferencedAmong([shared]),
      [],
      "the file is still attached to the message in c2, so it must not be selected",
    );
  });

  it("selects a file nothing points at any more", async () => {
    const only = "file-only";
    const m = await post("c3", [only]);
    await deleteMessage("c3", m.message_id);

    assert.deepEqual(await unreferencedAmong([only]), [only]);
  });
});
