import consola from "consola";
import type { JoinPolicy, ServerConfigRecord } from "../db/interfaces";
import {
  updateServerConfig,
  insertServerAudit,
  DEFAULT_AVATAR_MAX_BYTES,
  DEFAULT_EMOJI_MAX_BYTES,
  DEFAULT_UPLOAD_MAX_BYTES,
} from "../db";
import { invalidateSystemChannelCache } from "../socket/utils/systemMessages";
import { broadcastServerUiUpdate } from "../socket/utils/server";
import { syncMdnsAdvertising } from "../mdns";
import { VALID_CENSOR_STYLES, type CensorStyle } from "../utils/profanityFilter";

/**
 * Applying a settings change, in one place.
 *
 * This used to live inside the socket handler, which was fine while a socket
 * was the only way to change a setting. It is not any more: the CLI manages a
 * server it runs on the same machine, through a management endpoint, and two
 * copies of this logic would drift on the first change either one forgot.
 *
 * Validation is not the reason it has to be shared. The side effects are.
 * Writing the row is a small part of what happens when a setting changes:
 * turning discovery off has to withdraw the mDNS advertisement, changing the
 * system channel has to drop a cache, and every connected client has to be
 * told. A caller that only wrote the row would leave a server that believes it
 * is hidden and is still broadcasting itself on the network.
 */

export interface SettingsPatch {
  displayName?: string;
  description?: string;
  iconUrl?: string | null;
  avatarMaxBytes?: number | null;
  uploadMaxBytes?: number | null;
  emojiMaxBytes?: number | null;
  profanityMode?: string;
  profanityCensorStyle?: string;
  systemChannelId?: string | null;
  lanOpen?: boolean;
  joinPolicy?: string;
  discoverable?: boolean;
}

/** Who asked for the change, for the audit trail. */
export interface SettingsActor {
  /** The server user, when a person did it through a client. */
  serverUserId: string | null;
  /**
   * How the change arrived. A change made through the management endpoint is
   * recorded as such, so the audit log distinguishes "the owner changed this"
   * from "something holding the admin token changed this".
   */
  via: "client" | "management";
}

const clampBytes = (v: number | null | undefined, min: number, max: number): number | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, Math.floor(n)));
};

/**
 * Same as clampBytes, except zero survives, because zero means unlimited and
 * the 256 KB floor would otherwise make that unreachable. Uploads only:
 * avatars and emoji are held in memory to be re-encoded.
 */
const clampBytesAllowingZero = (v: number | null | undefined, min: number, max: number): number | null | undefined => {
  const n = typeof v === "number" ? v : Number(v);
  if (v !== undefined && v !== null && Number.isFinite(n) && Math.floor(n) === 0) return 0;
  return clampBytes(v, min, max);
};

export async function applyServerSettings(
  patch: SettingsPatch,
  actor: SettingsActor
): Promise<ServerConfigRecord> {
  const displayName = typeof patch.displayName === "string" ? patch.displayName.trim().slice(0, 80) : undefined;
  const description = typeof patch.description === "string" ? patch.description.trim().slice(0, 300) : undefined;
  const iconUrl = typeof patch.iconUrl === "string" ? patch.iconUrl.trim().slice(0, 500) : patch.iconUrl === null ? null : undefined;

  const avatarMaxBytes = clampBytes(patch.avatarMaxBytes, 256 * 1024, 200 * 1024 * 1024);
  const uploadMaxBytes = clampBytesAllowingZero(patch.uploadMaxBytes, 256 * 1024, Number.MAX_SAFE_INTEGER);
  const emojiMaxBytes = clampBytes(patch.emojiMaxBytes, 64 * 1024, 200 * 1024 * 1024);

  const validProfanityModes = ["off", "flag", "censor", "block"] as const;
  const profanityMode = typeof patch.profanityMode === "string" && validProfanityModes.includes(patch.profanityMode as typeof validProfanityModes[number])
    ? patch.profanityMode as typeof validProfanityModes[number]
    : undefined;

  const profanityCensorStyle: CensorStyle | undefined =
    typeof patch.profanityCensorStyle === "string" && VALID_CENSOR_STYLES.includes(patch.profanityCensorStyle as CensorStyle)
      ? patch.profanityCensorStyle as CensorStyle
      : undefined;

  const systemChannelId: string | null | undefined =
    patch.systemChannelId === null ? null
      : typeof patch.systemChannelId === "string" ? patch.systemChannelId.trim().slice(0, 64) || null
        : undefined;

  const lanOpen: boolean | undefined = typeof patch.lanOpen === "boolean" ? patch.lanOpen : undefined;

  // Only the two values mean anything, and anything else is dropped rather
  // than coerced — a typo should leave the policy alone, not silently reset it.
  const joinPolicy: JoinPolicy | undefined =
    patch.joinPolicy === "open" || patch.joinPolicy === "invite" ? patch.joinPolicy : undefined;

  const discoverable: boolean | undefined = typeof patch.discoverable === "boolean" ? patch.discoverable : undefined;

  const updated = await updateServerConfig({
    displayName: displayName === undefined ? undefined : (displayName.length > 0 ? displayName : null),
    description: description === undefined ? undefined : (description.length > 0 ? description : null),
    iconUrl,
    isConfigured: true,
    avatarMaxBytes,
    uploadMaxBytes,
    emojiMaxBytes,
    profanityMode,
    profanityCensorStyle,
    systemChannelId,
    lanOpen,
    joinPolicy,
    discoverable,
  });

  if (systemChannelId !== undefined) invalidateSystemChannelCache();

  // Take effect immediately rather than at the next restart. There is no
  // periodic re-sync: this call and the one at boot are the only two, so a
  // change that skipped it would leave the server advertising itself over
  // mDNS while its own configuration says it is hidden.
  if (discoverable !== undefined) {
    void syncMdnsAdvertising().catch((e) =>
      consola.warn("mDNS: re-sync after a settings change failed", e)
    );
  }

  insertServerAudit({
    actorServerUserId: actor.serverUserId,
    action: "settings_update",
    target: null,
    meta: {
      via: actor.via,
      displayName: displayName ?? null,
      description: description ?? null,
    },
  }).catch((e) => consola.warn("audit log write failed", e));

  broadcastServerUiUpdate("settings");
  return updated;
}

/** The settings as every caller reports them. */
export function settingsView(cfg: ServerConfigRecord, serverId: string, isOwner: boolean) {
  return {
    serverId,
    isOwner,
    isConfigured: !!cfg.is_configured,
    displayName: cfg.display_name || process.env.SERVER_NAME || "Unknown Server",
    description: cfg.description || process.env.SERVER_DESCRIPTION || "A Gryt server",
    iconUrl: cfg.icon_url || null,
    avatarMaxBytes: cfg.avatar_max_bytes ?? DEFAULT_AVATAR_MAX_BYTES,
    uploadMaxBytes: cfg.upload_max_bytes ?? DEFAULT_UPLOAD_MAX_BYTES,
    emojiMaxBytes: cfg.emoji_max_bytes ?? DEFAULT_EMOJI_MAX_BYTES,
    profanityMode: cfg.profanity_mode ?? "censor",
    profanityCensorStyle: cfg.profanity_censor_style ?? "emoji",
    systemChannelId: cfg.system_channel_id ?? null,
    lanOpen: !!cfg.lan_open,
    joinPolicy: cfg.join_policy ?? "invite",
    discoverable: cfg.discoverable !== false,
  };
}
