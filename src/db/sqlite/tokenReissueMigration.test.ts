import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { requireAuth } from "../../socket/middleware/auth";
import { registerJoinHelpers } from "../../socket/handlers/joinHelpers";
import type { HandlerContext } from "../../socket/handlers/types";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { getSqliteDb, initSqlite } from "./connection";
import { createServerConfigIfNotExists, setServerRole } from "./servers";
import { createRefreshToken } from "./tokens";
import { upsertUser } from "./users";
import { reissueAccessTokensAfterLeak, TOKEN_REISSUE_MIGRATION_KEY } from "./tokenReissueMigration";

/**
 * The one-shot that retires access tokens leaked before GRYT-1239, and proof it
 * fires once, spares a fresh install, and refuses the old token afterwards.
 */

const HOST = "reissue.test:5001";

let dir: string;

function tokenVersion(): number {
  const row = getSqliteDb().prepare(`SELECT token_version FROM server_config`).get() as
    | { token_version: number }
    | undefined;
  return row?.token_version ?? 0;
}

function marker(): string | null {
  const row = getSqliteDb().prepare(`SELECT value FROM schema_meta WHERE key = ?`).get(TOKEN_REISSUE_MIGRATION_KEY) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/** initSqlite has already run the migration once against the empty database, so
    every test starts from a clean slate: no marker, and the counter at zero. */
beforeEach(() => {
  const db = getSqliteDb();
  db.prepare(`DELETE FROM schema_meta WHERE key = ?`).run(TOKEN_REISSUE_MIGRATION_KEY);
  db.prepare(`UPDATE server_config SET token_version = 0`).run();
  db.prepare(`DELETE FROM users`).run();
});

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-reissue-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
});

after(() => {
  delete process.env.DATA_DIR;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file open past the run.
  }
});

describe("retiring the leaked access tokens", () => {
  it("bumps the counter once on a server that had members", async () => {
    await upsertUser("account-alice", "Alice");
    assert.equal(tokenVersion(), 0);

    const to = reissueAccessTokensAfterLeak(getSqliteDb());
    assert.equal(to, 1);
    assert.equal(tokenVersion(), 1);
    assert.ok(marker(), "the marker was not written");
  });

  it("does nothing on the second boot", async () => {
    await upsertUser("account-alice", "Alice");
    reissueAccessTokensAfterLeak(getSqliteDb());
    assert.equal(tokenVersion(), 1);

    const again = reissueAccessTokensAfterLeak(getSqliteDb());
    assert.equal(again, null, "it ran a second time");
    assert.equal(tokenVersion(), 1, "the second run bumped the counter again");
  });

  it("spares a fresh install that never had a member", () => {
    assert.equal(tokenVersion(), 0);
    const to = reissueAccessTokensAfterLeak(getSqliteDb());
    assert.equal(to, null, "it bumped a database nobody had joined");
    assert.equal(tokenVersion(), 0);
    assert.ok(marker(), "the marker must still be set, so it never reconsiders");
  });
});

/** A fake socket that records what it was emitted, enough for requireAuth and the
    token:refresh handler. */
function fakeSocket() {
  const emitted: { event: string; payload?: unknown }[] = [];
  const socket = {
    id: "sock-alice",
    rooms: new Set<string>(["sock-alice"]),
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    emit(event: string, payload?: unknown) {
      emitted.push({ event, payload });
      return true;
    },
    join() {},
    leave() {},
    to: () => ({ emit() {} }),
  };
  return { socket, emitted };
}

describe("what the bump does to the tokens that leaked", () => {
  let serverUserId: string;
  let oldAccessToken: string;

  beforeEach(async () => {
    const alice = await upsertUser("account-alice", "Alice");
    serverUserId = alice.server_user_id;
    await setServerRole(serverUserId, "member");
    // Minted at the version before the bump, the way a captured token was.
    oldAccessToken = generateAccessToken({
      grytUserId: "account-alice",
      serverUserId,
      nickname: "Alice",
      serverHost: HOST,
      tokenVersion: 0,
      userTokenVersion: alice.token_version ?? 0,
    });
    reissueAccessTokensAfterLeak(getSqliteDb());
    assert.equal(tokenVersion(), 1);
  });

  it("refuses the old access token at requireAuth", async () => {
    const { socket, emitted } = fakeSocket();
    const auth = await requireAuth(socket as never, { accessToken: oldAccessToken });
    assert.equal(auth, null, "requireAuth accepted a token from before the bump");
    assert.ok(
      emitted.some((e) => e.event === "token:revoked" && (e.payload as { reason?: string })?.reason === "token_version_mismatch"),
      `expected token:revoked, got ${JSON.stringify(emitted)}`,
    );
  });

  it("refuses the old access token at token:refresh", async () => {
    const { socket, emitted } = fakeSocket();
    const clientsInfo: Clients = {
      "sock-alice": { serverUserId, grytUserId: "account-alice", nickname: "Alice" } as Clients[string],
    };
    const ctx = {
      io: { sockets: { sockets: new Map() }, to: () => ({ emit() {} }), emit() {} },
      socket,
      clientId: "sock-alice",
      serverId: "reissue-test",
      clientsInfo,
      sfuClient: null,
      getClientIp: () => "127.0.0.1",
      clientAddressIsOwn: () => true,
    } as unknown as HandlerContext;

    await registerJoinHelpers(ctx)["token:refresh"]({ accessToken: oldAccessToken });
    assert.ok(
      emitted.some((e) => e.event === "token:revoked"),
      `token:refresh renewed a stale token: ${JSON.stringify(emitted)}`,
    );
    assert.ok(
      !emitted.some((e) => e.event === "token:refreshed"),
      "token:refresh handed back a fresh token for a stale one",
    );
  });

  it("still mints a fresh access token from a refresh token", async () => {
    const { socket, emitted } = fakeSocket();
    const record = await createRefreshToken({ grytUserId: "account-alice", serverUserId });
    const clientsInfo: Clients = {
      "sock-alice": { serverUserId, grytUserId: "account-alice", nickname: "Alice", isServerMuted: false, isServerDeafened: false } as Clients[string],
    };
    const ctx = {
      io: { sockets: { sockets: new Map() }, to: () => ({ emit() {} }), emit() {} },
      socket,
      clientId: "sock-alice",
      serverId: "reissue-test",
      clientsInfo,
      sfuClient: null,
      getClientIp: () => "127.0.0.1",
      clientAddressIsOwn: () => true,
    } as unknown as HandlerContext;

    await registerJoinHelpers(ctx)["token:refresh"]({ refreshToken: record.token_id });
    const refreshed = emitted.find((e) => e.event === "token:refreshed")?.payload as { accessToken?: string } | undefined;
    assert.ok(refreshed?.accessToken, `a refresh token did not mint a new access token: ${JSON.stringify(emitted)}`);

    // The new token carries the current version, so it is accepted where the old one was refused.
    const { socket: s2, emitted: e2 } = fakeSocket();
    const auth = await requireAuth(s2 as never, { accessToken: refreshed.accessToken });
    assert.ok(auth, `the freshly minted token was refused: ${JSON.stringify(e2)}`);
  });
});
