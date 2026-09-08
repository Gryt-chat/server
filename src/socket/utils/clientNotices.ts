import consola from "consola";
import { Server } from "socket.io";

import type { Clients } from "../../types";

/**
 * A kind and some values, never a sentence: app furniture carrying text the
 * server chose is a phishing kit. Bespoke text goes in `postSystemMessage`.
 */
export type ClientNotice = {
  kind: "outdated_client";
  /** The version they are stuck on. See `isPlainVersion`. */
  version: string;
};

/** The event a client listens on. */
export const NOTICE_EVENT = "server:notice";

/** Sending values rather than sentences is lost if a value can be a sentence.
    A notice failing this is dropped, not sent with the field removed. */
function isPlainVersion(value: string): boolean {
  return /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value);
}

/** Whether this is a notice the client will know what to do with. */
export function isValidNotice(notice: ClientNotice): boolean {
  switch (notice.kind) {
    case "outdated_client":
      return isPlainVersion(notice.version);
    default:
      return false;
  }
}

/** Every device they have open, because the condition is about their install.
    Nothing is stored: re-sent on the next join while it holds. */
export function sendClientNotice(
  io: Server,
  clientsInfo: Clients,
  serverUserId: string,
  notice: ClientNotice,
): void {
  if (!isValidNotice(notice)) {
    consola.warn(`[notice] Refusing to send a malformed ${notice.kind} notice`);
    return;
  }

  const targets = Object.entries(clientsInfo)
    .filter(([, ci]) => ci.serverUserId === serverUserId)
    .map(([clientId]) => clientId);

  /* Through the socket rather than `io.to(id)`, like the rest of this codebase.
     A room lookup that matches nothing fails silently. */
  for (const clientId of targets) {
    io.sockets.sockets.get(clientId)?.emit(NOTICE_EVENT, notice);
  }
}
