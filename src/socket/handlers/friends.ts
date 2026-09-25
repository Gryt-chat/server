import consola from "consola";

import { isBotIdentity } from "../../auth/identity";
import {
  countOutgoingFriendRequests,
  deleteFriendRequest,
  eitherHasBlocked,
  getFriendRequest,
  getServerConfig,
  getUserByServerId,
  ignoreFriendRequest,
  listFriendRequests,
  listFriends,
  makeFriends,
  putFriendRequest,
  unfriend,
  type FriendPerson,
} from "../../db";
import { spamFilter } from "../../moderation/spamFilter";
import { isSpamExempt, spamRefusal, timeOutSpammer } from "../../moderation/spamTimeout";
import { textMuteError, textMuteFor } from "../../moderation/textMute";
import { checkRateLimit, type RateLimitRule } from "../../utils/rateLimiter";
import { requireAuth, type AuthResult } from "../middleware/auth";
import { CONTACT_REFUSALS, mayRequestFriendship } from "../utils/contactGate";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * Friend requests on this server (GRYT-1471). Everything is answered with the
 * caller's whole `friend:list`, and the other person gets theirs too.
 */

/* Tighter than blocking: every request is a notification on somebody else's screen. */
const RL_REQUEST: RateLimitRule = { limit: 20, windowMs: 10 * 60_000, scorePerAction: 1, maxScore: 8, scoreDecayMs: 15_000 };
const RL_ANSWER: RateLimitRule = { limit: 60, windowMs: 60_000, scorePerAction: 1, maxScore: 30, scoreDecayMs: 2_000 };
/** Pending at once. Past this, a request list is a mailing list. */
export const MAX_OUTGOING_FRIEND_REQUESTS = 100;

const NOT_A_MEMBER = { error: "unknown_member", message: "That person is not a member of this server" } as const;

export interface FriendView {
  serverUserId: string;
  nickname: string | null;
  at: string;
}

const view = (people: FriendPerson[]): FriendView[] =>
  people
    .filter((p): p is FriendPerson & { serverUserId: string } => !!p.serverUserId)
    .map((p) => ({ serverUserId: p.serverUserId, nickname: p.nickname, at: p.at }));

/** What one member is shown. A request from somebody either of them blocked isn't. */
export async function friendListFor(grytUserId: string): Promise<{ friends: FriendView[]; incoming: FriendView[]; outgoing: FriendView[] }> {
  const [friends, requests] = await Promise.all([listFriends(grytUserId), listFriendRequests(grytUserId)]);
  const incoming: FriendPerson[] = [];
  for (const r of requests.incoming) if (!(await eitherHasBlocked(grytUserId, r.grytUserId))) incoming.push(r);
  return { friends: view(friends), incoming: view(incoming), outgoing: view(requests.outgoing) };
}

/** Every device the member has open here gets their list again. */
export async function pushFriendList(
  io: HandlerContext["io"],
  clientsInfo: HandlerContext["clientsInfo"],
  serverUserId: string,
  grytUserId: string,
): Promise<void> {
  const list = await friendListFor(grytUserId);
  for (const [cid, ci] of Object.entries(clientsInfo)) {
    if (ci.serverUserId === serverUserId) io.sockets.sockets.get(cid)?.emit("friend:list", list);
  }
}

export function registerFriendHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, clientsInfo, sfuClient, serverId, getClientIp } = ctx;

  function limited(event: string, rule: RateLimitRule): boolean {
    const rl = checkRateLimit(event, clientsInfo[clientId]?.serverUserId, getClientIp(), rule);
    if (rl.allowed) return false;
    socket.emit("friend:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs, message: "Too many friend requests. Try again in a bit." });
    return true;
  }

  function emitTo(serverUserId: string, event: string, payload: unknown): void {
    for (const [cid, ci] of Object.entries(clientsInfo)) {
      if (ci.serverUserId === serverUserId) io.sockets.sockets.get(cid)?.emit(event, payload);
    }
  }

  /** Auth, then the other person, who has to be a member and not you or a bot. */
  async function begin(payload: { accessToken?: string; serverUserId?: unknown }) {
    if (!payload || typeof payload.serverUserId !== "string" || !payload.serverUserId) {
      socket.emit("friend:error", { error: "invalid_payload", message: "Invalid payload" });
      return null;
    }
    const auth = await requireAuth(socket, payload);
    if (!auth) return null;
    const target = await getUserByServerId(payload.serverUserId);
    if (!target || payload.serverUserId === auth.tokenPayload.serverUserId || isBotIdentity(target.gryt_user_id)) {
      socket.emit("friend:error", { ...NOT_A_MEMBER, serverUserId: payload.serverUserId });
      return null;
    }
    return { auth, target, self: auth.tokenPayload.serverUserId, me: auth.tokenPayload.grytUserId, them: target.gryt_user_id };
  }

  async function both(self: string, me: string, other: string, them: string): Promise<void> {
    await pushFriendList(io, clientsInfo, self, me);
    await pushFriendList(io, clientsInfo, other, them);
  }

  /** A burst of requests counts like a burst of new conversations, and earns the same timeout. */
  async function droppedAsSpam(auth: AuthResult, target: string): Promise<boolean> {
    const cfg = await getServerConfig().catch(() => null);
    if (cfg && cfg.spam_filter_enabled === false) return false;
    if (isSpamExempt({ isOwner: auth.isOwner, permissions: auth.permissions, grytUserId: auth.tokenPayload.grytUserId })) return false;
    const user = await getUserByServerId(auth.tokenPayload.serverUserId);
    if (!user) return false;
    const sensitivity = cfg?.spam_filter_sensitivity ?? "normal";
    const verdict = spamFilter.evaluate(
      { id: user.server_user_id, memberSince: user.created_at },
      { kind: "dm", conversationId: `friend:${target}`, recipients: [target], size: 0, newConversation: true, attachments: 0 },
      sensitivity,
    );
    if (!verdict.spam) return false;
    const { until } = await timeOutSpammer({
      io, clientsInfo, sfuClient, serverId, serverUserId: user.server_user_id, verdict, sensitivity, where: "dm",
    });
    socket.emit("friend:error", spamRefusal(until));
    return true;
  }

  return {
    "friend:list": async (payload: { accessToken: string }) => {
      try {
        const auth = await requireAuth(socket, payload);
        if (!auth) return;
        socket.emit("friend:list", await friendListFor(auth.tokenPayload.grytUserId));
      } catch (err) {
        consola.error("friend:list failed", err);
        socket.emit("friend:error", { error: "failed", message: "Couldn't load your friends." });
      }
    },

    "friend:request": async (payload: { accessToken: string; serverUserId: string }) => {
      try {
        if (limited("friend:request", RL_REQUEST)) return;
        const found = await begin(payload);
        if (!found) return;
        const { auth, target, self, me, them } = found;
        if (!target.is_active) {
          socket.emit("friend:error", { ...NOT_A_MEMBER, serverUserId: target.server_user_id });
          return;
        }

        const mute = await textMuteFor(self);
        if (mute.muted) {
          socket.emit("friend:error", textMuteError(mute));
          return;
        }

        // Already asked by them, so this is a yes.
        if (await getFriendRequest(them, me)) {
          if (await eitherHasBlocked(me, them)) {
            await pushFriendList(io, clientsInfo, self, me);
            return;
          }
          await makeFriends(me, them);
          await both(self, me, target.server_user_id, them);
          return;
        }

        /* Stored but never shown to them, so the sender sees what anybody would
           and a block isn't given away. Blocking already cleared older ones. */
        const blocked = await eitherHasBlocked(me, them);
        if (!blocked && !(await mayRequestFriendship(target.server_user_id))) {
          socket.emit("friend:error", { ...CONTACT_REFUSALS.friends, serverUserId: target.server_user_id });
          return;
        }
        if (await getFriendRequest(me, them)) {
          await pushFriendList(io, clientsInfo, self, me);
          return;
        }
        if ((await countOutgoingFriendRequests(me)) >= MAX_OUTGOING_FRIEND_REQUESTS) {
          socket.emit("friend:error", { error: "too_many_requests", message: "You have too many friend requests waiting. Cancel some first." });
          return;
        }
        if (await droppedAsSpam(auth, target.server_user_id)) return;

        const stored = await putFriendRequest(me, them);
        await pushFriendList(io, clientsInfo, self, me);
        if (stored && !blocked) {
          await pushFriendList(io, clientsInfo, target.server_user_id, them);
          emitTo(target.server_user_id, "friend:request:incoming", { serverUserId: self, nickname: clientsInfo[clientId]?.nickname ?? null });
        }
      } catch (err) {
        consola.error("friend:request failed", err);
        socket.emit("friend:error", { error: "failed", message: "Couldn't send the friend request." });
      }
    },

    "friend:accept": async (payload: { accessToken: string; serverUserId: string }) => {
      try {
        if (limited("friend:answer", RL_ANSWER)) return;
        const found = await begin(payload);
        if (!found) return;
        const { self, me, them, target } = found;
        if (!(await getFriendRequest(them, me)) || (await eitherHasBlocked(me, them))) {
          await deleteFriendRequest(them, me);
          await pushFriendList(io, clientsInfo, self, me);
          return;
        }
        await makeFriends(me, them);
        await both(self, me, target.server_user_id, them);
      } catch (err) {
        consola.error("friend:accept failed", err);
        socket.emit("friend:error", { error: "failed", message: "Couldn't accept the friend request." });
      }
    },

    "friend:decline": async (payload: { accessToken: string; serverUserId: string }) => {
      try {
        if (limited("friend:answer", RL_ANSWER)) return;
        const found = await begin(payload);
        if (!found) return;
        await ignoreFriendRequest(found.them, found.me);
        await pushFriendList(io, clientsInfo, found.self, found.me);
      } catch (err) {
        consola.error("friend:decline failed", err);
        socket.emit("friend:error", { error: "failed", message: "Couldn't decline the friend request." });
      }
    },

    "friend:cancel": async (payload: { accessToken: string; serverUserId: string }) => {
      try {
        if (limited("friend:answer", RL_ANSWER)) return;
        const found = await begin(payload);
        if (!found) return;
        const { self, me, them, target } = found;
        await deleteFriendRequest(me, them);
        await both(self, me, target.server_user_id, them);
      } catch (err) {
        consola.error("friend:cancel failed", err);
        socket.emit("friend:error", { error: "failed", message: "Couldn't cancel the friend request." });
      }
    },

    "friend:remove": async (payload: { accessToken: string; serverUserId: string }) => {
      try {
        if (limited("friend:answer", RL_ANSWER)) return;
        const found = await begin(payload);
        if (!found) return;
        const { self, me, them, target } = found;
        await unfriend(me, them);
        await both(self, me, target.server_user_id, them);
      } catch (err) {
        consola.error("friend:remove failed", err);
        socket.emit("friend:error", { error: "failed", message: "Couldn't remove the friend." });
      }
    },
  };
}
