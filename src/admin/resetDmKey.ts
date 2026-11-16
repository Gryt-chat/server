import { consola } from "consola";

import {
  getUserByGrytId,
  getUserByServerId,
  initSqlite,
  insertServerAudit,
  setUserDmKeyBinding,
  setUserPersonKeyBinding,
} from "../db";

function usage(): string {
  return [
    "Wipe one member's DM key here, for when no device of theirs holds it any more.",
    "Their next device to connect publishes its key, and their contacts see it change.",
    "",
    "Usage:",
    "  node admin-resetDmKey.js --grytUserId <user_sub> --yes",
    "  node admin-resetDmKey.js --serverUserId <id> --yes",
  ].join("\n");
}

/** Clears the DM key and the person key. */
export async function resetDmKey(serverUserId: string): Promise<boolean> {
  const user = await getUserByServerId(serverUserId);
  if (!user) return false;
  await setUserDmKeyBinding(serverUserId, null);
  await setUserPersonKeyBinding(serverUserId, null);
  return true;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const v = args[args.indexOf(flag) + 1];
    return args.includes(flag) && v && !v.startsWith("--") ? v.trim() : null;
  };
  const grytUserId = value("--grytUserId");
  const serverUserId = value("--serverUserId");
  const help = args.includes("--help") || args.includes("-h");

  if (help || (!grytUserId && !serverUserId)) {
    console.log(usage());
    process.exit(help ? 0 : 2);
  }

  await initSqlite();
  const user = grytUserId ? await getUserByGrytId(grytUserId) : await getUserByServerId(serverUserId ?? "");
  if (!user) {
    consola.error("No member with that id on this server.");
    process.exit(1);
  }
  if (!args.includes("--yes")) {
    consola.info(`Would wipe the DM key of ${user.nickname} (${user.server_user_id}). Run again with --yes.`);
    process.exit(1);
  }

  await resetDmKey(user.server_user_id);
  insertServerAudit({ actorServerUserId: null, action: "dm_key_reset", target: user.server_user_id })
    .catch((e) => consola.warn("audit log write failed", e));
  consola.success(`Wiped the DM key of ${user.nickname}. Their next device to connect publishes a new one.`);
}

if (require.main === module) {
  main().catch((e: unknown) => {
    consola.error("Failed to reset the DM key", e);
    process.exit(1);
  });
}
