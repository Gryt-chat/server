import { getConversation, isConversationMember, listConversationMemberIds, listServerChannels } from "../../db";
import { mayViewChannel } from "../../services/channelPermissions";

/**
 * Who is allowed to read and write a conversation. Both the socket handlers and
 * the REST route go through here — two copies of an access rule are two chances
 * to disagree, and the REST route is the one somebody forgets.
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
 * What to tell the caller, and the matching HTTP status.
 *
 * Deliberately not `forbidden`, which means "your role does not allow this"
 * everywhere else — a client has to tell that apart from "not your
 * conversation".
 *
 * `not_a_member` and `unknown_conversation` say the same thing on purpose.
 * Telling them apart makes this an oracle for whether two people have a
 * conversation open, and the id is derived from the pair. A channel hidden by
 * `view_min_rank` answers the same: **guessing an id has to be
 * indistinguishable from guessing wrong.**
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
 * Whether a channel by this id exists. Cached, and on a miss it reads again
 * before answering no, or a just-created channel is refused to its own maker.
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
 * `serverUserId` must already be authenticated; a `temp_` id is nobody.
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

  if (await channelExists(conversationId)) {
    // The gate is checked here rather than at each caller because this is
    // already where the socket handlers, the REST route and the call handlers
    // meet. A channel somebody may not see has to read as absent from all
    // three, and history is the path where a guessed id would otherwise pay.
    if (!(await mayViewChannel(conversationId, serverUserId))) {
      return { allowed: false, reason: "unknown_conversation" };
    }
    return { allowed: true, kind: "channel" };
  }

  return { allowed: false, reason: "unknown_conversation" };
}
