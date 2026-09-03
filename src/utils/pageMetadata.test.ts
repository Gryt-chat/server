import assert from "node:assert/strict";
import { test } from "node:test";

import {
  charsetFromContentType,
  decodeHtmlEntities,
  extractMeta,
  parsePageMetadata,
} from "./pageMetadata";

const BASE = "https://example.com/a/page";

test("reads a meta tag written either way round", () => {
  assert.equal(
    extractMeta('<meta property="og:title" content="Hello">', "og:title"),
    "Hello",
  );
  assert.equal(
    extractMeta('<meta content="Hello" property="og:title">', "og:title"),
    "Hello",
  );
});

test("reads single-quoted, unquoted and self-closed tags", () => {
  assert.equal(extractMeta("<meta property='og:title' content='Hi'>", "og:title"), "Hi");
  assert.equal(extractMeta("<meta property=og:title content=Hi>", "og:title"), "Hi");
  assert.equal(extractMeta('<meta property="og:title" content="Hi" />', "og:title"), "Hi");
});

test("name and itemprop count as well as property", () => {
  assert.equal(extractMeta('<meta name="description" content="d">', "description"), "d");
  assert.equal(extractMeta('<meta itemprop="author" content="a">', "author"), "a");
});

test("a key is not matched by a longer key that starts with it", () => {
  // og:image:width must not answer a request for og:image.
  const html = '<meta property="og:image:width" content="1200">';
  assert.equal(extractMeta(html, "og:image"), null);
});

test("an empty content attribute reads as absent, not as an empty title", () => {
  assert.equal(extractMeta('<meta property="og:title" content="">', "og:title"), null);
  assert.equal(extractMeta('<meta property="og:title" content="   ">', "og:title"), null);
});

test("decodes named and numeric entities", () => {
  assert.equal(decodeHtmlEntities("Tom &amp; Jerry"), "Tom & Jerry");
  assert.equal(decodeHtmlEntities("caf&#233;"), "café");
  assert.equal(decodeHtmlEntities("&#x1F600;"), "😀");
  assert.equal(decodeHtmlEntities("it&rsquo;s"), "it’s");
});

test("leaves a malformed entity as written rather than throwing", () => {
  assert.equal(decodeHtmlEntities("&#xZZ;"), "&#xZZ;");
  assert.equal(decodeHtmlEntities("&#999999999;"), "&#999999999;");
  assert.equal(decodeHtmlEntities("&notarealentity;"), "&notarealentity;");
});

test("falls back through og, twitter and the title tag", () => {
  const og = parsePageMetadata('<meta property="og:title" content="OG">', BASE);
  assert.equal(og.title, "OG");

  const tw = parsePageMetadata('<meta name="twitter:title" content="TW">', BASE);
  assert.equal(tw.title, "TW");

  const plain = parsePageMetadata("<title>Plain  title</title>", BASE);
  assert.equal(plain.title, "Plain title");
});

test("resolves a relative image against the page it came from", () => {
  const meta = parsePageMetadata('<meta property="og:image" content="/img/card.png">', BASE);
  assert.equal(meta.image, "https://example.com/img/card.png");
});

test("keeps declared image dimensions and drops absurd ones", () => {
  const good = parsePageMetadata(
    '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">',
    BASE,
  );
  assert.equal(good.imageWidth, 1200);
  assert.equal(good.imageHeight, 630);

  const silly = parsePageMetadata('<meta property="og:image:width" content="999999">', BASE);
  assert.equal(silly.imageWidth, null);
});

test("finds the favicon a page declares, preferring the apple touch icon", () => {
  const html =
    '<link rel="icon" href="/small.ico"><link rel="apple-touch-icon" href="/big.png">';
  assert.equal(parsePageMetadata(html, BASE).favicon, "https://example.com/big.png");
});

test("reads a rel token list, not just an exact rel", () => {
  const html = '<link rel="shortcut icon" href="/fav.ico">';
  assert.equal(parsePageMetadata(html, BASE).favicon, "https://example.com/fav.ico");
});

test("falls back to the conventional favicon path", () => {
  assert.equal(parsePageMetadata("<title>x</title>", BASE).favicon, "https://example.com/favicon.ico");
});

test("does not take the href of a neighbouring link tag", () => {
  // One regex across the whole document pairs the rel of the first tag with
  // the href of the second, which is how a stylesheet becomes a favicon.
  const html = '<link rel="preconnect"><link rel="stylesheet" href="/style.css">';
  assert.equal(parsePageMetadata(html, BASE).favicon, "https://example.com/favicon.ico");
});

test("finds an advertised oEmbed endpoint and ignores an RSS alternate", () => {
  const html =
    '<link rel="alternate" type="application/rss+xml" href="/feed.xml">' +
    '<link rel="alternate" type="application/json+oembed" href="https://example.com/oembed?url=x">';
  assert.equal(parsePageMetadata(html, BASE).oembedUrl, "https://example.com/oembed?url=x");

  const rssOnly = '<link rel="alternate" type="application/rss+xml" href="/feed.xml">';
  assert.equal(parsePageMetadata(rssOnly, BASE).oembedUrl, null);
});

test("keeps a usable theme colour and drops anything else", () => {
  const hex = parsePageMetadata('<meta name="theme-color" content="#1DB954">', BASE);
  assert.equal(hex.themeColor, "#1DB954");

  const named = parsePageMetadata('<meta name="theme-color" content="rebeccapurple">', BASE);
  assert.equal(named.themeColor, "rebeccapurple");

  // A theme colour goes straight into a style attribute downstream.
  const hostile = parsePageMetadata(
    '<meta name="theme-color" content="red;background:url(javascript:alert(1))">',
    BASE,
  );
  assert.equal(hostile.themeColor, null);
});

test("reads the charset off a content type", () => {
  assert.equal(charsetFromContentType("text/html; charset=windows-1252"), "windows-1252");
  assert.equal(charsetFromContentType("text/html"), "utf-8");
  assert.equal(charsetFromContentType("text/html; charset=not-a-real-charset"), "utf-8");
});
