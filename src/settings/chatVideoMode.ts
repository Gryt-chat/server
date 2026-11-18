/* eslint-disable @typescript-eslint/no-restricted-types -- normalizes a database value or a client's patch */
/** How the image worker treats a video posted in chat. The worker reads the same column, with its own copy of this list. */
export type ChatVideoMode = "original" | "balanced" | "small";

export const CHAT_VIDEO_MODES: readonly ChatVideoMode[] = ["original", "balanced", "small"];

export function normalizeChatVideoMode(v: unknown): ChatVideoMode {
  return CHAT_VIDEO_MODES.includes(v as ChatVideoMode) ? (v as ChatVideoMode) : "original";
}
