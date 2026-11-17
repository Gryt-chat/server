import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";

import { v4 as uuidv4 } from "uuid";

import type { AssetSource } from "../import/discord/rows";

const DISCORD_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

/** Only Discord's own CDN, so a crafted embed can't make the server fetch anything else. */
export function isDiscordCdn(ref: string): boolean {
  try {
    const u = new URL(ref);
    return u.protocol === "https:" && DISCORD_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** Downloads into `dir`, keeping the extension: the upload path reads the type from it.
    `maxBytes` caps each file; the upload path checks the server's own limit again. */
export function discordCdnAssets(dir: string, maxBytes: number): AssetSource & { cleanup(): Promise<void> } {
  const done = new Map<string, string | null>();
  return {
    missingNote: "couldn't be downloaded from Discord",
    async resolve(ref: string | null | undefined) {
      if (!ref || !isDiscordCdn(ref)) return null;
      const key = ref.split("?")[0];
      if (done.has(key)) {
        const path = done.get(key);
        return path ? { path, key } : null;
      }
      let path: string | null = join(dir, `${uuidv4()}${extname(new URL(key).pathname).slice(0, 10)}`);
      try {
        await mkdir(dir, { recursive: true });
        const res = await fetch(ref, { redirect: "error" });
        const size = Number(res.headers.get("content-length") ?? 0);
        if (!res.ok || !res.body || size > maxBytes) throw new Error(`status ${res.status}, ${size} bytes`);
        let seen = 0;
        const cap = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            seen += chunk.length;
            cb(seen > maxBytes ? new Error("over the size limit") : null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(res.body as ReadableStream), cap, createWriteStream(path));
      } catch {
        await rm(path, { force: true });
        path = null;
      }
      done.set(key, path);
      return path ? { path, key } : null;
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
