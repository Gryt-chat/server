import { consola } from "consola";

import {
  demoteAllOwnerRoles,
  ensureOwnerRoleForGrytUser,
  getScyllaClient,
  getServerConfig,
  initScylla,
  insertServerAudit,
  setServerOwner,
} from "../db/scylla";

function usage(): string {
  return [
    "Usage:",
    "  node dist/admin/setOwner.js --grytUserId <keycloak_sub>",
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

  const disableScylla = (process.env.DISABLE_SCYLLA || "").toLowerCase() === "true";
  if (disableScylla) {
    consola.error("ScyllaDB is disabled (DISABLE_SCYLLA=true). Cannot set owner.");
    process.exit(2);
  }

  const scyllaContactPoints = (process.env.SCYLLA_CONTACT_POINTS || "").trim();
  if (!scyllaContactPoints) {
    consola.error("SCYLLA_CONTACT_POINTS is missing. Cannot set owner.");
    process.exit(2);
  }

  const nextOwner = parsed.grytUserId;

  await initScylla();
  const prev = (await getServerConfig())?.owner_gryt_user_id ?? null;

  await setServerOwner(nextOwner);
  const demoted = await demoteAllOwnerRoles();
  const ensured = await ensureOwnerRoleForGrytUser(nextOwner);

  insertServerAudit({
    actorServerUserId: null,
    action: "owner_set",
    target: nextOwner,
    meta: { from: prev, to: nextOwner, demotedOwners: demoted.demoted, ensuredOwnerRole: ensured.applied },
  }).catch(() => undefined);

  consola.success("Owner updated", {
    from: prev,
    to: nextOwner,
    demotedOwners: demoted.demoted,
    ensuredOwnerRole: ensured.applied,
    ensuredServerUserId: ensured.serverUserId,
  });

  await getScyllaClient().shutdown().catch(() => undefined);
}

main().catch((e: unknown) => {
  consola.error("Failed to set owner", e);
  process.exit(1);
});

