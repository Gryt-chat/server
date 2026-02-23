import { Server, Socket } from "socket.io";
import { Clients } from "../../types";
import { SFUClient } from "../../sfu/client";

/**
 * Shared context passed to every handler module.
 * This avoids each handler needing direct access to closure variables.
 */
export interface HandlerContext {
  io: Server;
  socket: Socket;
  clientId: string;
  serverId: string;
  clientsInfo: Clients;
  sfuClient: SFUClient | null;
  getClientIp: () => string;
}

type SocketListener = Parameters<Socket["on"]>[1];
export type EventHandlerMap = Record<string, SocketListener>;
