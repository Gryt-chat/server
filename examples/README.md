# Server plugin examples

Two plugins you can copy and change. Both run. Neither is a moderation policy
you should adopt as it stands: the numbers in them are guesses about a server
that isn't yours.

| | What it does | Asks for |
| --- | --- | --- |
| [`crosspost-guard`](crosspost-guard) | Deletes the same message when it lands in three channels inside a minute, and bans whoever does it twice | `messages:read`, `moderation` |
| [`presence`](presence) | Keeps a roster of who is playing what, for clients running the other half | `messaging`, `members:read` |

`presence` is half of a pair. The client half is in the client repo, under
[`examples/presence`](https://github.com/Gryt-chat/client/tree/main/examples/presence).
It works on its own too — you just won't see anybody but yourself.

## Running one

Plugins are off unless you point the server at a folder:

```bash
GRYT_PLUGINS_DIR=/srv/gryt/plugins yarn start
```

There's no default path on purpose. A server upgrade should never start running
whatever happens to be in a directory you'd forgotten about.

Copy a folder in, restart, and the log says what loaded:

```
ℹ plugin crosspost-guard 1.0.0 started (messages:read, moderation)
```

If a folder is skipped, the line says which field is wrong. A plugin that
throws ten times gets turned off and says so.

## What you're agreeing to

A plugin runs inside the server process, with the database, the filesystem and
the network. The capability list is what the plugin said it wanted, so you can
read it before you run anything and the log has an answer to "what is this
server running" afterwards. It doesn't hold the plugin to any of it.

Everybody who joins is told which plugins you run and what each one may do. You
can't turn that off. A plugin reading people's messages is something the people
sending them get to know about.

Installing one is trusting whoever wrote it with the whole server.

## Writing your own

[Server plugins](https://docs.gryt.chat/docs/server/plugins) covers the API.
[Plugin pairs](https://docs.gryt.chat/docs/guide/plugin-pairs) covers the two
halves and the pipe between them.
