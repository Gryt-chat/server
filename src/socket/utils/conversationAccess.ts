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
  | "unknown_conversation"
  /**
   * The question could not be answered. Not a refusal.
   *
   * Reading the permission rules failed — a busy database, a container still
   * coming up. This used to arrive as `unknown_conversation`, because
   * `mayViewChannel` caught its own errors and returned false, so "I could not
   * check" and "there is no such channel" were one answer.
   *
   * They are not one answer to a client. One is permanent and worth giving up
   * on; the other clears by itself in seconds. Voice reconnects five times over
   * twenty seconds and then stops, so a transient failure dressed as a missing
   * channel takes somebody out of a call they could have rejoined.
   *
   * Still `allowed: false` — failing closed does not change. Only what the
   * caller is told about why.
   */
  | "undetermined";

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
  /*
   * 503 and a distinct error, because this one is worth retrying and the others
   * are not. It says nothing about the conversation — only that this server
   * could not answer — so it is not an oracle the way telling the two 404s
   * apart would be.
   */
  undetermined: { error: "unavailable", message: "Could not check that just now. Try again in a moment.", status: 503 },
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
 *
 * Exported since GRYT-936: a plugin deleting a message has to establish that
 * the conversation is a channel and not a direct message, and it should be
 * asking the same cached question the access resolver asks rather than a second
 * one of its own.
 */
export async function channelExists(channelId: string): Promise<boolean> {
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
    //
    // The try is what separates "no" from "could not tell". `mayViewChannel`
    // throws now rather than swallowing its own failures, so a rules read that
    // fell over stops being reported as a channel that does not exist.
    let visible: boolean;
    try {
      visible = await mayViewChannel(conversationId, serverUserId);
    } catch {
      return { allowed: false, reason: "undetermined" };
    }

    if (!visible) {
      return { allowed: false, reason: "unknown_conversation" };
    }
    return { allowed: true, kind: "channel" };
  }

  return { allowed: false, reason: "unknown_conversation" };
}
