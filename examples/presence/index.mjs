/*
 * The server half; the client half is in the client repo. Gryt caps only a
 * payload's size and depth, so the shape is this plugin's to check.
 */

/** Bump this if you change what the two halves say to each other. */
const PROTOCOL = 1;

/** A game name people will read, so it is kept to something that renders. */
const MAX_GAME = 80;

export function activate(api) {
  /* userId -> { who, game }. In memory: every client says hello again on
     reconnect, and a surviving roster would list people who logged off. */
  const playing = new Map();

  function roster() {
    return [...playing.values()];
  }

  api.messaging.on("playing", (message) => {
    // Somebody else's bytes.
    if (message.data?.v !== PROTOCOL) return;

    const raw = message.data.game;
    const game = typeof raw === "string" ? raw.trim().slice(0, MAX_GAME) : "";

    /* Off the connection, not the payload, so nobody puts somebody else on the
       roster. A null nickname gets a word, since this is shown to people. */
    const who = message.nickname ?? "Somebody";

    if (game) playing.set(message.userId, { who, game });
    else if (!playing.delete(message.userId)) return; // already not on it

    api.messaging.send("roster", roster());
  });

  /* `member:joined` looks like the event for this and is not: it fires for a
     new member, not the reconnects an existing one makes all day. */
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
