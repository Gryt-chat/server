import { MESSAGE_MAX_LENGTH } from "../../utils/messageLimits";
import type { DceEmbed, DceUser } from "./dce";

function displayName(user: DceUser | undefined): string | null {
  const name = user?.nickname || user?.name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/**
 * DCE flattens mentions and emoji unless run with `--markdown false`, which keeps
 * Discord's raw forms. Those are turned into what the flattened export would say.
 */
export function rewriteDiscordMarkup(
  content: string,
  mentions: DceUser[] | undefined,
  channelNames: Map<string, string>,
): string {
  const byId = new Map<string, string>();
  for (const m of mentions ?? []) {
    const name = displayName(m);
    if (m?.id && name) byId.set(m.id, name);
  }
  return content
    .replace(/<@!?(\d{1,20})>/g, (_, id: string) => `@${byId.get(id) ?? "unknown-user"}`)
    .replace(/<@&(\d{1,20})>/g, "@role")
    .replace(/<#(\d{1,20})>/g, (_, id: string) => `#${channelNames.get(id) ?? "unknown-channel"}`)
    .replace(/<a?:([A-Za-z0-9_~-]{1,64}):\d{1,20}>/g, (_, name: string) => `:${name}:`)
    .replace(/<t:(-?\d{1,13})(?::[tTdDfFR])?>/g, (_, secs: string) => {
      const d = new Date(Number(secs) * 1000);
      return Number.isNaN(d.getTime()) ? secs : d.toISOString().replace(".000Z", "Z");
    });
}

/** The imported author's name as Gryt shows it. Never empty, since the row needs one. */
export function authorName(user: DceUser | undefined): string {
  return (displayName(user) ?? "Discord user").slice(0, 64);
}

/** Link previews come back as embeds. Gryt draws its own from the URL in the text, so those are skipped. */
export function isLinkPreview(embed: DceEmbed, content: string): boolean {
  const url = embed.url ?? embed.image?.canonicalUrl ?? embed.video?.canonicalUrl ?? null;
  return !!url && content.includes(url);
}

export function hasCardContent(embed: DceEmbed): boolean {
  return !!(embed.title || embed.description || embed.author?.name || (embed.fields?.length ?? 0) > 0 || embed.footer?.text);
}

export function normaliseHexColor(v: string | null | undefined): string | undefined {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : undefined;
}

export function httpUrl(v: string | null | undefined): string | undefined {
  if (typeof v !== "string" || v.length > 2048) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function clip(v: string | null | undefined, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

/** Joins the message text with notes about what didn't come across, within the cap. */
export function composeText(content: string, notes: string[]): string | null {
  const parts = [content.trim(), ...notes].filter(Boolean);
  if (parts.length === 0) return null;
  return parts.join("\n").slice(0, MESSAGE_MAX_LENGTH);
}

/** Only what Gryt's emoji names allow. Discord's are already this shape, bar length. */
export function emojiName(name: string | undefined): string | null {
  if (typeof name !== "string") return null;
  const clean = name.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 32);
  return clean.length >= 2 ? clean : null;
}
