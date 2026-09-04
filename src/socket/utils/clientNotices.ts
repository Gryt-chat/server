import consola from "consola";
import { Server } from "socket.io";

import type { Clients } from "../../types";

/**
 * Something the server needs one particular person to see. Not a chat message:
 * the reminder this replaces went through `postSystemMessage`, so a notice
 * naming one person was stored for good and shown to the whole channel.
 *
 * **The server sends a kind and some values. It never sends a sentence.** A
 * panel in app furniture carrying text the server chose is a phishing kit —
 * "Your Gryt session has expired, sign in at …". Sending no text makes it
 * impossible rather than harder.
 *
 * The cost is a client release for anything new to say. Anything bespoke
 * belongs in `postSystemMessage`, which is public and deletable.
 */
export type ClientNotice = {
  kind: "outdated_client";
  /** The version they are stuck on. See `isPlainVersion`. */
  version: string;
};

/** The event a client listens on. */
export const NOTICE_EVENT = "server:notice";

/**
 * `x.y.z` and nothing else.
 *
 * The point of sending values rather than sentences is lost if a value can be
 * a sentence. Every field on every kind gets a check this narrow, and a notice
 * that fails one is dropped rather than sent with the field removed — a
 * half-filled notice renders copy that does not match what happened.
 */
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

/**
 * Send a notice to one person, on every device they have open — the condition
 * is about their install rather than a connection.
 *
 * Nothing is stored. State rather than history: re-sent on the next join while
 * the condition holds, and stops when it does not.
 */
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

  /* `io.sockets.sockets.get(id)` rather than `io.to(id)`, which is what every
     other targeted emit here does. A client id is a socket id, and a socket
     does sit in a room of its own name — but reaching it through the socket is
     what the rest of this codebase does, and a room lookup that silently
     matches nothing is exactly the failure this had before it was measured. */
  for (const clientId of targets) {
    io.sockets.sockets.get(clientId)?.emit(NOTICE_EVENT, notice);
  }
}
