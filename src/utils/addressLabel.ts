import { createHmac, randomBytes } from "crypto";

/**
 * Tells two callers apart without identifying either. The salt is random per
 * process: IPv4 is small enough that an unsalted hash is reversible.
 */
const SALT = randomBytes(32);

/** How much of the digest to keep. Eight hex characters is 4 bytes. */
const LABEL_LENGTH = 8;

export function addressLabel(ip: string | null | undefined): string {
  /* An absent address must not hash into something that looks like a caller.
     Several at once is a proxy to look at, not a person. */
  if (!ip) return "ip_unknown";

  const digest = createHmac("sha256", SALT).update(ip).digest("hex");
  return `ip_${digest.slice(0, LABEL_LENGTH)}`;
}
