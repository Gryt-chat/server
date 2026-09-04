/**
 * Who is being rung, and until when.
 *
 * A call itself is not state — it is an SFU room with people in it, and "is
 * there a call" is "does the room have anybody". Ringing is the exception,
 * because it has to interrupt somebody who is not looking at the conversation.
 *
 * In memory, deliberately not in the database: a row that survived a restart
 * would ring somebody about a call that ended before the server came back.
 */

/**
 * How long a ring lasts. The number matters less than there being one: a caller
 * who closes their laptop mid-ring otherwise leaves a device ringing at nothing.
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
 * Start ringing a conversation. Null when one is already going, so a second
 * caller cannot restart the clock and leave a ring that never times out.
 * `onExpire` fires only on the timeout.
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
 * Stop the ring in this conversation. Returns the one that was going, so the
 * caller has everybody to tell — the answerer's other devices included.
 */
export function endRing(conversationId: string): CallRing | null {
  const ring = rings.get(conversationId);
  if (!ring) return null;
  clearTimeout(ring.timer);
  rings.delete(conversationId);
  return strip(ring);
}

/**
 * Every ring this person started, for when they disconnect. Nobody else can end
 * it — the people being rung can only decline, which says something different.
 */
export function ringsFrom(serverUserId: string): CallRing[] {
  return [...rings.values()].filter((r) => r.fromServerUserId === serverUserId).map(strip);
}

/** Drop everything. Tests only — a live server has no reason to forget. */
export function resetRings(): void {
  for (const ring of rings.values()) clearTimeout(ring.timer);
  rings.clear();
}
