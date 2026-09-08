import { randomBytes, randomUUID } from "crypto";

import { normalizePermissions, type Permission } from "../../constants/permissions";
import type { BotRecord, BotStatus } from "../interfaces";
import { fromIso, fromIsoNullable, getSqliteDb, toIso } from "./connection";

/**
 * What the bot asked is written once, so a taken-over image cannot re-ask a
 * question already answered. What was granted is its whole set, not a role.
 */

const NAME_MAX = 32;
const DESCRIPTION_MAX = 200;

function parsePermissions(raw: unknown): Permission[] {
  if (typeof raw !== "string") return [];
  try {
    return normalizePermissions(JSON.parse(raw));
  } catch {
    // Fails shut, like every other permission column: a row that will not parse
    // is a bot that can do nothing, not a bot that can do anything.
    return [];
  }
}

function normalizeStatus(v: unknown): BotStatus {
  const s = String(v || "").toLowerCase();
  if (s === "approved" || s === "denied") return s;
  return "pending";
}

export function normalizeBotName(v: unknown): string {
  const trimmed = String(v ?? "").trim().slice(0, NAME_MAX);
  return trimmed || "Bot";
}

export function normalizeBotDescription(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim().slice(0, DESCRIPTION_MAX);
  return trimmed.length > 0 ? trimmed : null;
}

function rowToBot(r: Record<string, unknown>): BotRecord {
  return {
    registration_id: r.registration_id as string,
    bot_id: (r.bot_id as string) ?? null,
    claim_token: (r.claim_token as string) ?? null,
    nickname: (r.nickname as string) ?? "Bot",
    description: (r.description as string) ?? null,
    requested_permissions: parsePermissions(r.requested_permissions),
    granted_permissions: parsePermissions(r.granted_permissions),
    rank: Number(r.rank ?? 0),
    status: normalizeStatus(r.status),
    created_at: fromIso(r.created_at as string),
    updated_at: fromIso(r.updated_at as string),
    decided_at: fromIsoNullable(r.decided_at as string | null),
    decided_by_server_user_id: (r.decided_by_server_user_id as string) ?? null,
  };
}

export async function listBots(): Promise<BotRecord[]> {
  const db = getSqliteDb();
  const rows = db
    .prepare(`SELECT * FROM bots ORDER BY created_at DESC`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToBot);
}

export async function getBotById(botId: string): Promise<BotRecord | null> {
  const db = getSqliteDb();
  const row = db.prepare(`SELECT * FROM bots WHERE bot_id = ?`).get(botId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToBot(row) : null;
}

export async function getBotByRegistrationId(
  registrationId: string,
): Promise<BotRecord | null> {
  const db = getSqliteDb();
  const row = db
    .prepare(`SELECT * FROM bots WHERE registration_id = ?`)
    .get(registrationId) as Record<string, unknown> | undefined;
  return row ? rowToBot(row) : null;
}

/** Returns the row a known bot already had rather than the declaration it just
    made, so one coming back for more gets its first answer. */
export async function recordBotKnock(input: {
  botId: string;
  nickname: string;
  description?: string | null;
  requestedPermissions: Permission[];
}): Promise<{ bot: BotRecord; created: boolean }> {
  const existing = await getBotById(input.botId);
  if (existing) return { bot: existing, created: false };

  const db = getSqliteDb();
  const now = toIso(new Date());
  db.prepare(
    `INSERT INTO bots (registration_id, bot_id, claim_token, nickname, description, requested_permissions, granted_permissions, rank, status, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, '[]', 0, 'pending', ?, ?)`,
  ).run(
    randomUUID(),
    input.botId,
    normalizeBotName(input.nickname),
    normalizeBotDescription(input.description),
    JSON.stringify(normalizePermissions(input.requestedPermissions)),
    now,
    now,
  );

  const bot = await getBotById(input.botId);
  if (!bot) throw new Error("Failed to record bot knock");
  return { bot, created: true };
}

/** The unattended path: an operator decides up front and hands over a token.
    Approved from the start, since the decision has already been made. */
export async function createBotRegistration(input: {
  nickname: string;
  description?: string | null;
  grantedPermissions: Permission[];
  rank?: number;
  createdByServerUserId: string;
}): Promise<BotRecord> {
  const db = getSqliteDb();
  const now = toIso(new Date());
  const registrationId = randomUUID();
  const permissions = JSON.stringify(normalizePermissions(input.grantedPermissions));

  db.prepare(
    `INSERT INTO bots (registration_id, bot_id, claim_token, nickname, description, requested_permissions, granted_permissions, rank, status, created_at, updated_at, decided_at, decided_by_server_user_id)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?)`,
  ).run(
    registrationId,
    // 32 bytes of base64url. This is the only secret in the whole flow and it
    // is single-use: claiming clears it.
    randomBytes(24).toString("base64url"),
    normalizeBotName(input.nickname),
    normalizeBotDescription(input.description),
    // The operator's list is recorded as the ask too, so the Bots tab can show
    // one shape for both routes in.
    permissions,
    permissions,
    Math.max(0, Math.floor(input.rank ?? 0)),
    now,
    now,
    now,
    input.createdByServerUserId,
  );

  const bot = await getBotByRegistrationId(registrationId);
  if (!bot) throw new Error("Failed to create bot registration");
  return bot;
}

/** Atomic on `claim_token IS NOT NULL`, so two bots racing one token end with
    one claimed and the other refused rather than both admitted. */
export async function claimBotRegistration(
  claimToken: string,
  botId: string,
): Promise<BotRecord | null> {
  const db = getSqliteDb();
  const now = toIso(new Date());
  const result = db
    .prepare(
      `UPDATE bots SET bot_id = ?, claim_token = NULL, updated_at = ?
       WHERE claim_token = ? AND bot_id IS NULL`,
    )
    .run(botId, now, claimToken);

  if (Number(result.changes ?? 0) === 0) return null;
  return getBotById(botId);
}

/** Intersected with what was asked for, here as well as at the caller: the
    operator cannot grant more than was requested, however it is reached. */
export async function decideBot(
  botId: string,
  decision: "approved" | "denied",
  decidedByServerUserId: string,
  grantedPermissions: Permission[] = [],
  rank = 0,
): Promise<BotRecord | null> {
  const existing = await getBotById(botId);
  if (!existing) return null;

  const asked = new Set(existing.requested_permissions);
  const granted =
    decision === "approved"
      ? normalizePermissions(grantedPermissions).filter((p) => asked.has(p))
      : [];

  const db = getSqliteDb();
  const now = toIso(new Date());
  db.prepare(
    `UPDATE bots SET status = ?, granted_permissions = ?, rank = ?, decided_at = ?, decided_by_server_user_id = ?, updated_at = ? WHERE bot_id = ?`,
  ).run(
    decision,
    JSON.stringify(granted),
    decision === "approved" ? Math.max(0, Math.floor(rank)) : 0,
    now,
    decidedByServerUserId,
    now,
    botId,
  );

  return getBotById(botId);
}

/** Still bounded by what it originally asked for: giving a bot something it
    never asked for is a new registration, not a wider grant on this one. */
export async function updateBotGrant(
  registrationId: string,
  grantedPermissions: Permission[],
  rank?: number,
): Promise<BotRecord | null> {
  const existing = await getBotByRegistrationId(registrationId);
  if (!existing) return null;

  const asked = new Set(existing.requested_permissions);
  const granted = normalizePermissions(grantedPermissions).filter((p) => asked.has(p));

  const db = getSqliteDb();
  db.prepare(
    `UPDATE bots SET granted_permissions = ?, rank = ?, updated_at = ? WHERE registration_id = ?`,
  ).run(
    JSON.stringify(granted),
    rank === undefined ? existing.rank : Math.max(0, Math.floor(rank)),
    toIso(new Date()),
    registrationId,
  );

  return getBotByRegistrationId(registrationId);
}

/** The membership row is a kick or a ban: this withdraws permission, which has
    to work whether or not the bot is connected. */
export async function deleteBotRegistration(registrationId: string): Promise<boolean> {
  const db = getSqliteDb();
  const result = db
    .prepare(`DELETE FROM bots WHERE registration_id = ?`)
    .run(registrationId);
  return Number(result.changes ?? 0) > 0;
}
