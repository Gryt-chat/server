import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  getMessageById,
  getServerChannel,
  getThread,
  getThreadByRoot,
  listMessages,
  listServerSidebarItems,
  listThreadMessages,
  type DiscordImportProgress,
  type MessageRecord,
} from "../../db";
import { getSqliteDb, initSqlite } from "../../db/sqlite/connection";
import { resolveImportFolder } from "./exportFolder";
import { importedId } from "./ids";
import { importDiscordExport, type ImportMedia, type StoreOutcome } from "./importer";

/** The fixture is a hand-written DiscordChatExporter export: see testdata/dce-export. */
const FIXTURE = join(__dirname, "testdata", "dce-export");

let dataDir: string;
let root: string;

class FakeMedia implements ImportMedia {
  readonly stored = new Set<string>();
  readonly paths: string[] = [];
  readonly emojis: string[] = [];
  async storeFile(input: { fileId: string; path: string; imageOnly?: boolean }): Promise<StoreOutcome> {
    this.paths.push(input.path);
    if (input.imageOnly && !input.path.endsWith(".png")) return { kind: "skipped", reason: "not a picture" };
    if (this.stored.has(input.fileId)) return { kind: "exists" };
    this.stored.add(input.fileId);
    return { kind: "stored" };
  }
  async queueEmoji(input: { name: string }): Promise<boolean> {
    if (this.emojis.includes(input.name)) return false;
    this.emojis.push(input.name);
    return true;
  }
}

const media = new FakeMedia();
let first: { progress: DiscordImportProgress; warnings: string[] };

const channel = (discordId: string) => importedId("channel", discordId);
const message = (discordId: string) => importedId("message", discordId);

async function stored(channelDiscordId: string, messageDiscordId: string): Promise<MessageRecord> {
  const m = await getMessageById(channel(channelDiscordId), message(messageDiscordId));
  assert.ok(m, `message ${messageDiscordId} was not imported`);
  return m;
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "gryt-dce-import-"));
  process.env.DATA_DIR = dataDir;
  await initSqlite();
  root = join(dataDir, "imports", "test-guild");
  mkdirSync(join(dataDir, "imports"), { recursive: true });
  cpSync(FIXTURE, root, { recursive: true });
  first = await importDiscordExport({ root, startedBy: "user_owner", media });
});

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("importing a DiscordChatExporter export", () => {
  it("makes the channels, with categories as folders and forums as forums", async () => {
    const general = await getServerChannel(channel("100"));
    assert.equal(general?.name, "general");
    assert.equal(general?.description, "Talk about anything");
    assert.equal(general?.layout, "chat");

    const lounge = await getServerChannel(channel("600"));
    assert.equal(lounge?.type, "voice");
    assert.equal(lounge?.text_in_voice, true);

    // Forum channels are never exported themselves, only their posts.
    const forum = await getServerChannel(channel("500"));
    assert.equal(forum?.name, "help-forum");
    assert.equal(forum?.layout, "forum");

    const items = await listServerSidebarItems();
    const folder = items.find((i) => i.kind === "folder" && i.label === "Text Channels");
    assert.ok(folder);
    assert.equal(items.find((i) => i.channel_id === channel("100"))?.parent_item_id, folder.item_id);
  });

  it("leaves DMs to the app", async () => {
    assert.equal(await getServerChannel(channel("700")), null);
    assert.ok(first.warnings.some((w) => w.includes("DM export")));
  });

  it("keeps who wrote it, when, and what it said", async () => {
    const m = await stored("100", "1001");
    assert.equal(m.sender_server_id, "discord:11");
    assert.equal(m.sender_display_name, "Ola N");
    assert.ok(m.sender_avatar_file_id);
    assert.equal(m.created_at.toISOString(), "2021-01-01T10:00:00.000Z");
    assert.equal(m.edited_at?.toISOString(), "2021-01-01T10:05:00.000Z");
    // Raw markup from `--markdown false` reads the way DCE would have flattened it.
    assert.equal(m.text, "Hello @Kari, see #general :pepe:");
    assert.equal(m.attachments?.length, 2);
  });

  it("carries reactions, with the Discord users who left them", async () => {
    const m = await stored("100", "1001");
    assert.deepEqual(m.reactions, [
      { src: "👍", amount: 2, users: ["discord:12", "discord:11"] },
      { src: ":pepe:", amount: 1, users: ["discord:12"] },
    ]);
    assert.deepEqual(media.emojis, ["pepe"]);
  });

  it("links replies to what they answered", async () => {
    assert.equal((await stored("100", "1002")).reply_to_message_id, message("1001"));
  });

  it("skips notices Gryt has nothing for", async () => {
    assert.equal(await getMessageById(channel("100"), message("1003")), null);
    assert.equal(await getMessageById(channel("100"), message("1004")), null);
  });

  it("hangs a thread started from a message off that message", async () => {
    const thread = await getThreadByRoot(message("200"));
    assert.ok(thread);
    assert.equal(thread.title, "Friday plans");
    assert.equal(thread.conversation_id, channel("100"));
    const replies = await listThreadMessages(thread.thread_id);
    assert.deepEqual(replies.map((r) => r.text), ["Me", "Me too"]);
    assert.equal(replies[1].reply_to_message_id, message("2002"));
    assert.equal(thread.reply_count, 2);
    assert.equal(thread.created_by, "discord:12");
  });

  it("hangs a standalone thread off its ThreadCreated notice", async () => {
    const thread = await getThreadByRoot(message("1005"));
    assert.ok(thread);
    assert.equal((await stored("100", "1005")).text, "side-thread");
    assert.deepEqual((await listThreadMessages(thread.thread_id)).map((r) => r.text), ["First in the side thread"]);
  });

  it("makes each forum post a topic rooted on its first message", async () => {
    const root = await stored("500", "400");
    assert.equal(root.thread_id, null);
    const thread = await getThreadByRoot(root.message_id);
    assert.equal(thread?.title, "How do I export?");
    assert.deepEqual((await listThreadMessages(thread!.thread_id)).map((r) => r.text), ["Use DiscordChatExporter"]);
  });

  it("keeps thread replies out of the channel timeline", async () => {
    const timeline = await listMessages(channel("100"), 100);
    assert.ok(timeline.every((m) => m.thread_id == null));
    assert.ok(!timeline.some((m) => m.text === "Me"));
  });

  it("turns rich embeds into cards and drops link previews", async () => {
    const m = await stored("100", "1006");
    assert.equal(m.cards?.length, 1);
    const [card] = m.cards!;
    assert.equal(card.title, "Build passed");
    assert.equal(card.color, "#57f287");
    assert.deepEqual(card.fields, [{ name: "Branch", value: "main", inline: true }]);
    assert.ok(card.image_file_id);
    assert.ok(card.author?.icon_file_id);
    assert.equal(card.footer?.text, "ci bot");
  });

  it("keeps picture stickers and names the rest", async () => {
    const m = await stored("100", "1007");
    assert.equal(m.attachments?.length, 1);
    assert.match(m.text ?? "", /sticker: dance/);
  });

  it("never reads outside the export, and says what it left out", async () => {
    const m = await stored("100", "1008");
    assert.equal(m.attachments, null);
    assert.match(m.text ?? "", /hosts wasn't imported: not in the export/);
    assert.match(m.text ?? "", /gone\.png wasn't imported: not in the export/);
    for (const p of media.paths) assert.ok(p.startsWith(root + sep), `read ${p}`);
    assert.ok(first.progress.files_missing >= 2);
  });

  it("finds a file by name when DCE wrote an absolute media path", async () => {
    assert.equal((await stored("100", "1009")).attachments?.length, 1);
  });

  it("quotes a forwarded message", async () => {
    assert.match((await stored("100", "1010")).text ?? "", /\*Forwarded:\*\n> forwarded words/);
  });

  it("references every file a message shows, so reads and the sweep see them", async () => {
    const m = await stored("100", "1006");
    const refs = getSqliteDb()
      .prepare(`SELECT file_id FROM message_attachments WHERE message_id = ?`)
      .all(m.message_id) as { file_id: string }[];
    const ids = new Set(refs.map((r) => r.file_id));
    assert.ok(ids.has(m.sender_avatar_file_id!));
    assert.ok(ids.has(m.cards![0].image_file_id!));
  });

  it("adds nothing the second time", async () => {
    const before = getSqliteDb().prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number };
    const again = await importDiscordExport({ root, startedBy: "user_owner", media });
    const afterCount = getSqliteDb().prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number };
    assert.equal(afterCount.n, before.n);
    assert.equal(again.progress.messages_imported, 0);
    assert.equal(again.progress.messages_already_there, first.progress.messages_imported);
    assert.equal(again.progress.files_stored, 0);
    assert.equal((await getThread((await getThreadByRoot(message("200")))!.thread_id))?.reply_count, 2);
    assert.equal(again.progress.emojis_queued, 0);
  });
});

describe("the import folder", () => {
  it("takes a name under DATA_DIR/imports and nothing else", async () => {
    assert.equal(await resolveImportFolder("test-guild"), realpathSync(root));
    assert.equal(await resolveImportFolder("../"), null);
    assert.equal(await resolveImportFolder("test-guild/media"), null);
    assert.equal(await resolveImportFolder("/etc"), null);
    assert.equal(await resolveImportFolder("missing"), null);
  });

  it("refuses a symlink that leads out of it", async () => {
    symlinkSync(tmpdir(), join(dataDir, "imports", "escape"));
    assert.equal(await resolveImportFolder("escape"), null);
  });
});
