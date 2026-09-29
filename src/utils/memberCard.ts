/**
 * What a member puts on their own card: its colours and pattern, a bio, pronouns
 * and a status line. Every member reads it, so a bad value falls back to the default.
 */

import { cleanLine } from "./richActivity";

export const CARD_LIMITS = {
  bio: 190,
  pronouns: 40,
  statusLine: 80,
} as const;

export type CardFill = "owl" | "solid" | "gradient";

/** Defaults are left out, so `{}` is the default card and is stored as nothing. */
export interface CardStyle {
  fill?: Exclude<CardFill, "owl">;
  /** `#rrggbb`, lower case. Set for `solid` and `gradient`. */
  c1?: string;
  /** Set for `gradient` only. */
  c2?: string;
  /** Degrees, 0 to 360. Gradient only; absent means the client's default. */
  angle?: number;
  /** A registry id the client looks up. An id it does not know draws as `none`. */
  pattern?: string;
  cover?: "card";
  fade?: "banner";
  colours?: "banner";
}

const PATTERN_ID = /^[a-z0-9-]{1,32}$/;

function readHex(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return m ? `#${m[1].toLowerCase()}` : undefined;
}

function readAngle(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 360 ? value : undefined;
}

/** Null is the default card. Unknown keys are dropped, and so is any value that fails. */
export function normaliseCardStyle(value: unknown): CardStyle | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const out: CardStyle = {};

  const c1 = readHex(raw.c1);
  const c2 = readHex(raw.c2);
  // A gradient missing its second colour is still a colour somebody picked.
  if (raw.fill === "gradient" && c1 && c2) {
    out.fill = "gradient";
    out.c1 = c1;
    out.c2 = c2;
    const angle = readAngle(raw.angle);
    if (angle !== undefined) out.angle = angle;
  } else if ((raw.fill === "solid" || raw.fill === "gradient") && c1) {
    out.fill = "solid";
    out.c1 = c1;
  }

  if (typeof raw.pattern === "string" && PATTERN_ID.test(raw.pattern) && raw.pattern !== "none") {
    out.pattern = raw.pattern;
  }
  if (raw.cover === "card") out.cover = "card";
  if (raw.fade === "banner") out.fade = "banner";
  if (raw.colours === "banner") out.colours = "banner";

  return Object.keys(out).length ? out : null;
}

/** The column holds what `normaliseCardStyle` returned, but it is read through it again. */
export function readStoredCardStyle(stored: string | null | undefined): CardStyle | null {
  if (!stored) return null;
  try {
    return normaliseCardStyle(JSON.parse(stored));
  } catch {
    return null;
  }
}

/** Same cleaning as a status: one line, no invisible or direction-changing characters. */
export function normaliseCardText(value: unknown, max: number): string | null {
  return cleanLine(value, max) ?? null;
}

/** What a `profile:update` asks to write. A field left out is left alone, and null clears. */
export interface CardUpdate {
  cardStyle?: string | null;
  bio?: string | null;
  pronouns?: string | null;
  statusLine?: string | null;
}

export function readCardUpdate(data: Record<string, unknown> | null | undefined): CardUpdate {
  const update: CardUpdate = {};
  if (!data) return update;
  if (data.cardStyle !== undefined) {
    const style = normaliseCardStyle(data.cardStyle);
    update.cardStyle = style ? JSON.stringify(style) : null;
  }
  if (data.bio !== undefined) update.bio = normaliseCardText(data.bio, CARD_LIMITS.bio);
  if (data.pronouns !== undefined) update.pronouns = normaliseCardText(data.pronouns, CARD_LIMITS.pronouns);
  if (data.statusLine !== undefined) update.statusLine = normaliseCardText(data.statusLine, CARD_LIMITS.statusLine);
  return update;
}

/** True when the update puts new free text on the card, as opposed to clearing it. */
export function setsCardText(update: CardUpdate): boolean {
  return Boolean(update.bio || update.pronouns || update.statusLine);
}

/** The card as a member list row carries it, and as a member reads their own back. */
export function cardFields(user: {
  card_style: string | null;
  bio: string | null;
  pronouns: string | null;
  status_line: string | null;
}) {
  return {
    cardStyle: readStoredCardStyle(user.card_style),
    bio: user.bio,
    pronouns: user.pronouns,
    statusLine: user.status_line,
  };
}
