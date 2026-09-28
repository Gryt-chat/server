import { createPublicKey, verify } from "crypto";

import type { DeviceCertificate } from "@gryt/crypto/dist/mls-device-certificate";
import type { IdentityScope } from "@gryt/crypto/dist/scope";

/**
 * The device certificate in a KeyPackage's credential (GRYT-1509), read and checked by
 * @gryt/crypto itself. Only the scope is looked up here, since the server can't know it.
 */

/* Through the package's `./*` export: the index would load ts-mls's whole index as well. */
/* eslint-disable @typescript-eslint/no-require-imports */
const { readDeviceCertificate: readChecked } =
  require("@gryt/crypto/mls-device-certificate") as typeof import("@gryt/crypto/dist/mls-device-certificate");
/* eslint-enable @typescript-eslint/no-require-imports */

export type { DeviceCertificate };

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Ed25519 from a raw 32-byte key, for ts-mls's KeyPackage signature. False if it isn't valid. */
export function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey).toString("base64url") },
      format: "jwk",
    });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

/* The scope the certificate names: after the version byte, a u16 length and UTF-8. A client
   builds it from its own pin, so the server takes the certificate's word and clients check it. */
function claimedScope(bytes: Uint8Array): IdentityScope | null {
  if (bytes.length < 3) return null;
  const length = (bytes[1] << 8) | bytes[2];
  if (length === 0 || bytes.length < 3 + length) return null;
  try {
    return utf8.decode(bytes.subarray(3, 3 + length)) as IdentityScope;
  } catch {
    return null;
  }
}

/** The certificate once the person key's signature checks out, or null. Whose person key
    it is, and which server it names, are the client's to check. */
export function readDeviceCertificate(bytes: Uint8Array): DeviceCertificate | null {
  const scope = claimedScope(bytes);
  if (!scope) return null;
  try {
    // A plain copy: crypto reads a Buffer's lengths off its pool (GRYT-1520).
    return readChecked(Uint8Array.from(bytes), scope);
  } catch {
    return null;
  }
}
