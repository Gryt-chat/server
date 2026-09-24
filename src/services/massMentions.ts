import { getAllRegisteredUsers } from "../db";
import { channelReaders } from "./channelPermissions";

export interface MassMentionAudience {
  role: string[];
  here: string[];
  everyone: string[];
}

/** Who @everyone, @here and each role reach in one channel: only people who can
    read it, never the sender, and nobody who blocked the sender. */
export async function massMentionAudience(args: {
  channelId: string;
  senderServerUserId: string;
  everyone: boolean;
  here: boolean;
  roleIds: readonly string[];
  /** Everybody with a socket open right now, which is all @here asks. */
  connected: ReadonlySet<string>;
  blockers: ReadonlySet<string>;
}): Promise<MassMentionAudience> {
  const audience: MassMentionAudience = { role: [], here: [], everyone: [] };
  if (!args.everyone && !args.here && args.roleIds.length === 0) return audience;

  const people = (await getAllRegisteredUsers())
    .filter((u) => u.is_active !== false)
    .filter((u) => u.server_user_id !== args.senderServerUserId && !args.blockers.has(u.server_user_id))
    .map((u) => ({ serverUserId: u.server_user_id, grytUserId: u.gryt_user_id }));

  const readers = await channelReaders(args.channelId, people);
  for (const [serverUserId, roleIds] of readers) {
    if (args.everyone) audience.everyone.push(serverUserId);
    if (args.here && args.connected.has(serverUserId)) audience.here.push(serverUserId);
    if (args.roleIds.some((r) => roleIds.includes(r))) audience.role.push(serverUserId);
  }
  return audience;
}
