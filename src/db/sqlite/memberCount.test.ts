import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "./connection";
import { getRegisteredUserCount, setUserInactive, upsertUser } from "./users";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-member-count-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("the member count behind the join preview", () => {
  it("counts everyone who has joined", async () => {
    await upsertUser("key:ada", "Ada");
    await upsertUser("key:bo", "Bo");

    assert.equal(await getRegisteredUserCount(), 2);
  });

  it("stops counting somebody once they leave", async () => {
    // The row stays behind, which is why "N members" in the Add a server
    // dialog used to keep climbing after people left.
    const cy = await upsertUser("key:cy", "Cy");
    assert.equal(await getRegisteredUserCount(), 3);

    await setUserInactive(cy.server_user_id);

    assert.equal(await getRegisteredUserCount(), 2);
  });

  it("counts them again when they rejoin", async () => {
    await upsertUser("key:cy", "Cy");

    assert.equal(await getRegisteredUserCount(), 3);
  });
});
