/**
 * Whether this server is in service (GRYT-281). Called `GRYT_AUTH_MODE` once,
 * which read as a switch for whether members needed an account and never was —
 * that is `GRYT_IDENTITY_TIERS` alone. All it ever did was reject every join.
 *
 * The old name and values still work silently: a rename that took somebody's
 * server offline on upgrade would be the worse bug.
 */

const TRUTHY = new Set(["true", "on", "yes", "1", "enabled", "required"]);
const FALSY = new Set(["false", "off", "no", "0", "disabled"]);

export type ServiceState =
  /** Joins proceed. */
  | { inService: true }
  /** Deliberately closed. */
  | { inService: false }
  /**
   * The value is not one this understands, so neither answer is safe: treating
   * a typo as "on" ignores somebody who meant to close their server, and
   * treating it as "off" takes down a server over a spelling mistake. Refusing
   * joins and saying why is the only honest option, and it is what the old code
   * did with an unrecognised `GRYT_AUTH_MODE`.
   */
  | { inService: false; misconfigured: string };

export function readServiceState(env: NodeJS.ProcessEnv = process.env): ServiceState {
  // The new name wins when both are set, so somebody migrating can add the new
  // one and delete the old one in either order without a window where the two
  // disagree and the loser is whichever the code happened to read first.
  const raw = env.GRYT_SERVER_ENABLED ?? env.GRYT_AUTH_MODE;
  if (raw === undefined || raw.trim() === "") return { inService: true };

  const value = raw.trim().toLowerCase();
  if (TRUTHY.has(value)) return { inService: true };
  if (FALSY.has(value)) return { inService: false };

  return { inService: false, misconfigured: value };
}

/** The name the operator actually set, so an error names the line they wrote. */
export function serviceStateVarName(
  env: NodeJS.ProcessEnv = process.env,
): "GRYT_SERVER_ENABLED" | "GRYT_AUTH_MODE" {
  return env.GRYT_SERVER_ENABLED !== undefined
    ? "GRYT_SERVER_ENABLED"
    : "GRYT_AUTH_MODE";
}
