/**
 * How long a message is allowed to be.
 *
 * Four thousand characters, which is not a new number — the webhook route has
 * refused anything longer since it was written. What is new is that the two
 * doors a person can post through, `chat:send` and `chat:edit`, did not check
 * at all. A message went in trimmed and non-empty and otherwise unbounded,
 * into SQLite and back out to every connected client.
 *
 * That made messages the only unbounded free-text field on the server. The
 * server description caps at 300, a channel description at 200, an invite note
 * at 200, a webhook's metadata at 4000.
 *
 * Counted in UTF-16 code units, because that is what `String.length` is and
 * what the composer's own counter will agree with. It is the wrong unit for
 * anything to do with storage — an emoji is two, and a Norwegian å is one but
 * two bytes — and the right one for "does the number on screen match the number
 * the server used". Storage is bounded by this either way: 4000 code units
 * cannot exceed 16 kB of UTF-8.
 *
 * A constant rather than a column on `server_config`, deliberately. Making it
 * per-server means a migration, a settings field and a client control, all in
 * a review-required path, for a number almost nobody will want to move. The
 * shape to copy is `upload_max_bytes` if that turns out to be wrong.
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
