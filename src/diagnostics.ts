import type { Clients } from "./types";
import type { SFUClient } from "./sfu/client";

export interface DiagnosticsSnapshot {
  serverVersion: string;
  uptimeSeconds: number;
  online: number;
  sfu: ReturnType<SFUClient["getConnectionStatus"]> | null;
  /** Null when the SFU's metrics did not answer. */
  sfuMetrics: Record<string, number> | null;
  voice: {
    channelId: string;
    members: {
      nickname: string;
      muted: boolean;
      deafened: boolean;
      serverMuted: boolean;
      camera: boolean;
      screenShares: number;
      latency: NonNullable<Clients[string]["latencyStats"]> | null;
    }[];
  }[];
}

/** Only the `gryt_sfu_*` series: the Go runtime ones say nothing about voice. */
export function parseSfuMetrics(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = /^(gryt_sfu_[a-z0-9_]+)(?:\{[^}]*\})?\s+(\S+)/.exec(line);
    if (!m) continue;
    const value = Number(m[2]);
    if (Number.isFinite(value)) out[m[1]] = (out[m[1]] ?? 0) + value;
  }
  return out;
}

/** SFU_METRICS_URL, or the SFU's default metrics port on the host SFU_WS_HOST names. */
export function sfuMetricsUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.SFU_METRICS_URL) return env.SFU_METRICS_URL;
  try {
    const host = new URL(env.SFU_WS_HOST ?? "").hostname;
    return host ? `http://${host}:9091/metrics` : undefined;
  } catch {
    return undefined;
  }
}

async function readSfuMetrics(url: string | undefined): Promise<Record<string, number> | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok ? parseSfuMetrics(await res.text()) : null;
  } catch {
    return null;
  }
}

export async function collectDiagnostics(
  clientsInfo: Clients,
  sfuClient: SFUClient | null,
): Promise<DiagnosticsSnapshot> {
  const rooms = new Map<string, DiagnosticsSnapshot["voice"][number]["members"]>();
  let online = 0;
  for (const c of Object.values(clientsInfo)) {
    if (!c.serverUserId || c.serverUserId.startsWith("temp_")) continue;
    online++;
    if (!c.hasJoinedChannel || !c.voiceChannelId) continue;
    const members = rooms.get(c.voiceChannelId) ?? [];
    members.push({
      nickname: c.nickname,
      muted: c.isMuted,
      deafened: c.isDeafened,
      serverMuted: c.isServerMuted,
      camera: c.cameraEnabled,
      screenShares: c.screenShares?.length ?? (c.screenShareEnabled ? 1 : 0),
      latency: c.latencyStats ?? null,
    });
    rooms.set(c.voiceChannelId, members);
  }

  return {
    serverVersion: process.env.SERVER_VERSION || "0.0.0",
    uptimeSeconds: Math.round(process.uptime()),
    online,
    sfu: sfuClient?.getConnectionStatus() ?? null,
    sfuMetrics: await readSfuMetrics(sfuMetricsUrl()),
    voice: [...rooms].map(([channelId, members]) => ({ channelId, members })),
  };
}
