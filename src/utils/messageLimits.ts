/**
 * UTF-16 code units, so the composer's counter agrees. Wrong for storage, since
 * an emoji is two, but 4000 of them cannot exceed 16 kB of UTF-8.
 */
export const MESSAGE_MAX_LENGTH = 4000;

/** The refusal, in the shape `chat:error` already uses. */
export const MESSAGE_TOO_LONG = {
  error: "message_too_long",
  message: `Messages are limited to ${MESSAGE_MAX_LENGTH.toLocaleString("en")} characters.`,
} as const;

/** Not `MESSAGE_MAX_LENGTH`: an envelope is ciphertext plus a wrapped key per
    member, so it grows with the conversation. Capped so it is not storage. */
export const SEALED_MAX_LENGTH = 64 * 1024;
