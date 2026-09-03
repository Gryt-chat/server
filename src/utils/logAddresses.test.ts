import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * No client's address reaches a log line.
 *
 * A unit test cannot catch this: the leak is not a wrong answer, it is a
 * correct answer written somewhere it should not be, and the fifth place
 * somebody adds it will look exactly like the four that were here. Two of those
 * four wrote an address on every connect and every disconnect, and the task
 * that found the other two said the rate limiter was the only one.
 *
 * So this reads the source. It is coarse — it asks whether a logging call
 * mentions the two functions that resolve a caller's address — and coarse is
 * the point: the fix is to wrap it in `addressLabel`, which the check accepts,
 * and anything else has to argue with a test.
 *
 * The server's *own* interface addresses are a different thing and not matched
 * here: `reachableAddresses` prints where the operator's machine can be
 * reached, which is the operator's own information and the reason it is
 * printed.
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
