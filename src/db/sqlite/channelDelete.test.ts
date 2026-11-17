import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { deleteServerChannel, deleteServerSidebarItem, ensureDefaultSidebarItems, listServerChannels, listServerSidebarItems } from "./channels";
import { initSqlite } from "./connection";
import { insertMessage, listMessages } from "./messages";
import { createThread, listThreadsByConversation } from "./threads";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-channel-delete-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("deleting channels", () => {
  it("seeds the defaults on a fresh server", async () => {
    assert.equal(await ensureDefaultSidebarItems(), true);
    assert.deepEqual((await listServerChannels()).map((c) => c.channel_id).sort(), ["general", "random", "voice"]);
  });

  it("takes a channel's messages and threads with it", async () => {
    const root = await insertMessage({ conversation_id: "general", sender_server_id: "u_a", text: "hi", attachments: null, reactions: null });
    await createThread({ conversation_id: "general", root_message_id: root.message_id, created_by: "u_a" });

    await deleteServerChannel("general");

    assert.equal((await listMessages("general", 50)).length, 0);
    assert.equal((await listThreadsByConversation("general")).length, 0);
  });

  it("does not bring the defaults back once every channel is gone", async () => {
    for (const c of await listServerChannels()) await deleteServerChannel(c.channel_id);
    for (const it of await listServerSidebarItems()) await deleteServerSidebarItem(it.item_id);

    assert.equal(await ensureDefaultSidebarItems(), false);
    assert.equal((await listServerChannels()).length, 0);
  });
});
