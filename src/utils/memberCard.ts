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
  fade?: "banner" | "none";
  colours?: "banner";
  /** Pattern tuning. Scale and rotation leave out their defaults (100, 0). */
  pScale?: number;
  pRotate?: number;
  /** No server default: absent means the client's. */
  pOpacity?: number;
  pFade?: Exclude<PatternFade, "none">;
  /** For scatter patterns. Absent means one derived from the member id. */
  pSeed?: number;
  /** Pattern colour, `#rrggbb`. Absent means the ink derived from the card. */
  pInk?: string;
  /** A Phosphor icon name for the `icon` pattern. The client falls back on one it lacks. */
  pIcon?: string;
  /** A Unicode emoji or current-server custom emoji id for the `emoji` pattern. */
  pEmoji?: string;
  /** A line pattern's weight, percent. Leaves out its default (100). */
  pStroke?: number;
  /** The pattern drawn over a banner picture. Absent, the picture covers it. */
  pLayer?: "front";
  /** The card's outline in pixels. Leaves out its default (1). */
  edge?: number;
  /** "short" draws the banner at its low height. Absent is tall; the stored banner box doesn't change. */
  bannerSize?: "short";
  /** The plain card as a choice. With no style at all, apps draw one worked out from the member's name. */
  plain?: true;
}

export const PATTERN_FADES = ["none", "top", "bottom", "left", "right", "radial"] as const;
export type PatternFade = (typeof PATTERN_FADES)[number];

const PATTERN_ID = /^[a-z0-9-]{1,32}$/;
const ICON_NAME = /^[a-z0-9-]{1,48}$/;
const validEmojiId = (value: unknown): value is string =>
  typeof value === "string" &&
  [...value].length >= 1 &&
  [...value].length <= 96 &&
  [...value].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code > 0x1f && (code < 0x7f || code > 0x9f);
  });

function readHex(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return m ? `#${m[1].toLowerCase()}` : undefined;
}

function readInt(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

function readAngle(value: unknown): number | undefined {
  return readInt(value, 0, 360);
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
  if (raw.fade === "banner" || raw.fade === "none") out.fade = raw.fade;
  if (raw.colours === "banner") out.colours = "banner";

  const pScale = readInt(raw.pScale, 50, 300);
  if (pScale !== undefined && pScale !== 100) out.pScale = pScale;
  const pRotate = readInt(raw.pRotate, 0, 359);
  if (pRotate) out.pRotate = pRotate;
  const pOpacity = readInt(raw.pOpacity, 3, 40);
  if (pOpacity !== undefined) out.pOpacity = pOpacity;
  if (PATTERN_FADES.includes(raw.pFade as PatternFade) && raw.pFade !== "none") out.pFade = raw.pFade as Exclude<PatternFade, "none">;
  const pSeed = readInt(raw.pSeed, 0, 65535);
  if (pSeed !== undefined) out.pSeed = pSeed;
  const pInk = readHex(raw.pInk);
  if (pInk) out.pInk = pInk;
  if (typeof raw.pIcon === "string" && ICON_NAME.test(raw.pIcon)) out.pIcon = raw.pIcon;
  if (validEmojiId(raw.pEmoji)) out.pEmoji = raw.pEmoji;
  const pStroke = readInt(raw.pStroke, 40, 300);
  if (pStroke !== undefined && pStroke !== 100) out.pStroke = pStroke;
  if (raw.pLayer === "front") out.pLayer = "front";
  const edge = readInt(raw.edge, 0, 6);
  if (edge !== undefined && edge !== 1) out.edge = edge;
  if (raw.bannerSize === "short") out.bannerSize = "short";

  // Only when nothing else is set: with a colour or a pattern the card isn't plain.
  if (raw.plain === true && Object.keys(out).length === 0) out.plain = true;

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
