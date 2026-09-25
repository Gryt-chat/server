import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { upsertServerChannel } from "../../db/sqlite/channels";
import { createPermissionScope, replacePermissionRules, setChannelPermissionScope } from "../../db/sqlite/channelScopes";
import { createRoleDefinition } from "../../db/sqlite/roleDefinitions";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import { resetChannelPermissionCache } from "../../services/channelPermissions";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { registerAdminChannelHandlers } from "../handlers/adminChannels";
import type { HandlerContext } from "../handlers/types";
import {
  pushVoiceCapabilities,
  pushVoiceCapabilitiesFor,
  setVoiceCapabilityRefs,
} from "./voiceCapabilities";

/**
 * GRYT-1426. The SFU reads capabilities off the join token, so a permission
 * changed mid-call has to be sent to it again, and only when it moved.
 */

const SERVER = "livecaps";
const CHANNEL = "hangout";
const ROOM = `${SERVER}_${CHANNEL}`;
const HOST = "livecaps.test";

let dir: string;
let scopeId: string;
let member: { serverUserId: string; grytUserId: string };
let owner: { serverUserId: string; grytUserId: string; accessToken: string };
let sent: { roomId: string; userId: string; capabilities: readonly string[] }[];
let clientsInfo: Clients;
let active: Map<string, { roomId: string; userId: string }>;

async function deny(...permissions: string[]) {
  await replacePermissionRules(scopeId, permissions.map((permission) => ({ roleId: "member", permission, effect: "deny" })));
  resetChannelPermissionCache();
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-livecaps-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  await upsertServerChannel({ channelId: CHANNEL, name: "Hangout", type: "voice" });
  scopeId = await createPermissionScope({ name: "Hangout rules", isTemplate: true });
  await setChannelPermissionScope(CHANNEL, scopeId);

  const user = await upsertUser("account-livecaps-member", "Camera person");
  await setServerRole(user.server_user_id, "member");
  member = { serverUserId: user.server_user_id, grytUserId: "account-livecaps-member" };

  await createRoleDefinition("livecaps-admin", { name: "Admin", rank: 90, permissions: ["manage_channels", "manage_roles"] });
  const admin = await upsertUser("account-livecaps-admin", "Admin");
  await setServerRole(admin.server_user_id, "livecaps-admin");
  owner = {
    serverUserId: admin.server_user_id,
    grytUserId: "account-livecaps-admin",
    accessToken: generateAccessToken({
      grytUserId: "account-livecaps-admin",
      serverUserId: admin.server_user_id,
      nickname: "Admin",
      serverHost: HOST,
      tokenVersion: 0,
    }),
  };
});

after(() => {
  setVoiceCapabilityRefs(null);
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await deny();
  sent = [];
  clientsInfo = {
    "sock-member": {
      serverUserId: member.serverUserId,
      grytUserId: member.grytUserId,
      nickname: "Camera person",
      hasJoinedChannel: true,
      voiceChannelId: CHANNEL,
      isMuted: false,
      cameraEnabled: true,
      cameraStreamID: "cam-stream",
      screenShareEnabled: true,
      screenShareVideoStreamID: "screen-v",
      screenShareAudioStreamID: "screen-a",
    } as unknown as Clients[string],
  };
  active = new Map([[member.serverUserId, { roomId: ROOM, userId: member.serverUserId }]]);
  const io = { to: () => ({ emit() {} }), emit() {}, sockets: { sockets: new Map() } };
  setVoiceCapabilityRefs({
    io: io as unknown as HandlerContext["io"],
    clientsInfo,
    serverId: SERVER,
    sfu: {
      getActiveUsers: () => active,
      async setUserCapabilities(roomId, userId, capabilities) {
        sent.push({ roomId, userId, capabilities });
      },
    },
  });
});

describe("pushing voice capabilities to the SFU", () => {
  it("sends what the member may do in the room they are in", async () => {
    await pushVoiceCapabilities();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].roomId, ROOM, "the SFU's room id, not the channel id");
    assert.equal(sent[0].userId, member.serverUserId);
    assert.deepEqual([...sent[0].capabilities].sort(), ["share_screen", "share_video", "speak", "video_checked"]);
  });

  it("sends nothing to somebody whose answer did not move", async () => {
    await pushVoiceCapabilities();
    await pushVoiceCapabilities();
    assert.equal(sent.length, 1, "a settings or icon change must not re-send every member");
  });

  it("takes share_video away, and turns the camera off in the member list", async () => {
    await pushVoiceCapabilities();
    await deny("share_video");
    await pushVoiceCapabilities();

    assert.equal(sent.length, 2);
    const caps = sent[1].capabilities;
    assert.ok(!caps.includes("share_video"), "the camera must be withdrawn");
    assert.ok(caps.includes("video_checked"), "without the marker the SFU reads a missing capability as allowed");
    assert.ok(caps.includes("share_screen") && caps.includes("speak"), "and only the camera");

    const ci = clientsInfo["sock-member"];
    assert.equal(ci.cameraEnabled, false);
    assert.equal(ci.cameraStreamID, "");
    assert.equal(ci.screenShareEnabled, true, "the share was not taken");
  });

  it("gives share_video back", async () => {
    await deny("share_video");
    await pushVoiceCapabilities();
    await deny();
    await pushVoiceCapabilities();
    assert.ok(sent.at(-1)!.capabilities.includes("share_video"));
  });

  it("takes speak away and records the member as muted", async () => {
    await deny("speak");
    await pushVoiceCapabilities();
    assert.ok(!sent[0].capabilities.includes("speak"));
    assert.equal(clientsInfo["sock-member"].isMuted, true);
  });

  it("takes share_screen away and ends the share in the member list", async () => {
    await deny("share_screen");
    await pushVoiceCapabilities();
    assert.equal(clientsInfo["sock-member"].screenShareEnabled, false);
    assert.equal(clientsInfo["sock-member"].screenShareVideoStreamID, "");
  });

  // The join race: a change after the token was minted but before the peer
  // reached the SFU found nobody there. peer_joined sends it again.
  it("always sends on peer_joined, changed or not", async () => {
    await pushVoiceCapabilities();
    await pushVoiceCapabilitiesFor(ROOM, member.serverUserId);
    assert.equal(sent.length, 2);
  });

  it("leaves the doctor's room of one alone", async () => {
    await deny("speak");
    await pushVoiceCapabilitiesFor(`${SERVER}_doctor:${member.serverUserId}`, member.serverUserId);
    assert.equal(sent.length, 0, "the doctor room always speaks and answers to no channel");
  });

  it("follows a scope change made through the admin handler", async () => {
    // The channel starts on no rules, and the owner points it at a template that denies cameras.
    await setChannelPermissionScope(CHANNEL, null);
    await deny("share_video");
    await pushVoiceCapabilities();
    assert.ok(sent[0].capabilities.includes("share_video"), "no scope yet, so the camera is allowed");
    const socket = {
      id: "sock-admin",
      handshake: { headers: { host: HOST }, address: "127.0.0.1" },
      rooms: new Set<string>(["verifiedClients"]),
      emit() { return true; },
      join() {},
      leave() {},
      to() { return { emit() {} }; },
    };
    clientsInfo["sock-admin"] = { serverUserId: owner.serverUserId, grytUserId: owner.grytUserId, nickname: "Admin" } as unknown as Clients[string];
    const ctx = {
      io: { sockets: { sockets: new Map([["sock-admin", socket]]) }, to: () => ({ emit() {} }), emit() {} },
      socket,
      clientId: "sock-admin",
      serverId: SERVER,
      clientsInfo,
      sfuClient: null,
      getClientIp: () => "127.0.0.1",
      clientAddressIsOwn: () => true,
    } as unknown as HandlerContext;

    await registerAdminChannelHandlers(ctx)["server:channels:scope:set"]({
      accessToken: owner.accessToken,
      channelId: CHANNEL,
      templateId: scopeId,
    });
    // Not pushed here: the handler has to have done it on its own.
    for (let waited = 0; sent.length < 2 && waited < 2000; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(sent.length, 2, "the scope change should have pushed once");
    assert.ok(!sent[1].capabilities.includes("share_video"));
  });
});
