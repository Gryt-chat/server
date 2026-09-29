import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { artUrls, readArtList } from "./gameArt";

const CS2 = "1158877933042143272";

describe("the game art list", () => {
  it("keeps only a hash-shaped cover and a numeric Steam id", () => {
    const list = readArtList([
      { id: CS2, cover_hash: "694f0b895f21566723671fa6219c1001", steam: "730" },
      { id: "1", cover_hash: "../../etc/passwd", steam: "730/../x" },
      { id: "nope", cover_hash: "694f0b895f21566723671fa6219c1001" },
    ]);
    assert.deepEqual([...list.keys()], [CS2]);
  });

  it("is empty for anything that isn't a list", () => {
    assert.equal(readArtList({ id: CS2 }).size, 0);
    assert.equal(readArtList(null).size, 0);
  });
});

describe("where the art comes from", () => {
  it("asks Steam for its header first, then Discord for the cover", () => {
    assert.deepEqual(artUrls(CS2, { cover: "694f0b895f21566723671fa6219c1001", steam: "730" }), [
      "https://cdn.cloudflare.steamstatic.com/steam/apps/730/header.jpg",
      `https://cdn.discordapp.com/app-icons/${CS2}/694f0b895f21566723671fa6219c1001.png?size=1024`,
    ]);
  });

  it("only ever builds Discord and Steam image URLs", () => {
    for (const url of artUrls(CS2, { cover: "a".repeat(32), steam: "1" })) {
      const host = new URL(url).host;
      assert.ok(host === "cdn.discordapp.com" || host === "cdn.cloudflare.steamstatic.com", host);
    }
  });
});
