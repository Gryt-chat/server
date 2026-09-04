/**
 * Accepting SVG without handing it to a browser as a document, or to a decoder.
 *
 * An SVG is a document rather than a picture, so three things carry the safety
 * and all three have to stay true. Drawn through `<img>`, a browser runs no
 * script and fetches no external references. Fetched directly, the response
 * carries `Content-Security-Policy: default-src 'none'; sandbox` — **that
 * header is load-bearing and has to be on every file response.** Downloaded and
 * opened from disk, no header applies, and what helps is that the copy on disk
 * is the sanitised one.
 *
 * So sanitising is not what makes the common paths safe. It covers the uncommon
 * ones, and a future component that inlines an icon.
 *
 * Nothing here rasterises. sharp renders SVG through librsvg, and pointing a
 * memory-unsafe parser at stranger-supplied bytes is the risk that made the
 * image worker a review-required path.
 */

import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

// One window for the process. Building a JSDOM per upload is slow, and
// DOMPurify only needs somewhere to parse.
const purify = createDOMPurify(new JSDOM("").window);

/**
 * An SVG has no business being large. A vector that needs more than this is
 * either an embedded raster, a generated monstrosity, or something trying to be
 * expensive to parse — and none of those is an avatar.
 */
export const MAX_SVG_BYTES = 512 * 1024;

export type SvgValidationResult =
  | { valid: true; svg: string; width: number; height: number }
  | { valid: false; reason: string };

/**
 * Dimensions for an SVG, which does not have to state any. viewBox first, since
 * it defines the coordinate space; width/height may carry units, so anything
 * non-numeric is ignored rather than guessed at.
 */
function readDimensions(el: Element): { width: number; height: number } | null {
  const viewBox = el.getAttribute("viewBox");
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      const [, , w, h] = parts;
      if (w > 0 && h > 0) return { width: Math.round(w), height: Math.round(h) };
    }
  }

  const w = parseFloat(el.getAttribute("width") || "");
  const h = parseFloat(el.getAttribute("height") || "");
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return { width: Math.round(w), height: Math.round(h) };
  }

  return null;
}

/**
 * Sanitise an uploaded SVG and report its dimensions. The original bytes are
 * deliberately not kept.
 */
export function sanitizeSvg(buffer: Buffer): SvgValidationResult {
  if (buffer.length > MAX_SVG_BYTES) {
    return {
      valid: false,
      reason: `That SVG is too large (max ${Math.round(MAX_SVG_BYTES / 1024)}KB).`,
    };
  }

  const source = buffer.toString("utf8");

  // Cheap rejection before parsing, so obviously-not-an-SVG does not get a DOM
  // built for it.
  if (!/<svg[\s>]/i.test(source)) {
    return { valid: false, reason: "That file is not an SVG." };
  }

  let clean: string;
  try {
    clean = purify.sanitize(source, {
      USE_PROFILES: { svg: true, svgFilters: true },
      // foreignObject is how HTML gets back into an SVG, which is the whole
      // door being closed here. The rest are external-reference vectors: they
      // do not render through <img>, but they would phone home anywhere else.
      FORBID_TAGS: ["foreignObject", "script", "a", "use", "image"],
      FORBID_ATTR: ["href", "xlink:href", "formaction", "ping"],
    });
  } catch {
    return { valid: false, reason: "That SVG could not be read." };
  }

  // Refuse rather than quietly repair: storing a modified file means an avatar
  // the uploader did not choose, and an SVG carrying <script> is not an
  // innocent file that needs fixing.
  //
  // BODY is jsdom's wrapper and is removed from every parse, clean or not.
  const removed = purify.removed
    .map((r) => {
      const el = (r as { element?: Node }).element;
      const attr = (r as { attribute?: Attr }).attribute;
      return el?.nodeName ?? attr?.name ?? "";
    })
    .filter((name) => name && name.toUpperCase() !== "BODY");

  if (removed.length > 0) {
    const unique = [...new Set(removed)].slice(0, 3).join(", ");
    return {
      valid: false,
      reason:
        `That SVG contains things that can run code or call out to other sites ` +
        `(${unique}), so it was not accepted. Export it again without scripting ` +
        `or interactivity, or upload a PNG.`,
    };
  }

  if (!clean.trim()) {
    return {
      valid: false,
      reason: "Nothing was left of that SVG after removing unsafe content.",
    };
  }

  const doc = new JSDOM(clean, { contentType: "image/svg+xml" }).window.document;
  const root = doc.querySelector("svg");
  if (!root) {
    return { valid: false, reason: "That file is not a valid SVG." };
  }

  const dims = readDimensions(root);
  if (!dims) {
    return {
      valid: false,
      reason: "That SVG has no viewBox or size, so it cannot be displayed reliably.",
    };
  }

  return { valid: true, svg: clean, width: dims.width, height: dims.height };
}
