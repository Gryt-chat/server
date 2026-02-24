import consola from "consola";
import { Server, Socket } from "socket.io";
import { Clients } from "../../types";
import { syncAllClients, broadcastMemberList } from "./clients";
import { listEmojiJobs } from "../../db/emojiJobs";
import {
  ensureDefaultChannels,
  ensureDefaultSidebarItems,
  getServerConfig,
  getServerRole,
  DEFAULT_AVATAR_MAX_BYTES,
  DEFAULT_UPLOAD_MAX_BYTES,
  listServerChannels,
  listServerSidebarItems,
} from "../../db/scylla";

// Module-level references set by socketHandler so REST routes can trigger broadcasts
let _io: Server | null = null;
let _serverId: string | null = null;
let _clientsInfo: Clients | null = null;

export function setSocketRefs(io: Server, serverId: string, clientsInfo: Clients) {
  _io = io;
  _serverId = serverId;
  _clientsInfo = clientsInfo;
}

export function broadcastServerUiUpdate(reason: "settings" | "icon" | "other" = "other"): void {
  if (!_io || !_serverId || !_clientsInfo) return;
  consola.info(`Broadcasting server UI update (${reason})`);
  for (const [sid, s] of _io.sockets.sockets) {
    sendInfo(s, _clientsInfo, _serverId).catch(() => undefined);
    if (_clientsInfo[sid]?.grytUserId) {
      sendServerDetails(s, _clientsInfo, _serverId).catch(() => undefined);
    }
  }
  syncAllClients(_io, _clientsInfo);
  broadcastMemberList(_io, _clientsInfo, _serverId).catch(() => undefined);
}

export function broadcastCustomEmojisUpdate(): void {
  if (!_io) return;
  consola.info("Broadcasting custom emojis update");
  _io.to("verifiedClients").emit("server:emojis:updated");
}

export function broadcastEmojiQueueUpdate(): void {
  if (!_io) return;
  scheduleEmojiQueueStateBroadcast();
}

export function sendEmojiQueueStateToSocket(socket: Socket): void {
  if (!_io) return;
  void Promise.resolve()
    .then(async () => {
      const jobs = await listEmojiJobs(150);
      const pendingCount = jobs.filter((j) => j.status === "queued" || j.status === "processing").length;
      socket.emit("server:emojiQueue:state", {
        pendingCount,
        jobs: jobs.map((j) => ({
          job_id: j.job_id,
          name: j.name,
          status: j.status,
          error_message: j.error_message,
          created_at: j.created_at.toISOString(),
          updated_at: j.updated_at.toISOString(),
        })),
      });
    })
    .catch((e) => {
      consola.warn("Failed to send emoji queue state", e);
    });
}

type EmojiQueueState = {
  pendingCount: number;
  jobs: Array<{
    job_id: string;
    name: string;
    status: string;
    error_message: string | null;
    created_at: string;
    updated_at: string;
  }>;
};

let _emojiQueueBroadcastTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleEmojiQueueStateBroadcast(): void {
  const io = _io;
  if (!io) return;
  if (_emojiQueueBroadcastTimer) return;

  _emojiQueueBroadcastTimer = setTimeout(() => {
    _emojiQueueBroadcastTimer = null;
    void Promise.resolve()
      .then(async () => {
        const jobs = await listEmojiJobs(150);
        const pendingCount = jobs.filter((j) => j.status === "queued" || j.status === "processing").length;
        const state: EmojiQueueState = {
          pendingCount,
          jobs: jobs.map((j) => ({
            job_id: j.job_id,
            name: j.name,
            status: j.status,
            error_message: j.error_message,
            created_at: j.created_at.toISOString(),
            updated_at: j.updated_at.toISOString(),
          })),
        };
        consola.info("Broadcasting emoji queue state", { pendingCount });
        io.to("verifiedClients").emit("server:emojiQueue:state", state);
      })
      .catch((e) => {
        consola.warn("Failed to broadcast emoji queue state", e);
      });
  }, 250);
}

const sfuHostsRaw = process.env.SFU_PUBLIC_HOST || process.env.SFU_WS_HOST || "";
const sfuHosts = sfuHostsRaw.split(",").map(h => h.trim()).filter(Boolean);
const sfuHost = sfuHosts[0] || undefined;
const stunHosts = process.env.STUN_SERVERS?.split(",") || [];
const voiceSeatLimit = (() => {
  const explicit = parseInt(process.env.VOICE_MAX_USERS || "0", 10);
  if (explicit > 0) return explicit;
  const min = parseInt(process.env.SFU_UDP_PORT_MIN || "0", 10);
  const max = parseInt(process.env.SFU_UDP_PORT_MAX || "0", 10);
  if (min > 0 && max >= min) return (max - min + 1);
  return null;
})();

// Validate configuration
if (!sfuHost) {
  consola.error("Missing SFU WebSocket Host! Voice functionality will not work.");
}
if (stunHosts.length === 0) {
  consola.error("Missing STUN servers! SFU may not reach all clients.");
}

export async function sendInfo(socket: Socket, clientsInfo: Clients | undefined, _instanceId: string) {
  const activeMembers = clientsInfo ? Object.values(clientsInfo).filter((client) => 
    client.serverUserId && !client.serverUserId.startsWith('temp_')
  ).length : 0;
  
  let displayName = process.env.SERVER_NAME || "Unknown Server";
  let description = process.env.SERVER_DESCRIPTION || "A Gryt server";
  try {
    const cfg = await getServerConfig();
    if (cfg?.display_name) displayName = cfg.display_name;
    if (cfg?.description) description = cfg.description;
  } catch {
    // ignore DB errors; fall back to env
  }

  const serverInfo = {
    name: displayName,
    description,
    members: activeMembers.toString(),
    version: process.env.SERVER_VERSION || "1.0.0",
  };
  
  socket.emit("server:info", serverInfo);
}

export async function sendServerDetails(socket: Socket, clientsInfo: Clients, instanceId: string) {
  // Only send server details to registered users
  const clientId = socket.id;
  const client = clientsInfo[clientId];
  
  // Check if client has joined the server (is a registered user)
  if (!client || !client.grytUserId) {
    consola.warn(`🚫 Client ${clientId} requested server details without joining`);
    socket.emit("server:details", {
      error: "join_required",
      message: "Please join the server first"
    });
    return;
  }

  // Sidebar items are persisted in DB; bootstrap defaults if missing.
  // We still emit `channels` for backward compatibility (derived from sidebar items).
  let sidebar_items: { id: string; kind: string; position: number; channelId?: string; spacerHeight?: number; label?: string }[] = [];
  let channels: { id: string; name: string; type: string; description?: string; requirePushToTalk?: boolean; disableRnnoise?: boolean; maxBitrate?: number; eSportsMode?: boolean; textInVoice?: boolean }[] = [];
  try {
    await ensureDefaultSidebarItems();

    const [items, persistedChannels] = await Promise.all([
      listServerSidebarItems(),
      listServerChannels(),
    ]);

    const channelById = new Map(persistedChannels.map((c) => [c.channel_id, c]));

    sidebar_items = items.map((it) => ({
      id: it.item_id,
      kind: it.kind,
      position: it.position,
      channelId: it.channel_id ?? undefined,
      spacerHeight: it.spacer_height ?? undefined,
      label: it.label ?? undefined,
    }));

    channels = items
      .filter((it) => it.kind === "channel" && !!it.channel_id)
      .flatMap((it) => {
        const c = channelById.get(it.channel_id as string);
        if (!c) return [];
        return [{
          id: c.channel_id,
          name: c.name,
          type: c.type,
          description: c.description ?? undefined,
          requirePushToTalk: c.require_push_to_talk || false,
          disableRnnoise: c.disable_rnnoise || false,
          maxBitrate: c.max_bitrate ?? undefined,
          eSportsMode: c.esports_mode || false,
          textInVoice: c.text_in_voice || false,
        }];
      });

    // If sidebar exists but is missing channels (e.g. manual DB edits), fall back to channel list.
    if (channels.length === 0) {
      channels = persistedChannels.map((c) => ({
        id: c.channel_id,
        name: c.name,
        type: c.type,
        description: c.description ?? undefined,
        requirePushToTalk: c.require_push_to_talk || false,
        disableRnnoise: c.disable_rnnoise || false,
        maxBitrate: c.max_bitrate ?? undefined,
        eSportsMode: c.esports_mode || false,
        textInVoice: c.text_in_voice || false,
      }));
    }
  } catch (e) {
    consola.warn("Failed to load persisted sidebar/channels (falling back to defaults):", e);
    await ensureDefaultChannels().catch(() => undefined);
    channels = [
      { name: "General", type: "text", id: "general", description: "General text chat" },
      { name: "Random", type: "text", id: "random", description: "Random discussions and off-topic chat" },
      {
        name: process.env.VOICE_CHANNEL_NAME || "Voice Chat",
        type: "voice",
        id: process.env.VOICE_CHANNEL_ID || "voice",
        description: "Voice communication channel",
      },
    ];
    sidebar_items = channels.map((c, idx) => ({
      id: `sb_fallback_${c.id}`,
      kind: "channel",
      position: (idx + 1) * 10,
      channelId: c.id,
    }));
  }

  // Filter to only include registered users (those with real serverUserId, not temp IDs)
  const registeredClients: Clients = {};
  Object.entries(clientsInfo).forEach(([clientId, client]) => {
    // Only include clients who have been properly registered in the database
    // (i.e., have a real serverUserId that doesn't start with "temp_")
    if (client.serverUserId && !client.serverUserId.startsWith('temp_')) {
      registeredClients[clientId] = client;
    }
  });

  let cfgName = process.env.SERVER_NAME || "Unknown Server";
  let cfgDesc = process.env.SERVER_DESCRIPTION || "A Gryt server";
  let cfgIconUrl: string | null = null;
  let cfgAvatarMaxBytes: number = DEFAULT_AVATAR_MAX_BYTES;
  let cfgUploadMaxBytes: number = DEFAULT_UPLOAD_MAX_BYTES;
  let isOwner = false;
  let role: "owner" | "admin" | "mod" | "member" = "member";
  try {
    const cfg = await getServerConfig();
    if (cfg?.display_name) cfgName = cfg.display_name;
    if (cfg?.description) cfgDesc = cfg.description;
    if (cfg?.icon_url) cfgIconUrl = cfg.icon_url;
    if (typeof cfg?.avatar_max_bytes === "number") cfgAvatarMaxBytes = cfg.avatar_max_bytes;
    if (typeof cfg?.upload_max_bytes === "number") cfgUploadMaxBytes = cfg.upload_max_bytes;
    isOwner = !!(cfg?.owner_gryt_user_id && cfg.owner_gryt_user_id === client.grytUserId);
    if (isOwner) {
      role = "owner";
    } else if (client.serverUserId) {
      const r = await getServerRole(client.serverUserId);
      role = r || "member";
    }
  } catch {
    // ignore DB errors; fall back to env
  }

  const serverDetails = {
    sfu_host: sfuHost,
    sfu_hosts: sfuHosts,
    stun_hosts: stunHosts,
    voice_capacity_max: voiceSeatLimit,
    clients: registeredClients, // Only send registered users, not temporary connections
    sidebar_items,
    channels,
    server_info: {
      server_id: instanceId,
      name: cfgName,
      description: cfgDesc,
      icon_url: cfgIconUrl,
      is_owner: isOwner,
      role,
      max_members: parseInt(process.env.MAX_MEMBERS || "100"),
      voice_enabled: !!sfuHost,
      avatar_max_bytes: cfgAvatarMaxBytes,
      upload_max_bytes: cfgUploadMaxBytes,
      version: process.env.SERVER_VERSION || "1.0.0",
    },
  };

  socket.emit("server:details", serverDetails);
  consola.info(`Sent server details to client ${socket.id}:`, {
    channels: channels.length,
    voice_enabled: !!sfuHost,
    stun_servers: stunHosts.length,
  });
}
