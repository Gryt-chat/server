import {
  RegExpMatcher,
  TextCensor,
  englishDataset,
  englishRecommendedTransformers,
  type MatchPayload,
} from "obscenity";

export type ProfanityMode = "off" | "flag" | "censor" | "block";

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

function randomGrawlix(length: number): string {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += GRAWLIX_CHARS[Math.floor(Math.random() * GRAWLIX_CHARS.length)];
  }
  return result;
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

export function censorText(text: string): string {
  const censor = new TextCensor().setStrategy((ctx) =>
    randomGrawlix(ctx.matchLength),
  );
  const raw = matcher.getAllMatches(text, true);
  if (raw.length === 0) return text;
  return censor.applyTo(text, raw);
}

const LONG_TEXT_THRESHOLD = 5000;

export function processProfanity(
  text: string,
  mode: ProfanityMode,
): Promise<
  | { action: "pass"; text: string; matches?: ProfanityMatch[] }
  | { action: "reject" }
> {
  if (mode === "off") {
    return Promise.resolve({ action: "pass", text });
  }

  const run = (): { action: "pass"; text: string; matches?: ProfanityMatch[] } | { action: "reject" } => {
    if (mode === "flag") {
      const scan = scanText(text);
      return {
        action: "pass",
        text,
        matches: scan.hasProfanity ? scan.matches : undefined,
      };
    }

    if (mode === "censor") {
      return { action: "pass", text: censorText(text) };
    }

    // mode === "block"
    const scan = scanText(text);
    if (scan.hasProfanity) return { action: "reject" };
    return { action: "pass", text };
  };

  if (text.length > LONG_TEXT_THRESHOLD) {
    return new Promise((resolve) => setImmediate(() => resolve(run())));
  }

  return Promise.resolve(run());
}
