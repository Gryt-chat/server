import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import sharp from "sharp";

import { webhookMessageSchema } from "../routes/webhookSchemas";
import { fallbackText, realMediaDeps, resolveWebhookMedia, sniffImageFormat, type FetchOutcome, type MediaDeps } from "./webhookMedia";

const png = () => sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 40, g: 120, b: 90 } } }).png().toBuffer();

function fakeDeps(respond: (url: string, max: number, signal: AbortSignal) => Promise<FetchOutcome>) {
  const fetched: string[] = [];
  const stored: ("picture" | "avatar")[] = [];
  const deps: MediaDeps = {
    fetchBytes: async (url, signal, max) => { fetched.push(url); return respond(url, max, signal); },
    storeImage: async () => { stored.push("picture"); return `file-${stored.length}`; },
    storeAvatar: async () => { stored.push("avatar"); return `avatar-${stored.length}`; },
  };
  return { deps, fetched, stored };
}

describe("sniffImageFormat", () => {
  it("reads the format from the bytes and refuses SVG", async () => {
    assert.equal(sniffImageFormat(await png()), "png");
    assert.equal(sniffImageFormat(await sharp({ create: { width: 4, height: 4, channels: 3, background: "#000" } }).jpeg().toBuffer()), "jpeg");
    assert.equal(sniffImageFormat(await sharp({ create: { width: 4, height: 4, channels: 3, background: "#000" } }).webp().toBuffer()), "webp");
    assert.equal(sniffImageFormat(Buffer.from("GIF89a......")), "gif");
    assert.equal(sniffImageFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
    assert.equal(sniffImageFormat(Buffer.from("<html>")), null);
  });
});

describe("resolveWebhookMedia", () => {
  it("stores every picture and puts file ids where the URLs were", async () => {
    const bytes = await png();
    const { deps, fetched } = fakeDeps(async () => ({ ok: true, bytes }));
    const body = webhookMessageSchema.parse({
      avatar_url: "https://a.example/avatar.png",
      cards: [{
        title: "t",
        author: { name: "a", icon_url: "https://a.example/icon.png" },
        thumbnail_url: "https://a.example/thumb.png",
        image_url: "https://a.example/image.png",
        footer: { text: "f", icon_url: "https://a.example/icon.png" },
        color: 0x3fb27f,
        timestamp: "2026-09-15T09:42:00+02:00",
      }],
    });
    const out = await resolveWebhookMedia("hook", body, deps);
    assert.deepEqual(out.warnings, []);
    assert.equal(out.avatarFileId !== undefined, true);
    const card = out.cards[0];
    assert.ok(card.author?.icon_file_id && card.thumbnail_file_id && card.image_file_id && card.footer?.icon_file_id);
    assert.equal(card.author!.icon_file_id, card.footer!.icon_file_id, "the same icon is fetched once");
    assert.equal(fetched.length, 4);
    assert.equal(card.color, "#3fb27f");
    assert.equal(card.timestamp, "2026-09-15T07:42:00.000Z");
    assert.equal(JSON.stringify(out.cards).includes("https://a.example"), false, "no remote picture URL is stored");
    assert.equal(out.mediaFileIds.length, 4);
  });

  it("drops a picture that fails, with a warning, and keeps the rest", async () => {
    const bytes = await png();
    const { deps } = fakeDeps(async (url) => {
      if (url.endsWith("blocked.png")) return { ok: false, code: "blocked" };
      if (url.endsWith("big.png")) return { ok: false, code: "too_large" };
      if (url.endsWith("page.png")) return { ok: true, bytes: Buffer.from("<html>not a picture</html>") };
      if (url.endsWith("svg.png")) return { ok: true, bytes: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>") };
      if (url.endsWith("broken.png")) return { ok: true, bytes: Buffer.concat([bytes.subarray(0, 16), Buffer.alloc(40)]) };
      return { ok: true, bytes };
    });
    const body = webhookMessageSchema.parse({
      cards: [
        { title: "a", image_url: "https://a.example/blocked.png", thumbnail_url: "https://a.example/ok.png" },
        { title: "b", image_url: "https://a.example/big.png", thumbnail_url: "https://a.example/page.png" },
        { title: "c", image_url: "https://a.example/svg.png", thumbnail_url: "https://a.example/broken.png" },
      ],
    });
    const out = await resolveWebhookMedia("hook", body, deps);
    assert.deepEqual(
      out.warnings.map((w) => [w.path, w.code]),
      [
        ["cards[0].image_url", "blocked"],
        ["cards[1].thumbnail_url", "unsupported_type"],
        ["cards[1].image_url", "too_large"],
        ["cards[2].thumbnail_url", "invalid_image"],
        ["cards[2].image_url", "unsupported_type"],
      ],
    );
    assert.ok(out.cards[0].thumbnail_file_id);
    assert.equal(out.cards[0].image_file_id, undefined);
    assert.equal(out.cards[1].title, "b");
  });

  it("stores the avatar as an avatar, and an icon from the same URL as sent, from one download", async () => {
    const bytes = await png();
    const { deps, fetched, stored } = fakeDeps(async () => ({ ok: true, bytes }));
    const body = webhookMessageSchema.parse({
      avatar_url: "https://a.example/logo.png",
      cards: [{ title: "t", author: { name: "a", icon_url: "https://a.example/logo.png" } }],
    });
    const out = await resolveWebhookMedia("hook", body, deps);
    assert.deepEqual(out.warnings, []);
    assert.deepEqual(fetched, ["https://a.example/logo.png"]);
    assert.deepEqual([...stored].sort(), ["avatar", "picture"]);
    assert.match(out.avatarFileId ?? "", /^avatar-/, "the avatar went through the card picture store");
    assert.match(out.cards[0].author?.icon_file_id ?? "", /^file-/, "the icon went through the avatar store");
    assert.equal(out.mediaFileIds.length, 2);
  });

  it("leaves out an avatar that fails to store, and keeps the icon it shares a URL with", async () => {
    const bytes = await png();
    const { deps } = fakeDeps(async () => ({ ok: true, bytes }));
    deps.storeAvatar = async () => { throw new Error("storage is down"); };
    const body = webhookMessageSchema.parse({
      avatar_url: "https://a.example/logo.png",
      cards: [{ title: "t", author: { name: "a", icon_url: "https://a.example/logo.png" } }],
    });
    const out = await resolveWebhookMedia("hook", body, deps);
    assert.deepEqual(out.warnings.map((w) => [w.path, w.code]), [["avatar_url", "store_failed"]]);
    assert.equal(out.avatarFileId, undefined);
    assert.ok(out.cards[0].author?.icon_file_id);
  });

  it("gives an icon the icon limit even when the same URL is also an image", async () => {
    const bytes = await png();
    const limits: number[] = [];
    const { deps } = fakeDeps(async (_url, max) => { limits.push(max); return { ok: true, bytes }; });
    const body = webhookMessageSchema.parse({
      cards: [{ title: "t", image_url: "https://a.example/x.png", author: { name: "a", icon_url: "https://a.example/x.png" } }],
    });
    await resolveWebhookMedia("hook", body, deps);
    assert.deepEqual(limits.sort((a, b) => a - b), [1024 * 1024, 8 * 1024 * 1024]);
  });

  it("gives up on pictures at the deadline and still returns", async () => {
    const { deps } = fakeDeps((_url, _max, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ ok: false, code: "timeout" }));
    }));
    const body = webhookMessageSchema.parse({ cards: [{ title: "t", image_url: "https://slow.example/a.png" }] });
    const started = Date.now();
    const out = await resolveWebhookMedia("hook", body, deps, 50);
    assert.ok(Date.now() - started < 2000);
    assert.deepEqual(out.warnings.map((w) => w.code), ["timeout"]);
    assert.equal(out.cards[0].title, "t");
  });
});

describe("realMediaDeps.fetchBytes", () => {
  let server: Server;
  let port: number;
  let hits = 0;

  before(async () => {
    const bytes = await png();
    server = createServer((_req, res) => {
      hits++;
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(bytes);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
  });

  after(() => server.close());

  it("refuses a loopback picture in the v4-mapped spelling and never connects", async () => {
    // Before GRYT-1196 this one was fetched and stored: new URL() writes it as [::ffff:7f00:1].
    for (const host of ["[::ffff:127.0.0.1]", "127.0.0.1"]) {
      const outcome = await realMediaDeps.fetchBytes(`http://${host}:${port}/a.png`, AbortSignal.timeout(5000), 1024 * 1024);
      assert.deepEqual(outcome, { ok: false, code: "blocked" }, host);
    }
    assert.equal(hits, 0);
  });
});

describe("fallbackText", () => {
  it("uses the first title and counts the rest", () => {
    assert.equal(fallbackText([{ title: "Deploy finished" }]), "Deploy finished");
    assert.equal(fallbackText([{ title: "Deploy finished" }, { title: "b" }, { title: "c" }]), "Deploy finished (+2 more)");
    assert.equal(fallbackText([{ author: { name: "Uptime check" } }]), "Uptime check");
    assert.equal(fallbackText([{ description: "x" }, { description: "y" }]), "Posted 2 cards");
  });

  it("can't ping or unfurl on an old client", () => {
    const text = fallbackText([{ title: "@everyone see https://example.com" }]);
    assert.equal(text.includes("@everyone"), false);
    assert.equal(text.includes("https://"), false);
  });
});
