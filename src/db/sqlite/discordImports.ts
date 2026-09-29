import type { Reaction, StoredWebhookCard } from "../interfaces";
import { fromIso, fromIsoNullable, getSqliteDb, toIso } from "./connection";

export type DiscordImportStatus = "queued" | "running" | "done" | "failed";

/** Counters only. What was imported is the rows themselves, found by their derived ids. */
export interface DiscordImportProgress {
  channels_total: number;
  channels_done: number;
  messages_imported: number;
  messages_already_there: number;
  messages_skipped: number;
  files_stored: number;
  files_already_there: number;
  files_skipped: number;
  files_missing: number;
  emojis_queued: number;
  current_channel?: string | null;
}

export interface DiscordImportRecord {
  import_id: string;
  folder: string;
  status: DiscordImportStatus;
  started_by_server_user_id: string;
  progress: DiscordImportProgress | null;
  warnings: string[];
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

/** Kept short so a run over a messy export can't grow the row without bound. */
export const DISCORD_IMPORT_MAX_WARNINGS = 200;

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToImport(r: Record<string, unknown>): DiscordImportRecord {
  return {
    import_id: r.import_id as string,
    folder: r.folder as string,
    status: r.status as DiscordImportStatus,
    started_by_server_user_id: r.started_by_server_user_id as string,
    progress: parseJson<DiscordImportProgress | null>(r.progress, null),
    warnings: parseJson<string[]>(r.warnings, []),
    error_message: (r.error_message as string) ?? null,
    created_at: fromIso(r.created_at as string),
    updated_at: fromIso(r.updated_at as string),
    finished_at: fromIsoNullable(r.finished_at as string | null),
  };
}

export async function createDiscordImport(input: {
  import_id: string;
  folder: string;
  started_by_server_user_id: string;
}): Promise<DiscordImportRecord> {
  const now = toIso(new Date());
  getSqliteDb()
    .prepare(
      `INSERT INTO discord_imports (import_id, folder, status, started_by_server_user_id, created_at, updated_at)
       VALUES (?, ?, 'queued', ?, ?, ?)`,
    )
    .run(input.import_id, input.folder, input.started_by_server_user_id, now, now);
  return (await getDiscordImport(input.import_id))!;
}

export async function getDiscordImport(importId: string): Promise<DiscordImportRecord | null> {
  const row = getSqliteDb()
    .prepare(`SELECT * FROM discord_imports WHERE import_id = ?`)
    .get(importId) as Record<string, unknown> | undefined;
  return row ? rowToImport(row) : null;
}

export async function listDiscordImports(limit = 20): Promise<DiscordImportRecord[]> {
  const rows = getSqliteDb()
    .prepare(`SELECT * FROM discord_imports ORDER BY created_at DESC LIMIT ?`)
    .all(Math.max(1, Math.min(100, Math.floor(limit)))) as Record<string, unknown>[];
  return rows.map(rowToImport);
}

/** Oldest first. Anything still `running` at boot was cut off and starts again. */
export async function listUnfinishedDiscordImports(): Promise<DiscordImportRecord[]> {
  const rows = getSqliteDb()
    .prepare(`SELECT * FROM discord_imports WHERE status IN ('queued', 'running') ORDER BY created_at ASC`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToImport);
}

export async function updateDiscordImport(
  importId: string,
  patch: {
    status?: DiscordImportStatus;
    progress?: DiscordImportProgress;
    warnings?: string[];
    error_message?: string | null;
  },
): Promise<void> {
  const sets: string[] = [];
  const params: (string | null)[] = [];
  if (patch.status) {
    sets.push("status = ?");
    params.push(patch.status);
    if (patch.status === "done" || patch.status === "failed") {
      sets.push("finished_at = ?");
      params.push(toIso(new Date()));
    }
  }
  if (patch.progress) {
    sets.push("progress = ?");
    params.push(JSON.stringify(patch.progress));
  }
  if (patch.warnings) {
    sets.push("warnings = ?");
    params.push(JSON.stringify(patch.warnings.slice(0, DISCORD_IMPORT_MAX_WARNINGS)));
  }
  if (patch.error_message !== undefined) {
    sets.push("error_message = ?");
    params.push(patch.error_message);
  }
  sets.push("updated_at = ?");
  params.push(toIso(new Date()));
  getSqliteDb()
    .prepare(`UPDATE discord_imports SET ${sets.join(", ")} WHERE import_id = ?`)
    .run(...params, importId);
}

/** One message as the importer built it. Ids come from Discord's, so a rerun names the same rows. */
export interface ImportedMessageRow {
  conversation_id: string;
  message_id: string;
  sender_server_id: string;
  sender_display_name: string | null;
  sender_avatar_file_id: string | null;
  text: string | null;
  attachments: string[];
  reactions: Reaction[];
  cards: StoredWebhookCard[];
  reply_to_message_id: string | null;
  thread_id: string | null;
  created_at: Date;
  edited_at: Date | null;
  /** Shown without being listed, like the author's picture, so file reads and the sweep see them. */
  media_file_ids: string[];
}

/** One transaction that skips rows already there, so a rerun adds nothing and a crash
    leaves whole batches. Any other constraint failure throws. Returns how many were new. */
export function insertImportedMessages(rows: ImportedMessageRow[]): number {
  if (rows.length === 0) return 0;
  const db = getSqliteDb();
  const insert = db.prepare(
    // Not OR IGNORE, which would also swallow a NOT NULL failure and lose the row silently.
    `INSERT INTO messages (conversation_id, message_id, sender_server_id, text, attachments, reactions, reply_to_message_id, thread_id, cards, sender_display_name, sender_avatar_file_id, edited_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id, message_id) DO NOTHING`,
  );
  const ref = db.prepare(
    `INSERT OR IGNORE INTO message_attachments (file_id, conversation_id, message_id) VALUES (?, ?, ?)`,
  );

  let inserted = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const result = insert.run(
        r.conversation_id,
        r.message_id,
        r.sender_server_id,
        r.text,
        r.attachments.length > 0 ? JSON.stringify(r.attachments) : null,
        r.reactions.length > 0 ? JSON.stringify(r.reactions) : null,
        r.reply_to_message_id,
        r.thread_id,
        r.cards.length > 0 ? JSON.stringify(r.cards) : null,
        r.sender_display_name,
        r.sender_avatar_file_id,
        r.edited_at ? toIso(r.edited_at) : null,
        toIso(r.created_at),
      );
      if (Number(result.changes) === 0) continue;
      inserted += 1;
      for (const fileId of new Set([...r.attachments, ...r.media_file_ids])) {
        ref.run(fileId, r.conversation_id, r.message_id);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return inserted;
}

/** Whether a message is already stored, for picking a thread's root. */
export function importedMessageExists(conversationId: string, messageId: string): boolean {
  return !!getSqliteDb()
    .prepare(`SELECT 1 FROM messages WHERE conversation_id = ? AND message_id = ?`)
    .get(conversationId, messageId);
}

/** Only if the root has no thread yet, since `root_message_id` is unique. Returns
    the id of whichever thread owns the root, which may be one written earlier. */
export function ensureImportedThread(input: {
  thread_id: string;
  conversation_id: string;
  root_message_id: string;
  title: string | null;
  created_by: string;
  created_at: Date;
}): string {
  const db = getSqliteDb();
  const at = toIso(input.created_at);
  db.prepare(
    `INSERT INTO threads (thread_id, conversation_id, root_message_id, title, created_by, status, reply_count, locked, created_at, last_message_at)
     VALUES (?, ?, ?, ?, ?, 'open', 0, 0, ?, ?)
     ON CONFLICT DO NOTHING`,
  ).run(input.thread_id, input.conversation_id, input.root_message_id, input.title, input.created_by, at, at);
  const row = db
    .prepare(`SELECT thread_id FROM threads WHERE root_message_id = ?`)
    .get(input.root_message_id) as { thread_id: string } | undefined;
  return row?.thread_id ?? input.thread_id;
}

/** Counted from the rows rather than bumped per insert, so a rerun can't count a reply twice. */
export function refreshImportedThreadCounters(threadId: string): void {
  getSqliteDb()
    .prepare(
      `UPDATE threads SET
         reply_count = (SELECT COUNT(*) FROM messages WHERE thread_id = ?),
         last_message_at = COALESCE((SELECT MAX(created_at) FROM messages WHERE thread_id = ?), created_at)
       WHERE thread_id = ?`,
    )
    .run(threadId, threadId, threadId);
}
