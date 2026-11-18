/* eslint-disable @typescript-eslint/no-restricted-types -- validates a client's payload */
import type { HandlerContext, EventHandlerMap } from "./types";
import {
  biggestStorageConversations,
  getUserByServerId,
  listServerChannels,
  listStorageFiles,
  storageFileIds,
  usageNumbers,
  type StorageFileFilter,
  type StorageFileRow,
  type StorageKind,
  type StorageSort,
} from "../../db";
import { planStorageBytes } from "../../settings/storageLimit";
import { deleteStoredFiles } from "../../services/storageDelete";
import { socketMay } from "../utils/standing";

const MAX_DELETE = 500;
const SORTS: StorageSort[] = ["size", "date", "name", "uploader"];
const KINDS: StorageKind[] = ["video", "image", "other"];

function str(v: unknown, max = 200): string | undefined {
  return typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

function filterFrom(p: Record<string, unknown> | null | undefined): StorageFileFilter {
  const days = num(p?.olderThanDays);
  return {
    conversationId: str(p?.conversationId),
    kind: KINDS.includes(p?.kind as StorageKind) ? (p?.kind as StorageKind) : undefined,
    uploader: str(p?.uploader),
    q: str(p?.q, 100),
    olderThan: days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : undefined,
    minBytes: num(p?.minBytes),
  };
}

export function registerStorageHandlers(ctx: HandlerContext): EventHandlerMap {
  const { socket, clientId, clientsInfo } = ctx;

  async function allowed(): Promise<boolean> {
    if (await socketMay(clientsInfo, clientId, "manage_server")) return true;
    socket.emit("storage:error", { error: "forbidden", message: "You need Manage server to see this server's storage." });
    return false;
  }

  async function withPeople(rows: StorageFileRow[]) {
    const names = new Map((await listServerChannels()).map((c) => [c.channel_id, c.name]));
    const people = new Map<string, { nickname: string | null; avatar_file_id: string | null }>();
    for (const id of new Set(rows.map((r) => r.uploader).filter((u): u is string => !!u))) {
      const u = await getUserByServerId(id);
      people.set(id, { nickname: u?.nickname ?? null, avatar_file_id: u?.avatar_file_id ?? null });
    }
    return rows.map((r) => ({
      ...r,
      channel_name: names.get(r.conversation_id) ?? null,
      uploader_nickname: r.uploader ? people.get(r.uploader)?.nickname ?? null : null,
      uploader_avatar_file_id: r.uploader ? people.get(r.uploader)?.avatar_file_id ?? null : null,
    }));
  }

  return {
    "storage:overview": async () => {
      if (!(await allowed())) return;
      const usage = usageNumbers();
      const names = new Map((await listServerChannels()).map((c) => [c.channel_id, c.name]));
      const channels = biggestStorageConversations(5).map((c) => ({ ...c, channel_name: names.get(c.conversation_id) ?? null }));
      const files = await withPeople(listStorageFiles({}, "size", "desc", 5).items);
      socket.emit("storage:overview", {
        used: usage.storageBytes.total,
        byKind: usage.storageBytes.byKind,
        limit: planStorageBytes(),
        channels,
        files,
      });
    },

    "storage:files": async (p: Record<string, unknown> | null) => {
      if (!(await allowed())) return;
      const sort = SORTS.includes(p?.sort as StorageSort) ? (p?.sort as StorageSort) : "size";
      const dir = p?.dir === "asc" ? "asc" : "desc";
      const limit = Math.min(num(p?.limit) ?? 50, 200);
      const offset = typeof p?.offset === "number" && p.offset >= 0 ? Math.floor(p.offset) : 0;
      const page = listStorageFiles(filterFrom(p), sort, dir, limit, offset);
      socket.emit("storage:files", { ...page, items: await withPeople(page.items), offset, requestId: str(p?.requestId, 64) });
    },

    "storage:delete": async (p: { fileIds?: unknown } | null) => {
      if (!(await allowed())) return;
      const ids = Array.isArray(p?.fileIds) ? p.fileIds.filter((id): id is string => typeof id === "string").slice(0, MAX_DELETE) : [];
      socket.emit("storage:deleted", await deleteStoredFiles(ids));
    },

    /** Everything a filter matches. dryRun counts it first, so the dialog can say how much goes. */
    "storage:purge": async (p: Record<string, unknown> | null) => {
      if (!(await allowed())) return;
      const matches = storageFileIds(filterFrom(p));
      const bytes = matches.reduce((s, f) => s + f.size, 0);
      if (p?.dryRun === true) {
        socket.emit("storage:purge", { dryRun: true, count: matches.length, bytes });
        return;
      }
      const done = await deleteStoredFiles(matches.map((f) => f.file_id));
      socket.emit("storage:purge", { dryRun: false, count: done.deleted, bytes: done.bytes });
    },
  };
}
