import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
} from "jose";

import { verifyCertificate } from "./identity";

async function keypair() {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  return { privateKey, jwk: await exportJWK(publicKey) };
}

/**
 * A certificate in which `user` vouches for `device`, built the way a client
 * would, with the parts an attacker would reach for exposed as options.
 */
async function delegate(opts?: {
  issuer?: string;
  signWith?: CryptoKey;
  issJwkOverride?: JWK;
  deviceJwkOverride?: JWK;
  expiresIn?: string;
}) {
  const user = await keypair();
  const device = await keypair();

  const jwt = await new SignJWT({
    iss_jwk: opts?.issJwkOverride ?? user.jwk,
    jwk: opts?.deviceJwkOverride ?? device.jwk,
  })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setIssuer(opts?.issuer ?? "gryt:delegated")
    .setIssuedAt()
    .setExpirationTime(opts?.expiresIn ?? "30d")
    .sign(opts?.signWith ?? user.privateKey);

  return { jwt, user, device };
}

describe("delegated certificates", () => {
  it("is the signing key's identity, not the device's", async () => {
    // The whole point: your key is who you are, the device just speaks for it.
    const { jwt, user, device } = await delegate();
    const userThumb = await calculateJwkThumbprint(user.jwk, "sha256");
    const deviceThumb = await calculateJwkThumbprint(device.jwk, "sha256");

    const cert = await verifyCertificate(jwt);

    assert.equal(cert.sub, `key:${userThumb}`);
    assert.notEqual(cert.sub, `key:${deviceThumb}`);
    assert.equal(cert.tier, "local");
  });

  it("hands back the device key for the assertion check", async () => {
    // Returning the signing key here would reject every delegated join, since
    // the device signs the assertion with the key it actually holds.
    const { jwt, device } = await delegate();
    const cert = await verifyCertificate(jwt);
    assert.equal(cert.jwk.x, device.jwk.x);
    assert.equal(cert.jwk.y, device.jwk.y);
  });

  it("gives two devices of one person the same identity", async () => {
    const user = await keypair();
    const subs: string[] = [];

    for (let i = 0; i < 2; i++) {
      const device = await keypair();
      const jwt = await new SignJWT({ iss_jwk: user.jwk, jwk: device.jwk })
        .setProtectedHeader({ alg: "ES256", typ: "JWT" })
        .setIssuer("gryt:delegated")
        .setIssuedAt()
        .setExpirationTime("30d")
        .sign(user.privateKey);
      subs.push((await verifyCertificate(jwt)).sub);
    }

    assert.equal(subs[0], subs[1]);
  });

  it("rejects one signed by a key other than the one it names", async () => {
    // Otherwise anybody could take somebody else's public key, name it as the
    // issuer, and be them.
    const impostor = await keypair();
    const { jwt } = await delegate({ signWith: impostor.privateKey });
    await assert.rejects(() => verifyCertificate(jwt), /Delegated certificate/i);
  });

  it("rejects a delegation to its own signing key", async () => {
    const user = await keypair();
    const { jwt } = await delegate({
      issJwkOverride: user.jwk,
      deviceJwkOverride: user.jwk,
      signWith: user.privateKey,
    });
    await assert.rejects(() => verifyCertificate(jwt), /names its own signing key/i);
  });

  it("rejects private key material in either slot", async () => {
    const user = await keypair();
    const privateJwk = await exportJWK(user.privateKey);

    const a = await delegate({ issJwkOverride: privateJwk, signWith: user.privateKey });
    await assert.rejects(() => verifyCertificate(a.jwt), /private key material/i);

    const b = await delegate({ deviceJwkOverride: privateJwk });
    await assert.rejects(() => verifyCertificate(b.jwt), /private key material/i);
  });

  it("rejects an expired delegation", async () => {
    // The only revocation there is.
    const { jwt } = await delegate({ expiresIn: "-1h" });
    await assert.rejects(() => verifyCertificate(jwt), /Delegated certificate/i);
  });

  it("rejects one missing the signing key", async () => {
    const user = await keypair();
    const device = await keypair();
    const jwt = await new SignJWT({ jwk: device.jwk })
      .setProtectedHeader({ alg: "ES256", typ: "JWT" })
      .setIssuer("gryt:delegated")
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(user.privateKey);

    await assert.rejects(() => verifyCertificate(jwt), /jwk/i);
  });

  it("does not treat a self-signed certificate as delegated", async () => {
    const { jwt } = await delegate({ issuer: "gryt:self" });
    // Sent down the self-signed path, where it fails for naming a key it was
    // not signed by — not quietly accepted under the other set of rules.
    await assert.rejects(() => verifyCertificate(jwt), /Self-signed/i);
  });
});
