export type ByteRange =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" };

/** Thrown by a storage backend so the route can answer 416 with the real size. */
export class RangeNotSatisfiableError extends Error {
  readonly size: number;

  constructor(size: number) {
    super(`Range not satisfiable for a ${size} byte object`);
    this.name = "RangeNotSatisfiableError";
    this.size = size;
  }
}

const SINGLE = /^bytes=[ \t]*(\d*)-(\d*)[ \t]*$/i;

/** Only one well-formed range counts. Anything else, several ranges included,
    is ignored and the whole file is served, which RFC 9110 14.2 allows. */
export function isSingleByteRange(header: string | undefined): header is string {
  if (!header) return false;
  const match = SINGLE.exec(header);
  if (!match) return false;
  const [, first, last] = match;
  if (!first && !last) return false;
  if (first && last && Number(first) > Number(last)) return false;
  return true;
}

/** RFC 9110 14.1.2: a last byte past the end is clamped, a first byte at or past
    it is unsatisfiable, and `-N` is the final N bytes. */
export function resolveByteRange(header: string | undefined, size: number): ByteRange {
  if (!isSingleByteRange(header)) return { kind: "full" };
  const [, first, last] = SINGLE.exec(header)!;

  if (!first) {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(first);
  if (start >= size) return { kind: "unsatisfiable" };
  const end = last ? Math.min(Number(last), size - 1) : size - 1;
  return { kind: "partial", start, end };
}
