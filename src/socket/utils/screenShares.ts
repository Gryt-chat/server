/** Ceiling on windows one client can announce, matching the SFU's `maxScreenShares`. */
export const MAX_SCREEN_SHARES = 8;
const MAX_ID_LENGTH = 128;

export interface ScreenShare {
  videoStreamID: string;
  audioStreamID: string;
}

const id = (v: unknown): string | null => (typeof v === "string" && v.length <= MAX_ID_LENGTH ? v : null);

/**
 * The windows a `voice:screen:state` announces. `shares` from an app that shares several,
 * otherwise the single pair older apps send. Anything malformed is dropped, not trusted.
 */
export function screenSharesFrom(payload: unknown): ScreenShare[] {
  if (typeof payload !== "object" || payload === null) return [];
  const p = payload as { shares?: unknown; videoStreamId?: unknown; audioStreamId?: unknown };
  const raw = Array.isArray(p.shares) ? p.shares : [{ videoStreamId: p.videoStreamId, audioStreamId: p.audioStreamId }];
  const out: ScreenShare[] = [];
  for (const entry of raw.slice(0, MAX_SCREEN_SHARES)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { videoStreamId?: unknown; audioStreamId?: unknown };
    const video = id(e.videoStreamId);
    if (!video) continue;
    out.push({ videoStreamID: video, audioStreamID: id(e.audioStreamId) ?? "" });
  }
  return out;
}
