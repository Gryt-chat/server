import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
} from "jose";

import {
  getAcceptedIdentityTiers,
  identityTierAccepted,
  verifyCertificate,
} from "./identity";

const SELF_ISSUER = "gryt:self";

async function makeKeyPair() {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  return { privateKey, publicJwk };
}

/**
 * Build a self-signed certificate the way a client would, with the escape
 * hatches a hostile client would reach for exposed as options.
 */
async function makeSelfSignedCert(opts?: {
  claimSub?: string;
  jwkOverride?: JWK;
  signWith?: Awaited<ReturnType<typeof makeKeyPair>>["privateKey"];
  issuer?: string;
  expiresIn?: string;
  preferredUsername?: string;
}) {
  const { privateKey, publicJwk } = await makeKeyPair();

  const jwt = await new SignJWT({
    jwk: opts?.jwkOverride ?? publicJwk,
    ...(opts?.preferredUsername
      ? { preferred_username: opts.preferredUsername }
      : {}),
  })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setIssuer(opts?.issuer ?? SELF_ISSUER)
    .setSubject(opts?.claimSub ?? "ignored")
    .setIssuedAt()
    .setExpirationTime(opts?.expiresIn ?? "24h")
    .sign(opts?.signWith ?? privateKey);

  return { jwt, publicJwk, privateKey };
}

afterEach(() => {
  delete process.env.GRYT_IDENTITY_TIERS;
});

describe("accepted identity tiers", () => {
  it("admits only accounts by default", () => {
    assert.deepEqual(getAcceptedIdentityTiers(), ["account"]);
    assert.equal(identityTierAccepted("account"), true);
    assert.equal(identityTierAccepted("local"), false);
  });

  it("admits local identity when configured", () => {
    process.env.GRYT_IDENTITY_TIERS = "account,local";
    assert.equal(identityTierAccepted("local"), true);
  });

  it("falls back to the default rather than something looser", () => {
    process.env.GRYT_IDENTITY_TIERS = "nonsense, ";
    assert.deepEqual(getAcceptedIdentityTiers(), ["account"]);
  });

  it("ignores unknown tiers alongside known ones", () => {
    process.env.GRYT_IDENTITY_TIERS = "local,wishful";
    assert.deepEqual(getAcceptedIdentityTiers(), ["local"]);
  });
});

describe("self-signed certificates", () => {
  it("verifies and derives sub from the key", async () => {
    const { jwt, publicJwk } = await makeSelfSignedCert();
    const expected = await calculateJwkThumbprint(publicJwk, "sha256");

    const result = await verifyCertificate(jwt);

    assert.equal(result.tier, "local");
    assert.equal(result.issuer, SELF_ISSUER);
    assert.equal(result.sub, `key:${expected}`);
  });

  it("ignores a sub the certificate claims for itself", async () => {
    // The attack this tier lives or dies on: a self-signed certificate naming
    // somebody else's account id. The sub must come from the key, never the
    // payload.
    const stolen = "0c8f2e1a-4b6d-4f2a-9c3e-71b0a5d9e4f7";
    const { jwt, publicJwk } = await makeSelfSignedCert({ claimSub: stolen });
    const expected = await calculateJwkThumbprint(publicJwk, "sha256");

    const result = await verifyCertificate(jwt);

    assert.notEqual(result.sub, stolen);
    assert.equal(result.sub, `key:${expected}`);
  });

  it("does not carry a self-asserted username", async () => {
    const { jwt } = await makeSelfSignedCert({ preferredUsername: "Sivert" });
    const result = await verifyCertificate(jwt);
    assert.equal(result.preferredUsername, undefined);
  });

  it("rejects a certificate signed by a key other than the one it carries", async () => {
    const other = await makeKeyPair();
    const { jwt } = await makeSelfSignedCert({ signWith: other.privateKey });

    await assert.rejects(() => verifyCertificate(jwt), /certificate/i);
  });

  it("rejects private key material", async () => {
    const { privateKey } = await makeKeyPair();
    const privateJwk = await exportJWK(privateKey);
    const { jwt } = await makeSelfSignedCert({ jwkOverride: privateJwk });

    await assert.rejects(() => verifyCertificate(jwt), /private key material/i);
  });

  it("rejects a curve it does not expect", async () => {
    const { publicKey } = await generateKeyPair("ES384", { extractable: true });
    const p384 = await exportJWK(publicKey);
    const { jwt } = await makeSelfSignedCert({ jwkOverride: p384 });

    await assert.rejects(() => verifyCertificate(jwt), /P-256/);
  });

  it("rejects an expired certificate", async () => {
    const { jwt } = await makeSelfSignedCert({ expiresIn: "-1h" });
    await assert.rejects(() => verifyCertificate(jwt), /certificate/i);
  });

  it("does not treat a CA-issued certificate as self-signed", async () => {
    // An unknown issuer goes down the CA path, where it fails for want of a
    // trusted issuer rather than being given a second chance under the rules
    // it named for itself.
    //
    // Pinned at a closed port so the CA path fails on a refused connection
    // instead of reaching for the real id.gryt.chat, which would make this
    // test need the network and the network's opinion of it.
    process.env.GRYT_TRUSTED_CERT_ISSUERS = "http://127.0.0.1:1";
    try {
      const { jwt } = await makeSelfSignedCert({ issuer: "https://id.example" });
      await assert.rejects(() => verifyCertificate(jwt), /trusted issuers/i);
    } finally {
      delete process.env.GRYT_TRUSTED_CERT_ISSUERS;
    }
  });

  it("rejects a malformed certificate", async () => {
    await assert.rejects(() => verifyCertificate("not-a-jwt"), /well-formed/i);
  });
});
