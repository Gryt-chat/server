export interface Side {
  id: string;
  name: string;
  kind: "text" | "voice";
}

const FILLER = new Set(["chat", "channel", "text", "voice", "general-chat", "the"]);

/** Lowercase, emoji and separators gone, filler words dropped: "💬・general-chat" and "General" meet. */
export function normalizeName(name: string): string {
  const words = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((w) => w && !FILLER.has(w));
  return words.join(" ");
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.replace(/ /g, "");
  for (let i = 0; i < t.length - 1; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1);
  return m;
}

/** Dice similarity of the normalized names, 0 to 1; a short name inside a longer one counts as close. */
export function similarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x))) return 0.85;
  const bx = bigrams(x);
  const by = bigrams(y);
  let overlap = 0;
  for (const [g, n] of bx) overlap += Math.min(n, by.get(g) ?? 0);
  const total = [...bx.values()].reduce((a2, b2) => a2 + b2, 0) + [...by.values()].reduce((a2, b2) => a2 + b2, 0);
  return total ? (2 * overlap) / total : 0;
}

/** Best pairs first, one Gryt channel per Discord one, same kind only. Suggestions; the owner confirms. */
export function suggestMatches(discord: Side[], gryt: Side[], threshold = 0.6): Map<string, string> {
  const pairs: { d: string; g: string; score: number }[] = [];
  for (const d of discord) for (const g of gryt) {
    if (d.kind !== g.kind) continue;
    const score = similarity(d.name, g.name);
    if (score >= threshold) pairs.push({ d: d.id, g: g.id, score });
  }
  pairs.sort((a, b) => b.score - a.score);
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const p of pairs) {
    if (out.has(p.d) || taken.has(p.g)) continue;
    out.set(p.d, p.g);
    taken.add(p.g);
  }
  return out;
}
