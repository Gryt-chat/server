/**
 * Per sender, in memory, from time-decayed counts. DMs are sealed, so they are
 * judged on who, how many and how long, never on what was said.
 */

export type SpamSensitivity = "low" | "normal" | "high";

export const SPAM_SENSITIVITIES: readonly SpamSensitivity[] = ["low", "normal", "high"];

/** Unknown reads as `normal`, so a typo neither switches it off nor turns it up. */
export function normalizeSpamSensitivity(v: unknown): SpamSensitivity {
  return v === "low" || v === "high" ? v : "normal";
}

/** The score at which a message is dropped and its sender timed out. */
export const SPAM_THRESHOLDS: Record<SpamSensitivity, number> = { low: 15, normal: 10, high: 6.6 };

/** A strike older than a week no longer counts towards the next step. */
export const TIMEOUT_LADDER_MINUTES = [1, 10, 60, 1440] as const;
export const STRIKE_MEMORY_MS = 7 * 24 * 60 * 60_000;

const HISTORY_MS = 15 * 60_000;
const HISTORY_MAX = 60;
const TEXT_HALF_LIFE_MS = 2 * 60_000;
const ATTACHMENT_HALF_LIFE_MS = 60_000;
const DM_HALF_LIFE_MS = 5 * 60_000;

export interface ChannelSend {
  kind: "channel";
  conversationId: string;
  text: string;
  /** Distinct members named. */
  userMentions: number;
  /** @everyone and @here attempted, whether or not the sender may. */
  massMentions: number;
  /** Roles attempted, whether or not they pinged. */
  roleMentions: number;
  /** Whether the sender may ping everybody here. Refused attempts weigh more. */
  mayMentionEveryone: boolean;
  attachments: number;
}

export interface DirectSend {
  kind: "dm";
  conversationId: string;
  /** Everybody in the conversation except the sender. */
  recipients: readonly string[];
  /** Length of the sealed envelope or the text. Never the content. */
  size: number;
  /** Whether this is the first message the conversation has had. */
  newConversation: boolean;
  attachments: number;
}

export type SpamSend = ChannelSend | DirectSend;

export interface SpamSender {
  id: string;
  /** When they joined this server, for the new-member weight. */
  memberSince: Date | null;
}

export type SignalName =
  | "duplicate"
  | "cross_channel"
  | "links"
  | "invites"
  | "mentions"
  | "wall"
  | "attachments"
  | "dm_fanout"
  | "dm_new_conversations"
  | "dm_same_size";

export interface Signal {
  name: SignalName;
  points: number;
}

export interface Verdict {
  spam: boolean;
  /** After the new-member weight. */
  score: number;
  threshold: number;
  weight: number;
  /** Only the ones that scored, before the weight. */
  signals: Signal[];
}

interface SendEvent {
  at: number;
  kind: "channel" | "dm";
  conversationId: string;
  fingerprint: string;
  bigrams: Map<string, number> | null;
  links: number;
  invites: number;
  mentionUnits: number;
  wall: number;
  attachments: number;
  recipients: readonly string[];
  size: number;
  newConversation: boolean;
}

// ── Text features ───────────────────────────────────────────────

// Hangul fillers are letters to Unicode but draw as nothing. Format characters
// and combining marks go with the punctuation below.
const INVISIBLE = /[\u115F\u1160\u3164\uFFA0]/g;
// Built at runtime: the compile target predates Unicode property escapes.
const NOT_CONTENT = new RegExp("[^\\p{L}\\p{N}\\p{S}]", "gu");
const PICTOGRAPH = new RegExp("\\p{Extended_Pictographic}", "gu");
const WHITESPACE = /\s/;

/** Case, spacing, punctuation, invisible characters and repeated letters all
    folded away, so "FREE  n i t r o!!!" and "freee nitro" are the same text. */
export function normalizeForSpam(text: string): string {
  const folded = text.normalize("NFKC").toLowerCase().replace(INVISIBLE, "").replace(NOT_CONTENT, "");
  let out = "";
  let previous = "";
  for (const ch of folded) {
    if (ch !== previous) out += ch;
    previous = ch;
  }
  return out;
}

/** Shorter than this and a repeat is "ok", "lol" or "yes", which is not spam. */
export const MIN_FINGERPRINT_LENGTH = 6;
/** Near-duplicates need enough text that a shared bigram means something. */
const MIN_FUZZY_LENGTH = 12;
const FUZZY_SIMILARITY = 0.8;

function bigramsOf(fingerprint: string): Map<string, number> {
  const chars = Array.from(fingerprint);
  const out = new Map<string, number>();
  for (let i = 0; i < chars.length - 1; i++) {
    const pair = chars[i] + chars[i + 1];
    out.set(pair, (out.get(pair) ?? 0) + 1);
  }
  return out;
}

/** Dice coefficient over character bigrams: 1 is the same text, 0 shares nothing. */
export function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  return diceOf(bigramsOf(a), bigramsOf(b));
}

function diceOf(a: Map<string, number>, b: Map<string, number>): number {
  let sizeA = 0;
  let sizeB = 0;
  let shared = 0;
  for (const n of a.values()) sizeA += n;
  for (const n of b.values()) sizeB += n;
  if (sizeA === 0 || sizeB === 0) return 0;
  for (const [pair, n] of a) shared += Math.min(n, b.get(pair) ?? 0);
  return (2 * shared) / (sizeA + sizeB);
}

function lengthOf(s: string): number {
  return Array.from(s).length;
}

function sameText(a: SendEvent, b: SendEvent): boolean {
  const la = lengthOf(a.fingerprint);
  const lb = lengthOf(b.fingerprint);
  if (la < MIN_FINGERPRINT_LENGTH || lb < MIN_FINGERPRINT_LENGTH) return false;
  if (a.fingerprint === b.fingerprint) return true;
  if (!a.bigrams || !b.bigrams) return false;
  if (Math.min(la, lb) / Math.max(la, lb) < 0.7) return false;
  return diceOf(a.bigrams, b.bigrams) >= FUZZY_SIMILARITY;
}

const URL_PATTERN = /(?:\bhttps?:\/\/|\bwww\.|\bgryt:\/\/)[^\s<>()[\]]+/gi;
/** Other servers' and chat apps' invites, with or without a scheme. */
const INVITE_PATTERN = /(?:\bdiscord(?:app)?\.com\/invite\/|\bdiscord\.gg\/|\bt\.me\/|\btelegram\.me\/|\bchat\.whatsapp\.com\/|\bguilded\.gg\/i\/|\bgryt:\/\/invite|\/invite\/[\w-]+|\/invite\?\S*code=)/gi;

export function countLinks(text: string): { links: number; invites: number } {
  const invites = (text.match(INVITE_PATTERN) ?? []).length;
  const links = Math.max((text.match(URL_PATTERN) ?? []).length, invites);
  return { links, invites };
}

const WALL_MIN_CHARACTERS = 30;
const WALL_SHARE = 0.6;
const WALL_RUN = 40;
const WALL_PICTOGRAPHS = 30;
const HUGE_WALL = 500;

/** 1 for a wall of one character or of emoji, 2 for a huge one, 0 otherwise. */
export function wallWeight(text: string): number {
  const chars = Array.from(text).filter((c) => !WHITESPACE.test(c));
  if (chars.length < WALL_MIN_CHARACTERS) return 0;

  const counts = new Map<string, number>();
  let top = 0;
  let run = 0;
  let longestRun = 0;
  let previous = "";
  for (const c of chars) {
    const n = (counts.get(c) ?? 0) + 1;
    counts.set(c, n);
    if (n > top) top = n;
    run = c === previous ? run + 1 : 1;
    if (run > longestRun) longestRun = run;
    previous = c;
  }
  const pictographs = (text.match(PICTOGRAPH) ?? []).length;

  const wall = top / chars.length >= WALL_SHARE || longestRun >= WALL_RUN || pictographs >= WALL_PICTOGRAPHS;
  if (!wall) return 0;
  return chars.length >= HUGE_WALL ? 2 : 1;
}

/** Somebody who joined minutes ago and starts messaging strangers is the classic
    shape. Lighter in channels, where a new member double-sending a hello is not. */
export function newMemberWeight(memberSince: Date | null, now: number, kind: "channel" | "dm"): number {
  if (!memberSince) return 1;
  const age = now - memberSince.getTime();
  const [first, hour, day] = kind === "dm" ? [2, 1.5, 1.25] : [1.5, 1.25, 1.1];
  if (age < 10 * 60_000) return first;
  if (age < 60 * 60_000) return hour;
  if (age < 24 * 60 * 60_000) return day;
  return 1;
}

// ── Scoring ─────────────────────────────────────────────────────

function decay(ageMs: number, halfLifeMs: number): number {
  return Math.pow(0.5, Math.max(0, ageMs) / halfLifeMs);
}

function above(total: number, free: number, perUnit: number): number {
  return Math.max(0, total - free) * perUnit;
}

/** A group counts as two people however big it is: somebody added to one did
    not choose its size. */
function recipientShare(recipients: readonly string[]): number {
  return recipients.length === 0 ? 0 : Math.min(1, 2 / recipients.length);
}

function clampCount(n: number, max: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(0, Math.floor(n)), max) : 0;
}

function toEvent(send: SpamSend, at: number): SendEvent {
  const attachments = clampCount(send.attachments, 3);
  if (send.kind === "dm") {
    return {
      at,
      kind: "dm",
      conversationId: send.conversationId,
      fingerprint: "",
      bigrams: null,
      links: 0,
      invites: 0,
      mentionUnits: 0,
      wall: 0,
      attachments,
      recipients: send.recipients,
      size: clampCount(send.size, Number.MAX_SAFE_INTEGER),
      newConversation: send.newConversation,
    };
  }

  const fingerprint = normalizeForSpam(send.text);
  const { links, invites } = countLinks(send.text);
  return {
    at,
    kind: "channel",
    conversationId: send.conversationId,
    fingerprint,
    bigrams: lengthOf(fingerprint) >= MIN_FUZZY_LENGTH ? bigramsOf(fingerprint) : null,
    links: Math.min(links, 3),
    invites: Math.min(invites, 2),
    mentionUnits:
      clampCount(send.userMentions, 1000) +
      (send.mayMentionEveryone ? 2 : 5) * clampCount(send.massMentions, 2) +
      (send.mayMentionEveryone ? 1 : 2) * clampCount(send.roleMentions, 3),
    wall: wallWeight(send.text),
    attachments,
    recipients: [],
    size: 0,
    newConversation: false,
  };
}

function scoreEvent(current: SendEvent, past: readonly SendEvent[], now: number): Signal[] {
  const signals: Signal[] = [];
  const add = (name: SignalName, points: number) => {
    if (points > 0) signals.push({ name, points });
  };

  let attachments = current.attachments;
  for (const p of past) attachments += decay(now - p.at, ATTACHMENT_HALF_LIFE_MS) * p.attachments;
  add("attachments", above(attachments, 8, 1.5));

  if (current.kind === "channel") {
    let duplicates = 0;
    const otherChannels = new Map<string, number>();
    let links = current.links;
    let invites = current.invites;
    let mentions = current.mentionUnits;
    let walls = current.wall;

    for (const p of past) {
      if (p.kind !== "channel") continue;
      const w = decay(now - p.at, TEXT_HALF_LIFE_MS);
      if (sameText(current, p)) {
        duplicates += w;
        if (p.conversationId !== current.conversationId) {
          otherChannels.set(p.conversationId, Math.max(otherChannels.get(p.conversationId) ?? 0, w));
        }
      }
      links += w * p.links;
      invites += w * p.invites;
      mentions += w * p.mentionUnits;
      walls += w * p.wall;
    }

    let crossChannel = 0;
    for (const w of otherChannels.values()) crossChannel += w;

    add("duplicate", 3.5 * duplicates);
    add("cross_channel", 3 * crossChannel);
    add("links", above(links, 2, 2.5));
    add("invites", above(invites, 1, 4));
    add("mentions", above(mentions, 6, 1.5));
    add("wall", 3 * walls);
    return signals;
  }

  const people = new Map<string, number>();
  const share = recipientShare(current.recipients);
  for (const r of current.recipients) people.set(r, share);
  let fresh = current.newConversation ? 1 : 0;
  const sameSize = new Map<string, number>();

  for (const p of past) {
    if (p.kind !== "dm") continue;
    const w = decay(now - p.at, DM_HALF_LIFE_MS);
    const s = w * recipientShare(p.recipients);
    for (const r of p.recipients) people.set(r, Math.max(people.get(r) ?? 0, s));
    if (p.newConversation) fresh += w;
    if (current.size > 0 && p.size === current.size && p.conversationId !== current.conversationId) {
      sameSize.set(p.conversationId, Math.max(sameSize.get(p.conversationId) ?? 0, w));
    }
  }

  let fanOut = 0;
  for (const w of people.values()) fanOut += w;
  let repeats = 0;
  for (const w of sameSize.values()) repeats += w;

  add("dm_fanout", above(fanOut, 5, 1.25));
  add("dm_new_conversations", above(fresh, 3, 2));
  add("dm_same_size", above(repeats, 2, 1.5));
  return signals;
}

export class SpamFilter {
  private history = new Map<string, SendEvent[]>();

  constructor() {
    // Unref'd like the rate limiter's, or a test that imports this never exits.
    setInterval(() => this.sweep(Date.now()), 60_000).unref();
  }

  /** Remembers the send unless it tripped. A trip clears the history, so the
      burst that earned a timeout cannot earn the next one as well. */
  evaluate(sender: SpamSender, send: SpamSend, sensitivity: SpamSensitivity, now = Date.now()): Verdict {
    const past = (this.history.get(sender.id) ?? []).filter((e) => now - e.at <= HISTORY_MS);
    const current = toEvent(send, now);
    const signals = scoreEvent(current, past, now);
    const weight = newMemberWeight(sender.memberSince, now, send.kind);
    const score = signals.reduce((sum, s) => sum + s.points, 0) * weight;
    const threshold = SPAM_THRESHOLDS[sensitivity];
    const spam = score >= threshold;

    if (spam) {
      this.history.delete(sender.id);
    } else {
      past.push(current);
      this.history.set(sender.id, past.slice(-HISTORY_MAX));
    }
    return { spam, score, threshold, weight, signals };
  }

  /** Tests only. */
  reset(): void {
    this.history.clear();
  }

  private sweep(now: number): void {
    for (const [id, events] of this.history) {
      const last = events[events.length - 1];
      if (!last || now - last.at > HISTORY_MS) this.history.delete(id);
    }
  }
}

export const spamFilter = new SpamFilter();
