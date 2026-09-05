import type { ServerChannelRecord, ServerSidebarItemKind, ServerSidebarItemRecord } from "../interfaces";
import { fromIso, getSqliteDb, intToBool, toIso } from "./connection";

function normalizeChannelType(t: unknown): "text" | "voice" {
  const s = String(t || "").toLowerCase();
  return s === "voice" ? "voice" : "text";
}

function normalizeSidebarKind(v: unknown): ServerSidebarItemKind {
  const s = String(v || "").toLowerCase();
  if (s === "separator") return "separator";
  if (s === "spacer") return "spacer";
  if (s === "folder") return "folder";
  return "channel";
}

function rowToChannel(r: Record<string, unknown>): ServerChannelRecord {
  return {
    channel_id: r.channel_id as string,
    name: r.name as string,
    type: normalizeChannelType(r.type),
    position: (r.position as number) ?? 0,
    description: (r.description as string) ?? null,
    require_push_to_talk: intToBool(r.require_push_to_talk as number),
    disable_rnnoise: intToBool(r.disable_rnnoise as number),
    max_bitrate: r.max_bitrate != null ? Number(r.max_bitrate) : null,
    esports_mode: intToBool(r.esports_mode as number),
    text_in_voice: intToBool(r.text_in_voice as number),
    post_min_rank: r.post_min_rank != null ? Number(r.post_min_rank) : null,
    view_min_rank: r.view_min_rank != null ? Number(r.view_min_rank) : null,
    permission_scope_id: (r.permission_scope_id as string) ?? null,
    created_at: fromIso(r.created_at as string),
    updated_at: fromIso(r.updated_at as string),
  };
}

function rowToSidebarItem(r: Record<string, unknown>): ServerSidebarItemRecord {
  return {
    item_id: r.item_id as string,
    kind: normalizeSidebarKind(r.kind),
    position: (r.position as number) ?? 0,
    channel_id: (r.channel_id as string) ?? null,
    spacer_height: r.spacer_height != null ? Number(r.spacer_height) : null,
    label: (r.label as string) ?? null,
    parent_item_id: (r.parent_item_id as string) ?? null,
    created_at: fromIso(r.created_at as string),
    updated_at: fromIso(r.updated_at as string),
  };
}

export async function listServerChannels(): Promise<ServerChannelRecord[]> {
  const db = getSqliteDb();
  const rows = db.prepare(`SELECT * FROM channels ORDER BY position ASC, name ASC`).all() as Record<string, unknown>[];
  return rows.map(rowToChannel);
}

export async function upsertServerChannel(channel: {
  channelId: string; name: string; type: "text" | "voice"; position?: number; description?: string | null;
  requirePushToTalk?: boolean; disableRnnoise?: boolean; maxBitrate?: number | null; eSportsMode?: boolean; textInVoice?: boolean;
}): Promise<void> {
  const db = getSqliteDb();
  const now = toIso(new Date());
  const channelId = String(channel.channelId).trim().slice(0, 64);
  const name = String(channel.name).trim().slice(0, 80);
  const type = channel.type === "voice" ? "voice" : "text";
  const position = typeof channel.position === "number" ? Math.max(0, Math.min(10_000, Math.floor(channel.position))) : 0;
  const description = channel.description == null ? null : String(channel.description).trim().slice(0, 200);
  const rPtt = channel.requirePushToTalk ? 1 : 0;
  const dRnn = channel.disableRnnoise ? 1 : 0;
  const maxBr = typeof channel.maxBitrate === "number" ? Math.max(0, Math.min(510_000, channel.maxBitrate)) : null;
  const eMode = channel.eSportsMode ? 1 : 0;
  const tiv = channel.textInVoice ? 1 : 0;

  db.prepare(
    // permission_scope_id is deliberately absent. It is set by
    // setChannelPermissionScope, which also cleans up an orphaned private
    // scope; letting a general channel update carry it would mean every caller
    // that renames a channel could silently change who can see it.
    `INSERT INTO channels (channel_id, name, type, position, description, require_push_to_talk, disable_rnnoise, max_bitrate, esports_mode, text_in_voice, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET name=?, type=?, position=?, description=?, require_push_to_talk=?, disable_rnnoise=?, max_bitrate=?, esports_mode=?, text_in_voice=?, updated_at=?`
  ).run(channelId, name, type, position, description, rPtt, dRnn, maxBr, eMode, tiv, now, now,
    name, type, position, description, rPtt, dRnn, maxBr, eMode, tiv, now);
}

export async function deleteServerChannel(channelId: string): Promise<void> {
  const db = getSqliteDb();
  db.prepare(`DELETE FROM channels WHERE channel_id = ?`).run(channelId);
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
          const cId = String(ch.id || ch.channel_id || "").trim();
          const cName = String(ch.name || "").trim();
          const cType = String(ch.type || "text").toLowerCase() === "voice" ? "voice" : "text";
          if (!cId || !cName) continue;
          await upsertServerChannel({ channelId: cId, name: cName, type: cType, position: typeof ch.position === "number" ? ch.position : pos, description: ch.description ?? null });
          pos += 10;
        }
      }
    } catch { /* ignore */ }
  }
}

export async function listServerSidebarItems(): Promise<ServerSidebarItemRecord[]> {
  const db = getSqliteDb();
  const rows = db.prepare(`SELECT * FROM sidebar_items ORDER BY position ASC, item_id ASC`).all() as Record<string, unknown>[];
  return rows.map(rowToSidebarItem);
}

/**
 * The folder an item may sit in, resolved rather than trusted.
 *
 * Answers null unless the id names an item that exists right now and is a
 * folder. That covers a channel dragged into a folder somebody else deleted a
 * moment earlier, and it covers a client that sends whatever it likes: the
 * worst outcome is a channel at the top level, where it is visible. Storing an
 * id that resolves to nothing would hide it instead, since the sidebar draws
 * children under their folder and nothing else.
 */
function resolveParentFolder(
  db: ReturnType<typeof getSqliteDb>,
  itemId: string,
  kind: ServerSidebarItemKind,
  parentItemId: string | null | undefined,
): string | null {
  if (kind !== "channel") return null;
  if (parentItemId == null) return null;

  const parent = String(parentItemId).trim().slice(0, 64);
  if (!parent || parent === itemId) return null;

  const row = db
    .prepare(`SELECT kind FROM sidebar_items WHERE item_id = ?`)
    .get(parent) as { kind?: unknown } | undefined;

  return row && normalizeSidebarKind(row.kind) === "folder" ? parent : null;
}

export async function upsertServerSidebarItem(item: {
  itemId: string; kind: ServerSidebarItemKind; position?: number; channelId?: string | null; spacerHeight?: number | null; label?: string | null; parentItemId?: string | null;
}): Promise<void> {
  const db = getSqliteDb();
  const now = toIso(new Date());
  const itemId = String(item.itemId || "").trim().slice(0, 64);
  if (!itemId) throw new Error("upsertServerSidebarItem: itemId is required");
  const kind = normalizeSidebarKind(item.kind);
  const position = typeof item.position === "number" ? Math.max(0, Math.min(100_000, Math.floor(item.position))) : 0;
  const channelId = kind === "channel" ? (item.channelId == null ? null : String(item.channelId).trim().slice(0, 64)) : null;
  const spacerHeight = kind === "spacer" ? (item.spacerHeight == null ? 16 : Math.max(0, Math.min(500, Math.floor(item.spacerHeight)))) : null;
  // A folder carries a name for the same reason a separator does, so both read
  // it out of the same column.
  const label = kind === "separator" || kind === "folder"
    ? (item.label == null ? null : String(item.label).trim().slice(0, 80))
    : null;
  const parentItemId = resolveParentFolder(db, itemId, kind, item.parentItemId);

  db.prepare(
    `INSERT INTO sidebar_items (item_id, kind, position, channel_id, spacer_height, label, parent_item_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET kind=?, position=?, channel_id=?, spacer_height=?, label=?, parent_item_id=?, updated_at=?`
  ).run(itemId, kind, position, channelId, spacerHeight, label, parentItemId, now, now, kind, position, channelId, spacerHeight, label, parentItemId, now);
}

/**
 * Deleting a folder empties it rather than taking the channels with it.
 *
 * The row being removed is one sidebar entry, and a channel's entry is the only
 * thing that puts it on screen. Cascading would make "remove this folder" mean
 * "remove these six channels from the sidebar", which is not what the words say
 * and is not recoverable from the sidebar itself — the channels would still
 * exist, with no way to reach them.
 */
export async function deleteServerSidebarItem(itemId: string): Promise<void> {
  const db = getSqliteDb();
  const norm = String(itemId || "").trim().slice(0, 64);
  if (!norm) return;
  db.prepare(`UPDATE sidebar_items SET parent_item_id = NULL WHERE parent_item_id = ?`).run(norm);
  db.prepare(`DELETE FROM sidebar_items WHERE item_id = ?`).run(norm);
}

export async function ensureDefaultSidebarItems(): Promise<void> {
  const existing = await listServerSidebarItems();
  if (existing.length > 0) return;
  await ensureDefaultChannels();
  const chans = await listServerChannels();
  let pos = 10;
  for (const ch of chans) {
    await upsertServerSidebarItem({ itemId: `sb_ch_${String(ch.channel_id).slice(0, 54)}`, kind: "channel", channelId: ch.channel_id, position: pos });
    pos += 10;
  }
}
