import { Server } from "socket.io";

import type { Clients } from "../../types";
import { postSystemMessage } from "./systemMessages";

/**
 * The first Windows build whose updater can install anything.
 *
 * v1.6.6 through v1.6.24 shipped a PowerShell update helper that failed to
 * parse, so those installs find every new release, download it, and install
 * none of them. Nothing published can reach them, because the broken helper is
 * the thing that would have to run the fix. The only way out is a person
 * double-clicking an installer, and the only way to ask is a message in a
 * channel their client already knows how to render.
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

export function formatUpdateReminder(
  nickname: string,
  serverUserId: string,
  version: string,
): string {
  return [
    `[@${nickname}](mention:${serverUserId}) — your Windows client (v${version}) cannot update itself.`,
    "",
    "It has been downloading every new release and installing none of them, and it cannot fix that on its own — the part that is broken is the part that would install the fix.",
    "",
    `**The installer is probably already on your machine.** Close Gryt, open \`%LOCALAPPDATA%\\gryt-chat-updater\\pending\`, and look for \`Gryt-Chat-${FIRST_WORKING_WINDOWS_UPDATER}-win-x64.exe\` or newer. Run it and you are done — updates work on their own again afterwards, and your settings and servers are untouched.`,
    "",
    `**Check the version in the filename first.** Anything below ${FIRST_WORKING_WINDOWS_UPDATER} carries the same broken updater, so installing it puts you right back here while looking like it worked. If the file in that folder is older, or the folder is empty, download the current one instead: https://github.com/Gryt-chat/gryt/releases/latest`,
    "",
    "Full instructions: https://docs.gryt.chat/docs/client/updates",
  ].join("\n");
}

/**
 * Post the reminder, at most once a day per member.
 *
 * Failures are swallowed by postSystemMessage. A reminder that does not arrive
 * is not worth failing a join over.
 */
export async function remindOutdatedWindowsClient(
  io: Server,
  clientsInfo: Clients,
  userAgent: string | undefined,
  nickname: string,
  serverUserId: string,
): Promise<void> {
  if (!needsUpdateReminder(userAgent)) return;

  const now = Date.now();
  const last = remindedAt.get(serverUserId);

  if (last !== undefined && now - last < REMINDER_INTERVAL_MS) return;

  remindedAt.set(serverUserId, now);

  const version = parseDesktopClient(userAgent)?.version ?? "unknown";

  await postSystemMessage(
    io,
    clientsInfo,
    formatUpdateReminder(nickname, serverUserId, version),
  );
}
