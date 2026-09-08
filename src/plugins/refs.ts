/**
 * Plugins load before the first connection, so everything needing `io` checks
 * rather than throwing at one that started a timer in `activate`.
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
