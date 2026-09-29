import { readdir } from "node:fs/promises";

import consola from "consola";
import express from "express";
import type { NextFunction, Request, Response } from "express";

import { getDiscordImport, listDiscordImports, type DiscordImportRecord } from "../db";
import { importsDir, resolveImportFolder } from "../import/discord/exportFolder";
import { startDiscordImport } from "../import/discord/runner";
import { requireBearerToken } from "../middleware/requireBearerToken";
import { getEffectiveStanding } from "../services/permissions";

/** The owner only, never a permission: an import writes as other people, which no role should be handed. */
export async function requireOwner(req: Request, res: Response, next: NextFunction): Promise<void> {
  const serverUserId = req.tokenPayload?.serverUserId;
  if (!serverUserId) {
    res.status(401).json({ error: "auth_required" });
    return;
  }
  const standing = await getEffectiveStanding(serverUserId, req.tokenPayload?.grytUserId);
  if (!standing.isOwner) {
    res.status(403).json({ error: "forbidden", message: "Only the server's owner can import from Discord." });
    return;
  }
  next();
}

function view(r: DiscordImportRecord) {
  return {
    importId: r.import_id,
    folder: r.folder,
    status: r.status,
    progress: r.progress,
    warnings: r.warnings,
    error: r.error_message,
    createdAt: r.created_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

/** Express 4 drops a rejected handler on the floor, so each one hands its error on. */
const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

export const discordImportRouter = express.Router();

discordImportRouter.use(requireBearerToken);
discordImportRouter.use((req, res, next) => {
  requireOwner(req, res, next).catch(next);
});

/** What's in `DATA_DIR/imports`, so the owner can pick one without typing its name. */
discordImportRouter.get("/folders", handle(async (_req, res) => {
  const entries = await readdir(importsDir(), { withFileTypes: true }).catch(() => []);
  res.json({ folders: entries.filter((e) => e.isDirectory()).map((e) => e.name).sort() });
}));

discordImportRouter.get("/", handle(async (_req, res) => {
  res.json({ imports: (await listDiscordImports()).map(view) });
}));

discordImportRouter.get("/:importId", handle(async (req, res) => {
  const record = await getDiscordImport(String(req.params.importId));
  if (!record) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(view(record));
}));

discordImportRouter.post("/", handle(async (req, res) => {
  const folder = (req.body as { folder?: unknown } | undefined)?.folder;
  if (typeof folder !== "string" || !(await resolveImportFolder(folder))) {
    res.status(400).json({
      error: "invalid_folder",
      message: "Put the export in a folder under DATA_DIR/imports on the server, then pass that folder's name.",
    });
    return;
  }
  try {
    const record = await startDiscordImport(folder, req.tokenPayload!.serverUserId);
    res.status(202).json(view(record));
  } catch (err) {
    consola.error("discord import: start failed", err);
    res.status(500).json({ error: "import_failed", message: "The import couldn't be started." });
  }
}));
