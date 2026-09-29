/**
 * The card under a member's status: what a game says about itself through Rich
 * Presence. Written by whatever program reached the desktop app, so nothing here trusts it.
 */

import { isIP } from "node:net";

import { CONTROL_AND_TRICKS } from "./activityText";
import { isBlockedPreviewHost } from "./previewUrlSafety";

export const RICH_ACTIVITY_TYPES = ["playing", "listening", "watching", "competing", "using"] as const;
export type RichActivityType = (typeof RICH_ACTIVITY_TYPES)[number];

export const RICH_LIMITS = {
  name: 64,
  details: 128,
  state: 128,
  buttonLabel: 32,
  buttonUrl: 512,
  buttons: 2,
  partyMax: 999,
  /** A match can have started before the app did, but not a month before. */
  startedAtMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  /** Clocks drift, so a start slightly in the future is a start of now. */
  startedAtFutureSlackMs: 60 * 1000,
} as const;

export interface RichActivityButton {
  label: string;
  url: string;
}

/** Every field a card may draw. Anything a client sends outside these is dropped. */
export interface RichActivity {
  type: RichActivityType;
  name: string;
  details?: string;
  state?: string;
  /** Epoch milliseconds. The card counts up from it. */
  startedAt?: number;
  party?: { size: number; max?: number };
  buttons?: RichActivityButton[];
  /** The Discord application id, for an icon. Digits only; anything else is dropped. */
  appId?: string;
}


/** One line of text, capped, or undefined. Same cleaning as the status line. */
export function cleanLine(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(CONTROL_AND_TRICKS, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A link other members will click. http or https, no user:password@ (which
 * can dress one host up as another), and no local or private address.
 */
export function checkButtonUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > RICH_LIMITS.buttonUrl) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password) return undefined;
  if (!url.hostname || isBlockedPreviewHost(url.hostname)) return undefined;
  // A bare IP is how a link reaches a router or a LAN box without a name to check.
  const bare = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare) !== 0) return undefined;
  // A single label (`http://router/`) only resolves on somebody's own network.
  if (!bare.includes(".")) return undefined;
  return url.href;
}

function readButtons(value: unknown): RichActivityButton[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: RichActivityButton[] = [];
  for (const entry of value.slice(0, RICH_LIMITS.buttons)) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const label = cleanLine(record.label, RICH_LIMITS.buttonLabel);
    const url = checkButtonUrl(record.url);
    if (label && url) out.push({ label, url });
  }
  return out.length ? out : undefined;
}

function readParty(value: unknown): RichActivity["party"] {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const whole = (n: unknown) =>
    typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= RICH_LIMITS.partyMax ? n : undefined;
  const size = whole(record.size);
  if (size === undefined) return undefined;
  const max = whole(record.max);
  // "5 of 3" is a game's bug, and drawing it would make it ours.
  if (max !== undefined && max < size) return { size };
  return max === undefined ? { size } : { size, max };
}

/** A Discord snowflake is 17-20 digits. Anything else isn't an application id. */
function readAppId(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{17,20}$/.test(value) ? value : undefined;
}

function readStartedAt(value: unknown, now: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const ms = Math.floor(value);
  if (ms > now + RICH_LIMITS.startedAtFutureSlackMs) return undefined;
  if (ms < now - RICH_LIMITS.startedAtMaxAgeMs) return undefined;
  return Math.min(ms, now);
}

/** Null when there is no card to draw, which includes a card with no name. */
export function normaliseRichActivity(value: unknown, now: number = Date.now()): RichActivity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const name = cleanLine(record.name, RICH_LIMITS.name);
  if (!name) return null;

  const type = RICH_ACTIVITY_TYPES.includes(record.type as RichActivityType)
    ? (record.type as RichActivityType)
    : "playing";

  const card: RichActivity = { type, name };
  const details = cleanLine(record.details, RICH_LIMITS.details);
  if (details) card.details = details;
  const state = cleanLine(record.state, RICH_LIMITS.state);
  if (state) card.state = state;
  const startedAt = readStartedAt(record.startedAt, now);
  if (startedAt !== undefined) card.startedAt = startedAt;
  const party = readParty(record.party);
  if (party) card.party = party;
  const buttons = readButtons(record.buttons);
  if (buttons) card.buttons = buttons;
  const appId = readAppId(record.appId);
  if (appId) card.appId = appId;
  return card;
}

/** For the unchanged check: key order is fixed by `normaliseRichActivity`. */
export function sameRichActivity(a: RichActivity | undefined, b: RichActivity | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
