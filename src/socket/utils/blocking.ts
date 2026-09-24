import { blockedServerIdsFor, blockersOfSender } from "../../db";

/** Who blocked them, as with messages. A one-to-one adds who they blocked, as
    `dm:open` does, since only the two of them are in it. */
export async function unreachableFrom(
  serverUserId: string,
  conversation: { group: boolean },
): Promise<Set<string>> {
  const blockers = await blockersOfSender(serverUserId);
  if (conversation.group) return blockers;
  for (const id of await blockedServerIdsFor(serverUserId)) blockers.add(id);
  return blockers;
}
