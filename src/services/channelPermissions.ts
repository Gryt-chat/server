import { CHANNEL_PERMISSIONS, type ChannelPermission } from "../constants/permissions";
import type { ChannelPermissionRuleRecord, ServerSidebarItemRecord } from "../db/interfaces";
import { listAllPermissionRules, listServerChannels, listServerSidebarItems, resolveChannelScopes } from "../db";
import { getEffectiveStanding } from "./permissions";

/**
 * Where a role's server-wide permissions and one channel's scope meet. Every
 * caller asks here: a rule read in two places is applied differently in two.
 */

const RULES_CACHE_TTL_MS = 15_000;

/** A sentinel channel id, so a failed read cannot look like "nothing scoped". */
const UNREADABLE = "\u0000unreadable";

interface CachedRules {
  byScope: Map<string, ChannelPermissionRuleRecord[]>;
  scopeByChannel: Map<string, string | null>;
  fetchedAt: number;
}

let rulesCache: CachedRules | null = null;

async function readRules(): Promise<CachedRules> {
  const [byScope, channels, items] = await Promise.all([
    listAllPermissionRules(),
    listServerChannels(),
    listServerSidebarItems(),
  ]);
  const scopeByChannel = new Map<string, string | null>();
  for (const [channelId, resolved] of resolveChannelScopes(channels, items)) {
    scopeByChannel.set(channelId, resolved.scopeId);
  }
  rulesCache = { byScope, scopeByChannel, fetchedAt: Date.now() };
  return rulesCache;
}

async function currentRules(): Promise<CachedRules> {
  const now = Date.now();
  if (!rulesCache || now - rulesCache.fetchedAt > RULES_CACHE_TTL_MS) return readRules();
  return rulesCache;
}

/** After any write that could change an answer: editing a scope, repointing a
    channel or a folder, moving a channel, deleting a template or a role. */
export function resetChannelPermissionCache(): void {
  rulesCache = null;
}

/** Undefined when nothing in the scope mentions it, which means inherit: the
    caller keeps whatever the server-wide answer was. */
function ruleVerdict(
  rules: ChannelPermissionRuleRecord[] | undefined,
  roleIds: readonly string[],
  permission: ChannelPermission,
): boolean | undefined {
  if (!rules || rules.length === 0) return undefined;

  let sawDeny = false;
  let sawAllow = false;
  for (const rule of rules) {
    if (rule.permission !== permission) continue;
    if (!roleIds.includes(rule.role_id)) continue;
    if (rule.effect === "allow") sawAllow = true;
    else sawDeny = true;
  }

  // Allow wins across roles: opening a channel to one group was deliberate, and
  // refusing a member of it over a second role reads as a bug in the channel.
  if (sawAllow) return true;
  if (sawDeny) return false;
  return undefined;
}

/** Whether a member may do one thing in one channel. */
export async function mayInChannel(
  channelId: string,
  serverUserId: string | null | undefined,
  permission: ChannelPermission,
  grytUserId?: string,
): Promise<boolean> {
  if (!serverUserId || serverUserId.startsWith("temp_")) return false;

  try {
    const [rules, standing] = await Promise.all([
      currentRules(),
      getEffectiveStanding(serverUserId, grytUserId),
    ]);

    // The owner can edit any scope anyway, so a channel they locked themselves
    // out of would be a puzzle with no lesson in it.
    if (standing.isOwner) return true;

    const base = standing.permissions.has(permission);

    // No scope, or not a channel at all: a DM reaches some of these paths. Both
    // mean whatever the server said.
    const scopeId = rules.scopeByChannel.get(channelId);
    if (!scopeId) return base;

    const verdict = ruleVerdict(rules.byScope.get(scopeId), standing.roleIds, permission);
    return verdict ?? base;
  } catch {
    // Fails shut, like every other gate here. A database hiccup that answered
    // yes to everything would be far worse than one that answered no.
    return false;
  }
}

/** One read of the rules and one resolution of standing, for every channel.
    Fails shut: unreadable returns an empty set, never every channel. */
async function channelIdsAllowing(
  permission: ChannelPermission,
  serverUserId: string | null | undefined,
  grytUserId?: string,
): Promise<Set<string>> {
  if (!serverUserId || serverUserId.startsWith("temp_")) return new Set();

  try {
    const [rules, standing] = await Promise.all([
      currentRules(),
      getEffectiveStanding(serverUserId, grytUserId),
    ]);
    if (standing.isOwner) return new Set(rules.scopeByChannel.keys());

    const base = standing.permissions.has(permission);
    const allowed = new Set<string>();
    for (const [channelId, scopeId] of rules.scopeByChannel) {
      if (!scopeId) {
        if (base) allowed.add(channelId);
        continue;
      }
      const verdict = ruleVerdict(rules.byScope.get(scopeId), standing.roleIds, permission);
      if (verdict ?? base) allowed.add(channelId);
    }
    return allowed;
  } catch {
    return new Set();
  }
}

/** Every channel permission a member holds, per channel: one read of the rules,
    one standing, and one pass per scope. Fails shut, to an empty map. */
export async function channelPermissionsByChannel(
  serverUserId: string | null | undefined,
  grytUserId?: string,
): Promise<Map<string, readonly ChannelPermission[]>> {
  const held = new Map<string, readonly ChannelPermission[]>();
  if (!serverUserId || serverUserId.startsWith("temp_")) return held;

  try {
    const [rules, standing] = await Promise.all([
      currentRules(),
      getEffectiveStanding(serverUserId, grytUserId),
    ]);
    if (standing.isOwner) {
      for (const channelId of rules.scopeByChannel.keys()) held.set(channelId, CHANNEL_PERMISSIONS);
      return held;
    }

    const base = CHANNEL_PERMISSIONS.filter((p) => standing.permissions.has(p));
    // Channels following one template share its scope, so each is worked out once.
    const byScope = new Map<string, ChannelPermission[]>();
    for (const [channelId, scopeId] of rules.scopeByChannel) {
      if (!scopeId) {
        held.set(channelId, base);
        continue;
      }
      let inScope = byScope.get(scopeId);
      if (!inScope) {
        const scopeRules = rules.byScope.get(scopeId);
        inScope = CHANNEL_PERMISSIONS.filter(
          (p) => ruleVerdict(scopeRules, standing.roleIds, p) ?? standing.permissions.has(p),
        );
        byScope.set(scopeId, inScope);
      }
      held.set(channelId, inScope);
    }
    return held;
  } catch {
    return new Map();
  }
}

/** Visibility is `read_messages` per channel, not a second setting: a template
    that denies reading hides the channel, and the server stops naming it. */
export async function visibleChannelIds(
  serverUserId: string | null | undefined,
  grytUserId?: string,
): Promise<Set<string>> {
  return channelIdsAllowing("read_messages", serverUserId, grytUserId);
}

/** True for an id that is not a channel: DM ids reach this and have no scope,
    so treating an unknown id as hidden would lock every DM. */
export async function mayViewChannel(
  channelId: string,
  serverUserId: string | null | undefined,
  grytUserId?: string,
): Promise<boolean> {
  if (!serverUserId || serverUserId.startsWith("temp_")) return false;

  /* Deliberately unwrapped: catching here makes an unreadable rules table look
     like a channel you may not see, which a client gives up on. */
  const rules = await currentRules();
  if (!rules.scopeByChannel.has(channelId)) return true;
  return await mayInChannel(channelId, serverUserId, "read_messages", grytUserId);
}

/** Empty on a server nobody has narrowed, so the broadcast paths can send one
    payload to everybody rather than a standing lookup per socket. */
export async function scopedChannelIds(): Promise<Set<string>> {
  try {
    const rules = await currentRules();
    const scoped = new Set<string>();
    for (const [channelId, scopeId] of rules.scopeByChannel) {
      if (scopeId) scoped.add(channelId);
    }
    return scoped;
  } catch {
    // Unreadable rules put the broadcast paths on the careful branch rather
    // than the fast one. An empty set here would be the fail-open answer.
    return new Set([UNREADABLE]);
  }
}

/** Hidden channels' rows go, then every folder with none of its rows left. A
    manager keeps empty folders, having somewhere to put a channel. */
export function visibleSidebarItems<
  T extends Pick<ServerSidebarItemRecord, "item_id" | "kind" | "channel_id" | "parent_item_id">,
>(items: readonly T[], visible: ReadonlySet<string>, keepEmptyFolders: boolean): T[] {
  const kept = items.filter((it) => it.kind !== "channel" || !it.channel_id || visible.has(it.channel_id));
  if (keepEmptyFolders) return kept;

  const filled = new Set<string>();
  for (const it of kept) {
    if (it.kind === "channel" && it.channel_id && it.parent_item_id) filled.add(it.parent_item_id);
  }
  return kept.filter((it) => it.kind !== "folder" || filled.has(it.item_id));
}

/** `manage_channels` lists every channel anyway, so its empty folders name
    nothing new. Fails shut, to hiding them. */
export async function keepsEmptyFolders(
  serverUserId: string | null | undefined,
  grytUserId?: string,
): Promise<boolean> {
  if (!serverUserId || serverUserId.startsWith("temp_")) return false;
  try {
    const standing = await getEffectiveStanding(serverUserId, grytUserId);
    return standing.isOwner || standing.permissions.has("manage_channels");
  } catch {
    return false;
  }
}
