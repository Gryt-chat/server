import consola from "consola";
import { v4 as uuidv4 } from "uuid";

import {
  createDiscordImport,
  getDiscordImport,
  listUnfinishedDiscordImports,
  updateDiscordImport,
  type DiscordImportRecord,
} from "../../db";
import { resetMessageCache } from "../../socket/utils/messageCache";
import { resolveImportFolder } from "./exportFolder";
import { importDiscordExport, type ImportMedia } from "./importer";

/** Progress is written at most this often, so a big import isn't mostly writing its own counters. */
const PROGRESS_EVERY_MS = 1000;

let draining: Promise<void> | null = null;
let media: ImportMedia | null = null;

/** One import at a time, oldest first. A run cut off by a restart is picked up by `resumeDiscordImports`. */
async function drain(): Promise<void> {
  for (;;) {
    const [next] = await listUnfinishedDiscordImports();
    if (!next || !media) return;
    await runOne(next, media);
  }
}

function kick(): void {
  if (draining) return;
  draining = drain()
    .catch((e) => consola.error("[DiscordImport] queue stopped", e))
    .finally(() => {
      draining = null;
    });
}

async function runOne(record: DiscordImportRecord, store: ImportMedia): Promise<void> {
  const root = await resolveImportFolder(record.folder);
  if (!root) {
    await updateDiscordImport(record.import_id, { status: "failed", error_message: "The export folder isn't there any more." });
    return;
  }
  await updateDiscordImport(record.import_id, { status: "running", error_message: null });
  consola.info(`[DiscordImport] ${record.import_id} started on "${record.folder}"`);

  let lastWrite = 0;
  try {
    const result = await importDiscordExport({
      root,
      startedBy: record.started_by_server_user_id,
      media: store,
      onProgress: async (progress, warnings) => {
        if (Date.now() - lastWrite < PROGRESS_EVERY_MS) return;
        lastWrite = Date.now();
        await updateDiscordImport(record.import_id, { progress, warnings });
      },
    });
    await updateDiscordImport(record.import_id, { status: "done", progress: result.progress, warnings: result.warnings });
    consola.info(`[DiscordImport] ${record.import_id} done: ${result.progress.messages_imported} messages`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    consola.error(`[DiscordImport] ${record.import_id} failed`, err);
    await updateDiscordImport(record.import_id, { status: "failed", error_message: message.slice(0, 500) });
  } finally {
    // Cached pages predate the import, and would hide it for their TTL.
    resetMessageCache();
  }
}

export async function startDiscordImport(folder: string, startedBy: string): Promise<DiscordImportRecord> {
  const record = await createDiscordImport({ import_id: uuidv4(), folder, started_by_server_user_id: startedBy });
  kick();
  return (await getDiscordImport(record.import_id)) ?? record;
}

/** At boot. Anything left `running` starts over, which is safe because every write skips what's there. */
export function resumeDiscordImports(store: ImportMedia): void {
  media = store;
  kick();
}
