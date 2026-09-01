import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { Permission } from "../../constants/permissions";
import { getSqliteDb, initSqlite } from "../../db/sqlite/connection";
import { upsertServerChannel, upsertServerSidebarItem } from "../../db/sqlite/channels";
import {
  createPermissionScope,
  replacePermissionRules,
  setChannelPermissionScope,
} from "../../db/sqlite/channelScopes";
import { createRoleDefinition } from "../../db/sqlite/roleDefinitions";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import { resetChannelPermissionCache } from "../../services/channelPermissions";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { broadcastMemberList, syncAllClients } from "../utils/clients";
import { resetChannelIdCache } from "../utils/conversationAccess";
import { sendServerDetails } from "../utils/server";
import { registerAdminChannelHandlers } from "./adminChannels";
import { registerChatHandlers } from "./chat";
import { registerTypingHandlers } from "./typing";
import { registerVoiceHandlers } from "./voice";
import { registerAdminHandlers } from "./admin";
import { registerReportHandlers } from "./reports";
import { insertServerAudit } from "../../db/sqlite/invites";
import { insertReport } from "../../db/sqlite/reports";
import type { HandlerContext } from "./types";

/**
 * Every path a hidden channel could travel, driven once each.
 *
 * The feature under test is a negative: a channel with `view_min_rank` set must
 * not appear in anything the server sends someone below it. A negative is easy
 * to believe and hard to check, and the failure is silent — the channel is
 * simply in the payload, and the person it leaked to has no reason to mention
 * it. So this file does not assert on the shape of one response. It runs a
 * path, collects everything that path emitted, and asserts the hidden id does
 * not appear anywhere in it, at any depth, under any key.
 *
 * That is deliberately blunt. A filter written for `channels` and forgotten for
 * `sidebar_items` passes a shaped assertion on `channels` and fails this — and
 * `sendServerDetails` builds the channel list three times in one function, so
 * that is not a hypothetical.
 *
 * The list below is the inventory. When a new event learns to name a channel,
 * it goes here, and the test that matters is the one that is missing.
 */

const HOST = "visibility.test:5001";

const OPEN = "general";
const HIDDEN = "staff";

/**
 * The role the hidden channel is hidden from.
 *
 * Denying `read_messages` for this one role is the whole of the gate — there is
 * no separate visibility setting, so a template that takes reading away takes
 * the channel with it.
 */
const SHUT_OUT_ROLE = "vis-low";

let dir: string;

/** A member at a rank, holding whatever permissions the path needs. */
async function memberAt(
  name: string,
  rank: number,
  permissions: Permission[],
): Promise<{ serverUserId: string; grytUserId: string; accessToken: string }> {
  const roleId = `vis-${name}`;
  const grytUserId = `account-${name}`;
  await createRoleDefinition(roleId, { name, rank, permissions });
  const user = await upsertUser(grytUserId, name);
  await setServerRole(user.server_user_id, roleId);
  return {
    serverUserId: user.server_user_id,
    grytUserId,
    accessToken: generateAccessToken({
      grytUserId,
      serverUserId: user.server_user_id,
      nickname: name,
      serverHost: HOST,
      tokenVersion: 0,
    }),
  };
}

type Member = Awaited<ReturnType<typeof memberAt>>;

let low: Member;
let high: Member;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-visibility-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  await upsertServerChannel({ channelId: OPEN, name: "General", type: "text", position: 10 });
  await upsertServerChannel({ channelId: HIDDEN, name: "Staff", type: "text", position: 20 });
  await upsertServerSidebarItem({ itemId: "sb-open", kind: "channel", position: 10, channelId: OPEN });
  await upsertServerSidebarItem({ itemId: "sb-hidden", kind: "channel", position: 20, channelId: HIDDEN });

  low = await memberAt("low", 10, ["read_messages", "send_messages", "view_members", "add_reactions", "view_audit_log", "view_reports"]);
  high = await memberAt("high", 80, ["read_messages", "send_messages", "view_members", "add_reactions", "view_audit_log", "view_reports"]);

  const staffOnly = await createPermissionScope({ name: "Staff only", isTemplate: true });
  await replacePermissionRules(staffOnly, [
    { roleId: SHUT_OUT_ROLE, permission: "read_messages", effect: "deny" },
  ]);
  await setChannelPermissionScope(HIDDEN, staffOnly);

  // Something for each of the new paths to leak: an audit entry naming the
  // hidden channel, a report from it, and the server pointing its system
  // messages at it. Without these the cases pass by having nothing to find.
  await insertServerAudit({
    actorServerUserId: high.serverUserId,
    action: "channel_upsert",
    target: HIDDEN,
    meta: { name: "Staff" },
  });
  await insertReport({
    message_id: "m-hidden",
    conversation_id: HIDDEN,
    reporter_server_user_id: high.serverUserId,
    message_text: "something said in the staff channel",
    message_attachments: null,
    message_sender_server_id: high.serverUserId,
    message_sender_nickname: "high",
  });
  getSqliteDb().prepare(`UPDATE server_config SET system_channel_id = ?`).run(HIDDEN);

  resetChannelPermissionCache();
  resetChannelIdCache();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

interface Emitted {
  /**
   * Which socket was sent this.
   *
   * Every socket in a case shares one list, and several of these paths send a
   * different payload to each — which is the whole point of them. Without this
   * field a case that masks correctly still fails, because the list also holds
   * what the *other* member was correctly told. That is not hypothetical: it
   * is how the first run of the two voice cases below failed.
   *
   * `null` for a room or server-wide emit, which by definition went to
   * everybody and so cannot have been masked for anybody.
   */
  to: string | null;
  event: string;
  payload: unknown;
}

/**
 * One socket, one member behind it, and a record of everything sent anywhere.
 *
 * `io.sockets.sockets` holds both members' sockets, because several of these
 * paths pick their audience out of that map rather than emitting to a room —
 * and picking the wrong audience is one of the ways this feature breaks.
 */
function harness(self: Member, others: Member[] = [], voice: Record<string, string> = {}) {
  const emitted: Emitted[] = [];
  const clientId = `sock-${self.serverUserId}`;
  const clientsInfo: Clients = {};

  function makeSocket(id: string) {
    return {
      id,
      handshake: { headers: { host: HOST }, address: "127.0.0.1" },
      rooms: new Set<string>(["verifiedClients"]),
      emit(event: string, payload?: unknown) {
        emitted.push({ to: id, event, payload });
        return true;
      },
      join() {},
      leave() {},
      to() {
        return { emit(event: string, payload?: unknown) { emitted.push({ to: null, event, payload }); } };
      },
    };
  }

  const sockets = new Map<string, ReturnType<typeof makeSocket>>();
  for (const m of [self, ...others]) {
    const id = `sock-${m.serverUserId}`;
    sockets.set(id, makeSocket(id));
    clientsInfo[id] = {
      serverUserId: m.serverUserId,
      grytUserId: m.grytUserId,
      nickname: m.grytUserId,
      // `clientMayReceive` reads this cache rather than the database, so the
      // member-list broadcast reaches nobody without it.
      permissions: new Set<Permission>(["view_members"]),
      voiceChannelId: voice[m.serverUserId] ?? "",
      isConnectedToVoice: Boolean(voice[m.serverUserId]),
      hasJoinedChannel: Boolean(voice[m.serverUserId]),
    } as unknown as Clients[string];
  }

  const io = {
    to() {
      return { emit(event: string, payload?: unknown) { emitted.push({ to: null, event, payload }); } };
    },
    emit(event: string, payload?: unknown) { emitted.push({ to: null, event, payload }); },
    sockets: { sockets },
  };

  const ctx = {
    io,
    socket: sockets.get(clientId),
    clientId,
    serverId: "visibility-test",
    clientsInfo,
    sfuClient: null,
    getClientIp: () => "127.0.0.1",
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  /**
   * What this member's own client was sent, plus anything sent to everybody.
   *
   * A room emit counts as theirs: it reached them along with everyone else, and
   * an unmasked broadcast is exactly the leak these cases are looking for.
   */
  function mine(): Emitted[] {
    return emitted.filter((e) => e.to === null || e.to === clientId);
  }

  return { ctx, emitted, mine, clientsInfo, socket: sockets.get(clientId)!, sockets };
}

/** Whether the hidden channel is named anywhere in what was emitted. */
function leaked(emitted: Emitted[]): boolean {
  return JSON.stringify(emitted).includes(HIDDEN);
}

/**
 * The inventory. Each entry drives one path as one member and returns what that
 * member's client was sent.
 */
const PATHS: {
  name: string;
  /** Run the path as this member, and hand back everything they received. */
  run: (who: Member) => Promise<Emitted[]>;
  /**
   * Some paths refuse rather than filter — history on a hidden channel answers
   * "no such conversation". Those still must not name the channel, so they are
   * in the same table; this only says the high-rank half cannot be asserted the
   * same way.
   */
  skipPermittedHalf?: boolean;
}[] = [
  {
    name: "server:details — the sidebar and the channel list",
    run: async (who) => {
      const h = harness(who);
      await sendServerDetails(h.socket as never, h.clientsInfo, "visibility-test");
      return h.mine();
    },
  },
  {
    name: "server:channels:list — the channel editor",
    run: async (who) => {
      const h = harness(who);
      await registerAdminChannelHandlers(h.ctx)["server:channels:list"]({ accessToken: who.accessToken });
      return h.mine();
    },
    // Only `manage_channels` reaches it now, and neither member here holds it,
    // so both halves are the refusing half. Asserted separately below.
    skipPermittedHalf: true,
  },
  {
    name: "chat:send — posting into a guessed id",
    run: async (who) => {
      const h = harness(who);
      await registerChatHandlers(h.ctx)["chat:send"]({
        conversationId: HIDDEN,
        accessToken: who.accessToken,
        text: "is anyone here",
      });
      return h.mine();
    },
    skipPermittedHalf: true,
  },
  {
    name: "server:audit:list — an auditor below the gate",
    run: async (who) => {
      const h = harness(who);
      await registerAdminHandlers(h.ctx)["server:audit:list"]({ accessToken: who.accessToken });
      return h.mine();
    },
    skipPermittedHalf: true,
  },
  {
    name: "reports:list — a moderator below the gate",
    run: async (who) => {
      const h = harness(who);
      await registerReportHandlers(h.ctx)["reports:list"]({ accessToken: who.accessToken });
      return h.mine();
    },
    skipPermittedHalf: true,
  },
  {
    name: "server:settings:get — systemChannelId on a hidden channel",
    run: async (who) => {
      const h = harness(who);
      await registerAdminHandlers(h.ctx)["server:settings:get"]();
      return h.mine();
    },
    skipPermittedHalf: true,
  },
  {
    name: "voice:room:request — asking the SFU for a hidden room",
    run: async (who) => {
      const h = harness(who);
      h.clientsInfo[`sock-${who.serverUserId}`].permissions = new Set<Permission>(["join_voice"]);
      await registerVoiceHandlers(h.ctx)["voice:room:request"](HIDDEN);
      return h.mine();
    },
    skipPermittedHalf: true,
  },
  {
    name: "chat:typing — the indicator's audience",
    run: async (who) => {
      // Driven as the *other* member typing in the hidden channel, so what is
      // collected is what `who` was told about it.
      const typist = who.serverUserId === low.serverUserId ? high : low;
      const h = harness(typist, [who]);
      await registerTypingHandlers(h.ctx)["chat:typing"]({ conversationId: HIDDEN });
      return h.emitted.filter((e) => e.to === null || e.to === `sock-${who.serverUserId}`);
    },
    skipPermittedHalf: true,
  },
];

describe("a channel with view_min_rank set", () => {
  for (const path of PATHS) {
    it(`is not named to somebody below the gate — ${path.name}`, async () => {
      const emitted = await path.run(low);
      assert.equal(
        leaked(emitted),
        false,
        `"${HIDDEN}" reached a rank-10 member through ${path.name}:\n${JSON.stringify(emitted, null, 2)}`,
      );
    });
  }

  for (const path of PATHS.filter((p) => !p.skipPermittedHalf)) {
    it(`still reaches somebody above the gate — ${path.name}`, async () => {
      const emitted = await path.run(high);
      assert.equal(
        leaked(emitted),
        true,
        `the gate hid "${HIDDEN}" from a rank-80 member too, through ${path.name}`,
      );
    });
  }

  it("still names the open channel to everybody", async () => {
    const h = harness(low);
    await sendServerDetails(h.socket as never, h.clientsInfo, "visibility-test");
    assert.ok(
      JSON.stringify(h.mine()).includes(OPEN),
      "filtering took the ungated channel with it",
    );
  });

  it("hides the typing indicator from below the gate and shows it above", async () => {
    // The one path where the audience, not the payload, is the thing being
    // filtered — so it is asserted on who was told rather than on a substring.
    const h = harness(high, [low]);
    await registerTypingHandlers(h.ctx)["chat:typing"]({ conversationId: HIDDEN });
    assert.equal(
      h.emitted.filter((e) => e.event === "chat:typing" && e.to === `sock-${low.serverUserId}`).length,
      0,
      "a rank-10 member was told somebody is typing in a channel they cannot see",
    );

    const open = harness(high, [low]);
    await registerTypingHandlers(open.ctx)["chat:typing"]({ conversationId: OPEN });
    assert.equal(
      open.emitted.filter((e) => e.event === "chat:typing" && e.to === `sock-${low.serverUserId}`).length,
      1,
      "the indicator stopped working in an ungated channel",
    );
  });

  it("answers a guessed id the same as an id that does not exist", async () => {
    // The refusal has to be indistinguishable, or it is an oracle: ask for a
    // hidden channel, ask for nonsense, and compare the two answers.
    const guessed = harness(low);
    await registerChatHandlers(guessed.ctx)["chat:send"]({
      conversationId: HIDDEN,
      accessToken: low.accessToken,
      text: "hello",
    });
    const nonsense = harness(low);
    await registerChatHandlers(nonsense.ctx)["chat:send"]({
      conversationId: "no-such-channel-at-all",
      accessToken: low.accessToken,
      text: "hello",
    });

    assert.deepEqual(
      guessed.mine().map((e) => ({ event: e.event, payload: e.payload })),
      nonsense.mine().map((e) => ({ event: e.event, payload: e.payload })),
      "a hidden channel answers differently from one that is not there",
    );
  });

  it("keeps the channel editor to whoever manages channels", async () => {
    const h = harness(high);
    await registerAdminChannelHandlers(h.ctx)["server:channels:list"]({ accessToken: high.accessToken });
    const forbidden = h.mine().some(
      (e) => (e.payload as { error?: string })?.error === "forbidden",
    );
    assert.ok(forbidden, "server:channels:list answered a member without manage_channels");
  });

  it("hands the editor every channel to somebody who does manage them", async () => {
    const admin = await memberAt("admin", 90, ["manage_channels"]);
    const h = harness(admin);
    await registerAdminChannelHandlers(h.ctx)["server:channels:list"]({ accessToken: admin.accessToken });
    const list = h.mine().find((e) => e.event === "server:channels");
    assert.ok(list, "the editor got no channel list at all");
    assert.ok(
      JSON.stringify(list).includes(HIDDEN),
      "the editor cannot see the channel it is meant to edit",
    );
  });
});

/**
 * The two broadcasts that carry `voiceChannelId` to everyone.
 *
 * Separate from the table above because what leaks here is not a channel in a
 * list — it is one field on somebody else's row, saying which room they are
 * sitting in. `publicVoiceRoom` already blanks a direct call's id for the same
 * reason; this is the same blanking, decided per recipient.
 *
 * Both are debounced behind a timer, so each case waits rather than asserting
 * on the tick it fired.
 */
describe("somebody sitting in a gated voice channel", () => {
  const settle = () => new Promise((r) => setTimeout(r, 250));

  it("is not named to a member below the gate, on server:clients", async () => {
    const h = harness(low, [high], { [high.serverUserId]: HIDDEN });
    syncAllClients(h.ctx.io, h.clientsInfo);
    await settle();

    const clients = h.mine().filter((e) => e.event === "server:clients");
    assert.ok(clients.length > 0, "server:clients was never sent");
    assert.equal(
      JSON.stringify(clients).includes(HIDDEN),
      false,
      `the room named a channel a rank-10 member cannot see:\n${JSON.stringify(clients, null, 2)}`,
    );
  });

  it("is still named to a member above the gate", async () => {
    const h = harness(high, [low], { [high.serverUserId]: HIDDEN });
    syncAllClients(h.ctx.io, h.clientsInfo);
    await settle();

    const mine = h.mine().filter((e) => e.event === "server:clients");
    assert.ok(
      JSON.stringify(mine).includes(HIDDEN),
      "the mask hid the channel from somebody who is allowed in it",
    );
  });

  it("is not named to a member below the gate, on members:list", async () => {
    const h = harness(low, [high], { [high.serverUserId]: HIDDEN });
    broadcastMemberList(h.ctx.io, h.clientsInfo, "visibility-test");
    await settle();

    const lists = h.mine().filter((e) => e.event === "members:list");
    assert.ok(lists.length > 0, "members:list was never sent");
    assert.equal(
      JSON.stringify(lists).includes(HIDDEN),
      false,
      `the member list named a channel a rank-10 member cannot see:\n${JSON.stringify(lists, null, 2)}`,
    );
  });
});

describe("hiding a channel somebody is already in", () => {
  it("turns them out of its voice room", async () => {
    const roomies = "roomies";
    await upsertServerChannel({ channelId: roomies, name: "Roomies", type: "voice", position: 30 });
    resetChannelPermissionCache();
    resetChannelIdCache();

    const admin = await memberAt("evictor", 95, ["manage_channels"]);
    const h = harness(admin, [low], { [low.serverUserId]: roomies });
    h.clientsInfo[`sock-${low.serverUserId}`].hasJoinedChannel = true;

    await registerAdminChannelHandlers(h.ctx)["server:channels:scope:set"]({
      accessToken: admin.accessToken,
      channelId: roomies,
      custom: true,
      rules: [{ roleId: SHUT_OUT_ROLE, permission: "read_messages", effect: "deny" }],
    });

    const theirs = h.emitted.filter((e) => e.to === `sock-${low.serverUserId}`);
    assert.ok(
      theirs.some((e) => e.event === "voice:room:leave"),
      `a member kept their seat in a channel that just became invisible to them:\n${JSON.stringify(theirs, null, 2)}`,
    );
    assert.equal(h.clientsInfo[`sock-${low.serverUserId}`].voiceChannelId, "");
    assert.equal(h.clientsInfo[`sock-${low.serverUserId}`].isConnectedToVoice, false);
  });

  it("leaves somebody the scope does not name where they are", async () => {
    const staffroom = "staffroom";
    await upsertServerChannel({ channelId: staffroom, name: "Staff room", type: "voice", position: 40 });
    resetChannelPermissionCache();
    resetChannelIdCache();

    const admin = await memberAt("evictor2", 96, ["manage_channels"]);
    const h = harness(admin, [high], { [high.serverUserId]: staffroom });
    h.clientsInfo[`sock-${high.serverUserId}`].hasJoinedChannel = true;

    await registerAdminChannelHandlers(h.ctx)["server:channels:scope:set"]({
      accessToken: admin.accessToken,
      channelId: staffroom,
      custom: true,
      rules: [{ roleId: SHUT_OUT_ROLE, permission: "read_messages", effect: "deny" }],
    });

    assert.equal(
      h.clientsInfo[`sock-${high.serverUserId}`].voiceChannelId,
      staffroom,
      "a member the scope says nothing about was thrown out",
    );
  });

  it("does the same when a template several channels share is edited", async () => {
    // The case a per-channel edit does not cover: one save, four channels. If
    // eviction only walked the channel being edited, everybody sitting in the
    // other three would keep a room the server has stopped admitting them to.
    const shared = "shared-room";
    await upsertServerChannel({ channelId: shared, name: "Shared", type: "voice", position: 50 });

    const template = await createPermissionScope({ name: "Locked later", isTemplate: true });
    await setChannelPermissionScope(shared, template);
    resetChannelPermissionCache();
    resetChannelIdCache();

    const admin = await memberAt("evictor3", 97, ["manage_roles"]);
    const h = harness(admin, [low], { [low.serverUserId]: shared });
    h.clientsInfo[`sock-${low.serverUserId}`].hasJoinedChannel = true;

    await registerAdminChannelHandlers(h.ctx)["server:permissions:template:save"]({
      accessToken: admin.accessToken,
      templateId: template,
      name: "Locked later",
      rules: [{ roleId: SHUT_OUT_ROLE, permission: "read_messages", effect: "deny" }],
    });

    assert.equal(
      h.clientsInfo[`sock-${low.serverUserId}`].voiceChannelId,
      "",
      "editing the template left somebody in a room they can no longer see",
    );
  });
});
