import { types } from "cassandra-driver";

import { getScyllaClient } from "./scylla";

export interface ServerChannelRecord {
  channel_id: string;
  name: string;
  type: "text" | "voice";
  position: number;
  description: string | null;
  require_push_to_talk: boolean;
  disable_rnnoise: boolean;
  max_bitrate: number | null;
  esports_mode: boolean;
  text_in_voice: boolean;
  created_at: Date;
  updated_at: Date;
}

export type ServerSidebarItemKind = "channel" | "separator" | "spacer";

export interface ServerSidebarItemRecord {
  item_id: string;
  kind: ServerSidebarItemKind;
  position: number;
  channel_id: string | null;
  spacer_height: number | null;
  label: string | null;
  created_at: Date;
  updated_at: Date;
}

function normalizeChannelType(t: unknown): "text" | "voice" {
  const s = String(t || "").toLowerCase();
  return s === "voice" ? "voice" : "text";
}

function normalizeSidebarKind(v: unknown): ServerSidebarItemKind {
  const s = String(v || "").toLowerCase();
  if (s === "separator") return "separator";
  if (s === "spacer") return "spacer";
  return "channel";
}

function rowToSidebarItem(r: types.Row): ServerSidebarItemRecord {
  return {
    item_id: r["item_id"],
    kind: normalizeSidebarKind(r["kind"]),
    position: typeof r["position"] === "number" ? r["position"] : 0,
    channel_id: r["channel_id"] ?? null,
    spacer_height: typeof r["spacer_height"] === "number" ? r["spacer_height"] : (r["spacer_height"] == null ? null : Number(r["spacer_height"]) || null),
    label: r["label"] ?? null,
    created_at: r["created_at"] ?? new Date(0),
    updated_at: r["updated_at"] ?? new Date(0),
  };
}

export async function listServerChannels(): Promise<ServerChannelRecord[]> {
  const c = getScyllaClient();
  const rs = await c.execute(
    `SELECT channel_id, name, type, position, description, require_push_to_talk, disable_rnnoise, max_bitrate, esports_mode, text_in_voice, created_at, updated_at
     FROM server_channels_by_id`,
    [],
    { prepare: true }
  );
  const rows = rs.rows.map((r) => ({
    channel_id: r["channel_id"],
    name: r["name"],
    type: normalizeChannelType(r["type"]),
    position: typeof r["position"] === "number" ? r["position"] : 0,
    description: r["description"] ?? null,
    require_push_to_talk: r["require_push_to_talk"] === true,
    disable_rnnoise: r["disable_rnnoise"] === true,
    max_bitrate: typeof r["max_bitrate"] === "number" ? r["max_bitrate"] : null,
    esports_mode: r["esports_mode"] === true,
    text_in_voice: r["text_in_voice"] === true,
    created_at: r["created_at"] ?? new Date(0),
    updated_at: r["updated_at"] ?? new Date(0),
  }));
  rows.sort((a, b) => (a.position - b.position) || a.name.localeCompare(b.name));
  return rows;
}

export async function upsertServerChannel(channel: {
  channelId: string;
  name: string;
  type: "text" | "voice";
  position?: number;
  description?: string | null;
  requirePushToTalk?: boolean;
  disableRnnoise?: boolean;
  maxBitrate?: number | null;
  eSportsMode?: boolean;
  textInVoice?: boolean;
}): Promise<void> {
  const c = getScyllaClient();
  const now = new Date();
  const channelId = String(channel.channelId).trim().slice(0, 64);
  const name = String(channel.name).trim().slice(0, 80);
  const type = channel.type === "voice" ? "voice" : "text";
  const position = typeof channel.position === "number" ? Math.max(0, Math.min(10_000, Math.floor(channel.position))) : 0;
  const description = channel.description == null ? null : String(channel.description).trim().slice(0, 200);
  const requirePushToTalk = channel.requirePushToTalk === true;
  const disableRnnoise = channel.disableRnnoise === true;
  const maxBitrate = typeof channel.maxBitrate === "number" ? Math.max(0, Math.min(510_000, channel.maxBitrate)) : null;
  const eSportsMode = channel.eSportsMode === true;
  const textInVoice = channel.textInVoice === true;

  const existing = await c.execute(
    `SELECT created_at FROM server_channels_by_id WHERE channel_id = ?`,
    [channelId],
    { prepare: true }
  );
  const createdAt = existing.first()?.["created_at"] ?? now;

  await c.execute(
    `INSERT INTO server_channels_by_id (channel_id, name, type, position, description, require_push_to_talk, disable_rnnoise, max_bitrate, esports_mode, text_in_voice, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [channelId, name, type, position, description, requirePushToTalk, disableRnnoise, maxBitrate, eSportsMode, textInVoice, createdAt, now],
    { prepare: true }
  );
}

export async function deleteServerChannel(channelId: string): Promise<void> {
  const c = getScyllaClient();
  await c.execute(
    `DELETE FROM server_channels_by_id WHERE channel_id = ?`,
    [channelId],
    { prepare: true }
  );
}

export async function ensureDefaultChannels(): Promise<void> {
  const existing = await listServerChannels();
  if (existing.length > 0) return;

  const voiceId = (process.env.VOICE_CHANNEL_ID || "voice").trim().slice(0, 64) || "voice";
  const voiceName = (process.env.VOICE_CHANNEL_NAME || "Voice Chat").trim().slice(0, 80) || "Voice Chat";

  await upsertServerChannel({ channelId: "general", name: "General", type: "text", position: 10, description: "General text chat" });
  await upsertServerChannel({ channelId: "random", name: "Random", type: "text", position: 20, description: "Random discussions and off-topic chat" });
  await upsertServerChannel({ channelId: voiceId, name: voiceName, type: "voice", position: 30, description: "Voice communication channel" });

  if (process.env.ADDITIONAL_CHANNELS) {
    try {
      const additional = JSON.parse(process.env.ADDITIONAL_CHANNELS);
      if (Array.isArray(additional)) {
        let pos = 40;
        for (const ch of additional) {
          if (!ch) continue;
          const channelId = String(ch.id || ch.channel_id || "").trim();
          const name = String(ch.name || "").trim();
          const type = String(ch.type || "text").toLowerCase() === "voice" ? "voice" : "text";
          if (!channelId || !name) continue;
          await upsertServerChannel({
            channelId,
            name,
            type,
            position: typeof ch.position === "number" ? ch.position : pos,
            description: ch.description ?? null,
          });
          pos += 10;
        }
      }
    } catch {
      // ignore
    }
  }
}

export async function listServerSidebarItems(): Promise<ServerSidebarItemRecord[]> {
  const c = getScyllaClient();
  const rs = await c.execute(
    `SELECT item_id, kind, position, channel_id, spacer_height, label, created_at, updated_at
     FROM server_sidebar_items_by_id`,
    [],
    { prepare: true }
  );
  const rows = rs.rows.map(rowToSidebarItem);
  rows.sort((a, b) => (a.position - b.position) || a.item_id.localeCompare(b.item_id));
  return rows;
}

export async function upsertServerSidebarItem(item: {
  itemId: string;
  kind: ServerSidebarItemKind;
  position?: number;
  channelId?: string | null;
  spacerHeight?: number | null;
  label?: string | null;
}): Promise<void> {
  const c = getScyllaClient();
  const now = new Date();

  const itemId = String(item.itemId || "").trim().slice(0, 64);
  if (!itemId) throw new Error("upsertServerSidebarItem: itemId is required");
  const kind = normalizeSidebarKind(item.kind);

  const position =
    typeof item.position === "number" ? Math.max(0, Math.min(100_000, Math.floor(item.position))) : 0;

  const channelId =
    kind === "channel"
      ? (item.channelId == null ? null : String(item.channelId).trim().slice(0, 64))
      : null;

  const spacerHeight =
    kind === "spacer"
      ? (item.spacerHeight == null ? 16 : Math.max(0, Math.min(500, Math.floor(item.spacerHeight))))
      : null;

  const label =
    kind === "separator"
      ? (item.label == null ? null : String(item.label).trim().slice(0, 80))
      : null;

  const existing = await c.execute(
    `SELECT created_at FROM server_sidebar_items_by_id WHERE item_id = ?`,
    [itemId],
    { prepare: true }
  );
  const createdAt = existing.first()?.["created_at"] ?? now;

  await c.execute(
    `INSERT INTO server_sidebar_items_by_id (item_id, kind, position, channel_id, spacer_height, label, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [itemId, kind, position, channelId, spacerHeight, label, createdAt, now],
    { prepare: true }
  );
}

export async function deleteServerSidebarItem(itemId: string): Promise<void> {
  const c = getScyllaClient();
  const norm = String(itemId || "").trim().slice(0, 64);
  if (!norm) return;
  await c.execute(
    `DELETE FROM server_sidebar_items_by_id WHERE item_id = ?`,
    [norm],
    { prepare: true }
  );
}

export async function ensureDefaultSidebarItems(): Promise<void> {
  const existing = await listServerSidebarItems();
  if (existing.length > 0) return;

  await ensureDefaultChannels();
  const chans = await listServerChannels();
  let pos = 10;
  for (const ch of chans) {
    await upsertServerSidebarItem({
      itemId: `sb_ch_${String(ch.channel_id).slice(0, 54)}`,
      kind: "channel",
      channelId: ch.channel_id,
      position: pos,
    });
    pos += 10;
  }
}
