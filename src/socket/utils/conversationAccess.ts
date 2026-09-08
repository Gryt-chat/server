import { getConversation, isConversationMember, listConversationMemberIds, listServerChannels } from "../../db";
import { mayViewChannel } from "../../services/channelPermissions";

/** Both the socket handlers and the REST route go through here: two copies of
    an access rule are two chances to disagree. */

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
  /** The rules could not be read. Still `allowed: false`, but a client gives up
      on a missing channel and retries this, which clears in seconds. */
  | "undetermined";

/** `not_a_member` and `unknown_conversation` say the same thing on purpose: a
    DM id is derived from the pair, so guessing right must look like guessing wrong. */
export const DENIAL_RESPONSES: Record<AccessDenial, { error: string; message: string; status: number }> = {
  unauthenticated: { error: "unauthenticated", message: "You are not signed in to this server", status: 401 },
  not_a_member: { error: "not_found", message: "No such conversation", status: 404 },
  unknown_conversation: { error: "not_found", message: "No such conversation", status: 404 },
  /* 503 and its own error, because this one is worth retrying. It says nothing
     about the conversation, so it is not an oracle. */
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

/** Cached, and on a miss it reads again before answering no, or a just-created
    channel is refused to its own maker. */
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

/** `serverUserId` must already be authenticated; a `temp_` id is nobody. */
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
    // Here rather than at each caller: a hidden channel has to read as absent
    // from all three. The try is what separates "no" from "could not tell".
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
