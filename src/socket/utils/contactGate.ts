import { getContactPrefs, getUserByServerId, hasWrittenTo, type ContactPrefs, type ContactRule } from "../../db";

/**
 * The recipient's own settings, asked on every DM open, send, group add, ring and
 * one-to-one call join. Nobody bypasses them, owner included (decision 8).
 */

/** What the sender is told. Plain on purpose: this is a preference, not a block. */
export const CONTACT_REFUSALS = {
  messages: { error: "contact_refused", message: "They're not taking messages from you on this server." },
  calls: { error: "contact_refused", message: "They're not taking calls from you on this server." },
} as const;

/**
 * Stands in for friends until GRYT-1471: somebody the recipient has written to in
 * their one-to-one. Swap this body for the friendships table when that lands.
 */
export async function isFriendOf(recipientServerUserId: string, senderServerUserId: string): Promise<boolean> {
  return hasWrittenTo(recipientServerUserId, senderServerUserId);
}

async function prefsOf(serverUserId: string): Promise<ContactPrefs | null> {
  const user = await getUserByServerId(serverUserId);
  return user ? getContactPrefs(user.gryt_user_id) : null;
}

async function passes(rule: ContactRule, recipient: string, sender: string): Promise<boolean> {
  if (rule === "everyone") return true;
  if (rule === "nobody") return false;
  return isFriendOf(recipient, sender);
}

/** Whether `sender` may write to `recipient` one-to-one, or put them in a group. */
export async function mayMessage(senderServerUserId: string, recipientServerUserId: string): Promise<boolean> {
  const prefs = await prefsOf(recipientServerUserId);
  if (!prefs) return false;
  return passes(prefs.messages, recipientServerUserId, senderServerUserId);
}

/** Calls are never looser than messages, since a ring happens inside a conversation. */
export async function mayCall(senderServerUserId: string, recipientServerUserId: string): Promise<boolean> {
  const prefs = await prefsOf(recipientServerUserId);
  if (!prefs) return false;
  return (
    (await passes(prefs.messages, recipientServerUserId, senderServerUserId))
    && (await passes(prefs.calls, recipientServerUserId, senderServerUserId))
  );
}

/** The other person in a one-to-one, or null for one already down to one member. */
export function peerOf(memberIds: string[], self: string): string | null {
  return memberIds.find((id) => id !== self) ?? null;
}

/**
 * Joining a one-to-one call. The peer ringing or already in the room is their yes,
 * or answering somebody you never wrote to could not work.
 */
export async function mayJoinOneToOneCall(
  memberIds: string[],
  joiner: string,
  peerIsWaiting: (peer: string) => boolean,
): Promise<boolean> {
  const peer = peerOf(memberIds, joiner);
  if (peer === null || peerIsWaiting(peer)) return true;
  return mayCall(joiner, peer);
}
