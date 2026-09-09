import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../db/sqlite/connection";
import { createServerConfigIfNotExists, getServerConfig } from "../db/sqlite/servers";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-server-name-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("the name a server is started with", () => {
  it("is written to the config row that startup creates", async () => {
    const { config } = await createServerConfigIfNotExists({
      displayName: "Rehearsal Room",
      description: "somewhere to try things",
      discoverable: false,
    });
    assert.equal(config.display_name, "Rehearsal Room");
    assert.equal(config.description, "somewhere to try things");
  });

  it("stays whatever the row already holds, once the row exists", async () => {
    // The environment seeds a first run and is ignored after it, which is the
    // reason a later call cannot be the one carrying the name.
    const { applied, config } = await createServerConfigIfNotExists({
      displayName: "Something Else",
    });
    assert.equal(applied, false);
    assert.equal(config.display_name, "Rehearsal Room");
    assert.equal((await getServerConfig())?.display_name, "Rehearsal Room");
  });
});

describe("startup", () => {
  /* The row is created here and nowhere else, so a name passed later is
     dropped. That was the bug. */
  const root = join(__dirname, "..");
  const index = readFileSync(join(root, "index.ts"), "utf8");
  /* From the call onwards: syncMdnsAdvertising is imported at the top too, so
     searching from zero finds the import and slices nothing. */
  const at = index.indexOf("await createServerConfigIfNotExists({");
  const startup = index.slice(at, index.indexOf("syncMdnsAdvertising", at));

  it("passes the name to the call that creates the row", () => {
    assert.match(startup, /displayName: process\.env\.SERVER_NAME/);
  });

  it("passes the description too, for the same reason", () => {
    assert.match(startup, /description: process\.env\.SERVER_DESCRIPTION/);
  });

  it("is the only place that seeds a name", () => {
    const join_ = readFileSync(join(root, "socket/handlers/join.ts"), "utf8");
    assert.doesNotMatch(
      join_,
      /createServerConfigIfNotExists\(\{[\s\S]{0,200}displayName/,
      "join.ts seeds a name again, into a call that returns early",
    );
  });
});
