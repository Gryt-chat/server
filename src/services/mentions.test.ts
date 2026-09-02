import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findMentions } from "./mentions";

/**
 * The cases that matter are the ones where the server could disagree with the
 * client about what a mention is. A name the client draws as a mention but the
 * server does not store is a highlighted word that reached nobody, which looks
 * like it worked and did not.
 */
const MEMBERS = [
  { serverUserId: "u_ada", nickname: "Ada" },
  { serverUserId: "u_adalovelace", nickname: "Ada Lovelace" },
  { serverUserId: "u_tor", nickname: "tor" },
  { serverUserId: "u_mia", nickname: "Mia" },
];

describe("findMentions", () => {
  it("finds a plain one", () => {
    assert.deepEqual(findMentions("hey @Ada can you look", MEMBERS), ["u_ada"]);
  });

  it("does not care about case", () => {
    assert.deepEqual(findMentions("@ADA and @TOR", MEMBERS), ["u_ada", "u_tor"]);
  });

  it("keeps the order they were named in", () => {
    assert.deepEqual(findMentions("@Mia then @Ada", MEMBERS), ["u_mia", "u_ada"]);
  });

  it("counts somebody named twice once", () => {
    assert.deepEqual(findMentions("@Ada @Ada @Ada", MEMBERS), ["u_ada"]);
  });

  it("prefers the longer name at the same place", () => {
    // Both members match at index 0. "Ada Lovelace" is the one meant.
    assert.deepEqual(findMentions("@Ada Lovelace hello", MEMBERS), ["u_adalovelace"]);
  });

  it("leaves an email alone", () => {
    // The word character before the @ is the whole test: without it every
    // address in a message mentions somebody.
    assert.deepEqual(findMentions("write to ada@Ada.example", MEMBERS), []);
  });

  it("does not match a name that is only a prefix", () => {
    assert.deepEqual(findMentions("@Adams is someone else", MEMBERS), []);
  });

  it("matches up against punctuation", () => {
    // Punctuation is not a word character, so this is a mention — and it is by
    // far the most common way one is written.
    assert.deepEqual(findMentions("thanks @Ada!", MEMBERS), ["u_ada"]);
    assert.deepEqual(findMentions("(@Mia)", MEMBERS), ["u_mia"]);
  });

  it("finds one at the very end", () => {
    assert.deepEqual(findMentions("over to @tor", MEMBERS), ["u_tor"]);
  });

  it("says nothing about text with no mentions", () => {
    assert.deepEqual(findMentions("no names here at all", MEMBERS), []);
    assert.deepEqual(findMentions("", MEMBERS), []);
  });

  it("says nothing when there is nobody to mention", () => {
    assert.deepEqual(findMentions("@Ada", []), []);
  });

  it("survives a member with an empty nickname", () => {
    // The server does not promise every row has one, and `@` followed by
    // nothing would otherwise match at every position and never advance.
    const members = [...MEMBERS, { serverUserId: "u_blank", nickname: "" }];
    assert.deepEqual(findMentions("@Ada and @", members), ["u_ada"]);
  });

  it("does not loop forever on a name made of punctuation", () => {
    const members = [{ serverUserId: "u_odd", nickname: "!!" }];
    assert.deepEqual(findMentions("@!! @!!", members), ["u_odd"]);
  });
});
