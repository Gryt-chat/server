import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * A leak here is a correct answer written where it should not be, so this reads
 * the source. Coarse on purpose: the fix is to wrap it in `addressLabel`.
 */
/* `__dirname` rather than `import.meta`: this file is compiled as CommonJS. */
const SOURCES = join(__dirname, "..");

/** The two functions that answer "who is calling", either spelling. */
const RESOLVERS = /(getClientIp|requestIp)\s*\(/;

function everyTsFile(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...everyTsFile(path));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      found.push(path);
    }
  }
  return found;
}

describe("addresses in the log", () => {
  it("are labelled, everywhere one is logged at all", () => {
    const offenders: string[] = [];

    for (const file of everyTsFile(SOURCES)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!/consola\.(info|warn|error|log|debug|success)/.test(line)) return;
        if (!RESOLVERS.test(line)) return;
        if (line.includes("addressLabel(")) return;
        offenders.push(`${file.replace(SOURCES, "")}:${index + 1}  ${line.trim()}`);
      });
    }

    assert.deepEqual(
      offenders,
      [],
      `a caller's address is being written to the log:\n${offenders.join("\n")}\n\n` +
        "Wrap it in addressLabel() — the log still tells two callers apart, and " +
        "stops being personal data.",
    );
  });
});
