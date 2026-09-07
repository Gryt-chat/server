# Crosspost guard

Catches the one spam pattern that's easy to be sure about: the same message,
pasted into several channels inside a minute. Somebody answering a question in
two places writes it differently the second time. A script posts the same bytes.

It deletes the copies. Whoever does it twice in an hour gets a day off.

## Run it

```bash
cp -r crosspost-guard /srv/gryt/plugins/
GRYT_PLUGINS_DIR=/srv/gryt/plugins yarn start
```

The log says it's there:

```
ℹ plugin crosspost-guard 1.0.0 started (messages:read, moderation)
ℹ [crosspost-guard] watching for the same message in 3 channels within a minute
```

Then it's quiet until something happens:

```
ℹ [crosspost-guard] deleted 3 copies of the same message from mira
ℹ [crosspost-guard] banned mira for a day
```

## The numbers

They're at the top of `index.mjs`, and they're guesses about a server that isn't
yours. Three channels in a minute is safe on a server with fifteen channels and
wrong on one with four.

| | | |
| --- | --- | --- |
| `CHANNELS` | 3 | how many channels before it's spam |
| `WINDOW_MS` | 60s | how close together |
| `REPEAT_MS` | 1h | a second sweep this soon earns a ban |
| `BAN_MS` | 24h | drop `durationMs` for a permanent one |
| `MIN_LENGTH` | 12 | shorter than this proves nothing — "ok" lands everywhere |

## What it won't touch

Anybody who can moderate. Gryt refuses a plugin acting on somebody holding
kick, ban, mute, manage messages or manage roles, whatever the plugin asks for,
and the refusal comes back as an ordinary answer rather than an error. This one
logs it and leaves the rest of the messages alone:

```
⚠ [crosspost-guard] left sam's message in general alone: that member is a moderator here (manage_messages)
```

Direct messages are out of reach as well. `message:created` never carries one,
and `deleteMessage` only works on channels.

## Things to change before you trust it

**Deleting is not the only answer.** `api.moderation` also has `kick` and
`ban`. Deleting is the proportionate one for most of this — the post is the
problem, and the account may be somebody's that got taken.

**The map has to empty.** `prune` runs on every message and drops anything past
the window. If you widen the window, check what that does to memory on a busy
server. A Map that only grows is how a plugin takes a server down three weeks
after somebody installs it.

**Twenty actions a minute.** Gryt caps what a plugin does to people. Past that,
calls come back refused with a reason. A sweep here is three deletes and
sometimes a ban, so it takes a while to get there — but a rewrite that acts on
every message will find it.
