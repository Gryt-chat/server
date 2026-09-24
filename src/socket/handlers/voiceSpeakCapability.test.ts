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
 * Audio never reaches this server, so the capability list on the token is the
 * whole gate. The SFU side is `handler_speakgate_test.go` and `handler_videogate_test.go`.
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

/** Records what it was asked to mint and nothing else: the argument is what is
    under test, not the transport. */
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

describe("the capabilities on a voice join token", () => {
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

    // Talk, share a screen, but no cameras for members (GRYT-1417).
    await upsertServerChannel({ channelId: "no-cameras", name: "No cameras", type: "voice" });
    const noCameras = await createPermissionScope({ name: "No cameras", isTemplate: true });
    await replacePermissionRules(noCameras, [{ roleId: "member", permission: "share_video", effect: "deny" }]);
    await setChannelPermissionScope("no-cameras", noCameras);

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

  // `sfuRoomId` folds the server id in and matches no scope, so asking with it
  // answers server-wide and grants speak to everybody, in every channel.
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

  // Without the marker an SFU reads a missing video capability as allowed, so
  // it has to be on every token this server mints, denied or not.
  it("grants both video capabilities, and says it decided them", async () => {
    const minted: MintedToken[] = [];
    const { handlers } = await connectMember("Open sharer", "member", minted);

    await handlers["voice:room:request"]("open-room");

    for (const cap of ["video_checked", "share_video", "share_screen"]) {
      assert.ok(minted[0].capabilities.includes(cap), `an unscoped channel must carry ${cap}`);
    }
  });

  it("withholds share_video where the scope denies it, and nothing else", async () => {
    const minted: MintedToken[] = [];
    const { handlers } = await connectMember("Camera-shy member", "member", minted);

    await handlers["voice:room:request"]("no-cameras");

    const caps = minted[0].capabilities;
    assert.ok(caps.includes("video_checked"), "the marker is what makes the missing capability a denial");
    assert.ok(!caps.includes("share_video"), "a member denied share_video must not be handed it");
    assert.ok(caps.includes("share_screen"), "the deny is on the camera only");
    assert.ok(caps.includes("speak"), "and does not touch the microphone");
  });

  it("still grants share_video to a role the scope did not deny", async () => {
    const minted: MintedToken[] = [];
    const { handlers } = await connectMember("Camera mod", "mod", minted);

    await handlers["voice:room:request"]("no-cameras");

    assert.ok(minted[0].capabilities.includes("share_video"));
  });
});
