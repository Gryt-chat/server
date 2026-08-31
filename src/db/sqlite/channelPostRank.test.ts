import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { getSqliteDb, initSqlite } from "./connection";
import { listServerChannels, upsertServerChannel } from "./channels";

/**
 * A channel can require a rank to post in, which is what makes a read-only
 * #rules or an announcements channel possible. Before this the channels table
 * had no permission column at all and a role could either post everywhere or
 * nowhere.
 */

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-chanrank-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

async function get(id: string) {
  return (await listServerChannels()).find((c) => c.channel_id === id);
}

describe("post_min_rank", () => {
  it("is null on a channel nobody has restricted", async () => {
    await upsertServerChannel({ channelId: "open-chan", name: "Open", type: "text" });
    assert.equal((await get("open-chan"))?.post_min_rank, null);
  });

  it("round-trips a rank", async () => {
    await upsertServerChannel({ channelId: "announce", name: "Announcements", type: "text", postMinRank: 60 });
    assert.equal((await get("announce"))?.post_min_rank, 60);
  });

  /**
   * The one that matters. Every existing caller of upsertServerChannel omits
   * this field, and an update must not silently reopen a restricted channel
   * just because whoever wrote the caller had never heard of it.
   */
  it("survives an update that does not mention it", async () => {
    await upsertServerChannel({ channelId: "rules", name: "Rules", type: "text", postMinRank: 100 });
    await upsertServerChannel({ channelId: "rules", name: "Rules renamed", type: "text" });

    const after = await get("rules");
    assert.equal(after?.name, "Rules renamed", "the rename should still apply");
    assert.equal(after?.post_min_rank, 100, "omitting postMinRank must not reopen the channel");
  });

  it("is clamped rather than trusted", async () => {
    await upsertServerChannel({ channelId: "silly", name: "Silly", type: "text", postMinRank: 10_000_000 });
    assert.equal((await get("silly"))?.post_min_rank, 1000);

    await upsertServerChannel({ channelId: "negative", name: "Negative", type: "text", postMinRank: -5 });
    assert.equal((await get("negative"))?.post_min_rank, 0);
  });

  it("is added to a database that predates it", async () => {
    const db = getSqliteDb();
    const cols = db.prepare("PRAGMA table_info(channels)").all() as unknown as { name: string }[];
    assert.ok(cols.some((c) => c.name === "post_min_rank"), "the migration should have added the column");
  });
});
