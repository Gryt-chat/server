import consola from "consola";
import type { Server } from "socket.io";

import { isBotIdentity } from "../auth/identity";
import type { Permission } from "../constants/permissions";
import { countServerAudit, insertServerAudit, setUserModerationState } from "../db";
import type { SFUClient } from "../sfu/client";
import { broadcastMemberList, syncAllClients } from "../socket/utils/clients";
import type { Clients } from "../types";
import { STRIKE_MEMORY_MS, TIMEOUT_LADDER_MINUTES, type SpamSensitivity, type Verdict } from "./spamFilter";
import { textMuteError } from "./textMute";
import { announceMute } from "./timeout";

export const SPAM_AUDIT_ACTION = "spam_timeout";

/** Anybody who can already silence or remove a member, or hand that out, or run
    the server. The same list plugins may not act on, plus `manage_server`. */
export const SPAM_EXEMPT_PERMISSIONS: readonly Permission[] = [
  "kick_members",
  "ban_members",
  "mute_members",
  "manage_messages",
  "manage_roles",
  "manage_server",
];

/** Webhooks never reach `chat:send`, and a bot is here because somebody approved it. */
export function isSpamExempt(who: {
  isOwner: boolean;
  permissions: ReadonlySet<Permission>;
  grytUserId: string | null | undefined;
}): boolean {
  if (who.isOwner) return true;
  if (isBotIdentity(who.grytUserId)) return true;
  return SPAM_EXEMPT_PERMISSIONS.some((p) => who.permissions.has(p));
}

/** Prior strikes this week pick the step; past the end it stays at the last. */
export function timeoutMinutesFor(priorStrikes: number): number {
  const step = Math.min(Math.max(0, Math.floor(priorStrikes)), TIMEOUT_LADDER_MINUTES.length - 1);
  return TIMEOUT_LADDER_MINUTES[step];
}

function rounded(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * The same timeout a moderator gives, written the same way. The audit row names
 * the signals but never the channel, whose id the audit list would not filter.
 */
export async function timeOutSpammer(p: {
  io: Server;
  clientsInfo: Clients;
  sfuClient: SFUClient | null;
  serverId: string;
  serverUserId: string;
  verdict: Verdict;
  sensitivity: SpamSensitivity;
  where: "channel" | "dm";
}): Promise<{ until: Date; minutes: number; strike: number }> {
  const now = Date.now();
  const prior = await countServerAudit(SPAM_AUDIT_ACTION, p.serverUserId, new Date(now - STRIKE_MEMORY_MS));
  const minutes = timeoutMinutesFor(prior);
  const until = new Date(now + minutes * 60_000);

  await setUserModerationState(p.serverUserId, { muted: true, mutedUntil: until });
  announceMute({
    io: p.io,
    clientsInfo: p.clientsInfo,
    sfuClient: p.sfuClient,
    serverId: p.serverId,
    serverUserId: p.serverUserId,
    muted: true,
    until,
    reason: "spam",
  });

  const signals: Record<string, number> = {};
  for (const s of p.verdict.signals) signals[s.name] = rounded(s.points);

  await insertServerAudit({
    actorServerUserId: null,
    action: SPAM_AUDIT_ACTION,
    target: p.serverUserId,
    meta: {
      signals,
      score: rounded(p.verdict.score),
      threshold: p.verdict.threshold,
      newMemberWeight: p.verdict.weight,
      sensitivity: p.sensitivity,
      in: p.where,
      strike: prior + 1,
      minutes,
      expiresAt: until.toISOString(),
    },
  }).catch((e) => consola.warn("audit log write failed", e));

  syncAllClients(p.io, p.clientsInfo);
  broadcastMemberList(p.io, p.clientsInfo, p.serverId);

  consola.warn("🚫 Spam filter timeout", {
    user: p.serverUserId,
    minutes,
    strike: prior + 1,
    score: rounded(p.verdict.score),
    signals,
  });
  return { until, minutes, strike: prior + 1 };
}

/** A mute refusal, so the client settles the row and the composer says so. */
export function spamRefusal(until: Date): ReturnType<typeof textMuteError> & { reason: "spam" } {
  return {
    ...textMuteError({ until }),
    reason: "spam",
    message: `The spam filter muted you on this server until ${until.toISOString()}.`,
  };
}
