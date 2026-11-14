import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../db/sqlite/connection";
import { addDmKeyAsk, listDmKeyAsks } from "../db/sqlite/dmKeyAsks";
import { getUserByServerId, setUserDmKeyBinding, setUserDmKeyReset, setUserPersonKeyBinding, upsertUser } from "../db/sqlite/users";
import { resetDmKey } from "./resetDmKey";

let dir: string;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-reset-dm-key-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe("resetDmKey", () => {
  it("clears the keys, the pending reset and the asks, and only for that member", async () => {
    const stuck = await upsertUser("gryt-stuck", "Stuck");
    const other = await upsertUser("gryt-other", "Other");
    for (const u of [stuck, other]) {
      await setUserDmKeyBinding(u.server_user_id, "a.b.c");
      await setUserPersonKeyBinding(u.server_user_id, "d.e.f");
      await setUserDmKeyReset(u.server_user_id, "g.h.i", Date.now());
      await addDmKeyAsk(u.server_user_id, "g.h.i", "Laptop", Date.now());
    }

    assert.equal(await resetDmKey(stuck.server_user_id), true);

    const after = await getUserByServerId(stuck.server_user_id);
    assert.equal(after?.dm_key_binding, null);
    assert.equal(after?.person_key_binding, null);
    assert.equal(after?.dm_key_reset_binding, null);
    assert.equal(after?.dm_key_reset_at, null);
    assert.deepEqual(await listDmKeyAsks(stuck.server_user_id, Number.MAX_SAFE_INTEGER), []);

    const untouched = await getUserByServerId(other.server_user_id);
    assert.equal(untouched?.dm_key_binding, "a.b.c");
    assert.equal((await listDmKeyAsks(other.server_user_id, Number.MAX_SAFE_INTEGER)).length, 1);
  });

  it("says so when there's no such member", async () => {
    assert.equal(await resetDmKey("nobody"), false);
  });
});
