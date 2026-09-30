import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { artUrls, readArtList } from "./gameArt";

const CS2 = "1158877933042143272";

describe("the game art list", () => {
  it("keeps only a numeric Steam id", () => {
    const list = readArtList([
      { id: CS2, cover_hash: "694f0b895f21566723671fa6219c1001", steam: "730" },
      { id: "1", cover_hash: "694f0b895f21566723671fa6219c1001", steam: "730/../x" },
      { id: "nope", cover_hash: "694f0b895f21566723671fa6219c1001" },
    ]);
    assert.deepEqual([...list.keys()], [CS2]);
  });

  it("reads games.json's { games: [...] }", () => {
    assert.deepEqual([...readArtList({ version: 1, games: [{ id: CS2, name: "Counter-Strike 2", steam: "730" }] }).keys()], [CS2]);
  });

  it("is empty for anything that isn't a list", () => {
    assert.equal(readArtList({ id: CS2 }).size, 0);
    assert.equal(readArtList(null).size, 0);
  });
});

describe("where the art comes from", () => {
  it("is Steam's header and nothing from Discord", () => {
    assert.deepEqual(artUrls({ steam: "730" }), ["https://cdn.cloudflare.steamstatic.com/steam/apps/730/header.jpg"]);
    assert.deepEqual(artUrls({}), []);
  });
});
