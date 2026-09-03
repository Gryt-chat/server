import { Server } from "socket.io";

import { sendClientNotice } from "./clientNotices";
import type { Clients } from "../../types";

/**
 * The first Windows build whose updater can install anything.
 *
 * v1.6.6 through v1.6.24 shipped a PowerShell update helper that failed to
 * parse, so those installs find every new release, download it, and install
 * none of them. Installing is the step that fails, so nothing published since
 * can reach them. The only way out is a person double-clicking an installer,
 * and the only way to ask is to tell the client, which renders the asking.
 */
const FIRST_WORKING_WINDOWS_UPDATER = "1.6.25";

/** One reminder per person per day. */
const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Kept in memory rather than in the database.
 *
 * A restart forgets who has been told, so a server restarted twice in a day
 * can remind the same person twice. That is the trade for not adding a table
 * and a migration for something nobody should still be seeing in a month. The
 * ceiling is one message per member per start, not a loop.
 */
const remindedAt = new Map<string, number>();

type DesktopClient = {
  platform: "win32" | "other";
  version: string;
};

/**
 * Read the desktop client out of Electron's default user agent, which Gryt
 * does not override:
 *
 *   Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like
 *   Gecko) gryt-chat/1.6.24 Chrome/144.0.7559.220 Electron/40.6.1 Safari/537.36
 *
 * The browser build carries neither the gryt-chat token nor the Electron one,
 * so it cannot match — which matters, because a browser user has nothing to
 * install and should never see this.
 */
export function parseDesktopClient(
  userAgent: string | undefined,
): DesktopClient | null {
  if (!userAgent || !userAgent.includes("Electron/")) return null;

  const version = /gryt-chat\/(\d+\.\d+\.\d+)/.exec(userAgent)?.[1];
  if (!version) return null;

  return {
    platform: userAgent.includes("Windows NT") ? "win32" : "other",
    version,
  };
}

/** True when `a` is older than `b`. Both are plain x.y.z. */
function isOlder(a: string, b: string): boolean {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);

  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i];
  }

  return false;
}

export function needsUpdateReminder(userAgent: string | undefined): boolean {
  const client = parseDesktopClient(userAgent);
  if (!client || client.platform !== "win32") return false;

  return isOlder(client.version, FIRST_WORKING_WINDOWS_UPDATER);
}

/**
 * Tell this person, and only this person, at most once a day.
 *
 * It used to be a chat message, which meant a notice naming one person was
 * stored for good and shown to the whole channel. It is a directed notice now:
 * their sockets only, nothing written down, and the words themselves live in
 * the client (GRYT-896).
 *
 * No nickname parameter any more. The client is rendering this to the person
 * it is about, so it can say "your client" — there is nobody else in the room
 * to disambiguate for.
 */
export function remindOutdatedWindowsClient(
  io: Server,
  clientsInfo: Clients,
  userAgent: string | undefined,
  serverUserId: string,
): void {
  if (!needsUpdateReminder(userAgent)) return;

  const version = parseDesktopClient(userAgent)?.version;
  if (!version) return;

  const now = Date.now();
  const last = remindedAt.get(serverUserId);

  if (last !== undefined && now - last < REMINDER_INTERVAL_MS) return;

  remindedAt.set(serverUserId, now);

  sendClientNotice(io, clientsInfo, serverUserId, { kind: "outdated_client", version });
}
