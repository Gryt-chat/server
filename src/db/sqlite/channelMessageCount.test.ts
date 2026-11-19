import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "./connection";
import { countChannelMessages, insertMessage } from "./messages";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-message-count-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("the message count on the owner's overview", () => {
  it("counts channel messages and leaves DMs out", async () => {
    const msg = (conversation_id: string, id: string) =>
      insertMessage({ conversation_id, sender_server_id: "u1", text: id, attachments: null, reactions: null, message_id: id });
    await msg("general", "a");
    await msg("random", "b");
    await msg("dm_ab12", "c");
    await msg("dmx", "d");

    assert.equal(await countChannelMessages(), 3);
  });
});
