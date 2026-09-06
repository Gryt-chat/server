/**
 * The socket layer's handles, for the parts of the plugin API that need them
 * (GRYT-939).
 *
 * Plugins load at startup, before the first connection, so their API object
 * exists before there is an `io` to send anything through. Everything that
 * needs one checks, and answers "the server is not accepting connections yet"
 * rather than throwing at a plugin that started a timer in `activate`.
 *
 * Set the same way `setSocketRefs` sets its own for REST-triggered broadcasts.
 * Lifted out of `actions.ts` when messaging needed the same two handles —
 * moderation and messaging reaching for separate copies of `io` would be two
 * answers to which socket server this is.
 */

import type { Server } from "socket.io";

import type { SFUClient } from "../sfu/client";
import type { Clients } from "../types";

export interface PluginRefs {
  io: Server;
  serverId: string;
  clientsInfo: Clients;
  sfuClient: SFUClient | null;
}

let refs: PluginRefs | null = null;

export function setPluginRefs(next: PluginRefs): void {
  refs = next;
}

/** Null until the socket layer is up. Every caller has to handle that. */
export function pluginRefs(): PluginRefs | null {
  return refs;
}

/** For tests, which must not inherit a previous case's refs. */
export function clearPluginRefs(): void {
  refs = null;
}
