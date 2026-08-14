/**
 * Whether this server is in service, and the long story behind the name
 * (GRYT-281).
 *
 * The setting used to be `GRYT_AUTH_MODE`, whose values were `required` and
 * `disabled`. It read like it controlled whether members needed an account, and
 * every comment and doc page said so, but it never did any such thing: joining
 * without an account is decided by `GRYT_IDENTITY_TIERS` alone, and the two do
 * not interact. All this ever did was reject every join, which is a maintenance
 * switch wearing a security name.
 *
 * So it is `GRYT_SERVER_ENABLED` now, and it takes the words a person would
 * guess. The old name and the old values still work, silently, because a rename
 * that takes somebody's server offline on upgrade would be a worse bug than the
 * one being fixed.
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
