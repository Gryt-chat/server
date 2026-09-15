import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { colorToHex, problemsFrom, unknownKeys, webhookMessageSchema } from "./webhookSchemas";

function problems(body: unknown) {
  const parsed = webhookMessageSchema.safeParse(body, { reportInput: true });
  assert.equal(parsed.success, false, "expected a refusal");
  return problemsFrom(parsed.error!);
}

describe("webhook message schema", () => {
  it("still takes a plain text message", () => {
    const parsed = webhookMessageSchema.parse({ text: "  deployed  ", display_name: "CI" });
    assert.equal(parsed.text, "deployed");
  });

  it("takes cards without text", () => {
    const parsed = webhookMessageSchema.parse({ cards: [{ title: "Backup completed" }] });
    assert.equal(parsed.cards?.length, 1);
  });

  it("refuses a message with neither text nor cards", () => {
    assert.deepEqual(problems({ text: "   " }).map((p) => p.code), ["empty_message"]);
  });

  it("names every problem with a path and a code", () => {
    const found = problems({
      cards: [
        {},
        {
          title: "x".repeat(257),
          url: "ftp://example.com",
          color: "red",
          timestamp: "yesterday",
          fields: [{ name: "", value: "x".repeat(1025) }],
          image_url: "javascript:alert(1)",
        },
      ],
    });
    const byPath = Object.fromEntries(found.map((p) => [p.path, p]));
    assert.equal(byPath["cards[0]"].code, "empty_card");
    assert.equal(byPath["cards[1].title"].code, "too_long");
    assert.equal(byPath["cards[1].title"].limit, 256);
    assert.equal(byPath["cards[1].url"].code, "invalid_url");
    assert.equal(byPath["cards[1].color"].code, "invalid_color");
    assert.equal(byPath["cards[1].timestamp"].code, "invalid_timestamp");
    assert.equal(byPath["cards[1].fields[0].name"].code, "required");
    assert.equal(byPath["cards[1].fields[0].value"].code, "too_long");
    assert.equal(byPath["cards[1].image_url"].code, "invalid_url");
  });

  it("allows 10 cards and refuses 11", () => {
    const card = { title: "t" };
    assert.ok(webhookMessageSchema.safeParse({ cards: Array(10).fill(card) }).success);
    const found = problems({ cards: Array(11).fill(card) });
    assert.deepEqual(found.map((p) => [p.path, p.code, p.limit]), [["cards", "too_many", 10]]);
  });

  it("refuses 26 fields on a card", () => {
    const fields = Array.from({ length: 26 }, (_, i) => ({ name: `f${i}`, value: "v" }));
    assert.equal(problems({ cards: [{ fields }] })[0].code, "too_many");
  });

  it("counts all cards together against 6000 characters", () => {
    const card = { title: "t", description: "x".repeat(1000) };
    assert.ok(webhookMessageSchema.safeParse({ cards: Array(5).fill(card) }).success);
    const found = problems({ cards: Array(6).fill(card) });
    assert.deepEqual(found.map((p) => [p.path, p.code, p.limit]), [["cards", "total_too_long", 6000]]);
  });

  it("stops at 20 problems", () => {
    const cards = Array.from({ length: 10 }, () => ({ url: "nope", color: "nope", timestamp: "nope" }));
    assert.equal(problems({ cards }).length, 20);
  });

  it("stores a colour as #rrggbb whichever way it came", () => {
    assert.equal(colorToHex(0x3fb27f), "#3fb27f");
    assert.equal(colorToHex(255), "#0000ff");
    assert.equal(colorToHex("#3FB27F"), "#3fb27f");
    assert.ok(webhookMessageSchema.safeParse({ cards: [{ title: "t", color: 16777215 }] }).success);
    assert.equal(problems({ cards: [{ title: "t", color: 16777216 }] })[0].code, "invalid_color");
  });

  it("lists keys it ignores, down into cards", () => {
    const warnings = unknownKeys({
      content: "discord",
      text: "hi",
      cards: [{ title: "t", thumbnail: { url: "x" }, author: { name: "a", icon: "x" }, fields: [{ name: "n", value: "v", extra: 1 }] }],
    });
    assert.deepEqual(warnings.map((w) => w.path), [
      "content",
      "cards[0].thumbnail",
      "cards[0].author.icon",
      "cards[0].fields[0].extra",
    ]);
  });
});
