import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { memberStateHash } from "./clients";

/**
 * A field `buildMemberList` carries and this does not reaches nobody: the list is
 * rebuilt correctly and thrown away, with nothing erroring.
 */

type Member = Parameters<typeof memberStateHash>[0][number];

function member(over: Partial<Member> = {}): Member {
  return {
    serverUserId: "user_1",
    nickname: "Alice",
    identityFingerprint: "fp_1",
    avatarFileId: null,
    avatarColor: null,
    avatarWorn: null,
    cardStyle: null,
    bio: null,
    pronouns: null,
    statusLine: null,
    dmKeyBinding: null,
    personKeyBinding: null,
    role: "member",
    isBot: false,
    status: "online",
    lastSeen: "2026-08-25T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
    nicknameChangeCount: 0,
    nicknameChangedAt: null,
    isMuted: false,
    isDeafened: false,
    isServerMuted: false,
    isServerDeafened: false,
    color: "#666666",
    isConnectedToVoice: false,
    hasJoinedChannel: false,
    voiceChannelId: "",
    streamID: "",
    ...over,
  } as Member;
}

describe("the member list dedupe", () => {
  it("lets an unchanged list dedupe", () => {
    assert.equal(memberStateHash([member()]), memberStateHash([member()]));
  });

  it("does not depend on the order members arrive in", () => {
    const a = member({ serverUserId: "user_a" });
    const b = member({ serverUserId: "user_b" });
    assert.equal(memberStateHash([a, b]), memberStateHash([b, a]));
  });

  const changes: Array<[string, Partial<Member>]> = [
    ["a rename", { nickname: "Alicia" }],
    ["a rename back to a previous name", { nicknameChangedAt: "2026-08-25T12:00:00.000Z" }],
    ["a replaced identity", { identityFingerprint: "fp_2" }],
    ["a new picture", { avatarFileId: "file_2" }],
    ["a computed avatar colour", { avatarColor: "#6cdac8" }],
    ["a designed owl", { avatarWorn: "aiac----adab" }],
    ["a new DM key", { dmKeyBinding: "a.b.c" }],
    ["a new person key", { personKeyBinding: "a.b.c" }],
    ["a role change", { role: "admin" }],
    ["going bot", { isBot: true }],
    ["going offline", { status: "offline" }],
    ["joining voice", { isConnectedToVoice: true }],
    ["joining a channel", { hasJoinedChannel: true }],
    ["moving channel", { voiceChannelId: "chan_2" }],
    ["muting", { isMuted: true }],
    ["deafening", { isDeafened: true }],
    ["a server mute", { isServerMuted: true }],
    ["a server deafen", { isServerDeafened: true }],
    ["a status", { activity: "Playing Factorio" }],
    ["a game's card", { richActivity: { type: "playing", name: "Factorio" } }],
    ["a card style", { cardStyle: { pattern: "dots" } }],
    ["a bio", { bio: "Plays bass badly" }],
    ["pronouns", { pronouns: "she/her" }],
    ["a status line", { statusLine: "back at six" }],
  ];

  for (const [what, over] of changes) {
    it(`sees ${what}`, () => {
      assert.notEqual(
        memberStateHash([member()]),
        memberStateHash([member(over)]),
        `${what} would be deduped away and reach nobody`,
      );
    });
  }

  it("clearing a designed owl is a change too", () => {
    // The value moves to null, and a hash noticing only a look appearing leaves
    // everybody looking at an owl somebody stopped wearing.
    assert.notEqual(
      memberStateHash([member({ avatarWorn: "aiac----adab" })]),
      memberStateHash([member({ avatarWorn: null })]),
    );
  });

  it("sees a card style change inside the object", () => {
    // Only a colour moves, so a hash comparing by reference or by key would miss it.
    assert.notEqual(
      memberStateHash([member({ cardStyle: { fill: "solid", c1: "#111111" } })]),
      memberStateHash([member({ cardStyle: { fill: "solid", c1: "#222222" } })]),
    );
  });

  it("sees the card change while the status line stays put", () => {
    const at = (state: string) =>
      member({ activity: "Factorio", richActivity: { type: "playing", name: "Factorio", state } });
    assert.notEqual(memberStateHash([at("Nauvis")]), memberStateHash([at("Vulcanus")]));
  });

  it("ignores a moving lastSeen", () => {
    // Deliberately out. It changes on every heartbeat, so including it would
    // defeat the dedupe entirely and broadcast the whole list on a timer.
    assert.equal(
      memberStateHash([member({ lastSeen: "2026-08-25T00:00:00.000Z" })]),
      memberStateHash([member({ lastSeen: "2026-08-25T23:59:59.000Z" })]),
    );
  });
});
