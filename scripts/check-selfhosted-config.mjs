// The self-hosted bundles run the SFU straight on the host, so their config.env has to keep
// registration and metrics on 127.0.0.1. Takes a path to check a built bundle's copy instead.

import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "dist-selfhosted/config.env";

// Last assignment wins, and a quoted value keeps its #, as in node --env-file and godotenv.
function parse(text) {
  const values = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const quoted = /^(["'`])(.*)\1$/.exec(match[2]);
    values.set(match[1], quoted ? quoted[2] : match[2].replace(/\s+#.*$/, "").trim());
  }
  return values;
}

const values = parse(readFileSync(file, "utf8"));
const problems = [];

const expected = [
  ["SFU_CONTROL_HOST", "127.0.0.1", "anyone on the network can register a server with the SFU"],
  ["SFU_METRICS_HOST", "127.0.0.1", "the SFU serves its metrics to the whole network"],
  ["METRICS_PORT", "0", "the server serves its own metrics on every address"],
];

for (const [name, want, otherwise] of expected) {
  const got = values.get(name);
  if (got !== want) {
    problems.push(`${name} is ${got === undefined ? "not set" : `"${got}"`}, not ${want}, so ${otherwise}`);
  }
}

// Registration only listens on loopback now, so a server dialling any other host can't reach it.
const wsHost = values.get("SFU_WS_HOST");
let dials;
try {
  dials = new URL(wsHost).hostname;
} catch {
  dials = undefined;
}
if (dials !== "127.0.0.1") {
  problems.push(`SFU_WS_HOST is ${wsHost === undefined ? "not set" : `"${wsHost}"`}, so the server won't dial 127.0.0.1, the only address the SFU takes registration on`);
}

if (problems.length > 0) {
  console.error(`${file} would open the SFU to the network:\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`selfhosted config: ${file} keeps SFU registration and metrics on 127.0.0.1, and the server's metrics off`);
