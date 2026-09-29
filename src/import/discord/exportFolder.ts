import { open, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, posix, relative, sep } from "node:path";

/** Past this a folder is not an export, and walking it would hold the job for no reason. */
export const MAX_EXPORT_FILES = 1_000_000;

/** Every regular file under the root, by path relative to it. Symlinks are never followed. */
export interface ExportFolder {
  root: string;
  files: Map<string, string>;
  byName: Map<string, string[]>;
}

const FOLDER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;

export function importsDir(): string {
  return join(process.env.DATA_DIR || "./data", "imports");
}

/** A folder name under `DATA_DIR/imports`, never a path: no slashes and no `..`. */
export async function resolveImportFolder(name: string): Promise<string | null> {
  if (typeof name !== "string" || !FOLDER_NAME_RE.test(name) || name.includes("..")) return null;
  let base: string;
  let full: string;
  try {
    base = await realpath(importsDir());
    full = await realpath(join(base, name));
  } catch {
    return null;
  }
  if (!full.startsWith(base + sep)) return null;
  const info = await stat(full).catch(() => null);
  return info?.isDirectory() ? full : null;
}

export async function indexExportFolder(root: string): Promise<ExportFolder> {
  const files = new Map<string, string>();
  const byName = new Map<string, string[]>();
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile()) {
        const rel = relative(root, full).split(sep).join("/");
        files.set(rel, full);
        const list = byName.get(entry.name) ?? [];
        list.push(full);
        byName.set(entry.name, list);
        if (files.size > MAX_EXPORT_FILES) throw new Error(`The export has over ${MAX_EXPORT_FILES} files.`);
      }
    }
  }
  return { root, files, byName };
}

/**
 * The local file a DCE path points at, or null. Paths come from the JSON and are
 * untrusted, so only files found by the walk can come back.
 */
export function resolveExportAsset(folder: ExportFolder, jsonDir: string, ref: string | null | undefined): string | null {
  if (typeof ref !== "string" || !ref || ref.length > 4096) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return null;
  const clean = ref.replace(/\\/g, "/");

  const isAbsolute = clean.startsWith("/") || /^[A-Za-z]:\//.test(clean);
  if (!isAbsolute) {
    const joined = posix.normalize(posix.join(jsonDir, clean));
    const hit = folder.files.get(joined);
    if (hit) return hit;
  }

  // DCE writes an absolute path when --media-dir is outside the output folder,
  // and its file names carry a hash of the URL, so the name alone finds it.
  const found = folder.byName.get(basename(clean));
  return found && found.length > 0 ? found[0] : null;
}

/** DCE writes `guild` and `channel` before `messages`, so the start of the file is enough to plan with. */
export async function readExportHead(path: string, maxBytes = 1024 * 1024): Promise<unknown | null> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8").replace(/^\uFEFF/, "");
    const match = /\n\s*"messages"\s*:\s*\[/.exec(text);
    const head = match ? text.slice(0, match.index).replace(/,\s*$/, "") + "}" : text;
    try {
      return JSON.parse(head);
    } catch {
      return null;
    }
  } finally {
    await handle.close();
  }
}
