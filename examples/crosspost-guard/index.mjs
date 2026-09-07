/*
 * Crosspost guard — a server plugin with no client half.
 *
 * Catches the one spam pattern that is easy to be sure about: the same message,
 * pasted into several channels inside a minute. A person answering a question
 * in two places writes it differently the second time. A script does not.
 *
 * What it does when it is sure: deletes the copies. Deleting is the answer to
 * most of this — the post is the problem, and the person may well be somebody
 * whose account got taken. Whoever does it twice in an hour gets a day off.
 *
 * Read this before running it. It is an example of the shape, not a moderation
 * policy, and the numbers below are guesses about a server that is not yours.
 */

/** How many channels the same text has to reach before this is spam. */
const CHANNELS = 3;

/** ...within this long. */
const WINDOW_MS = 60_000;

/** A second sweep inside this long is what earns a ban. */
const REPEAT_MS = 60 * 60_000;

/** How long the ban lasts. Omit `durationMs` entirely for a permanent one. */
const BAN_MS = 24 * 60 * 60_000;

/** Short messages are not evidence of anything. "ok" lands everywhere. */
const MIN_LENGTH = 12;

export function activate(api) {
  /*
   * `${userId}\n${text}` -> { at, posts: [{ channelId, messageId }] }
   *
   * Keyed on the pair, so two people saying the same thing are two entries and
   * one person saying two things is as well. Text is the key rather than a
   * hash of it: this map is pruned to a minute, and hashing would buy nothing
   * but a way to be wrong about collisions.
   */
  const recent = new Map();

  /** userId -> when this plugin last swept them. */
  const swept = new Map();

  /*
   * Called on every message, so it has to stay cheap and it has to actually
   * empty. A Map that only grows is how a plugin takes a server down three
   * weeks after somebody installs it.
   */
  function prune(now) {
    for (const [key, entry] of recent) {
      if (now - entry.at > WINDOW_MS) recent.delete(key);
    }
    for (const [userId, at] of swept) {
      if (now - at > REPEAT_MS) swept.delete(userId);
    }
  }

  async function sweep(userId, nickname, posts, now) {
    const who = nickname ?? userId;

    for (const post of posts) {
      const outcome = await api.moderation.deleteMessage(post.channelId, post.messageId);

      /*
       * A refusal here is an ordinary answer, not a failure. The usual one is
       * that they are a moderator — Gryt will not let a plugin act on somebody
       * who can moderate, whatever the plugin thinks — and the log line is how
       * an operator finds out this ran and chose not to.
       */
      if (!outcome.ok) {
        api.log.warn(`left ${who}'s message in ${post.channelId} alone: ${outcome.reason}`);
        return;
      }
    }

    api.log.info(`deleted ${posts.length} copies of the same message from ${who}`);

    const last = swept.get(userId);
    swept.set(userId, now);

    // First time is a bad afternoon. Second time inside an hour is a script.
    if (last === undefined) return;

    const outcome = await api.moderation.ban(userId, {
      reason: "Posted the same message across several channels twice in an hour",
      durationMs: BAN_MS,
    });

    if (outcome.ok) api.log.info(`banned ${who} for a day`);
    else api.log.warn(`did not ban ${who}: ${outcome.reason}`);
  }

  api.on("message:created", (message) => {
    const text = message.text.trim();
    if (text.length < MIN_LENGTH) return;

    const now = Date.now();
    prune(now);

    const key = `${message.userId}\n${text}`;
    const entry = recent.get(key) ?? { at: now, posts: [] };
    entry.at = now;

    // The same message edited or resent in one channel is not crossposting.
    if (entry.posts.some((post) => post.channelId === message.channelId)) return;

    entry.posts.push({ channelId: message.channelId, messageId: message.messageId });
    recent.set(key, entry);

    if (entry.posts.length < CHANNELS) return;

    // Take it out of the map before doing anything slow, so the next message
    // in does not start a second sweep over the same posts.
    recent.delete(key);

    /*
     * `message:created` does not wait for this and nothing upstream sees what
     * it throws, so the catch is here or it is nowhere. Ten throws and Gryt
     * turns the plugin off, which is the right outcome but a confusing one to
     * debug from a server log with nothing in it.
     */
    void sweep(message.userId, message.nickname, entry.posts, now).catch((error) => {
      api.log.error(`sweep failed: ${error.message}`);
    });
  });

  api.log.info(`watching for the same message in ${CHANNELS} channels within a minute`);
}
