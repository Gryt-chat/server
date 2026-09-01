import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { upsertServerChannel } from "../../db/sqlite/channels";
import { createPermissionScope, replacePermissionRules, setChannelPermissionScope } from "../../db/sqlite/channelScopes";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import { resetChannelPermissionCache } from "../../services/channelPermissions";
import type { Clients } from "../../types";
import { resetChannelIdCache } from "../utils/conversationAccess";
import type { EventHandlerMap, HandlerContext } from "./types";
import { registerVoiceHandlers } from "./voice";

/**
 * What the SFU is told this member may publish.
 *
 * `speak` is the one channel permission this server cannot enforce itself —
 * audio goes to the SFU, not here — so the whole gate is the capability list on
 * the token. If this handler mints a token granting `speak` to somebody the
 * scope denied, the SFU forwards their microphone and the permission is a
 * setting that does nothing. Nothing downstream would notice: the call works,
 * the UI shows the denial, and the person is audible.
 *
 * The SFU side is `internal/websocket/handler_speakgate_test.go`.
 */

const HOST = "voicespeak.test:5001";

let dir: string;

interface MintedToken {
  roomId: string;
  userId: string;
  capabilities: readonly string[];
}

const clientsInfo: Clients = {};

const io = {
  to() {
    return { emit() {} };
  },
  emit() {},
  sockets: { sockets: new Map() },
};

let seq = 0;

/**
 * A stand-in SFU that records what it was asked to mint and nothing else.
 *
 * The real one needs a socket to a running SFU. What is under test is the
 * argument, not the transport.
 */
function fakeSfu(minted: MintedToken[]) {
  return {
    isConnected: () => true,
    registerRoom: async () => {},
    generateClientJoinToken(roomId: string, userId: string, capabilities: readonly string[]) {
      minted.push({ roomId, userId, capabilities });
      return { room_id: roomId, server_id: "voice-speak-test", user_token: "stub", user_id: userId };
    },
  };
}

async function connectMember(nickname: string, roleId: string, minted: MintedToken[]) {
  seq += 1;
  const clientId = `speak-socket-${seq}`;
  const grytUserId = `account-speak-${seq}`;
  const user = await upsertUser(grytUserId, nickname);
  await setServerRole(user.server_user_id, roleId);

  const socket = {
    id: clientId,
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    emit() {
      return true;
    },
    join() {},
    leave() {},
    to() {
      return { emit() {} };
    },
  };

  clientsInfo[clientId] = {
    serverUserId: user.server_user_id,
    grytUserId,
    nickname,
    color: "#666666",
    isMuted: false,
    isDeafened: false,
    streamID: "",
    hasJoinedChannel: false,
    voiceChannelId: "",
    isAFK: false,
    cameraEnabled: false,
    cameraStreamID: "",
    screenShareEnabled: false,
    screenShareVideoStreamID: "",
    screenShareAudioStreamID: "",
    isServerMuted: false,
    isServerDeafened: false,
  } as Clients[string];

  const ctx = {
    io,
    socket,
    clientId,
    serverId: "voice-speak-test",
    clientsInfo,
    sfuClient: fakeSfu(minted),
    getClientIp: () => `10.2.0.${seq}`,
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  return { handlers: registerVoiceHandlers(ctx) as EventHandlerMap, serverUserId: user.server_user_id };
}

describe("the speak capability on a voice join token", () => {
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "gryt-voice-speak-"));
    process.env.DATA_DIR = dir;
    await initSqlite();
    await createServerConfigIfNotExists();

    await upsertServerChannel({ channelId: "open-room", name: "Open", type: "voice" });
    await upsertServerChannel({ channelId: "stage", name: "Stage", type: "voice" });

    // The announcement case: everybody hears, the member role does not talk.
    const scopeId = await createPermissionScope({ name: "Stage", isTemplate: true });
    await replacePermissionRules(scopeId, [{ roleId: "member", permission: "speak", effect: "deny" }]);
    await setChannelPermissionScope("stage", scopeId);

    resetChannelIdCache();
    resetChannelPermissionCache();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("grants speak in a channel that does not narrow it", async () => {
    const minted: MintedToken[] = [];
    const { handlers } = await connectMember("Open talker", "member", minted);

    await handlers["voice:room:request"]("open-room");

    assert.equal(minted.length, 1, "the handler should have asked for one token");
    assert.ok(minted[0].capabilities.includes("speak"), "an unscoped channel must still grant speak");
  });

  it("withholds speak where the scope denies it", async () => {
    const minted: MintedToken[] = [];
    const { handlers } = await connectMember("Stage listener", "member", minted);

    await handlers["voice:room:request"]("stage");

    assert.equal(minted.length, 1, "a denied member still joins, so a token is still minted");
    assert.ok(
      !minted[0].capabilities.includes("speak"),
      "a member denied speak must not be handed a token that grants it",
    );
  });

  it("still grants speak to a role the scope did not deny", async () => {
    const minted: MintedToken[] = [];
    const { handlers } = await connectMember("Stage host", "mod", minted);

    await handlers["voice:room:request"]("stage");

    assert.equal(minted.length, 1);
    assert.ok(
      minted[0].capabilities.includes("speak"),
      "the deny is on member, so a moderator keeps speaking",
    );
  });

  // The mistake this is really guarding: `mayInChannel` has to be asked about
  // the channel, not about the SFU's name for the room. `sfuRoomId` folds the
  // server id in, so the id handed to the SFU matches no scope at all — asking
  // with it answers from the server-wide permission and quietly grants speak to
  // everybody, in every channel, with the UI still showing the denial.
  it("asks about the channel rather than the SFU room id", async () => {
    const minted: MintedToken[] = [];
    const { handlers } = await connectMember("Stage listener two", "member", minted);

    await handlers["voice:room:request"]("stage");

    assert.notEqual(minted[0].roomId, "stage", "the SFU is given its own room id, not the channel id");
    assert.ok(
      !minted[0].capabilities.includes("speak"),
      "the scope was still consulted, so the lookup used the channel id",
    );
  });
});
