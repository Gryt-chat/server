/*
 * Presence — the server half.
 *
 * Keeps a roster of who is playing what and sends it to everybody running the
 * client half. That is the whole job. The client half is in the client repo,
 * under examples/presence.
 *
 * What arrives on `playing` was written by somebody's client, so all of it is
 * checked before it goes anywhere near the roster. Gryt caps how big and how
 * deep a payload is and stops there — the shape is this plugin's to establish.
 */

/** Bump this if you change what the two halves say to each other. */
const PROTOCOL = 1;

/** A game name people will read, so it is kept to something that renders. */
const MAX_GAME = 80;

export function activate(api) {
  /*
   * userId -> { who, game }. In memory, so a restart empties it. That is fine:
   * every client says hello again when it reconnects, and a roster that
   * survived a restart would be a list of people who logged off during it.
   */
  const playing = new Map();

  function roster() {
    return [...playing.values()];
  }

  api.messaging.on("playing", (message) => {
    // Somebody else's bytes.
    if (message.data?.v !== PROTOCOL) return;

    const raw = message.data.game;
    const game = typeof raw === "string" ? raw.trim().slice(0, MAX_GAME) : "";

    /*
     * `nickname` and `userId` come off the connection, not out of the payload,
     * so nobody can put somebody else on the roster. Null nickname means they
     * never set one; the client half is showing this to people, so it gets a
     * word rather than the literal null.
     */
    const who = message.nickname ?? "Somebody";

    if (game) playing.set(message.userId, { who, game });
    else if (!playing.delete(message.userId)) return; // already not on it

    api.messaging.send("roster", roster());
  });

  /*
   * Somebody arriving needs the roster, and nobody else needs telling about
   * it, so this answers one member.
   *
   * `member:joined` would look like the event for this and is not. It fires
   * for a new member, not for the reconnects an existing one makes all day, so
   * a plugin leaning on it hands the roster to somebody's first evening and
   * never again. Let the client ask instead.
   */
  api.messaging.on("hello", (message) => {
    if (playing.size === 0) return;
    api.messaging.send("roster", roster(), [message.userId]);
  });

  // Gone means gone. Without this the roster keeps them until the server
  // restarts, and everybody watches them play something they quit hours ago.
  api.on("member:left", (member) => {
    if (!playing.delete(member.userId)) return;
    api.messaging.send("roster", roster());
  });

  api.log.info("presence ready");
}
