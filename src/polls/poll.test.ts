import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyVote, parsePoll, publicPoll, type StoredPoll } from "./poll";

const now = new Date("2026-10-13T12:00:00Z");
const base = () => parsePoll({ question: " What are we playing? ", options: ["Deep Rock", "Helldivers"] }, now) as StoredPoll;

describe("polls", () => {
  it("parses a poll and trims it", () => {
    const p = base();
    assert.equal(p.question, "What are we playing?");
    assert.deepEqual(p.options, ["Deep Rock", "Helldivers"]);
    assert.equal(p.ends_at, null);
  });

  it("refuses too few, too many, blank or repeated options", () => {
    assert.deepEqual(parsePoll({ question: "q", options: ["one"] }), { error: "poll_options" });
    assert.deepEqual(parsePoll({ question: "q", options: Array.from({ length: 11 }, (_, i) => `o${i}`) }), { error: "poll_options" });
    assert.deepEqual(parsePoll({ question: "q", options: ["a", " "] }), { error: "poll_options" });
    assert.deepEqual(parsePoll({ question: "q", options: ["A", "a"] }), { error: "poll_options_repeat" });
    assert.deepEqual(parsePoll({ question: "", options: ["a", "b"] }), { error: "poll_question" });
  });

  it("ends when it says, and refuses votes after", () => {
    const p = parsePoll({ question: "q", options: ["a", "b"], ends_in_seconds: 3600 }, now) as StoredPoll;
    assert.equal(p.ends_at, "2026-10-13T13:00:00.000Z");
    const later = new Date("2026-10-13T13:00:01Z");
    assert.deepEqual(applyVote(p, "u1", [0], later), { error: "poll_closed" });
    assert.equal(publicPoll(p, "u1", later).closed, true);
  });

  it("keeps one pick on a single-answer poll, and an empty pick takes the vote back", () => {
    let p = base();
    assert.deepEqual(applyVote(p, "u1", [0, 1], now), { error: "poll_choice" });
    p = applyVote(p, "u1", [1], now) as StoredPoll;
    p = applyVote(p, "u1", [0], now) as StoredPoll;
    assert.deepEqual(p.votes, { u1: [0] });
    p = applyVote(p, "u1", [], now) as StoredPoll;
    assert.deepEqual(p.votes, {});
  });

  it("only lets the chosen roles answer", () => {
    const p = parsePoll({ question: "q", options: ["a", "b"], allowed_roles: ["mod"] }, now) as StoredPoll;
    assert.deepEqual(applyVote(p, "u1", [0], now, ["member"]), { error: "poll_not_allowed" });
    assert.deepEqual((applyVote(p, "u1", [0], now, ["member", "mod"]) as StoredPoll).votes, { u1: [0] });
    assert.deepEqual(publicPoll(p).allowed_roles, ["mod"]);
  });

  it("shows voters only when it isn't anonymous, and always your own picks", () => {
    let p = base();
    p = applyVote(p, "u1", [0], now) as StoredPoll;
    p = applyVote(p, "u2", [0], now) as StoredPoll;
    const open = publicPoll(p, "u2", now);
    assert.deepEqual(open.options[0], { text: "Deep Rock", count: 2, voters: ["u1", "u2"] });
    assert.deepEqual(open.mine, [0]);
    const anon = publicPoll({ ...p, anonymous: true }, "u3", now);
    assert.equal(anon.options[0].voters, undefined);
    assert.equal(anon.options[0].count, 2);
    assert.deepEqual(anon.mine, []);
    assert.equal(anon.voter_count, 2);
  });
});
