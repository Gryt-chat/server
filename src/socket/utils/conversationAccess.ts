import { getConversation, isConversationMember, listConversationMemberIds, listServerChannels } from "../../db";

/**
 * Who is allowed to read and write a conversation.
 *
 * Until direct messages existed there was nothing to decide: every value in
 * `messages.conversation_id` was a channel, and a channel is open to every
 * member of the server. The chat events check who the caller is and whether
 * their role lets them read or post here at all, and that was the whole of it —
 * no event asked whether *this* conversation was one of theirs, because the
 * answer was always yes. That holds exactly as long as no private conversation
 * exists, and this file is what has to exist before one does.
 *
 * Both the socket handlers and the REST route go through here, because two
 * copies of an access rule are two chances to disagree, and the REST route is
 * the one somebody forgets.
 */

export type ConversationAccess =
  | { allowed: true; kind: "channel" }
  | { allowed: true; kind: "dm"; memberIds: string[] }
  | { allowed: false; reason: AccessDenial };

/** The half of {@link ConversationAccess} that means yes. */
export type AllowedConversationAccess = Extract<ConversationAccess, { allowed: true }>;

export type AccessDenial =
  /** No authenticated member behind this request. */
  | "unauthenticated"
  /** A real conversation, but not one of theirs. */
  | "not_a_member"
  /** Neither a channel nor a conversation. Nothing to read. */
  | "unknown_conversation";

/**
 * What to tell the caller, and the HTTP status that matches.
 *
 * Deliberately not `forbidden`. That code means "your role does not allow this"
 * everywhere else in the chat events, and `permissionGates.test.ts` reads it as
 * exactly that — a conversation that is not yours is a different answer, and
 * folding the two together leaves a client unable to tell "ask an admin for the
 * permission" from "that is not your conversation".
 *
 * `not_a_member` and `unknown_conversation` deliberately say the same thing.
 * Telling them apart turns this into an oracle for whether two particular
 * people have a conversation open, which anybody who can read a member list
 * could then ask, since the id is derived from the pair.
 */
export const DENIAL_RESPONSES: Record<AccessDenial, { error: string; message: string; status: number }> = {
  unauthenticated: { error: "unauthenticated", message: "You are not signed in to this server", status: 401 },
  not_a_member: { error: "not_found", message: "No such conversation", status: 404 },
  unknown_conversation: { error: "not_found", message: "No such conversation", status: 404 },
};

const CHANNEL_CACHE_TTL_MS = 15_000;
let channelIdCache: { ids: Set<string>; fetchedAt: number } | null = null;

async function refreshChannelIds(): Promise<Set<string>> {
  const channels = await listServerChannels();
  const ids = new Set(channels.map((c) => c.channel_id));
  channelIdCache = { ids, fetchedAt: Date.now() };
  return ids;
}

/**
 * Whether a channel by this id exists.
 *
 * Cached, and on a miss it reads again before answering no. Without the second
 * read a channel created moments ago would be refused for as long as the cache
 * lived, so the person who just made it could not post in it — a cache that
 * makes a wrong answer stick is worse than no cache.
 */
async function channelExists(channelId: string): Promise<boolean> {
  const now = Date.now();
  if (!channelIdCache || now - channelIdCache.fetchedAt > CHANNEL_CACHE_TTL_MS) {
    return (await refreshChannelIds()).has(channelId);
  }
  if (channelIdCache.ids.has(channelId)) return true;
  return (await refreshChannelIds()).has(channelId);
}

/** Drop the cached channel ids, for a test or a channel that just went away. */
export function resetChannelIdCache(): void {
  channelIdCache = null;
}

/**
 * Whether this member may touch this conversation, and what kind it is.
 *
 * `serverUserId` must be one the server has already authenticated — the value
 * from a verified token, or the one recorded against a socket that finished
 * joining. A `temp_` id belongs to a socket that has connected but not proved
 * anything yet and is treated as nobody.
 */
export async function resolveConversationAccess(
  conversationId: string,
  serverUserId: string | null | undefined,
): Promise<ConversationAccess> {
  if (!serverUserId || serverUserId.startsWith("temp_")) {
    return { allowed: false, reason: "unauthenticated" };
  }

  const conversation = await getConversation(conversationId);
  if (conversation) {
    if (!(await isConversationMember(conversationId, serverUserId))) {
      return { allowed: false, reason: "not_a_member" };
    }
    return { allowed: true, kind: "dm", memberIds: await listConversationMemberIds(conversationId) };
  }

  if (await channelExists(conversationId)) return { allowed: true, kind: "channel" };

  return { allowed: false, reason: "unknown_conversation" };
}
