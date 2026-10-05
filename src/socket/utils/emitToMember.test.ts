import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Server } from "socket.io";

import type { Clients } from "../../types";
import { emitToMember, setSocketRefs } from "./server";

/* GRYT-1667: a refused avatar is told to the person who uploaded it, on every socket they have open, and nobody else. */
describe("emitToMember", () => {
  it("reaches each of that member's sockets and no one else's", () => {
    const got: string[] = [];
    const socket = (id: string) => ({ emit: (event: string, payload: unknown) => got.push(`${id} ${event} ${JSON.stringify(payload)}`) });
    const sockets = new Map([["a1", socket("a1")], ["a2", socket("a2")], ["b1", socket("b1")]]);
    const io = { sockets: { sockets } } as unknown as Server;
    const clients = { a1: { serverUserId: "alice" }, a2: { serverUserId: "alice" }, b1: { serverUserId: "bob" } } as unknown as Clients;
    setSocketRefs(io, "srv", clients);

    emitToMember("alice", "profile:media-refused", { purpose: "avatar" });
    assert.deepEqual(got.sort(), [
      'a1 profile:media-refused {"purpose":"avatar"}',
      'a2 profile:media-refused {"purpose":"avatar"}',
    ]);
  });
});
