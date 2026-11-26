/* eslint-disable @typescript-eslint/no-restricted-types -- checks a poster a client sent or the database stored */
/**
 * A channel's poster, drawn at the start of its history, and the colour that tints its
 * icon and header. Every member reads both, so a bad value is dropped rather than refused.
 */

import { normaliseCardStyle } from "./memberCard";

export const POSTER_LAYOUTS = ["classic", "centred", "quiet"] as const;
export type PosterLayout = (typeof POSTER_LAYOUTS)[number];

export interface ChannelPoster {
  layout: PosterLayout;
  fill?: "solid" | "gradient";
  c1?: string;
  c2?: string;
  angle?: number;
  /** A card pattern id. */
  pattern?: string;
}

/** Null is no poster. Colour and pattern are checked the way a member card's are. */
export function normaliseChannelPoster(value: unknown): ChannelPoster | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!POSTER_LAYOUTS.includes(raw.layout as PosterLayout)) return null;
  const card = normaliseCardStyle({ fill: raw.fill, c1: raw.c1, c2: raw.c2, angle: raw.angle, pattern: raw.pattern }) ?? {};
  const out: ChannelPoster = { layout: raw.layout as PosterLayout };
  if (card.fill) out.fill = card.fill;
  if (card.c1) out.c1 = card.c1;
  if (card.c2) out.c2 = card.c2;
  if (card.angle !== undefined) out.angle = card.angle;
  if (card.pattern) out.pattern = card.pattern;
  return out;
}

export function readStoredChannelPoster(stored: string | null | undefined): ChannelPoster | null {
  if (!stored) return null;
  try {
    return normaliseChannelPoster(JSON.parse(stored));
  } catch {
    return null;
  }
}

/** `#rrggbb` in lower case, or null. */
export function normaliseChannelColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return m ? `#${m[1].toLowerCase()}` : null;
}
