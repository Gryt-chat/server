import type { HandlerContext, EventHandlerMap } from "./types";

export function registerDiagnosticsHandlers(ctx: HandlerContext): EventHandlerMap {
  const { socket } = ctx;

  return {
    "diagnostics:ping": (payload: { t0: number }) => {
      const t0 = payload?.t0;
      if (typeof t0 !== "number") return;
      socket.emit("diagnostics:pong", { t0, serverNow: Date.now() });
    },
  };
}

