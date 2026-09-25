import { directConversationId } from "./conversations";
import { getSqliteDb, toIso } from "./connection";

/**
 * Who may message or ring somebody on this server (GRYT-1470). Their own choice,
 * so no permission, and nobody's rank gets past it.
 */

/** Who counts as a friend is `isFriendOf` in socket/utils/contactGate.ts. */
export type ContactRule = "everyone" | "friends" | "nobody";

export interface ContactPrefs {
  messages: ContactRule;
  calls: ContactRule;
}

/** Sivert's defaults, 2026-09-24. No row reads as these. */
export const DEFAULT_CONTACT_PREFS: ContactPrefs = { messages: "everyone", calls: "friends" };

export function isContactRule(value: unknown): value is ContactRule {
  return value === "everyone" || value === "friends" || value === "nobody";
}

export async function getContactPrefs(grytUserId: string): Promise<ContactPrefs> {
  const row = getSqliteDb()
    .prepare(`SELECT messages, calls FROM contact_prefs WHERE gryt_user_id = ?`)
    .get(grytUserId) as { messages: string; calls: string } | undefined;
  if (!row) return { ...DEFAULT_CONTACT_PREFS };
  /* An unknown word from a newer server, after a downgrade, reads as the default
     rather than as "everyone". */
  return {
    messages: isContactRule(row.messages) ? row.messages : DEFAULT_CONTACT_PREFS.messages,
    calls: isContactRule(row.calls) ? row.calls : DEFAULT_CONTACT_PREFS.calls,
  };
}

/** Back to the defaults deletes the row, so the table only holds people who chose. */
export async function setContactPrefs(grytUserId: string, prefs: ContactPrefs): Promise<void> {
  const db = getSqliteDb();
  if (prefs.messages === DEFAULT_CONTACT_PREFS.messages && prefs.calls === DEFAULT_CONTACT_PREFS.calls) {
    db.prepare(`DELETE FROM contact_prefs WHERE gryt_user_id = ?`).run(grytUserId);
    return;
  }
  db.prepare(
    `INSERT INTO contact_prefs (gryt_user_id, messages, calls, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(gryt_user_id) DO UPDATE SET messages = excluded.messages, calls = excluded.calls, updated_at = excluded.updated_at`,
  ).run(grytUserId, prefs.messages, prefs.calls, toIso(new Date()));
}

/** Whether `author` has sent anything in their one-to-one with `other`. The
    sender column is stored for sealed messages too, so this works on those. */
export async function hasWrittenTo(authorServerUserId: string, otherServerUserId: string): Promise<boolean> {
  const row = getSqliteDb()
    .prepare(`SELECT 1 FROM messages WHERE conversation_id = ? AND sender_server_id = ? LIMIT 1`)
    .get(directConversationId(authorServerUserId, otherServerUserId), authorServerUserId);
  return !!row;
}
