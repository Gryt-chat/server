// No comment may run past two lines. Storytelling, history and restated types
// belong in git, in a task, or nowhere. See .claude/CLAUDE.md in the superproject.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const LIMIT = 2;

const EMPTY = /^(\/\*+|\*+\/?|\/\/|#|--)$|[─=]{3,}\s*\*?\/?$/;
const ROOTS = ["src", "scripts", "examples", ".github/workflows"];
const SKIP = new Set(["node_modules", "dist", "build", "coverage", ".git"]);
const CODE = /\.(ts|tsx|mts|js|mjs|cjs)$/;
const HASH = /\.(ya?ml|sh)$/;
// SQL comment runs over the limit that predate counting them. Only ever lower these.
const SQL_DEBT: Record<string, number> = { "src/db/sqlite/connection.ts": 15 };

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (CODE.test(name) || HASH.test(name)) out.push(full);
  }
  return out;
}

// A run is consecutive comment lines: one block comment, or a stack of // lines.
// Only lines carrying words count: `/**`, `*/` and a ── section rule are free.
function runs(text: string, hash: boolean) {
  const lines = text.split("\n");
  const found: { line: number; length: number; sql: boolean }[] = [];
  let start = -1;
  let length = 0;
  let inBlock = false;
  let sql = false;

  const close = () => {
    if (length > LIMIT) found.push({ line: start + 1, length, sql });
    start = -1;
    length = 0;
    sql = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    let comment = false;

    if (inBlock) {
      comment = true;
      if (line.includes("*/")) inBlock = false;
    } else if (!hash && line.startsWith("/*")) {
      comment = true;
      if (!line.includes("*/")) inBlock = true;
    } else if (!hash && line.startsWith("//")) {
      comment = true;
    } else if (!hash && /^--( |$)/.test(line)) {
      // SQL inside a template string.
      comment = true;
      sql = true;
    } else if (hash && line.startsWith("#") && !line.startsWith("#!")) {
      comment = true;
    }

    if (comment) {
      if (start === -1) start = i;
      if (!EMPTY.test(line)) length++;
    } else if (start !== -1) {
      close();
    }
  }
  if (start !== -1) close();
  return found;
}

const offenders = [];
for (const root of ROOTS) {
  let entries;
  try {
    entries = files(root);
  } catch {
    continue;
  }
  for (const file of entries) {
    const text = readFileSync(file, "utf8");
    const found = runs(text, HASH.test(file));
    const sqlRuns = found.filter((run) => run.sql).length;
    const debt = SQL_DEBT[file.split("\\").join("/")] ?? 0;
    for (const run of found) {
      if (run.sql && sqlRuns <= debt) continue;
      offenders.push(`${file}:${run.line} — ${run.length} lines`);
    }
  }
}

if (offenders.length > 0) {
  console.error(`${offenders.length} comments longer than ${LIMIT} lines:\n`);
  for (const line of offenders) console.error(`  ${line}`);
  process.exit(1);
}

console.log("comments: none longer than two lines");
