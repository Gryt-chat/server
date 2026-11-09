import express from "express";
import type { NextFunction, Request, Response } from "express";
import { rm } from "fs/promises";
import { join } from "path";

import { getServerConfig } from "../db";
import { requireBearerToken } from "../middleware/requireBearerToken";
import { deleteObject, getObjectAsBuffer, putObject, STORAGE_DISABLED, uploadsDisabled } from "../storage";

/* Message history for a device being linked (GRYT-2055). The old device leaves sealed chunks
   here, the new one (same identity, so the same user) reads them back. The server can't open them. */

const MiB = 1024 * 1024;
const BUCKET = "link-history";

export const LINK_HISTORY_LIMITS = {
  /** A 2 MiB chunk plus its AES-GCM tag and framing. */
  chunkBytes: 2 * MiB + 4096,
  userBytes: 256 * MiB,
  transfersPerUser: 2,
  slots: 4096,
  ttlMs: 60 * 60 * 1000,
};

const TRANSFER_ID = /^[A-Za-z0-9_-]{22,64}$/;

export type LinkHistoryError = "not_found" | "too_large" | "too_many" | "bad_request";

interface Transfer {
  owner: string;
  slots: Map<number, number>;
  bytes: number;
  expiresAt: number;
}

export interface ChunkFiles {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  del(key: string): Promise<void>;
}

/** Who may touch which transfer, and how much each user holds. The files live in `files`. */
export function createLinkHistoryStore(files: ChunkFiles, limits = LINK_HISTORY_LIMITS, now = () => Date.now()) {
  const transfers = new Map<string, Transfer>();

  async function drop(id: string) {
    const t = transfers.get(id);
    if (!t) return;
    transfers.delete(id);
    await Promise.all([...t.slots.keys()].map((n) => files.del(`${id}/${n}`).catch(() => undefined)));
  }

  async function sweep() {
    const at = now();
    await Promise.all([...transfers].filter(([, t]) => t.expiresAt <= at).map(([id]) => drop(id)));
  }

  /** Someone else's transfer looks the same as none at all. */
  function own(id: string, owner: string): Transfer | null {
    const t = transfers.get(id);
    return t && t.owner === owner ? t : null;
  }

  const held = (owner: string) => [...transfers.values()].filter((t) => t.owner === owner);

  return {
    async put(owner: string, id: string, n: number, body: Buffer): Promise<LinkHistoryError | null> {
      if (!TRANSFER_ID.test(id) || !Number.isInteger(n) || n < 0 || n >= limits.slots) return "bad_request";
      if (body.length === 0 || body.length > limits.chunkBytes) return "too_large";
      await sweep();
      if (transfers.has(id) && !own(id, owner)) return "not_found";
      let t = own(id, owner);
      if (!t && held(owner).length >= limits.transfersPerUser) return "too_many";
      const previous = t?.slots.get(n) ?? 0;
      const total = held(owner).reduce((sum, x) => sum + x.bytes, 0) - previous + body.length;
      if (total > limits.userBytes) return "too_large";
      if (!t) {
        t = { owner, slots: new Map(), bytes: 0, expiresAt: now() + limits.ttlMs };
        transfers.set(id, t);
      }
      await files.put(`${id}/${n}`, body);
      t.slots.set(n, body.length);
      t.bytes += body.length - previous;
      return null;
    },

    async get(owner: string, id: string, n: number): Promise<Buffer | null> {
      await sweep();
      const t = own(id, owner);
      if (!t || !t.slots.has(n)) return null;
      return files.get(`${id}/${n}`);
    },

    /** The new device drops each chunk once it has it, so the disk empties as it goes. */
    async removeChunk(owner: string, id: string, n: number): Promise<boolean> {
      const t = own(id, owner);
      const size = t?.slots.get(n);
      if (!t || size === undefined) return false;
      t.slots.delete(n);
      t.bytes -= size;
      await files.del(`${id}/${n}`).catch(() => undefined);
      return true;
    },

    async remove(owner: string, id: string): Promise<boolean> {
      if (!own(id, owner)) return false;
      await drop(id);
      return true;
    },
  };
}

const store = createLinkHistoryStore({
  put: (key, body) => putObject({ bucket: BUCKET, key, body, contentType: "application/octet-stream" }),
  get: (key) => getObjectAsBuffer({ bucket: BUCKET, key }),
  del: (key) => deleteObject({ bucket: BUCKET, key }),
});

/** Every transfer is lost on a restart, so whatever is on disk from before is too. */
export async function clearLinkHistoryOnStart(): Promise<void> {
  await rm(join(process.env.DATA_DIR || "./data", BUCKET), { recursive: true, force: true });
}

const STATUS: Record<LinkHistoryError, number> = { not_found: 404, too_large: 413, too_many: 429, bad_request: 400 };

function slot(req: Request) {
  return { id: String(req.params.transfer), n: Number(req.params.n) };
}

/** Set by requireBearerToken, which runs first. */
const userOf = (req: Request) => req.tokenPayload?.serverUserId ?? "";

export const linkHistoryRouter = express.Router();

linkHistoryRouter.use(requireBearerToken);

linkHistoryRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (!userOf(req)) return void res.status(401).json({ error: "auth_required" });
  if (uploadsDisabled()) return void res.status(503).json(STORAGE_DISABLED);
  getServerConfig()
    .then((cfg) => (cfg?.link_history_enabled === false ? res.status(403).json({ error: "link_history_off" }) : next()))
    .catch(next);
});

linkHistoryRouter.put(
  "/:transfer/:n",
  express.raw({ type: "application/octet-stream", limit: LINK_HISTORY_LIMITS.chunkBytes }),
  (req: Request, res: Response, next: NextFunction) => {
    const { id, n } = slot(req);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    store
      .put(userOf(req), id, n, body)
      .then((error) => (error ? res.status(STATUS[error]).json({ error }) : res.status(204).end()))
      .catch(next);
  },
);

linkHistoryRouter.get("/:transfer/:n", (req: Request, res: Response, next: NextFunction) => {
  const { id, n } = slot(req);
  store
    .get(userOf(req), id, n)
    .then((body) => (body ? res.type("application/octet-stream").send(body) : res.status(404).json({ error: "not_found" })))
    .catch(next);
});

linkHistoryRouter.delete("/:transfer/:n", (req: Request, res: Response, next: NextFunction) => {
  const { id, n } = slot(req);
  store
    .removeChunk(userOf(req), id, n)
    .then((ok) => res.status(ok ? 204 : 404).end())
    .catch(next);
});

linkHistoryRouter.delete("/:transfer", (req: Request, res: Response, next: NextFunction) => {
  store
    .remove(userOf(req), String(req.params.transfer))
    .then((ok) => res.status(ok ? 204 : 404).end())
    .catch(next);
});
