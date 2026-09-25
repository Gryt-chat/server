import consola from "consola";

import {
  addMlsKeyPackages,
  appendMlsCommit,
  appendMlsMessage,
  blockedServerIdsFor,
  blockersOfSender,
  claimMlsKeyPackage,
  countMlsKeyPackages,
  createMlsGroup,
  deleteMlsWelcomes,
  eitherHasBlocked,
  getConversation,
  getMlsGroupForConversation,
  getServerConfig,
  getUserByServerId,
  isMlsDevice,
  listConversationsForUser,
  listMlsDevices,
  listMlsGroupsForMember,
  listMlsLog,
  listMlsWelcomes,
  MLS_MAX_KEY_PACKAGES,
  mlsKeyPackageOwner,
  oldestMlsSeq,
  removeMlsDevice,
  touchConversation,
  touchMlsDevice,
  type MlsGroup,
  type MlsLogEntry,
  type MlsWelcomeFor,
} from "../../db";
import { spamFilter } from "../../moderation/spamFilter";
import { isSpamExempt, spamRefusal, timeOutSpammer } from "../../moderation/spamTimeout";
import { textMuteError, textMuteFor } from "../../moderation/textMute";
import { mayInChannel } from "../../services/channelPermissions";
import { asBytes, parseGroupMessage, parseKeyPackage, parseWelcome } from "../../services/mlsWire";
import { SEALED_MAX_LENGTH } from "../../utils/messageLimits";
import { checkRateLimit, type RateLimitRule } from "../../utils/rateLimiter";
import { requireAuth, type AuthResult } from "../middleware/auth";
import { CONTACT_REFUSALS, mayMessage, peerOf } from "../utils/contactGate";
import { DENIAL_RESPONSES, resolveConversationAccess } from "../utils/conversationAccess";
import { socketIsIdentified } from "../utils/standing";
import { directConversationViews } from "./dm";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * The MLS delivery service (GRYT-1500, stage 1 of docs/mls-design.md in the crypto repo).
 * Every request answers through its ack as `{ ok: true, ... }` or `{ ok: false, error, message }`.
 */

type Reply = Record<string, unknown> & { ok: boolean };
type Ack = (reply: Reply) => void;

const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** 1 to 64 bytes, lower-case hex. RFC 9420 leaves the length to the application. */
const GROUP_ID = /^(?:[0-9a-f]{2}){1,64}$/;

/** A suite 1 KeyPackage is about 330 bytes plus the device certificate in its credential. */
const MAX_KEY_PACKAGE_BYTES = 16 * 1024;
/** A DM commit adds at most ten devices; a Welcome carries the tree for all of them. */
const MAX_HANDSHAKE_BYTES = 256 * 1024;
const MAX_LOG_PAGE = 200;
const MAX_CLAIM_DEVICES = 50;

const RL_PUBLISH: RateLimitRule = { limit: 10, windowMs: 60_000, scorePerAction: 1, maxScore: 10, scoreDecayMs: 6000 };
/** Every claim uses up somebody else's packages, so it is the one to hold back. */
const RL_CLAIM: RateLimitRule = { limit: 20, windowMs: 60_000, scorePerAction: 1, maxScore: 10, scoreDecayMs: 3000 };
const RL_COMMIT: RateLimitRule = { limit: 30, windowMs: 60_000, scorePerAction: 1, maxScore: 15, scoreDecayMs: 2000 };
/** chat:send's numbers, under its own key so MLS and sealed sends don't share one budget. */
const RL_SEND: RateLimitRule = { limit: 20, windowMs: 10_000, banMs: 30_000, scorePerAction: 1, maxScore: 10, scoreDecayMs: 2000 };
const RL_READ: RateLimitRule = { limit: 120, windowMs: 60_000, scorePerAction: 0.2, maxScore: 20, scoreDecayMs: 500 };

const fail = (error: string, message: string, extra: Record<string, unknown> = {}): Reply => ({
  ok: false,
  error,
  message,
  ...extra,
});

function groupView(g: MlsGroup): Record<string, unknown> {
  return { conversationId: g.conversationId, groupId: g.groupId, epoch: g.epoch, headSeq: g.headSeq };
}

function entryView(conversationId: string, e: MlsLogEntry): Record<string, unknown> {
  return {
    conversationId,
    groupId: e.groupId,
    seq: e.seq,
    kind: e.kind,
    epoch: e.epoch,
    senderServerUserId: e.senderServerUserId,
    senderDeviceId: e.senderDeviceId,
    data: Buffer.from(e.data),
    createdAt: e.createdAt,
  };
}

export function registerMlsHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, clientsInfo, serverId, sfuClient, getClientIp } = ctx;

  function socketsOf(serverUserIds: Iterable<string>): string[] {
    const wanted = new Set(serverUserIds);
    return Object.entries(clientsInfo)
      .filter(([cid, ci]) => socketIsIdentified(clientsInfo, cid) && wanted.has(ci.serverUserId))
      .map(([cid]) => cid);
  }

  function emitTo(socketIds: string[], event: string, payload: unknown): void {
    for (const cid of socketIds) io.sockets.sockets.get(cid)?.emit(event, payload);
  }

  /* Rate limit, then the token. Null once the refusal has gone back through the ack. */
  async function begin(
    event: string,
    rule: RateLimitRule,
    payload: { accessToken?: string } | undefined,
    ack: Ack,
  ): Promise<AuthResult | null> {
    const rl = checkRateLimit(event, clientsInfo[clientId]?.serverUserId, getClientIp(), rule);
    if (!rl.allowed) {
      ack(fail("rate_limited", `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.`, { retryAfterMs: rl.retryAfterMs }));
      return null;
    }
    if (!payload || typeof payload !== "object") {
      ack(fail("invalid_payload", "Invalid payload"));
      return null;
    }
    const auth = await requireAuth(socket, payload);
    if (!auth) ack(fail("unauthenticated", "Sign in to this server first."));
    return auth;
  }

  /* One-to-one DMs only in stage 1; group DMs are stage 2 and bring their own checks. */
  async function dmOf(conversationId: unknown, serverUserId: string, ack: Ack): Promise<string[] | null> {
    if (typeof conversationId !== "string" || !conversationId) {
      ack(fail("invalid_payload", "conversationId is required."));
      return null;
    }
    const access = await resolveConversationAccess(conversationId, serverUserId);
    if (!access.allowed) {
      const { error, message } = DENIAL_RESPONSES[access.reason];
      ack(fail(error, message));
      return null;
    }
    if (access.kind !== "dm" || access.group) {
      ack(fail("not_supported", "Only one-to-one direct messages use MLS so far."));
      return null;
    }
    return access.memberIds;
  }

  function ownDevice(auth: AuthResult, deviceId: unknown, ack: Ack, mustExist = true): deviceId is string {
    if (typeof deviceId !== "string" || !DEVICE_ID.test(deviceId)) {
      ack(fail("invalid_device", "deviceId has to be 1 to 64 letters, digits, - or _."));
      return false;
    }
    if (mustExist && !isMlsDevice(auth.tokenPayload.serverUserId, deviceId)) {
      ack(fail("unknown_device", "Publish KeyPackages from this device first."));
      return false;
    }
    return true;
  }

  /* What chat:send asks before a DM goes out, minus what needs the text. Null is yes. */
  async function sendRefusal(auth: AuthResult, conversationId: string, memberIds: string[]): Promise<Reply | null> {
    const self = auth.tokenPayload.serverUserId;
    const mute = await textMuteFor(self);
    if (mute.muted) return { ok: false, ...textMuteError(mute) };
    if (!(await mayInChannel(conversationId, self, "send_messages", auth.tokenPayload.grytUserId))) {
      return fail("forbidden", "You don't have permission to send messages on this server.", { permission: "send_messages" });
    }
    return writeRefusal(auth, memberIds);
  }

  /* Anything that reaches the other person: a message, or taking their KeyPackages. */
  async function writeRefusal(auth: AuthResult, memberIds: string[]): Promise<Reply | null> {
    const self = auth.tokenPayload.serverUserId;
    const cfg = await getServerConfig().catch(() => null);
    if (cfg && cfg.allow_dms === false) return fail("dms_disabled", "Direct messages are turned off on this server");
    if (!auth.permissions.has("send_direct_messages")) {
      return fail("forbidden", "You do not have permission to send direct messages here.", { permission: "send_direct_messages" });
    }
    const peer = peerOf(memberIds, self);
    if (peer && !(await mayMessage(self, peer))) return { ok: false, ...CONTACT_REFUSALS.messages };
    return null;
  }

  /* Metadata only, as for sealed DMs: who, how often, how big. */
  async function droppedAsSpam(auth: AuthResult, conversationId: string, memberIds: string[], size: number, newConversation: boolean): Promise<Reply | null> {
    const cfg = await getServerConfig().catch(() => null);
    if (cfg && cfg.spam_filter_enabled === false) return null;
    if (isSpamExempt({ isOwner: auth.isOwner, permissions: auth.permissions, grytUserId: auth.tokenPayload.grytUserId })) return null;
    const user = await getUserByServerId(auth.tokenPayload.serverUserId);
    if (!user) return fail("unknown_member", "User not found. Please rejoin.");

    const sensitivity = cfg?.spam_filter_sensitivity ?? "normal";
    const verdict = spamFilter.evaluate(
      { id: user.server_user_id, memberSince: user.created_at },
      {
        kind: "dm",
        conversationId,
        recipients: memberIds.filter((id) => id !== user.server_user_id),
        size,
        newConversation,
        attachments: 0,
      },
      sensitivity,
    );
    if (!verdict.spam) return null;
    const { until } = await timeOutSpammer({
      io, clientsInfo, sfuClient, serverId, serverUserId: user.server_user_id, verdict, sensitivity, where: "dm",
    });
    return { ok: false, ...spamRefusal(until) };
  }

  /* Every device of a member, or refused: a group can only grow by its own people. */
  function memberDevicesFor(refs: string[], memberIds: string[]): { serverUserId: string; deviceId: string }[] | null {
    const members = new Set(memberIds);
    const owners = [];
    for (const ref of refs) {
      const owner = mlsKeyPackageOwner(ref);
      if (!owner || !members.has(owner.serverUserId)) return null;
      owners.push(owner);
    }
    return owners;
  }

  /* Commits always arrive, or the reader's group state falls behind. Anything else
     skips people who blocked the sender, as chat:send does. */
  async function fanOut(memberIds: string[], entry: MlsLogEntry, conversationId: string): Promise<void> {
    let audience = memberIds;
    if (entry.kind !== "commit") {
      const blockers = await blockersOfSender(entry.senderServerUserId);
      audience = memberIds.filter((id) => id === entry.senderServerUserId || !blockers.has(id));
    }
    const recipients = socketsOf(audience);
    emitTo(recipients, "mls:message", entryView(conversationId, entry));
  }

  /* Whoever shares a DM with them adds the new device the next time they send. */
  async function announceDevices(serverUserId: string): Promise<void> {
    const people = new Set([serverUserId]);
    for (const c of await listConversationsForUser(serverUserId)) {
      for (const id of c.other_server_user_ids) people.add(id);
    }
    const recipients = socketsOf(people);
    emitTo(recipients, "mls:devices:changed", { serverUserId });
  }

  return {
    "mls:keypackages:publish": async (
      payload: { accessToken: string; deviceId: string; keyPackages?: unknown[]; lastResort?: unknown },
      ack: Ack,
    ) => {
      ack = typeof ack === "function" ? ack : () => {};
      try {
        const auth = await begin("mls:keypackages:publish", RL_PUBLISH, payload, ack);
        if (!auth || !ownDevice(auth, payload.deviceId, ack, false)) return;
        const self = auth.tokenPayload.serverUserId;

        const regular = Array.isArray(payload.keyPackages) ? payload.keyPackages : [];
        const raw = [...regular.map((b) => ({ b, lastResort: false }))];
        if (payload.lastResort !== undefined && payload.lastResort !== null) raw.push({ b: payload.lastResort, lastResort: true });
        if (raw.length === 0 || regular.length > MLS_MAX_KEY_PACKAGES) {
          ack(fail("invalid_payload", `Send 1 to ${MLS_MAX_KEY_PACKAGES} KeyPackages, plus a last-resort one if you like.`));
          return;
        }

        const packages = [];
        for (const { b, lastResort } of raw) {
          const bytes = asBytes(b);
          if (!bytes || bytes.length > MAX_KEY_PACKAGE_BYTES) {
            ack(fail("invalid_key_package", "Each KeyPackage has to be binary and under 16 kB."));
            return;
          }
          const parsed = await parseKeyPackage(bytes);
          if (!parsed.ok) {
            ack(fail(parsed.error, parsed.message));
            return;
          }
          packages.push({ ref: parsed.ref, data: bytes, lastResort });
        }

        const isNew = !isMlsDevice(self, payload.deviceId);
        if (touchMlsDevice(self, payload.deviceId) === "too_many_devices") {
          ack(fail("too_many_devices", "You have five devices using encrypted messages here. Remove one first."));
          return;
        }
        const result = addMlsKeyPackages(self, payload.deviceId, packages);
        ack({ ok: true, ...result });
        if (isNew) await announceDevices(self);
      } catch (err) {
        consola.error("mls:keypackages:publish failed", err);
        ack(fail("failed", "Could not store the KeyPackages"));
      }
    },

    /** Your own devices with no conversation named; with one, every member's device ids. */
    "mls:devices": async (payload: { accessToken: string; conversationId?: string }, ack: Ack) => {
      ack = typeof ack === "function" ? ack : () => {};
      try {
        const auth = await begin("mls:read", RL_READ, payload, ack);
        if (!auth) return;
        const self = auth.tokenPayload.serverUserId;
        if (payload.conversationId === undefined) {
          ack({ ok: true, devices: listMlsDevices([self]) });
          return;
        }
        const memberIds = await dmOf(payload.conversationId, self, ack);
        if (!memberIds) return;
        const devices = listMlsDevices(memberIds).map((d) => ({ serverUserId: d.serverUserId, deviceId: d.deviceId }));
        ack({ ok: true, devices });
      } catch (err) {
        consola.error("mls:devices failed", err);
        ack(fail("failed", "Could not list devices"));
      }
    },

    "mls:device:remove": async (payload: { accessToken: string; deviceId: string }, ack: Ack) => {
      ack = typeof ack === "function" ? ack : () => {};
      try {
        const auth = await begin("mls:keypackages:publish", RL_PUBLISH, payload, ack);
        if (!auth || !ownDevice(auth, payload.deviceId, ack)) return;
        removeMlsDevice(auth.tokenPayload.serverUserId, payload.deviceId);
        ack({ ok: true });
        await announceDevices(auth.tokenPayload.serverUserId);
      } catch (err) {
        consola.error("mls:device:remove failed", err);
        ack(fail("failed", "Could not remove the device"));
      }
    },

    /**
     * One KeyPackage for each device named, or for every device in the conversation
     * except the caller's. Handed out once; a device with none left is listed as missing.
     */
    "mls:keypackages:claim": async (
      payload: { accessToken: string; conversationId: string; deviceId: string; devices?: { serverUserId: string; deviceId: string }[] },
      ack: Ack,
    ) => {
      ack = typeof ack === "function" ? ack : () => {};
      try {
        const auth = await begin("mls:keypackages:claim", RL_CLAIM, payload, ack);
        if (!auth || !ownDevice(auth, payload.deviceId, ack)) return;
        const self = auth.tokenPayload.serverUserId;
        const memberIds = await dmOf(payload.conversationId, self, ack);
        if (!memberIds) return;

        const known = listMlsDevices(memberIds);
        let targets = known.filter((d) => !(d.serverUserId === self && d.deviceId === payload.deviceId));
        if (payload.devices !== undefined) {
          if (!Array.isArray(payload.devices)) {
            ack(fail("invalid_payload", "devices has to be a list."));
            return;
          }
          const asked = new Set(payload.devices.map((d) => `${d?.serverUserId}\u0000${d?.deviceId}`));
          targets = targets.filter((d) => asked.has(`${d.serverUserId}\u0000${d.deviceId}`));
        }
        targets = targets.slice(0, MAX_CLAIM_DEVICES);

        const peers = new Set(targets.map((d) => d.serverUserId).filter((id) => id !== self));
        if (peers.size > 0) {
          const refusal = await writeRefusal(auth, memberIds);
          if (refusal) {
            ack(refusal);
            return;
          }
          for (const peer of peers) {
            const user = await getUserByServerId(peer);
            // As dm:open answers it, so a block reads the same as somebody who isn't there.
            if (!user || (await eitherHasBlocked(auth.tokenPayload.grytUserId, user.gryt_user_id))) {
              ack(fail("unknown_member", "That person is not a member of this server"));
              return;
            }
          }
        }

        const keyPackages = [];
        const missing = [];
        for (const d of targets) {
          const kp = claimMlsKeyPackage(d.serverUserId, d.deviceId);
          if (kp) {
            keyPackages.push({ serverUserId: d.serverUserId, deviceId: d.deviceId, keyPackage: Buffer.from(kp.data), lastResort: kp.lastResort });
          } else {
            missing.push({ serverUserId: d.serverUserId, deviceId: d.deviceId });
          }
        }
        ack({ ok: true, keyPackages, missing });
      } catch (err) {
        consola.error("mls:keypackages:claim failed", err);
        ack(fail("failed", "Could not hand out KeyPackages"));
      }
    },

    /** The first group for a conversation wins. The loser drops its own and waits for a Welcome. */
    "mls:group:create": async (payload: { accessToken: string; conversationId: string; groupId: string }, ack: Ack) => {
      ack = typeof ack === "function" ? ack : () => {};
      try {
        const auth = await begin("mls:commit", RL_COMMIT, payload, ack);
        if (!auth) return;
        const self = auth.tokenPayload.serverUserId;
        const memberIds = await dmOf(payload.conversationId, self, ack);
        if (!memberIds) return;
        if (typeof payload.groupId !== "string" || !GROUP_ID.test(payload.groupId)) {
          ack(fail("invalid_group_id", "groupId has to be 1 to 64 bytes of lower-case hex."));
          return;
        }

        const result = createMlsGroup(payload.groupId, payload.conversationId, self);
        if (result.created) ack({ ok: true, group: groupView(result.group) });
        else if (result.group) ack(fail("group_exists", "This conversation already has a group.", { group: groupView(result.group) }));
        else ack(fail("group_id_taken", "Pick another group id."));
      } catch (err) {
        consola.error("mls:group:create failed", err);
        ack(fail("failed", "Could not create the group"));
      }
    },

    /**
     * A commit built on the group's current epoch, with the Welcome for anybody it adds.
     * Any other epoch is refused with the current one, and the client catches up and retries.
     */
    "mls:commit": async (
      payload: { accessToken: string; conversationId: string; deviceId: string; commit: unknown; welcome?: unknown },
      ack: Ack,
    ) => {
      ack = typeof ack === "function" ? ack : () => {};
      try {
        const auth = await begin("mls:commit", RL_COMMIT, payload, ack);
        if (!auth || !ownDevice(auth, payload.deviceId, ack)) return;
        const self = auth.tokenPayload.serverUserId;
        const memberIds = await dmOf(payload.conversationId, self, ack);
        if (!memberIds) return;
        const group = getMlsGroupForConversation(payload.conversationId);
        if (!group) {
          ack(fail("no_group", "This conversation has no group yet."));
          return;
        }

        const commit = asBytes(payload.commit);
        const welcome = payload.welcome == null ? null : asBytes(payload.welcome);
        if (!commit || commit.length > MAX_HANDSHAKE_BYTES || (payload.welcome != null && (!welcome || welcome.length > MAX_HANDSHAKE_BYTES))) {
          ack(fail("invalid_payload", "commit and welcome have to be binary and under 256 kB."));
          return;
        }

        const parsed = await parseGroupMessage(commit);
        if (!parsed.ok) {
          ack(fail(parsed.error, parsed.message));
          return;
        }
        if (parsed.kind !== "commit") {
          ack(fail("not_a_commit", "Send proposals and application messages with mls:send."));
          return;
        }
        if (parsed.groupId !== group.groupId) {
          ack(fail("wrong_group", "That commit is for another group.", { group: groupView(group) }));
          return;
        }
        if (!memberDevicesFor(parsed.addedRefs, memberIds)) {
          ack(fail("not_a_member_device", "A commit here can only add devices of people in the conversation."));
          return;
        }

        const welcomes: MlsWelcomeFor[] = [];
        if (welcome) {
          const w = parseWelcome(welcome);
          if (!w.ok) {
            ack(fail(w.error, w.message));
            return;
          }
          const devices = memberDevicesFor(w.recipients, memberIds);
          if (!devices) {
            ack(fail("not_a_member_device", "That Welcome is for somebody outside the conversation."));
            return;
          }
          const seen = new Set<string>();
          for (const d of devices) {
            const key = `${d.serverUserId}\u0000${d.deviceId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            welcomes.push({ ...d, data: welcome });
          }
        }

        const result = appendMlsCommit(
          { groupId: group.groupId, epoch: parsed.epoch, senderServerUserId: self, senderDeviceId: payload.deviceId, data: commit },
          welcomes,
        );
        if (!result.accepted) {
          if (result.reason === "stale_epoch") {
            ack(fail("stale_epoch", "Another commit got there first. Fetch the log and try again.", { epoch: result.epoch, headSeq: result.headSeq }));
          } else {
            ack(fail("no_group", "This conversation has no group yet."));
          }
          return;
        }

        const accepted = { ok: true, seq: result.seq, epoch: result.epoch };
        if (result.duplicate) {
          ack(accepted);
          return;
        }

        const entry: MlsLogEntry = {
          groupId: group.groupId, seq: result.seq, kind: "commit", epoch: parsed.epoch,
          senderServerUserId: self, senderDeviceId: payload.deviceId, data: commit, createdAt: result.createdAt,
        };
        await fanOut(memberIds, entry, payload.conversationId);
        welcomes.forEach((w, i) => {
          const recipients = socketsOf([w.serverUserId]);
          emitTo(recipients, "mls:welcome", {
            welcomeId: result.welcomeIds[i],
            conversationId: payload.conversationId,
            groupId: group.groupId,
            deviceId: w.deviceId,
            data: Buffer.from(w.data),
            createdAt: result.createdAt,
          });
        });
        ack(accepted);
      } catch (err) {
        consola.error("mls:commit failed", err);
        ack(fail("failed", "Could not accept the commit"));
      }
    },

    /** An application message (PrivateMessage) or a proposal (PublicMessage). */
    "mls:send": async (
      payload: { accessToken: string; conversationId: string; deviceId: string; message: unknown },
      ack: Ack,
    ) => {
      ack = typeof ack === "function" ? ack : () => {};
      try {
        const auth = await begin("mls:send", RL_SEND, payload, ack);
        if (!auth || !ownDevice(auth, payload.deviceId, ack)) return;
        const self = auth.tokenPayload.serverUserId;
        const memberIds = await dmOf(payload.conversationId, self, ack);
        if (!memberIds) return;
        const group = getMlsGroupForConversation(payload.conversationId);
        if (!group) {
          ack(fail("no_group", "This conversation has no group yet."));
          return;
        }

        const bytes = asBytes(payload.message);
        if (!bytes || bytes.length > SEALED_MAX_LENGTH) {
          ack(fail("invalid_payload", "message has to be binary and under 64 kB."));
          return;
        }
        const parsed = await parseGroupMessage(bytes);
        if (!parsed.ok) {
          ack(fail(parsed.error, parsed.message));
          return;
        }
        if (parsed.kind === "commit") {
          ack(fail("use_commit", "Send commits with mls:commit, so they're ordered."));
          return;
        }
        if (parsed.groupId !== group.groupId) {
          ack(fail("wrong_group", "That message is for another group.", { group: groupView(group) }));
          return;
        }
        if (!memberDevicesFor(parsed.addedRefs, memberIds)) {
          ack(fail("not_a_member_device", "A proposal here can only add devices of people in the conversation."));
          return;
        }

        const application = parsed.kind === "application";
        let wasEmpty = false;
        if (application) {
          const refusal = await sendRefusal(auth, payload.conversationId, memberIds);
          if (refusal) {
            ack(refusal);
            return;
          }
          wasEmpty = !(await getConversation(payload.conversationId))?.last_message_at;
          const spam = await droppedAsSpam(auth, payload.conversationId, memberIds, bytes.length, wasEmpty);
          if (spam) {
            ack(spam);
            return;
          }
        }

        const result = appendMlsMessage(parsed.kind, {
          groupId: group.groupId, epoch: parsed.epoch, senderServerUserId: self, senderDeviceId: payload.deviceId, data: bytes,
        });
        if (!result.accepted) {
          if (result.reason === "future_epoch") ack(fail("future_epoch", "That epoch hasn't happened yet.", { epoch: result.epoch }));
          else ack(fail("no_group", "This conversation has no group yet."));
          return;
        }
        if (result.duplicate) {
          ack({ ok: true, seq: result.seq });
          return;
        }

        if (application) {
          await touchConversation(payload.conversationId, new Date(result.createdAt)).catch((err) =>
            consola.warn("touchConversation failed", payload.conversationId, err),
          );
          // The first message is what puts the conversation in the other person's list.
          if (wasEmpty) {
            for (const id of memberIds) {
              const view = (await directConversationViews(id)).find((v) => v.conversation_id === payload.conversationId);
              const recipients = socketsOf([id]);
              if (view) emitTo(recipients, "dm:opened", view);
            }
          }
        }
        await fanOut(memberIds, {
          groupId: group.groupId, seq: result.seq, kind: parsed.kind, epoch: parsed.epoch,
          senderServerUserId: self, senderDeviceId: payload.deviceId, data: bytes, createdAt: result.createdAt,
        }, payload.conversationId);
        ack({ ok: true, seq: result.seq });
      } catch (err) {
        consola.error("mls:send failed", err);
        ack(fail("failed", "Could not send"));
      }
    },

    /**
     * Everything after the cursor, oldest first. `gap` says entries the cursor needed were
     * already swept, so the device has lost them and has to be re-added.
     */
    "mls:log:fetch": async (payload: { accessToken: string; conversationId: string; after: number; limit?: number }, ack: Ack) => {
      ack = typeof ack === "function" ? ack : () => {};
      try {
        const auth = await begin("mls:read", RL_READ, payload, ack);
        if (!auth) return;
        const self = auth.tokenPayload.serverUserId;
        const memberIds = await dmOf(payload.conversationId, self, ack);
        if (!memberIds) return;
        const after = payload.after;
        if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) {
          ack(fail("invalid_payload", "after has to be a seq, 0 for the start."));
          return;
        }
        const limit = typeof payload.limit === "number" && payload.limit >= 1 ? Math.min(Math.floor(payload.limit), MAX_LOG_PAGE) : 100;
        const group = getMlsGroupForConversation(payload.conversationId);
        if (!group) {
          ack({ ok: true, group: null, entries: [], nextCursor: after, hasMore: false, gap: false });
          return;
        }

        const rows = listMlsLog(group.groupId, after, limit + 1);
        const page = rows.slice(0, limit);
        const blocked = await blockedServerIdsFor(self);
        const entries = page
          .filter((e) => e.kind === "commit" || !blocked.has(e.senderServerUserId))
          .map((e) => entryView(payload.conversationId, e));
        const oldest = oldestMlsSeq(group.groupId);
        const gap = after < group.headSeq && (oldest === null || oldest > after + 1);
        ack({
          ok: true,
          group: groupView(group),
          entries,
          nextCursor: page.length > 0 ? page[page.length - 1].seq : Math.max(after, gap ? group.headSeq : after),
          hasMore: rows.length > limit,
          gap,
        });
      } catch (err) {
        consola.error("mls:log:fetch failed", err);
        ack(fail("failed", "Could not read the log"));
      }
    },

    /** What a device needs on connect: its groups' heads, its Welcomes, and its package count. */
    "mls:sync": async (payload: { accessToken: string; deviceId: string }, ack: Ack) => {
      ack = typeof ack === "function" ? ack : () => {};
      try {
        const auth = await begin("mls:read", RL_READ, payload, ack);
        if (!auth || !ownDevice(auth, payload.deviceId, ack, false)) return;
        const self = auth.tokenPayload.serverUserId;
        const registered = isMlsDevice(self, payload.deviceId);
        if (registered) touchMlsDevice(self, payload.deviceId);

        ack({
          ok: true,
          registered,
          groups: listMlsGroupsForMember(self).map((g) => ({ ...groupView(g), oldestSeq: g.oldestSeq })),
          welcomes: registered
            ? listMlsWelcomes(self, payload.deviceId).map((w) => ({ ...w, data: Buffer.from(w.data) }))
            : [],
          keyPackages: { ...countMlsKeyPackages(self, payload.deviceId), target: MLS_MAX_KEY_PACKAGES },
        });
      } catch (err) {
        consola.error("mls:sync failed", err);
        ack(fail("failed", "Could not sync"));
      }
    },

    /** Once a Welcome is processed and saved. Until then it stays, so a crash loses nothing. */
    "mls:welcome:ack": async (payload: { accessToken: string; deviceId: string; welcomeIds: string[] }, ack: Ack) => {
      ack = typeof ack === "function" ? ack : () => {};
      try {
        const auth = await begin("mls:read", RL_READ, payload, ack);
        if (!auth || !ownDevice(auth, payload.deviceId, ack)) return;
        if (!Array.isArray(payload.welcomeIds) || payload.welcomeIds.length > 100) {
          ack(fail("invalid_payload", "welcomeIds has to be a list of up to 100."));
          return;
        }
        const ids = payload.welcomeIds.filter((id): id is string => typeof id === "string");
        ack({ ok: true, deleted: deleteMlsWelcomes(auth.tokenPayload.serverUserId, payload.deviceId, ids) });
      } catch (err) {
        consola.error("mls:welcome:ack failed", err);
        ack(fail("failed", "Could not delete the Welcomes"));
      }
    },
  };
}
