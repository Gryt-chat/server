/**
 * Who is being rung, and until when.
 *
 * A call itself is not state. It is an SFU room with people in it, the same as
 * a voice channel — "is there a call" is "does the room have anybody", and
 * joining one is the ordinary join path. Nothing about a call is written down.
 *
 * Ringing is the exception, and it is the whole reason this file exists. A
 * channel never has to reach anybody: you go to it, and whoever is there was
 * already there. A call has to interrupt somebody who is not looking at the
 * conversation, and then be answered, refused, or given up on. That is a fact
 * about a moment rather than about the conversation, so it lives in memory and
 * dies with the process.
 *
 * Deliberately not in the database. A ring outlives its usefulness in seconds;
 * a row that survives a restart would ring somebody about a call that ended
 * before the server came back.
 */

/**
 * How long a ring lasts before it gives up.
 *
 * Thirty seconds, which is about how long a phone rings before it feels
 * broken. The number matters less than there being one at all: without it a
 * caller who closes their laptop mid-ring leaves the other person's device
 * ringing with nothing on the other end, and the only way out is for them to
 * decline a call that no longer exists.
 */
export const RING_TTL_MS = 30_000;

export interface CallRing {
  conversationId: string;
  /** Who started it. */
  fromServerUserId: string;
  /** Everybody being rung — the conversation's members, minus the caller. */
  toServerUserIds: string[];
  startedAt: number;
  expiresAt: number;
}

/** Why a ring stopped, as the people being rung are told. */
export type RingEnd =
  /** Somebody joined the call. */
  | "answered"
  /** Somebody said no. */
  | "declined"
  /** The caller gave up, or went away. */
  | "cancelled"
  /** Nobody answered in {@link RING_TTL_MS}. */
  | "timeout";

interface StoredRing extends CallRing {
  timer: ReturnType<typeof setTimeout>;
}

const rings = new Map<string, StoredRing>();

/** The ring without its timer, which is nobody else's business. */
function strip(ring: StoredRing): CallRing {
  return {
    conversationId: ring.conversationId,
    fromServerUserId: ring.fromServerUserId,
    toServerUserIds: ring.toServerUserIds,
    startedAt: ring.startedAt,
    expiresAt: ring.expiresAt,
  };
}

/** The ring in this conversation, if one is going. */
export function getRing(conversationId: string): CallRing | null {
  const ring = rings.get(conversationId);
  return ring ? strip(ring) : null;
}

/**
 * Start ringing a conversation.
 *
 * Returns null when one is already going, so a second caller cannot restart the
 * clock on the first — two people pressing call at once in a group should be
 * one ring, not a ring that never times out.
 *
 * `onExpire` fires only on the timeout. Every other ending is somebody doing
 * something, and the code that does it is where the telling belongs.
 */
export function startRing(
  ring: Omit<CallRing, "startedAt" | "expiresAt">,
  now: number,
  onExpire: (expired: CallRing) => void,
): CallRing | null {
  if (rings.has(ring.conversationId)) return null;

  const stored: StoredRing = {
    ...ring,
    startedAt: now,
    expiresAt: now + RING_TTL_MS,
    timer: setTimeout(() => {
      const current = rings.get(ring.conversationId);
      if (!current) return;
      rings.delete(ring.conversationId);
      onExpire(strip(current));
    }, RING_TTL_MS),
  };

  // Nothing here should hold the process open. A ring is a timer nobody would
  // wait for on shutdown.
  stored.timer.unref?.();

  rings.set(ring.conversationId, stored);
  return strip(stored);
}

/**
 * Stop the ring in this conversation and say what happened to it.
 *
 * Returns the ring that was going, so the caller has the list of people to
 * tell — including the devices of whoever just answered, which is what stops a
 * phone ringing in a pocket after the call was taken on a laptop.
 */
export function endRing(conversationId: string): CallRing | null {
  const ring = rings.get(conversationId);
  if (!ring) return null;
  clearTimeout(ring.timer);
  rings.delete(conversationId);
  return strip(ring);
}

/**
 * Every ring this person started.
 *
 * For a caller who disconnects. Their ring is the one nobody else can end —
 * the people being rung can only decline, which is a different thing to say —
 * so it would otherwise ring on until it timed out at somebody who is no
 * longer there.
 */
export function ringsFrom(serverUserId: string): CallRing[] {
  return [...rings.values()].filter((r) => r.fromServerUserId === serverUserId).map(strip);
}

/** Drop everything. Tests only — a live server has no reason to forget. */
export function resetRings(): void {
  for (const ring of rings.values()) clearTimeout(ring.timer);
  rings.clear();
}
