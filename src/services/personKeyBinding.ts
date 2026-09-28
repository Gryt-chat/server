import type { IdentityScope } from "@gryt/crypto/dist/scope";

/**
 * The MLS person key binding a member publishes (GRYT-1515, mls-design.md section 1). Peers
 * check it themselves; this keeps an honest server from handing out one they'd refuse.
 */

/* Subpaths, like mlsWire does with ts-mls: the package index pulls in all of MLS. */
/* eslint-disable @typescript-eslint/no-require-imports */
const { verifyPersonKeyBinding } = require("@gryt/crypto/mls-person-key") as typeof import("@gryt/crypto/dist/mls-person-key");
const { verifyDmKeyBinding } = require("@gryt/crypto/dm-key-binding") as typeof import("@gryt/crypto/dist/dm-key-binding");
/* eslint-enable @typescript-eslint/no-require-imports */

/** A real binding is about 500 bytes. The same ceiling as the DM key binding's. */
export const MAX_PERSON_KEY_BINDING_BYTES = 4096;

const COMPACT_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export type PersonKeyCheck =
  | { ok: true }
  | {
      ok: false;
      error: "invalid_binding" | "no_dm_key" | "wrong_identity";
      message: string;
    };

/* The scope a binding names, so it can be verified under that one. Null when unreadable. */
function claimedScope(jwt: string): IdentityScope | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload?.scope === "string" ? (payload.scope as IdentityScope) : null;
  } catch {
    return null;
  }
}

const refuse = (error: Exclude<PersonKeyCheck, { ok: true }>["error"], message: string): PersonKeyCheck => ({
  ok: false,
  error,
  message,
});

/**
 * Valid, and signed by the identity key that signed this member's DM key binding, for the
 * same scope. That's the key peers have pinned, and `pinPersonKey` refuses any other signer.
 */
export async function checkPersonKeyBinding(
  binding: string,
  dmKeyBinding: string | null,
): Promise<PersonKeyCheck> {
  if (binding.length > MAX_PERSON_KEY_BINDING_BYTES || !COMPACT_JWT.test(binding)) {
    return refuse("invalid_binding", "That isn't a person key binding.");
  }
  const scope = claimedScope(binding);
  if (!scope) return refuse("invalid_binding", "That person key binding names no scope.");

  let person;
  try {
    person = await verifyPersonKeyBinding(binding, scope);
  } catch (err) {
    return refuse("invalid_binding", err instanceof Error ? err.message : "That person key binding does not verify.");
  }

  const dmScope = dmKeyBinding ? claimedScope(dmKeyBinding) : null;
  if (!dmKeyBinding || !dmScope) {
    return refuse("no_dm_key", "Publish your DM key first. The person key is checked against the identity that signed it.");
  }
  let dm;
  try {
    dm = await verifyDmKeyBinding(dmKeyBinding, dmScope);
  } catch {
    return refuse("no_dm_key", "Your DM key binding here doesn't verify, so there's nothing to check the person key against.");
  }

  if (person.identityThumbprint !== dm.identityThumbprint) {
    return refuse("wrong_identity", "The person key binding is signed by a different identity key than your DM key binding.");
  }
  if (person.scope !== dm.scope) {
    return refuse("wrong_identity", "The person key binding was signed for a different server than your DM key binding.");
  }
  return { ok: true };
}
