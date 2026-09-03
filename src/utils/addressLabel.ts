import { createHmac, randomBytes } from "crypto";

/**
 * A name for a client's address that is not the address.
 *
 * The logs need to tell two callers apart — that is the whole reason an address
 * was ever written down. Everything public arrives through a tunnel, so the
 * handshake address is the tunnel for every client and says nothing; the
 * resolved one distinguishes them, and also identifies them.
 *
 * A label does the first job and not the second. The same address gets the same
 * label for as long as the process lives, so "one caller hammering us" and
 * "eighty callers doing it once" still read differently in the log, and nothing
 * in the file is personal data.
 *
 * **The salt is random per process and never written anywhere.** An address
 * space small enough to enumerate — IPv4 is — makes an unsalted hash a
 * reversible encoding of the address rather than a replacement for it. A salt
 * that survived a restart, or that was stored, would eventually be somewhere it
 * could be read alongside the logs it protects.
 *
 * The cost is that labels mean nothing across a restart, and nothing between
 * two servers. Both are correct: correlating a caller across restarts is
 * exactly the tracking this exists to not do, and an operator who genuinely
 * needs an address has the connection in front of them.
 */
const SALT = randomBytes(32);

/** How much of the digest to keep. Eight hex characters is 4 bytes. */
const LABEL_LENGTH = 8;

export function addressLabel(ip: string | null | undefined): string {
  /* An absent address is its own answer and must not be hashed into one that
     looks like a real caller. Several of them at once is a proxy configuration
     to look at, not a person. */
  if (!ip) return "ip_unknown";

  const digest = createHmac("sha256", SALT).update(ip).digest("hex");
  return `ip_${digest.slice(0, LABEL_LENGTH)}`;
}
