import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { consola } from "consola";

import { uploadsFolder } from "../storage";

const MANIFEST = "gryt-export.json";
const DB_FILES = ["gryt.db", "gryt.db-wal", "gryt.db-shm"];

interface Manifest {
  format: 1;
  createdAt: string;
  serverVersion: string;
  uploadsFolder: string;
}

function usage(): string {
  return [
    "Move a whole server: database, identity key and uploads, in one file.",
    "",
    "Usage:",
    "  node dist/admin/archive.js export --out server.tar.gz",
    "  node dist/admin/archive.js import --in server.tar.gz",
    "",
    "Export works while the server runs. Import goes into an empty DATA_DIR,",
    "with the server stopped. The identity key comes along, so members keep",
    "trusting the server at its new address. That also means whoever holds",
    "the file can be this server, so keep it as safe as DATA_DIR itself.",
  ].join("\n");
}

function dataDir(): string {
  return resolve(process.env.DATA_DIR || "./data");
}

/** Everything in DATA_DIR, with the database taken as one consistent copy even while it's in use. */
export function exportServer(dir: string, out: string, serverVersion = process.env.SERVER_VERSION || "unknown"): void {
  const db = join(dir, "gryt.db");
  if (!existsSync(db)) throw new Error(`No database at ${db}`);

  const stage = mkdtempSync(join(tmpdir(), "gryt-export-"));
  try {
    // VACUUM INTO reads one snapshot, so a write landing meanwhile can't half-appear.
    const live = new DatabaseSync(db);
    try {
      live.prepare("VACUUM INTO ?").run(join(stage, "gryt.db"));
    } finally {
      live.close();
    }
    const manifest: Manifest = { format: 1, createdAt: new Date().toISOString(), serverVersion, uploadsFolder: uploadsFolder() };
    writeFileSync(join(stage, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);

    const rest = readdirSync(dir).filter((name) => !DB_FILES.includes(name));
    execFileSync("tar", ["-czf", resolve(out), "-C", stage, "gryt.db", MANIFEST, ...(rest.length ? ["-C", dir, ...rest] : [])]);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Unpacks an export into an empty DATA_DIR, renaming the uploads folder to the one this server reads. */
export function importServer(dir: string, archive: string): Manifest {
  if (!existsSync(archive)) throw new Error(`No file at ${archive}`);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`${dir} is not empty. Import only into a fresh DATA_DIR, so nothing is overwritten.`);
  }

  mkdirSync(dir, { recursive: true });
  execFileSync("tar", ["-xzf", resolve(archive), "-C", dir]);

  const manifestPath = join(dir, MANIFEST);
  if (!existsSync(manifestPath) || !existsSync(join(dir, "gryt.db"))) {
    throw new Error("That file isn't a Gryt server export.");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  rmSync(manifestPath);

  const here = uploadsFolder();
  if (manifest.uploadsFolder !== here && existsSync(join(dir, manifest.uploadsFolder)) && !existsSync(join(dir, here))) {
    renameSync(join(dir, manifest.uploadsFolder), join(dir, here));
  }
  return manifest;
}

function argValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  const v = i >= 0 ? args[i + 1] : undefined;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    process.exit(command ? 0 : 2);
  }

  try {
    if (command === "export") {
      const out = argValue(args, "--out");
      if (!out) throw new Error("export needs --out <file>");
      exportServer(dataDir(), out);
      consola.success(`Exported ${dataDir()} to ${resolve(out)}`);
    } else if (command === "import") {
      const archive = argValue(args, "--in");
      if (!archive) throw new Error("import needs --in <file>");
      const manifest = importServer(dataDir(), archive);
      consola.success(`Imported a server exported ${manifest.createdAt} (version ${manifest.serverVersion}) into ${dataDir()}`);
    } else {
      throw new Error(`Unknown command "${command}". Use export or import.`);
    }
  } catch (e) {
    consola.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

if (require.main === module) main();
