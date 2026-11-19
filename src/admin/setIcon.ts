import { readFileSync } from "node:fs";

import { consola } from "consola";

import { createServerConfigIfNotExists, initSqlite } from "../db";
import { saveRasterServerIcon, type ServerIconResult } from "../services/serverIcon";
import { refreshWorkerCapabilities } from "../services/workerCapabilities";
import { initStorage, uploadsDisabled } from "../storage";
import { sniffMedia } from "../utils/sniffMedia";

const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp"]);

function usage(): string {
  return [
    "Set the server icon from a PNG, JPEG or WebP file, the same way the owner's upload does.",
    "",
    "Usage:",
    "  node dist/admin/setIcon.js --file /path/to/icon.png",
  ].join("\n");
}

/** The type comes from the file's first bytes, never from its name. */
export async function setIcon(body: Buffer): Promise<ServerIconResult> {
  const mime = sniffMedia(body);
  if (!mime || !ALLOWED.has(mime)) {
    return { ok: false, status: 400, error: "invalid_file", message: "Not a PNG, JPEG or WebP file" };
  }
  await createServerConfigIfNotExists();
  return saveRasterServerIcon(body, mime, "admin", null);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = args.indexOf("--file");
  const file = at >= 0 ? args[at + 1] : undefined;
  if (!file || args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    process.exit(file ? 0 : 2);
  }
  if (uploadsDisabled()) {
    consola.error("Uploads are turned off on this server, so it can't store an icon.");
    process.exit(1);
  }

  await initSqlite();
  initStorage();
  await refreshWorkerCapabilities();
  const result = await setIcon(readFileSync(file));
  if (!result.ok) {
    consola.error(result.message);
    process.exit(1);
  }
  consola.success("Icon updated", { key: result.key });
}

if (require.main === module) {
  main().catch((e: Error) => {
    consola.error("Failed to set the icon", e);
    process.exit(1);
  });
}
