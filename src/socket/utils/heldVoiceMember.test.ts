import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { createServerConfigIfNotExists } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import { buildMemberList } from "./clients";
import { stashedVoiceState, voiceStateOf } from "./voiceStash";
import type { Clients } from "../../types";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-heldvoice-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
});

after(() => {
  stashedVoiceState.clear();
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("a member whose socket dropped mid-call", () => {
  it("stays in voice under the stream id the call still carries", async () => {
    const user = await upsertUser("account-held-1", "Justin");
    const ci = {
      serverUserId: user.server_user_id,
      nickname: "Justin",
      voiceChannelId: "lounge",
      streamID: "stream-justin",
      hasJoinedChannel: true,
      isMuted: true,
      isDeafened: false,
    } as Clients[string];
    stashedVoiceState.set(user.server_user_id, voiceStateOf(ci));

    const row = (await buildMemberList({})).find((m) => m.serverUserId === user.server_user_id);
    assert.equal(row?.status, "in_voice");
    assert.equal(row?.streamID, "stream-justin");
    assert.equal(row?.voiceChannelId, "lounge");
    assert.equal(row?.hasJoinedChannel, true);
    assert.equal(row?.isMuted, true);

    stashedVoiceState.delete(user.server_user_id);
    const gone = (await buildMemberList({})).find((m) => m.serverUserId === user.server_user_id);
    assert.equal(gone?.status, "offline");
    assert.equal(gone?.streamID, "");
  });
});
