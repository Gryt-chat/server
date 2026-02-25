import {
  RegExpMatcher,
  TextCensor,
  englishDataset,
  englishRecommendedTransformers,
  type MatchPayload,
} from "obscenity";

export type ProfanityMode = "off" | "flag" | "censor" | "block";
export type CensorStyle = "grawlix" | "emoji" | "asterisks" | "block" | "hearts";

export const VALID_CENSOR_STYLES: CensorStyle[] = ["grawlix", "emoji", "asterisks", "block", "hearts"];

export function normalizeCensorStyle(v: unknown): CensorStyle {
  const s = String(v || "").toLowerCase();
  if (VALID_CENSOR_STYLES.includes(s as CensorStyle)) return s as CensorStyle;
  return "emoji";
}

export interface ProfanityMatch {
  startIndex: number;
  endIndex: number;
}

export interface ScanResult {
  hasProfanity: boolean;
  matches: ProfanityMatch[];
}

const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

const GRAWLIX_CHARS = ["$", "#", "@", "!", "%", "&", "*"];

function censorReplacement(length: number, style: CensorStyle): string {
  switch (style) {
    case "emoji":
      return "\u{1F92C}".repeat(Math.max(1, Math.ceil(length / 2)));
    case "asterisks":
      return "*".repeat(length);
    case "block":
      return "\u2588".repeat(length);
    case "hearts":
      return "\u2665".repeat(length);
    case "grawlix":
    default: {
      let result = "";
      for (let i = 0; i < length; i++) {
        result += GRAWLIX_CHARS[Math.floor(Math.random() * GRAWLIX_CHARS.length)];
      }
      return result;
    }
  }
}

function toMatches(raw: MatchPayload[]): ProfanityMatch[] {
  return raw.map((m) => ({
    startIndex: m.startIndex,
    endIndex: m.endIndex,
  }));
}

export function scanText(text: string): ScanResult {
  const raw = matcher.getAllMatches(text, true);
  return {
    hasProfanity: raw.length > 0,
    matches: toMatches(raw),
  };
}

function logProfanityMatches(
  text: string,
  raw: MatchPayload[],
  mode: ProfanityMode,
) {
  if (raw.length === 0) return;
  const matched = raw.map(
    (m) => `"${text.slice(m.startIndex, m.endIndex + 1)}" [${m.startIndex}:${m.endIndex}]`,
  );
  console.log(
    `[Profanity] mode=${mode} text=${JSON.stringify(text)} matched=[${matched.join(", ")}]`,
  );
}

export function censorText(text: string, style: CensorStyle = "emoji"): string {
  const censor = new TextCensor().setStrategy((ctx) =>
    censorReplacement(ctx.matchLength, style),
  );
  const raw = matcher.getAllMatches(text, true);
  if (raw.length === 0) return text;
  return censor.applyTo(text, raw);
}

const LONG_TEXT_THRESHOLD = 5000;

export function processProfanity(
  text: string,
  mode: ProfanityMode,
  censorStyle: CensorStyle = "emoji",
): Promise<
  | { action: "pass"; text: string; matches?: ProfanityMatch[] }
  | { action: "reject" }
> {
  if (mode === "off") {
    return Promise.resolve({ action: "pass", text });
  }

  const run = (): { action: "pass"; text: string; matches?: ProfanityMatch[] } | { action: "reject" } => {
    const raw = matcher.getAllMatches(text, true);
    logProfanityMatches(text, raw, mode);

    if (mode === "flag") {
      return {
        action: "pass",
        text,
        matches: raw.length > 0 ? toMatches(raw) : undefined,
      };
    }

    if (mode === "censor") {
      if (raw.length === 0) return { action: "pass", text };
      const censor = new TextCensor().setStrategy((ctx) =>
        censorReplacement(ctx.matchLength, censorStyle),
      );
      return { action: "pass", text: censor.applyTo(text, raw) };
    }

    // mode === "block"
    if (raw.length > 0) return { action: "reject" };
    return { action: "pass", text };
  };

  if (text.length > LONG_TEXT_THRESHOLD) {
    return new Promise((resolve) => setImmediate(() => resolve(run())));
  }

  return Promise.resolve(run());
}
