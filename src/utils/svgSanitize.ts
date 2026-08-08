/**
 * Accepting SVG without handing it to a browser as a document, or to a decoder.
 *
 * SVG is worth having for avatars and server icons: one file of a couple of
 * kilobytes stays sharp at every size the UI asks for, where a raster needs a
 * set of them and still goes soft when someone's display disagrees.
 *
 * It is also a document rather than a picture, so the reasoning about how it is
 * safe has to be written down rather than assumed:
 *
 *   - Rendered through <img>, which is how every avatar and icon in the client
 *     is drawn, a browser does not run script in an SVG and does not fetch its
 *     external references. That covers displaying it.
 *   - Fetched directly — someone opens the file URL — the response carries
 *     `Content-Security-Policy: default-src 'none'; sandbox`, and a sandbox with
 *     no tokens blocks scripts. That covers "open it in your browser", but only
 *     for as long as that header is on every file response. It is load-bearing.
 *   - Downloaded and opened from disk, no header applies. Nothing served can fix
 *     that, and it is equally true of any file anyone sends you. What helps is
 *     that the copy on disk is the sanitised one, which is this module.
 *
 * So sanitising is not what makes the common paths safe; the <img> element and
 * the CSP already do. It is what keeps the uncommon ones from being sharp, and
 * what stops a future component that inlines an icon from being an XSS bug on
 * its first day.
 *
 * Nothing here rasterises. sharp renders SVG through librsvg, and pointing a
 * memory-unsafe parser at stranger-supplied bytes is the risk that made the
 * image worker a review-required path. Storing the vector means never doing it.
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
 * Dimensions for an SVG, which does not have to state any.
 *
 * viewBox first: it is what actually defines the coordinate space, and it is
 * present on essentially everything a design tool exports. width/height are a
 * fallback and may carry units, so anything non-numeric is ignored rather than
 * guessed at.
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
 * Sanitise an uploaded SVG and report its dimensions.
 *
 * Returns the cleaned markup to store. The original bytes are deliberately not
 * kept — there is no reason to hold a version of the file that we decided was
 * unsafe to serve.
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
