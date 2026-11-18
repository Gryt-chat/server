/* eslint-disable @typescript-eslint/no-restricted-types -- normalizes a database value, an env var or a management patch */
/** A Gryt Cloud plan's video ceiling. None on a self-hosted server. */
export interface VideoCeiling {
  maxHeight: number;
  maxFps: number;
  /** What the SFU holds a video track to: the bitrate for this ceiling, with headroom. */
  maxKbps: number;
}

/** The same 30 fps bitrates `@gryt/voice` encodes at, so the SFU's cap matches what clients send. */
const BASE_BPS_30FPS: Record<number, number> = {
  2160: 20_000_000, 1440: 12_000_000, 1080: 6_000_000, 720: 3_000_000, 480: 1_500_000, 360: 800_000,
};
const MAX_BPS = 50_000_000;
const HEADROOM = 1.25;

/** "1080p60" or "720p30". Anything else is no ceiling. */
export function parseVideoCeiling(raw: unknown): VideoCeiling | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{3,4})p(\d{2,3})$/.exec(raw.trim().toLowerCase());
  if (!m) return null;
  const maxHeight = Number(m[1]);
  const maxFps = Number(m[2]);
  const base = BASE_BPS_30FPS[maxHeight];
  if (!base || maxFps < 1 || maxFps > 240) return null;
  const bps = Math.min(base * Math.pow(maxFps / 30, 0.7), MAX_BPS);
  return { maxHeight, maxFps, maxKbps: Math.round((bps * HEADROOM) / 1000) };
}

/** The value set through management wins over GRYT_PLAN_VIDEO_MAX, so a host can lower it live. */
export function effectiveVideoCeiling(stored: string | null | undefined): VideoCeiling | null {
  return parseVideoCeiling(stored) ?? parseVideoCeiling(process.env.GRYT_PLAN_VIDEO_MAX);
}

/** The SFU reads this from the token. An SFU that doesn't know it ignores it. */
export function videoCeilingCapability(ceiling: VideoCeiling | null): string | null {
  return ceiling ? `video_max_kbps:${ceiling.maxKbps}` : null;
}
