/*
 * Deletes the same message pasted into several channels inside a minute. An
 * example of the shape, not a policy — the numbers are guesses about a server.
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
  /* `${userId}\n${text}` -> { at, posts: [{ channelId, messageId }] }. Text
     rather than a hash of it: a minute's worth cannot be worth a collision. */
  const recent = new Map();

  /** userId -> when this plugin last swept them. */
  const swept = new Map();

  /* Called on every message, so it has to actually empty: a Map that only grows
     takes a server down three weeks after somebody installs it. */
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

      /* An ordinary answer, not a failure. Usually they are a moderator, whom
         no plugin may act on, and this line is how an operator finds out. */
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

    /* Nothing upstream sees what this throws, so the catch is here or nowhere.
       Ten throws and Gryt turns the plugin off. */
    void sweep(message.userId, message.nickname, entry.posts, now).catch((error) => {
      api.log.error(`sweep failed: ${error.message}`);
    });
  });

  api.log.info(`watching for the same message in ${CHANNELS} channels within a minute`);
}
