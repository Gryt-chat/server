import assert from "node:assert/strict";
import { test } from "node:test";

import type { Clients } from "../types";
import { countVoiceUsers } from "./voiceUsers";

test("voice users: people in a voice channel, once each", () => {
  const c = (serverUserId: string | undefined, hasJoinedChannel: boolean) => ({ serverUserId, hasJoinedChannel }) as Partial<Clients[string]> as Clients[string];
  const clients: Clients = { a1: c("u-a", true), a2: c("u-a", true), b: c("u-b", false), d: c(undefined, true) };
  assert.equal(countVoiceUsers(clients), 2);
  assert.equal(countVoiceUsers({}), 0);
});
