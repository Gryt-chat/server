import type { HandlerContext, EventHandlerMap } from "./types";
import { syncAllClients, broadcastMemberList } from "../utils/clients";

export function registerDiagnosticsHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, serverId, clientsInfo } = ctx;

  return {
    "diagnostics:ping": (payload: { t0: number }) => {
      const t0 = payload?.t0;
      if (typeof t0 !== "number") return;
      socket.emit("diagnostics:pong", { t0, serverNow: Date.now() });
    },

    "presence:heartbeat": () => {
      const client = clientsInfo[clientId];
      if (!client || client.serverUserId.startsWith("temp_")) {
        socket.emit("presence:stale");
        return;
      }
      syncAllClients(io, clientsInfo);
      broadcastMemberList(io, clientsInfo, serverId);
    },
  };
}

