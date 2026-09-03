import consola from "consola";
import { Server } from "socket.io";

import type { Clients } from "../../types";

/**
 * Something the server needs one particular person to see.
 *
 * Not a chat message. The reminder this replaces was posted through
 * `postSystemMessage`, which writes a row into the messages table and
 * broadcasts it — so a notice addressed to one person by name was stored for
 * good and shown to everybody in the channel. The whole server learned that
 * somebody's Windows install was broken, and nobody could delete it.
 *
 * **The server sends a kind and some values. It never sends a sentence.**
 *
 * That is the whole security property. A panel rendered in app furniture,
 * carrying text the server chose, addressed to one person, is a phishing kit:
 * "Your Gryt session has expired, sign in at …". Attribution and link-stripping
 * would make that harder. Sending no text at all makes it impossible.
 *
 * The cost is a client release whenever there is something new to say. That is
 * accepted: there is one kind today, and anything genuinely bespoke belongs in
 * `postSystemMessage`, which is public, attributable and deletable — which is
 * the right shape for something a server wants to tell everybody.
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
 * Send a notice to one person, on every device they have open.
 *
 * Every socket, not just the one that triggered it: the condition is about
 * their install rather than about a connection, and somebody with the desktop
 * app on two machines should see it on the one that is broken. The client
 * decides what to do with a notice it has already dismissed.
 *
 * Nothing is stored. This is state rather than history — it is re-sent on the
 * next join while the condition holds, and simply stops when it does not.
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
