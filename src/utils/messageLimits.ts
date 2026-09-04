/**
 * How long a message is allowed to be. The webhook route has refused anything
 * longer since it was written; `chat:send` and `chat:edit` did not check at
 * all, which made messages the only unbounded free-text field on the server.
 *
 * Counted in UTF-16 code units, so the composer's own counter agrees. Wrong for
 * storage — an emoji is two — but 4000 of them cannot exceed 16 kB of UTF-8.
 *
 * A constant rather than a `server_config` column: per-server means a
 * migration, a settings field and a client control for a number almost nobody
 * moves. Copy the shape of `upload_max_bytes` if that turns out to be wrong.
 */
export const MESSAGE_MAX_LENGTH = 4000;

/** The refusal, in the shape `chat:error` already uses. */
export const MESSAGE_TOO_LONG = {
  error: "message_too_long",
  message: `Messages are limited to ${MESSAGE_MAX_LENGTH.toLocaleString("en")} characters.`,
} as const;

/**
 * How large a sealed envelope may be (GRYT-729).
 *
 * Not `MESSAGE_MAX_LENGTH`. An envelope is a body of ciphertext plus one
 * wrapped key for every member, base64url, so it is several times the message
 * inside it and grows with the conversation — comparing it against the limit
 * for plain text would refuse ordinary messages in a large group.
 *
 * A cap at all because nothing on this server reads the column, and an
 * unbounded field nobody parses is a place to park data.
 */
export const SEALED_MAX_LENGTH = 64 * 1024;
