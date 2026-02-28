import { consola } from "consola";

import {
  demoteAllOwnerRoles,
  ensureOwnerRoleForGrytUser,
  getServerConfig,
  initSqlite,
  insertServerAudit,
  setServerOwner,
} from "../db";

function usage(): string {
  return [
    "Usage:",
    "  node dist/admin/setOwner.js --grytUserId <user_sub>",
    "",
    "Example:",
    "  node dist/admin/setOwner.js --grytUserId 00000000-0000-0000-0000-000000000000",
  ].join("\n");
}

function parseArgs(argv: string[]): { grytUserId: string } | { error: string } {
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") return { error: "" };
    if (a === "--grytUserId") {
      const v = args[i + 1];
      if (typeof v !== "string" || v.trim().length === 0) return { error: "--grytUserId is required" };
      return { grytUserId: v.trim() };
    }
  }
  return { error: "--grytUserId is required" };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  if ("error" in parsed) {
    if (parsed.error) consola.error(parsed.error);
    process.stdout.write(`${usage()}\n`);
    process.exit(parsed.error ? 2 : 0);
  }

  const nextOwner = parsed.grytUserId;

  await initSqlite();
  const prev = (await getServerConfig())?.owner_gryt_user_id ?? null;

  await setServerOwner(nextOwner);
  const demoted = await demoteAllOwnerRoles();
  const ensured = await ensureOwnerRoleForGrytUser(nextOwner);

  insertServerAudit({
    actorServerUserId: null,
    action: "owner_set",
    target: nextOwner,
    meta: { from: prev, to: nextOwner, demotedOwners: demoted.demoted, ensuredOwnerRole: ensured.applied },
  }).catch((e) => consola.warn("audit log write failed", e));

  consola.success("Owner updated", {
    from: prev,
    to: nextOwner,
    demotedOwners: demoted.demoted,
    ensuredOwnerRole: ensured.applied,
    ensuredServerUserId: ensured.serverUserId,
  });
}

main().catch((e: unknown) => {
  consola.error("Failed to set owner", e);
  process.exit(1);
});
