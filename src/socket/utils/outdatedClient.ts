import { Server } from "socket.io";

import { sendClientNotice } from "./clientNotices";
import type { Clients } from "../../types";

/** 1.6.6 through 1.6.24 shipped a PowerShell helper that failed to parse, so
    those installs download every release and install none. */
const FIRST_WORKING_WINDOWS_UPDATER = "1.6.25";

/** One reminder per person per day. */
const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** A restart forgets who was told, which is the trade for not adding a table.
    The ceiling is one message per member per start, not a loop. */
const remindedAt = new Map<string, number>();

type DesktopClient = {
  platform: "win32" | "other";
  version: string;
};

/** Out of Electron's default user agent, which Gryt does not override. The
    browser build carries neither token, so it cannot match. */
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

/** Their sockets only, at most once a day, nothing written down, and the words
    live in the client. */
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
