/**
 * Whether this server is in service. The old `GRYT_AUTH_MODE` name and values
 * still work silently, since a rename that took a server offline is worse.
 */

const TRUTHY = new Set(["true", "on", "yes", "1", "enabled", "required"]);
const FALSY = new Set(["false", "off", "no", "0", "disabled"]);

export type ServiceState =
  /** Joins proceed. */
  | { inService: true }
  /** Deliberately closed. */
  | { inService: false }
  /** Neither answer is safe: a typo read as on ignores somebody closing their
      server, and read as off takes one down over a spelling mistake. */
  | { inService: false; misconfigured: string };

export function readServiceState(env: NodeJS.ProcessEnv = process.env): ServiceState {
  // The new name wins when both are set, so a migration can add and delete in
  // either order.
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
