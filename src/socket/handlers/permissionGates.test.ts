import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { PERMISSIONS, type Permission } from "../../constants/permissions";
import { initSqlite } from "../../db/sqlite/connection";
import {
  createRoleDefinition,
  listRoleDefinitions,
} from "../../db/sqlite/roleDefinitions";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import { generateAccessToken } from "../../utils/jwt";
import type { Clients } from "../../types";
import { registerAdminHandlers } from "./admin";
import { registerChatHandlers } from "./chat";
import { registerDirectMessageHandlers } from "./dm";
import { registerMemberHandlers } from "./members";
import { registerReportHandlers } from "./reports";
import type { EventHandlerMap, HandlerContext } from "./types";
import { registerVoiceHandlers } from "./voice";

/**
 * Every gate, driven twice.
 *
 * The point of this file is one property: an event that names a permission must
 * refuse a role without it, and must not refuse a role with it. That sounds
 * obvious enough not to need testing until you notice how a gate actually gets
 * broken — a permission renamed in the catalogue and not at the call site, a
 * handler that checks the caller and forgets the target, a new event added
 * beside an old one and gated by copy-paste from the wrong neighbour. None of
 * those fail to compile.
 *
 * Drives the handler functions directly rather than over a socket. There is no
 * network here and no socket.io: `requireAuth` wants a token and a `host`
 * header, both of which are a few lines to fake, and what is being tested is
 * the decision rather than the transport.
 *
 * The permitted half asserts "not refused" rather than "succeeded". Past the
 * gate the handler does its real work against a database with almost nothing in
 * it, so most of them fail on the next line for reasons that are not about
 * permissions. `forbidden` is the answer that means the gate fired.
 */

const HOST = "gates.test:5001";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-gates-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  // requireAuth refuses everything when there is no config row, which would
  // make the permitted half of this file pass without ever reaching a gate.
  await createServerConfigIfNotExists();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
  if (process.env.GRYT_TEST_HANDLES) {
    console.log("ACTIVE HANDLES:", process.getActiveResourcesInfo());
  }
});

interface Emitted {
  event: string;
  payload: unknown;
}

function makeContext(): { ctx: HandlerContext; emitted: Emitted[]; clientsInfo: Clients } {
  const emitted: Emitted[] = [];
  const clientId = "socket-under-test";

  const socket = {
    id: clientId,
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    emit(event: string, payload?: unknown) {
      emitted.push({ event, payload });
      return true;
    },
    join() {},
    leave() {},
    to() {
      return { emit() {} };
    },
  };

  const io = {
    to() {
      return { emit() {} };
    },
    emit() {},
    sockets: { sockets: new Map() },
  };

  const clientsInfo: Clients = {};

  const ctx = {
    io,
    socket,
    clientId,
    serverId: "gates-test",
    clientsInfo,
    sfuClient: null,
    getClientIp: () => "127.0.0.1",
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  return { ctx, emitted, clientsInfo };
}

function allHandlers(ctx: HandlerContext): EventHandlerMap {
  return {
    ...registerAdminHandlers(ctx),
    ...registerChatHandlers(ctx),
    ...registerDirectMessageHandlers(ctx),
    ...registerMemberHandlers(ctx),
    ...registerReportHandlers(ctx),
    ...registerVoiceHandlers(ctx),
  };
}

/**
 * A member holding exactly the permissions given, and nothing else.
 *
 * One throwaway role and one throwaway user per case, so a refusal can never be
 * a leftover from the case before — and so the rank checks see a role well
 * below the target's, which is what a real non-owner moderator looks like.
 */
let seq = 0;
async function memberWith(permissions: Permission[]): Promise<{
  accessToken: string;
  serverUserId: string;
  grytUserId: string;
}> {
  seq += 1;
  const roleId = `probe-${seq}`;
  const grytUserId = `account-probe-${seq}`;

  await createRoleDefinition(roleId, { name: `Probe ${seq}`, rank: 50, permissions });
  const user = await upsertUser(grytUserId, `Probe ${seq}`);
  await setServerRole(user.server_user_id, roleId);

  return {
    accessToken: generateAccessToken({
      grytUserId,
      serverUserId: user.server_user_id,
      nickname: `Probe ${seq}`,
      serverHost: HOST,
      tokenVersion: 0,
    }),
    serverUserId: user.server_user_id,
    grytUserId,
  };
}

function refusals(emitted: Emitted[]): { message?: string; permission?: string }[] {
  return emitted
    .map((e) => e.payload as { error?: string; message?: string; permission?: string })
    .filter((p) => p && typeof p === "object" && p.error === "forbidden");
}

/**
 * Events that carry an access token, which is most of them.
 *
 * `payload` is whatever else the handler needs to get as far as the gate. It is
 * deliberately minimal — anything past the gate is not what is under test.
 */
const TOKEN_GATES: {
  event: string;
  permission: Permission;
  payload?: Record<string, unknown>;
  /**
   * Refusal only. Past the gate this handler reaches the network, and a test
   * that calls out to GitHub is a test that fails when GitHub is slow. The
   * refusal half is what proves the gate is there and named right; the
   * permitted half would only prove it does not fire.
   */
  refusalOnly?: boolean;
}[] = [
  { event: "chat:send", permission: "send_messages", payload: { conversationId: "general", text: "hi" } },
  { event: "dm:open", permission: "send_direct_messages", payload: { targetServerUserId: "user_x" } },
  { event: "chat:react", permission: "add_reactions", payload: { conversationId: "general", messageId: "m1", reactionSrc: "👍" } },
  { event: "chat:report", permission: "report_messages", payload: { conversationId: "general", messageId: "m1" } },
  { event: "reports:list", permission: "view_reports" },
  { event: "reports:resolve", permission: "manage_reports", payload: { messageId: "m1", conversationId: "general", action: "approve" } },
  { event: "server:settings:update", permission: "manage_server", payload: { displayName: "x" } },
  { event: "server:invites:list", permission: "manage_invites" },
  { event: "server:invites:create", permission: "create_invite" },
  { event: "server:invites:revoke", permission: "manage_invites", payload: { code: "abc" } },
  { event: "server:joinRequests:list", permission: "manage_join_requests" },
  { event: "server:joinRequests:decide", permission: "manage_join_requests", payload: { grytUserId: "someone", decision: "approved" } },
  { event: "server:roles:list", permission: "manage_roles" },
  { event: "server:roles:set", permission: "manage_roles", payload: { serverUserId: "user_x", role: "member" } },
  { event: "server:roles:definitions:list", permission: "manage_roles" },
  { event: "server:roles:definitions:save", permission: "manage_roles", payload: { roleId: "made-up", name: "Made up" } },
  { event: "server:roles:definitions:delete", permission: "manage_roles", payload: { roleId: "made-up" } },
  { event: "server:roles:defaults:set", permission: "manage_roles", payload: { accountRoleId: "member" } },
  { event: "server:kick", permission: "kick_members", payload: { targetServerUserId: "user_x" } },
  { event: "server:ban", permission: "ban_members", payload: { targetServerUserId: "user_x" } },
  { event: "server:unban", permission: "ban_members", payload: { grytUserId: "someone" } },
  { event: "server:bans:list", permission: "view_bans" },
  { event: "server:mute", permission: "mute_members", payload: { targetServerUserId: "user_x", muted: true } },
  { event: "server:deafen", permission: "deafen_members", payload: { targetServerUserId: "user_x", deafened: true } },
  { event: "voice:disconnect:user", permission: "disconnect_members", payload: { targetServerUserId: "user_x" } },
  { event: "server:emojiQueue:get", permission: "manage_emojis" },
  { event: "server:channels:upsert", permission: "manage_channels", payload: { channelId: "c1", name: "c", type: "text" } },
  { event: "server:channels:delete", permission: "manage_channels", payload: { channelId: "c1" } },
  { event: "server:channels:reorder", permission: "manage_channels", payload: { order: [] } },
  { event: "server:sidebar:item:upsert", permission: "manage_sidebar", payload: { itemId: "i1", kind: "separator" } },
  { event: "server:sidebar:item:delete", permission: "manage_sidebar", payload: { itemId: "i1" } },
  { event: "server:sidebar:reorder", permission: "manage_sidebar", payload: { order: [] } },
  { event: "server:user:replace", permission: "replace_identity", payload: { targetServerUserId: "user_x", newGrytUserId: "account-new" } },
  { event: "server:audit:list", permission: "view_audit_log" },
  { event: "server:version:check", permission: "view_server_status", refusalOnly: true },
  { event: "server:member:invite", permission: "create_invite", payload: { targetServerUserId: "user_x" } },
  { event: "server:bots:list", permission: "manage_bots" },
  { event: "server:bots:decide", permission: "manage_bots", payload: { botId: "BOT_x", decision: "denied" } },
  { event: "server:bots:register", permission: "manage_bots", payload: { nickname: "Probe" } },
  { event: "server:bots:update", permission: "manage_bots", payload: { registrationId: "nope" } },
  { event: "server:bots:revoke", permission: "manage_bots", payload: { registrationId: "nope" } },
  { event: "server:bots:policy:set", permission: "manage_bots", payload: { policy: "disabled" } },
];

describe("every gated event refuses a role without the permission", () => {
  for (const { event, permission, payload } of TOKEN_GATES) {
    it(`${event} needs ${permission}`, async () => {
      const { ctx, emitted } = makeContext();
      const handlers = allHandlers(ctx);
      const handler = handlers[event];
      assert.ok(handler, `no handler registered for ${event}`);

      // Everything except the one under test, so a gate that happens to check
      // the wrong permission shows up as a pass where there should be a
      // refusal — rather than being hidden by a caller who has nothing.
      const without = PERMISSIONS.filter((p) => p !== permission);
      const caller = await memberWith([...without]);

      await handler({ accessToken: caller.accessToken, ...(payload ?? {}) });

      const refused = refusals(emitted);
      assert.equal(
        refused.length >= 1,
        true,
        `${event} allowed a caller holding every permission except ${permission}`,
      );
      assert.equal(
        refused.some((r) => r.permission === permission),
        true,
        `${event} refused, but named ${JSON.stringify(refused.map((r) => r.permission))} rather than ${permission}`,
      );
    });
  }
});

describe("every gated event lets a role with the permission through", () => {
  for (const { event, permission, payload, refusalOnly } of TOKEN_GATES) {
    if (refusalOnly) continue;
    it(`${event} accepts ${permission}`, async () => {
      const { ctx, emitted } = makeContext();
      const handlers = allHandlers(ctx);
      const handler = handlers[event];
      assert.ok(handler, `no handler registered for ${event}`);

      const caller = await memberWith([permission]);
      await handler({ accessToken: caller.accessToken, ...(payload ?? {}) });

      // Past the gate the handler runs for real against an almost-empty
      // database, so it may well fail — on a missing target, a made-up invite
      // code, a role that does not exist. What it must not do is refuse for
      // want of the permission it was just given.
      const named = refusals(emitted).filter((r) => r.permission === permission);
      assert.equal(
        named.length,
        0,
        `${event} refused a caller who holds ${permission}: ${JSON.stringify(named)}`,
      );
    });
  }
});

describe("events that read the socket rather than a token", () => {
  /**
   * `chat:fetch`, `members:fetch` and the voice state stream carry no access
   * token — they come off a socket that has already joined. So the caller is
   * `clientsInfo`, and the gate has to read from there.
   */
  async function socketCaller(permissions: Permission[], clientsInfo: Clients, clientId: string) {
    const caller = await memberWith(permissions);
    clientsInfo[clientId] = {
      serverUserId: caller.serverUserId,
      grytUserId: caller.grytUserId,
      nickname: "Probe",
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
    };
    return caller;
  }

  it("chat:fetch needs read_messages", async () => {
    const { ctx, emitted, clientsInfo } = makeContext();
    await socketCaller([], clientsInfo, ctx.clientId);
    await registerChatHandlers(ctx)["chat:fetch"]({ conversationId: "general" });
    assert.equal(refusals(emitted).some((r) => r.permission === "read_messages"), true);
  });

  it("chat:fetch answers a role that has it", async () => {
    const { ctx, emitted, clientsInfo } = makeContext();
    await socketCaller(["read_messages"], clientsInfo, ctx.clientId);
    await registerChatHandlers(ctx)["chat:fetch"]({ conversationId: "general" });
    assert.equal(refusals(emitted).length, 0);
  });

  it("members:fetch says nothing without view_members", async () => {
    const { ctx, emitted, clientsInfo } = makeContext();
    await socketCaller([], clientsInfo, ctx.clientId);
    await registerMemberHandlers(ctx)["members:fetch"]();
    assert.equal(emitted.some((e) => e.event === "members:list"), false);
  });

  it("members:fetch answers a role that has it", async () => {
    const { ctx, emitted, clientsInfo } = makeContext();
    await socketCaller(["view_members"], clientsInfo, ctx.clientId);
    await registerMemberHandlers(ctx)["members:fetch"]();
    assert.equal(emitted.some((e) => e.event === "members:list"), true);
  });

  it("voice:camera:state needs share_video", async () => {
    const { ctx, emitted, clientsInfo } = makeContext();
    await socketCaller(["join_voice"], clientsInfo, ctx.clientId);
    await registerVoiceHandlers(ctx)["voice:camera:state"]({ enabled: true });
    assert.equal(refusals(emitted).some((r) => r.permission === "share_video"), true);
    assert.equal(clientsInfo[ctx.clientId].cameraEnabled, false);
  });

  it("voice:screen:state needs share_screen", async () => {
    const { ctx, emitted, clientsInfo } = makeContext();
    await socketCaller(["join_voice"], clientsInfo, ctx.clientId);
    await registerVoiceHandlers(ctx)["voice:screen:state"]({ enabled: true });
    assert.equal(refusals(emitted).some((r) => r.permission === "share_screen"), true);
    assert.equal(clientsInfo[ctx.clientId].screenShareEnabled, false);
  });

  it("turning a camera off is never refused", async () => {
    // A permission taken away mid-call must not leave somebody unable to stop
    // streaming.
    const { ctx, emitted, clientsInfo } = makeContext();
    await socketCaller([], clientsInfo, ctx.clientId);
    clientsInfo[ctx.clientId].cameraEnabled = true;
    await registerVoiceHandlers(ctx)["voice:camera:state"]({ enabled: false });
    assert.equal(refusals(emitted).length, 0);
    assert.equal(clientsInfo[ctx.clientId].cameraEnabled, false);
  });

  /**
   * A socket mid-restore is not a socket that has been refused (GRYT-647).
   *
   * On a reconnect the client sends `session:restore` and its voice
   * re-announce together and they race. Caught on prod three milliseconds
   * apart: `voice:room:request` arrived while the socket still held its
   * `temp_<id>` placeholder, every gate read that as no permissions, and the
   * server said `forbidden`.
   *
   * `forbidden` is the one answer the client will not retry, because a
   * permission decision does not change if you ask again. This one changed
   * three milliseconds later. So the assertions below are about the *code*
   * rather than about being refused: refusing is right, saying `forbidden` is
   * what put people out of the channel.
   */
  function unidentifiedCaller(clientsInfo: Clients, clientId: string) {
    clientsInfo[clientId] = {
      ...clientsInfo[clientId],
      serverUserId: `temp_${clientId}`,
      grytUserId: undefined,
    } as Clients[string];
  }

  function codes(emitted: Emitted[]): string[] {
    return emitted
      .map((e) => (e.payload as { error?: string })?.error)
      .filter((c): c is string => typeof c === "string");
  }

  it("voice:room:request tells an unidentified socket to retry, not that it is forbidden", async () => {
    const { ctx, emitted, clientsInfo } = makeContext();
    await socketCaller(["join_voice"], clientsInfo, ctx.clientId);
    unidentifiedCaller(clientsInfo, ctx.clientId);

    await registerVoiceHandlers(ctx)["voice:room:request"]("chan_probe");

    assert.equal(codes(emitted).includes("unidentified"), true);
    assert.equal(
      refusals(emitted).length,
      0,
      "forbidden is the one code the client will not retry",
    );
  });

  it("voice:channel:joined does the same", async () => {
    const { ctx, emitted, clientsInfo } = makeContext();
    await socketCaller(["join_voice"], clientsInfo, ctx.clientId);
    unidentifiedCaller(clientsInfo, ctx.clientId);

    await registerVoiceHandlers(ctx)["voice:channel:joined"](true);

    assert.equal(codes(emitted).includes("unidentified"), true);
    assert.equal(refusals(emitted).length, 0);
    assert.equal(clientsInfo[ctx.clientId].hasJoinedChannel, false);
  });

  it("voice:camera:state tells an unidentified socket to retry, not that it is forbidden", async () => {
    // What the client does on a reconnect: it says the camera is still on. The
    // socket is mid-restore, so `forbidden` here is a state the client will not
    // re-send — and the camera goes on sending while the room sees it as off.
    const { ctx, emitted, clientsInfo } = makeContext();
    await socketCaller(["share_video"], clientsInfo, ctx.clientId);
    unidentifiedCaller(clientsInfo, ctx.clientId);

    await registerVoiceHandlers(ctx)["voice:camera:state"]({ enabled: true, streamId: "cam_1" });

    assert.equal(codes(emitted).includes("unidentified"), true);
    assert.equal(
      refusals(emitted).length,
      0,
      "forbidden is the one code the client will not retry",
    );
    assert.equal(clientsInfo[ctx.clientId].cameraEnabled, false);
  });

  it("voice:screen:state does the same", async () => {
    const { ctx, emitted, clientsInfo } = makeContext();
    await socketCaller(["share_screen"], clientsInfo, ctx.clientId);
    unidentifiedCaller(clientsInfo, ctx.clientId);

    await registerVoiceHandlers(ctx)["voice:screen:state"]({
      enabled: true,
      videoStreamId: "vid_1",
      audioStreamId: "aud_1",
    });

    assert.equal(codes(emitted).includes("unidentified"), true);
    assert.equal(refusals(emitted).length, 0);
    assert.equal(clientsInfo[ctx.clientId].screenShareEnabled, false);
  });

  it("an unidentified socket can still turn its camera and screen share off", async () => {
    // The guard is on `enabled` only. Stopping has never needed a permission,
    // and somebody mid-restore who hits the button has to be able to stop.
    const { ctx, emitted, clientsInfo } = makeContext();
    await socketCaller([], clientsInfo, ctx.clientId);
    clientsInfo[ctx.clientId].cameraEnabled = true;
    clientsInfo[ctx.clientId].screenShareEnabled = true;
    unidentifiedCaller(clientsInfo, ctx.clientId);

    const handlers = registerVoiceHandlers(ctx);
    await handlers["voice:camera:state"]({ enabled: false });
    await handlers["voice:screen:state"]({ enabled: false });

    assert.equal(codes(emitted).length, 0);
    assert.equal(clientsInfo[ctx.clientId].cameraEnabled, false);
    assert.equal(clientsInfo[ctx.clientId].screenShareEnabled, false);
  });

  it("voice:state:update does not force-mute a socket it cannot evaluate yet", async () => {
    // Forcing the mute here records the wrong state and tells somebody they
    // cannot speak, both on the strength of not knowing who they are.
    const { ctx, emitted, clientsInfo } = makeContext();
    await socketCaller([], clientsInfo, ctx.clientId);
    unidentifiedCaller(clientsInfo, ctx.clientId);

    await registerVoiceHandlers(ctx)["voice:state:update"]({
      isMuted: false,
      isDeafened: false,
      isAFK: false,
    });

    assert.equal(clientsInfo[ctx.clientId].isMuted, false);
    assert.equal(refusals(emitted).length, 0);
  });

  it("voice:state:update records somebody without speak as muted", async () => {
    const { ctx, emitted, clientsInfo } = makeContext();
    await socketCaller(["join_voice"], clientsInfo, ctx.clientId);
    await registerVoiceHandlers(ctx)["voice:state:update"]({
      isMuted: false,
      isDeafened: false,
      isAFK: false,
    });
    assert.equal(clientsInfo[ctx.clientId].isMuted, true, "forced back to muted");
    assert.equal(refusals(emitted).some((r) => r.permission === "speak"), true);
  });

  it("voice:state:update leaves somebody with speak unmuted", async () => {
    const { ctx, clientsInfo } = makeContext();
    await socketCaller(["join_voice", "speak"], clientsInfo, ctx.clientId);
    await registerVoiceHandlers(ctx)["voice:state:update"]({
      isMuted: false,
      isDeafened: false,
      isAFK: false,
    });
    assert.equal(clientsInfo[ctx.clientId].isMuted, false);
  });

  it("voice:channel:joined needs join_voice", async () => {
    const { ctx, emitted, clientsInfo } = makeContext();
    await socketCaller([], clientsInfo, ctx.clientId);
    await registerVoiceHandlers(ctx)["voice:channel:joined"](true);
    assert.equal(refusals(emitted).some((r) => r.permission === "join_voice"), true);
    assert.equal(clientsInfo[ctx.clientId].hasJoinedChannel, false);
  });
});

describe("the catalogue and the gates agree", () => {
  it("gates only ever name a permission the catalogue has", () => {
    for (const { event, permission } of TOKEN_GATES) {
      assert.equal(
        PERMISSIONS.includes(permission),
        true,
        `${event} names ${permission}, which is not in PERMISSIONS`,
      );
    }
  });

  it("leaves the seeded roles alone", async () => {
    // The probe roles above are created and never cleaned up. If one of them
    // ever collided with a built-in, every case after it would be testing
    // something else.
    const ids = (await listRoleDefinitions()).map((r) => r.role_id);
    for (const id of ["owner", "admin", "mod", "member", "guest"]) {
      assert.ok(ids.includes(id), `built-in ${id} went missing`);
    }
  });
});
