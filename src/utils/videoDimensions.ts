import { open } from "fs/promises";

/* Reads a video's display size from its container headers: MP4/MOV boxes and
   WebM/Matroska elements. No frame is decoded and no codec is involved. */

export interface VideoDimensions {
  width: number;
  height: number;
}

/** Random access to the upload, so the parser can skip `mdat` without reading it. */
export interface ByteSource {
  size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

/** Headers are a few kilobytes in any real file. These bound a hostile one. */
export const PARSE_LIMITS = {
  maxElements: 2_000,
  maxBytesRead: 1024 * 1024,
  maxTracksBytes: 256 * 1024,
  maxSide: 32_768,
};

class OverBudget extends Error {}

interface Budget {
  elements: number;
  bytes: number;
}

async function readCounted(src: ByteSource, budget: Budget, offset: number, length: number): Promise<Buffer> {
  budget.elements -= 1;
  budget.bytes -= length;
  if (budget.elements < 0 || budget.bytes < 0) throw new OverBudget();
  return src.read(offset, length);
}

function sane(width: number, height: number): VideoDimensions | null {
  const w = Math.round(width);
  const h = Math.round(height);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (w < 1 || h < 1 || w > PARSE_LIMITS.maxSide || h > PARSE_LIMITS.maxSide) return null;
  return { width: w, height: h };
}

// ISO base media: MP4, MOV, M4V, 3GP.

/** Types an ISO file can open with. Older QuickTime files start without `ftyp`. */
const ISO_FIRST_BOXES = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot"]);

interface Box {
  type: string;
  start: number;
  end: number;
}

/** A box that claims to run past its parent ends the walk, which is how a truncated file is refused. */
async function* boxes(src: ByteSource, budget: Budget, start: number, end: number): AsyncGenerator<Box> {
  let pos = start;
  while (pos + 8 <= end) {
    const head = await readCounted(src, budget, pos, Math.min(16, end - pos));
    if (head.length < 8) return;

    let size = head.readUInt32BE(0);
    let headerSize = 8;
    if (size === 1) {
      if (head.length < 16) return;
      const high = head.readUInt32BE(8);
      if (high > 0x1fffff) return;
      size = high * 2 ** 32 + head.readUInt32BE(12);
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < headerSize || pos + size > end) return;

    yield { type: head.toString("latin1", 4, 8), start: pos + headerSize, end: pos + size };
    pos += size;
  }
}

async function payload(src: ByteSource, budget: Budget, box: Box, max: number): Promise<Buffer> {
  return readCounted(src, budget, box.start, Math.min(max, box.end - box.start));
}

/** Width and height are 16.16 fixed point after the matrix; a 90° matrix swaps them. */
function tkhdDimensions(tkhd: Buffer): VideoDimensions | null {
  const version = tkhd[0];
  if (version !== 0 && version !== 1) return null;
  const matrix = version === 1 ? 52 : 40;
  if (tkhd.length < matrix + 44) return null;

  const a = tkhd.readInt32BE(matrix);
  const b = tkhd.readInt32BE(matrix + 4);
  const width = tkhd.readUInt32BE(matrix + 36) / 65536;
  const height = tkhd.readUInt32BE(matrix + 40) / 65536;
  const quarterTurn = Math.abs(b) > Math.abs(a);
  return quarterTurn ? sane(height, width) : sane(width, height);
}

async function trakDimensions(src: ByteSource, budget: Budget, trak: Box): Promise<VideoDimensions | null> {
  let tkhd: Buffer | null = null;
  let video = false;

  for await (const child of boxes(src, budget, trak.start, trak.end)) {
    if (child.type === "tkhd") {
      tkhd = await payload(src, budget, child, 96);
    } else if (child.type === "mdia") {
      for await (const inner of boxes(src, budget, child.start, child.end)) {
        if (inner.type !== "hdlr") continue;
        const hdlr = await payload(src, budget, inner, 12);
        video = hdlr.length >= 12 && hdlr.toString("latin1", 8, 12) === "vide";
      }
    }
  }

  return video && tkhd ? tkhdDimensions(tkhd) : null;
}

async function isoDimensions(src: ByteSource, budget: Budget): Promise<VideoDimensions | null> {
  for await (const top of boxes(src, budget, 0, src.size)) {
    if (top.type !== "moov") continue;
    for await (const trak of boxes(src, budget, top.start, top.end)) {
      if (trak.type !== "trak") continue;
      const found = await trakDimensions(src, budget, trak);
      if (found) return found;
    }
    return null;
  }
  return null;
}

// EBML: WebM, Matroska.

const EBML_HEADER = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const TRACKS = 0x1654ae6b;
const CLUSTER = 0x1f43b675;
const TRACK_ENTRY = 0xae;
const TRACK_TYPE = 0x83;
const VIDEO = 0xe0;
const PIXEL_WIDTH = 0xb0;
const PIXEL_HEIGHT = 0xba;
const DISPLAY_WIDTH = 0x54b0;
const DISPLAY_HEIGHT = 0x54ba;
const DISPLAY_UNIT = 0x54b2;

interface Element {
  id: number;
  /** Null for the "unknown size" a live recording writes. */
  size: number | null;
  headerSize: number;
}

/** An ID keeps its length marker and a size drops it. IDs are at most 4 bytes, sizes 8. */
function elementHeader(buf: Buffer, pos: number): Element | null {
  const first = buf[pos];
  if (first === undefined || first === 0) return null;
  const idLength = Math.clz32(first) - 23;
  if (idLength > 4 || pos + idLength > buf.length) return null;
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + buf[pos + i];

  const sizeAt = pos + idLength;
  const lead = buf[sizeAt];
  if (lead === undefined || lead === 0) return null;
  const sizeLength = Math.clz32(lead) - 23;
  if (sizeAt + sizeLength > buf.length) return null;

  let size = lead & (0xff >> sizeLength);
  let allOnes = size === 0xff >> sizeLength;
  for (let i = 1; i < sizeLength; i++) {
    const byte = buf[sizeAt + i];
    if (byte !== 0xff) allOnes = false;
    size = size * 256 + byte;
  }
  if (!allOnes && size > Number.MAX_SAFE_INTEGER) return null;

  return { id, size: allOnes ? null : size, headerSize: idLength + sizeLength };
}

function readUint(buf: Buffer, start: number, length: number): number | undefined {
  if (length < 1 || length > 4) return undefined;
  return buf.readUIntBE(start, length);
}

/** Calls `visit` for each child in [start, end). False if a child is malformed or overruns. */
function eachChild(
  buf: Buffer,
  start: number,
  end: number,
  visit: (id: number, at: number, length: number) => void,
): boolean {
  let pos = start;
  while (pos < end) {
    const el = elementHeader(buf, pos);
    if (!el || el.size === null) return false;
    const at = pos + el.headerSize;
    if (at + el.size > end) return false;
    visit(el.id, at, el.size);
    pos = at + el.size;
  }
  return true;
}

interface VideoFields {
  pixelWidth?: number;
  pixelHeight?: number;
  displayWidth?: number;
  displayHeight?: number;
  displayUnit?: number;
}

/** Display size wins over pixel size. In any unit but pixels it is only a ratio. */
function videoFieldDimensions(f: VideoFields): VideoDimensions | null {
  if (!f.pixelWidth || !f.pixelHeight) return null;
  if (f.displayWidth && f.displayHeight) {
    if (!f.displayUnit) return sane(f.displayWidth, f.displayHeight);
    return sane((f.pixelHeight * f.displayWidth) / f.displayHeight, f.pixelHeight);
  }
  return sane(f.pixelWidth, f.pixelHeight);
}

function tracksDimensions(buf: Buffer): VideoDimensions | null {
  let result: VideoDimensions | null = null;
  let malformed = false;

  const ok = eachChild(buf, 0, buf.length, (id, at, length) => {
    if (id !== TRACK_ENTRY || result || malformed) return;
    let type: number | undefined;
    const fields: VideoFields = {};

    const entryOk = eachChild(buf, at, at + length, (childId, childAt, childLength) => {
      if (childId === TRACK_TYPE) type = readUint(buf, childAt, childLength);
      if (childId !== VIDEO) return;
      const videoOk = eachChild(buf, childAt, childAt + childLength, (fieldId, fieldAt, fieldLength) => {
        const value = readUint(buf, fieldAt, fieldLength);
        if (fieldId === PIXEL_WIDTH) fields.pixelWidth = value;
        else if (fieldId === PIXEL_HEIGHT) fields.pixelHeight = value;
        else if (fieldId === DISPLAY_WIDTH) fields.displayWidth = value;
        else if (fieldId === DISPLAY_HEIGHT) fields.displayHeight = value;
        else if (fieldId === DISPLAY_UNIT) fields.displayUnit = value;
      });
      if (!videoOk) malformed = true;
    });

    if (!entryOk) malformed = true;
    else if (type === 1 && !malformed) result = videoFieldDimensions(fields);
  });

  return ok && !malformed ? result : null;
}

/** Tracks come before the first Cluster in anything a browser or ffmpeg writes. */
async function ebmlDimensions(src: ByteSource, budget: Budget): Promise<VideoDimensions | null> {
  let pos = 0;
  let segmentEnd: number | null = null;

  while (pos < (segmentEnd ?? src.size)) {
    const el = elementHeader(await readCounted(src, budget, pos, 12), 0);
    if (!el) return null;
    const dataStart = pos + el.headerSize;

    if (el.id === SEGMENT && segmentEnd === null) {
      segmentEnd = el.size === null ? src.size : Math.min(src.size, dataStart + el.size);
      pos = dataStart;
      continue;
    }
    if (el.size === null || el.id === CLUSTER) return null;

    if (el.id === TRACKS && segmentEnd !== null) {
      if (el.size > PARSE_LIMITS.maxTracksBytes || dataStart + el.size > segmentEnd) return null;
      const tracks = await readCounted(src, budget, dataStart, el.size);
      if (tracks.length < el.size) return null;
      return tracksDimensions(tracks);
    }

    pos = dataStart + el.size;
  }
  return null;
}

/** Null for anything it cannot read, including a file that is not a video. Never throws. */
export async function readVideoDimensions(src: ByteSource): Promise<VideoDimensions | null> {
  const budget: Budget = { elements: PARSE_LIMITS.maxElements, bytes: PARSE_LIMITS.maxBytesRead };
  try {
    const head = await readCounted(src, budget, 0, 12);
    if (head.length >= 4 && head.readUInt32BE(0) === EBML_HEADER) return await ebmlDimensions(src, budget);
    if (head.length >= 8 && ISO_FIRST_BOXES.has(head.toString("latin1", 4, 8))) {
      return await isoDimensions(src, budget);
    }
    return null;
  } catch {
    return null;
  }
}

export function bufferSource(buf: Buffer): ByteSource {
  return {
    size: buf.length,
    read: async (offset, length) => buf.subarray(offset, Math.min(buf.length, offset + length)),
  };
}

/** Reads through a handle, so a large upload is never loaded to find a few bytes. */
export async function readVideoDimensionsFromFile(path: string): Promise<VideoDimensions | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const fh = handle;
    const { size } = await fh.stat();
    return await readVideoDimensions({
      size,
      read: async (offset, length) => {
        const buf = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
        const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
        return buf.subarray(0, bytesRead);
      },
    });
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
