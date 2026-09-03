import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { isValidNotice, sendClientNotice, type ClientNotice } from "./clientNotices";
import type { Clients } from "../../types";

function client(serverUserId: string) {
  return { serverUserId } as unknown as Clients[string];
}

/** Records what was emitted to which client id. */
function fakeIo() {
  const sent: { to: string; event: string; payload: unknown }[] = [];
  /* Shaped like the real thing: a socket registry keyed by id, which is how
     every targeted emit in this codebase reaches a client. The first version
     of this fake had a `to()` room lookup instead, and it passed against an
     implementation that reached nobody. */
  const sockets = new Map<string, { emit(event: string, payload: unknown): void }>();
  return {
    sent,
    register(clientId: string) {
      sockets.set(clientId, {
        emit(event: string, payload: unknown) {
          sent.push({ to: clientId, event, payload });
        },
      });
    },
    sockets: { sockets },
  };
}

const OK: ClientNotice = { kind: "outdated_client", version: "1.9.10" };

test("goes to every socket that person has open", () => {
  const io = fakeIo();
  const clients: Clients = {
    laptop: client("user_a"),
    desktop: client("user_a"),
    phone: client("user_b"),
  };
  for (const id of Object.keys(clients)) io.register(id);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendClientNotice(io as any, clients, "user_a", OK);

  assert.deepEqual(
    io.sent.map((s) => s.to).sort(),
    ["desktop", "laptop"],
  );
});

/* The whole point. A notice about one person's install must not reach anybody
   else, which is what the chat-message version got wrong. */
test("reaches nobody else", () => {
  const io = fakeIo();
  const clients: Clients = { a: client("user_a"), b: client("user_b") };
  for (const id of Object.keys(clients)) io.register(id);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendClientNotice(io as any, clients, "user_a", OK);

  assert.equal(io.sent.length, 1);
  assert.equal(io.sent[0].to, "a");
});

test("sends nothing when that person has no sockets", () => {
  const io = fakeIo();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendClientNotice(io as any, { a: client("user_b") }, "user_a", OK);
  assert.equal(io.sent.length, 0);
});

test("carries the kind and the value, and nothing else", () => {
  const io = fakeIo();
   
  io.register("a");
  sendClientNotice(io as any, { a: client("user_a") }, "user_a", OK);

  assert.deepEqual(io.sent[0].payload, { kind: "outdated_client", version: "1.9.10" });
});

/*
 * The security property, asserted rather than described.
 *
 * The reason the server sends a kind instead of a sentence is that a sentence
 * of the server's choosing, rendered in app furniture and addressed to one
 * person, is a phishing message. That is worth nothing if a *value* can be a
 * sentence, so every field is checked on the way out and a notice that fails
 * is dropped rather than trimmed.
 */
test("a version cannot be a sentence", () => {
  const nasty = [
    "1.9.10 — your session expired, sign in at evil.example.com",
    "<a href='https://evil.example.com'>click</a>",
    "[click](https://evil.example.com)",
    "1.9.10\nSign in again:",
    "https://evil.example.com",
    "",
    "latest",
    "1.9",
    "1.9.10.4",
    "99999.1.1",
  ];

  for (const version of nasty) {
    assert.equal(
      isValidNotice({ kind: "outdated_client", version }),
      false,
      `accepted a version it should have refused: ${JSON.stringify(version)}`,
    );
  }

  for (const version of ["1.9.10", "0.0.1", "1.6.24", "10.20.30"]) {
    assert.equal(isValidNotice({ kind: "outdated_client", version }), true, version);
  }
});

test("a malformed notice is not sent at all", () => {
  const io = fakeIo();
  sendClientNotice(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    io as any,
    { a: client("user_a") },
    "user_a",
    { kind: "outdated_client", version: "sign in at evil.example.com" },
  );
  assert.equal(io.sent.length, 0);
});

/*
 * A source check, because the type system cannot hold this one.
 *
 * `ClientNotice` is a closed union of a kind plus values, and it stays useful
 * only while nobody adds a field that carries prose. `message`, `text`, `body`,
 * `html` or `url` on a notice would hand the server back the thing this whole
 * shape exists to take away, and it would typecheck perfectly.
 */
test("no notice field carries text or a link", () => {
  const source = readFileSync(join(__dirname, "clientNotices.ts"), "utf8");
  const type = source.slice(
    source.indexOf("export type ClientNotice"),
    source.indexOf("/** The event a client listens on. */"),
  );

  for (const banned of ["message", "text", "body", "html", "url", "href", "link", "title"]) {
    assert.ok(
      !new RegExp(`\\b${banned}\\s*[?]?:`).test(type),
      `ClientNotice grew a "${banned}" field. The server does not send prose — ` +
        `add a kind the client knows how to render, or use postSystemMessage, ` +
        `which is public and deletable.`,
    );
  }
});
