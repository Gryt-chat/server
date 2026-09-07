# Presence — the server half

Keeps a list of who's playing what and sends it to everybody running the client
half. That's the whole job.

The other half is in the client repo, under
[`examples/presence`](https://github.com/Gryt-chat/client/tree/main/examples/presence).
Both have to be installed, the same way a Minecraft mod has to be on the server
and on your machine. Nobody is turned away for missing it — they just don't see
the roster.

## Run it

```bash
cp -r presence /srv/gryt/plugins/
GRYT_PLUGINS_DIR=/srv/gryt/plugins yarn start
```

```
ℹ plugin presence 1.0.0 started (messaging, members:read)
ℹ [presence] presence ready
```

Everybody who joins now sees `presence` in the server menu, under **What this
server runs**, along with the fact that it reads who joins and leaves. That's
not optional and there's no flag for it.

## What the two halves say

Three topics, and they're this plugin's invention. Gryt carries `{ topic, data }`
and stays out of the rest.

| Topic | Direction | Data |
| --- | --- | --- |
| `hello` | client → server | `{ v: 1 }` — I just got here, what's the roster |
| `playing` | client → server | `{ v: 1, game: "Factorio" }`, or `game: null` to come off |
| `roster` | server → clients | `[{ who, game }, …]` |

The client has to ask, because a reconnect gives the server no event to answer.
`member:joined` looks like that event and isn't: it fires for a new member, not
for the reconnects an existing one makes all day. A plugin leaning on it hands
out the roster on somebody's first evening and never again.

## Where the names come from

`message.userId` and `message.nickname` come off the connection, not out of the
payload. Nobody can put somebody else on the roster by sending a name.

Everything in `message.data` is a stranger's bytes. Gryt caps the size, the
depth and the rate, and nothing else — the shape is yours. This one checks the
protocol number, checks the game is a string, and cuts it to 80 characters
before it goes in front of anybody.

## What it doesn't survive

A restart empties the roster, which is fine: every client says hello again when
it reconnects. Keeping it would leave you with a list of people who logged off
during the restart.

## What the client half can't do

Read what you're actually playing. A client plugin runs in a worker with no
view of your processes, so the game name has to come from somewhere outside —
the client half ships a small HTTP source you can run, and the client repo's
README says why.
