import type { HandlerContext, EventHandlerMap } from "./types";

export function registerVoiceLatencyHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, clientId, clientsInfo } = ctx;

  return {
    "voice:latency:report": (payload: {
      estimatedOneWayMs: number | null;
      networkRttMs: number | null;
      jitterMs: number | null;
      codec: string | null;
      bitrateKbps: number | null;
    }) => {
      if (!payload || typeof payload !== "object") return;
      const client = clientsInfo[clientId];
      if (!client || !client.hasJoinedChannel) return;

      client.latencyStats = {
        estimatedOneWayMs:
          typeof payload.estimatedOneWayMs === "number"
            ? Math.round(payload.estimatedOneWayMs * 10) / 10
            : null,
        networkRttMs:
          typeof payload.networkRttMs === "number"
            ? Math.round(payload.networkRttMs * 10) / 10
            : null,
        jitterMs:
          typeof payload.jitterMs === "number"
            ? Math.round(payload.jitterMs * 10) / 10
            : null,
        codec: typeof payload.codec === "string" ? payload.codec : null,
        bitrateKbps:
          typeof payload.bitrateKbps === "number"
            ? Math.round(payload.bitrateKbps * 10) / 10
            : null,
      };

      const update = {
        clientId,
        latency: client.latencyStats,
      };

      const senderChannelId = client.voiceChannelId;
      for (const [sid] of io.sockets.sockets) {
        if (sid === clientId) continue;
        const peer = clientsInfo[sid];
        if (peer?.hasJoinedChannel && peer.voiceChannelId === senderChannelId) {
          io.sockets.sockets.get(sid)?.emit("voice:latency:update", update);
        }
      }
    },
  };
}
