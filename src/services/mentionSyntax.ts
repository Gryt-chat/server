/* Stored text holds the link form only for a mention that pinged. The client
   halves are `mentionTokens.ts`; all three check `mention-vectors.json`. */

export type MentionTarget =
  | { kind: "user"; id: string }
  | { kind: "everyone" }
  | { kind: "here" }
  | { kind: "role"; id: string }
  | { kind: "channel"; id: string; host: string | null };

const ROLE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const CHANNEL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HOST = /^[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;

/** The same rules as the clients' `mentionTarget`, so all three agree on what a link is. */
export function mentionTarget(href: string): MentionTarget | null {
  if (href.startsWith("mention:")) {
    const id = href.slice("mention:".length);
    if (id === "everyone") return { kind: "everyone" };
    if (id === "here") return { kind: "here" };
    return id ? { kind: "user", id } : null;
  }
  if (href.startsWith("role:")) {
    const id = href.slice("role:".length);
    return ROLE_ID.test(id) ? { kind: "role", id } : null;
  }
  if (href.startsWith("channel:")) {
    const ref = href.slice("channel:".length);
    const slash = ref.lastIndexOf("/");
    const host = slash === -1 ? null : ref.slice(0, slash);
    const id = slash === -1 ? ref : ref.slice(slash + 1);
    if (!CHANNEL_ID.test(id)) return null;
    if (host !== null && !HOST.test(host)) return null;
    return { kind: "channel", id, host };
  }
  return null;
}

export interface MentionRights {
  /** Mention everyone in this channel: @everyone, @here and every role. */
  everyone: boolean;
  roles: ReadonlyMap<string, { name: string; mentionable: boolean }>;
  /** Channels the sender can see, so a typed `#name` can become a link. */
  channels: readonly { id: string; name: string }[];
}

export interface CanonicalMentions {
  text: string;
  everyone: boolean;
  here: boolean;
  roleIds: string[];
  /** The text without the role and mass links, for the nickname scan: a role
      called Ada must not ping a member called Ada. */
  forNicknames: string;
}

/** The label is fixed, so a reader who cannot see the channel never gets its name. */
export const CHANNEL_LABEL = "#channel";

const LINK = /\[([^\]\n]*)\]\(([^)\s]*)\)/g;
// Code and bare URLs are left exactly as written.
const LITERAL = /(```|~~~)[\s\S]*?(?:\1|$)|`[^`\n]*`|https?:\/\/\S+/g;

function safeLabel(name: string): string {
  return name.replace(/[[\]\n]/g, "");
}

interface Candidate {
  needle: string;
  apply: () => string;
}

/** Longest first at the earliest position, with the same word boundaries as `findMentions`. */
function replacePlain(text: string, candidates: Candidate[]): string {
  if (candidates.length === 0) return text;
  const sorted = [...candidates].sort((a, b) => b.needle.length - a.needle.length);
  const lower = text.toLowerCase();
  let out = "";
  let from = 0;

  while (from < text.length) {
    let at = -1;
    let chosen: Candidate | null = null;
    for (const c of sorted) {
      let index = lower.indexOf(c.needle.toLowerCase(), from);
      while (index !== -1) {
        const before = index > 0 ? text[index - 1] : "";
        const after = text[index + c.needle.length] ?? "";
        if (!/[\w@#&/]/.test(before) && !/\w/.test(after)) break;
        index = lower.indexOf(c.needle.toLowerCase(), index + 1);
      }
      if (index === -1) continue;
      if (at === -1 || index < at) {
        at = index;
        chosen = c;
      }
    }
    if (at === -1 || !chosen) break;
    out += text.slice(from, at) + chosen.apply();
    from = at + chosen.needle.length;
  }

  return out + text.slice(from);
}

export function canonicalizeMentions(text: string, rights: MentionRights): CanonicalMentions {
  let everyone = false;
  let here = false;
  const roleIds: string[] = [];
  const blanked: [string, string][] = [];

  const mass = (kind: "everyone" | "here"): string => {
    if (!rights.everyone) return `@${kind}`;
    if (kind === "everyone") everyone = true;
    else here = true;
    const link = `[@${kind}](mention:${kind})`;
    blanked.push([link, " "]);
    return link;
  };

  const role = (id: string, fallback: string): string => {
    const def = rights.roles.get(id);
    if (!def) return fallback;
    const name = safeLabel(def.name);
    if (!rights.everyone && !def.mentionable) return `@${name}`;
    if (!roleIds.includes(id)) roleIds.push(id);
    const link = `[@${name}](role:${id})`;
    blanked.push([link, " "]);
    return link;
  };

  const candidates: Candidate[] = [
    { needle: "@everyone", apply: () => mass("everyone") },
    { needle: "@here", apply: () => mass("here") },
  ];
  for (const [id, def] of rights.roles) {
    const name = safeLabel(def.name).trim();
    if (!name || name.toLowerCase() === "everyone" || name.toLowerCase() === "here") continue;
    if (!rights.everyone && !def.mentionable) continue;
    candidates.push({ needle: `@${name}`, apply: () => role(id, `@${name}`) });
  }
  for (const channel of rights.channels) {
    const name = channel.name.trim();
    if (!name || !CHANNEL_ID.test(channel.id)) continue;
    candidates.push({ needle: `#${name}`, apply: () => `[${CHANNEL_LABEL}](channel:${channel.id})` });
  }

  const prose = (segment: string): string => {
    let out = "";
    let last = 0;
    for (const m of segment.matchAll(LINK)) {
      const [whole, label, href] = m;
      const start = m.index ?? 0;
      out += replacePlain(segment.slice(last, start), candidates);
      last = start + whole.length;

      const target = mentionTarget(href);
      if (!target || target.kind === "user") {
        out += whole;
        continue;
      }
      if (target.kind === "everyone" || target.kind === "here") {
        out += mass(target.kind);
      } else if (target.kind === "role") {
        out += role(target.id, label);
      } else {
        out += `[${CHANNEL_LABEL}](${href})`;
      }
    }
    return out + replacePlain(segment.slice(last), candidates);
  };

  let result = "";
  let last = 0;
  for (const m of text.matchAll(LITERAL)) {
    const start = m.index ?? 0;
    result += prose(text.slice(last, start)) + m[0];
    last = start + m[0].length;
  }
  result += prose(text.slice(last));

  let forNicknames = result;
  for (const [link, blank] of blanked) forNicknames = forNicknames.split(link).join(blank);

  return { text: result, everyone, here, roleIds, forNicknames };
}
