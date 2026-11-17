import consola from "consola";
import { PermissionFlagsBits, type Guild, type Role } from "discord.js";

import { ESCALATION_PERMISSIONS, PERMISSIONS, type Permission } from "../constants/permissions";
import { addMemberRole, createRoleDefinition, getRoleDefinition } from "../db";

const P = PermissionFlagsBits;

/** Discord's permission to the nearest Gryt ones. Nothing here reaches the escalation set. */
const MAP: [bigint, Permission[]][] = [
  [P.ViewChannel, ["read_messages"]],
  [P.SendMessages, ["send_messages"]],
  [P.AttachFiles, ["attach_files"]],
  [P.AddReactions, ["add_reactions"]],
  [P.MentionEveryone, ["mention_everyone"]],
  [P.Connect, ["join_voice"]],
  [P.Speak, ["speak"]],
  [P.Stream, ["share_screen", "share_video"]],
  [P.ChangeNickname, ["change_nickname"]],
  [P.CreateInstantInvite, ["create_invite"]],
  [P.ManageMessages, ["manage_messages"]],
  [P.KickMembers, ["kick_members"]],
  [P.BanMembers, ["ban_members", "view_bans"]],
  [P.MuteMembers, ["mute_members"]],
  [P.DeafenMembers, ["deafen_members"]],
  [P.MoveMembers, ["disconnect_members"]],
  [P.ManageChannels, ["manage_channels", "manage_sidebar"]],
  [P.ManageGuildExpressions, ["manage_emojis"]],
  [P.ManageWebhooks, ["manage_webhooks"]],
  [P.ViewAuditLog, ["view_audit_log"]],
];

/** Between Member (40) and Moderator (60), in Discord's order, so an imported role never outranks Gryt's own. */
const RANK_LOW = 41;
const RANK_HIGH = 59;

export function grytPermissionsFor(bits: bigint): Permission[] {
  if ((bits & P.Administrator) === P.Administrator) return PERMISSIONS.filter((p) => !ESCALATION_PERMISSIONS.has(p));
  const out = new Set<Permission>();
  for (const [flag, perms] of MAP) if ((bits & flag) === flag) for (const p of perms) out.add(p);
  return [...out];
}

export function roleIdFor(discordRoleId: string): string {
  return `dc-${discordRoleId}`;
}

function copyable(r: Role, guild: Guild): boolean {
  return r.id !== guild.id && !r.managed;
}

/** Each Discord role once; an existing one is left as the owner may have changed it. */
export async function importRoles(guild: Guild): Promise<number> {
  const roles = [...(await guild.roles.fetch()).values()].filter((r) => copyable(r, guild)).sort((a, b) => a.position - b.position);
  let made = 0;
  for (const [i, r] of roles.entries()) {
    const id = roleIdFor(r.id);
    if (await getRoleDefinition(id)) continue;
    const rank = roles.length <= 1 ? RANK_LOW : Math.round(RANK_LOW + ((RANK_HIGH - RANK_LOW) * i) / (roles.length - 1));
    try {
      await createRoleDefinition(id, {
        name: r.name.slice(0, 64) || "Discord role",
        color: r.color ? r.hexColor : null,
        rank,
        permissions: grytPermissionsFor(r.permissions.bitfield),
        mentionable: r.mentionable,
      });
      made += 1;
    } catch (e) {
      consola.warn(`[DiscordBridge] role ${r.name} wasn't copied`, e);
    }
  }
  return made;
}

/** A linked member gets the roles they hold on Discord, the ones that were copied. */
export async function grantDiscordRoles(guild: Guild, discordUserId: string, serverUserId: string): Promise<number> {
  const member = await guild.members.fetch(discordUserId).catch(() => null);
  if (!member) return 0;
  let granted = 0;
  for (const r of member.roles.cache.values()) {
    if (!copyable(r, guild) || !(await getRoleDefinition(roleIdFor(r.id)))) continue;
    await addMemberRole(serverUserId, roleIdFor(r.id));
    granted += 1;
  }
  return granted;
}
