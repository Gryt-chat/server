import { consola } from "consola";

import { rotateServerIdentity } from "../auth/serverIdentity";

function usage(): string {
  return [
    "Replace this server's identity key, leaving a signed statement that lets",
    "clients pinned to the old key follow the change instead of blocking.",
    "",
    "Usage:",
    "  node dist/admin/rotateIdentity.js --yes",
    "",
    "Rotation is deliberate and one-shot, so it is a command rather than an",
    "environment variable — a flag left set would rotate on every restart and",
    "burn through the succession chain.",
    "",
    "Restart the server afterwards so it serves the new key.",
    "",
    "Do NOT use this to recover from a suspected key compromise. The statement",
    "is signed by the key being retired, so whoever holds it can sign one too.",
    "In that case rotate, then have clients re-verify the new fingerprint by",
    "hand.",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }

  if (!args.includes("--yes")) {
    console.log(usage());
    consola.error("Refusing to rotate without --yes.");
    process.exit(1);
  }

  try {
    const { from, to } = await rotateServerIdentity();
    consola.success("Server identity rotated.");
    consola.info(`  was: ${from}`);
    consola.info(`  now: ${to}`);
    consola.info("Restart the server so it serves the new key.");
    consola.info(
      "Clients pinned to the old key will follow the change automatically for the next 180 days.",
    );
  } catch (err) {
    consola.error("Rotation failed:", err);
    process.exit(1);
  }
}

main();
