import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
} from "jose";

import { verifyIdentityLink } from "./identity";

const AUD = "chat.example:5000";
const NONCE = "nonce-abc";
const ACCOUNT = "0c8f2e1a-4b6d-4f2a-9c3e-71b0a5d9e4f7";

async function makeLink(opts?: {
  aud?: string;
  nonce?: string;
  linkTo?: string;
  issuer?: string;
  jwkOverride?: JWK;
  signWithOther?: boolean;
  expiresIn?: string;
}) {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);

  const signer = opts?.signWithOther
    ? (await generateKeyPair("ES256", { extractable: true })).privateKey
    : privateKey;

  const jwt = await new SignJWT({
    jwk: opts?.jwkOverride ?? publicJwk,
    nonce: opts?.nonce ?? NONCE,
    link_to: opts?.linkTo ?? ACCOUNT,
  })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setIssuer(opts?.issuer ?? "gryt:link")
    .setAudience(opts?.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opts?.expiresIn ?? "60s")
    .sign(signer);

  return { jwt, publicJwk };
}

describe("identity link", () => {
  it("derives the prior identity from the key that signed it", async () => {
    const { jwt, publicJwk } = await makeLink();
    const expected = await calculateJwkThumbprint(publicJwk, "sha256");

    const { priorSub } = await verifyIdentityLink(jwt, AUD, NONCE, ACCOUNT);

    assert.equal(priorSub, `key:${expected}`);
  });

  it("rejects one signed by a different key than it carries", async () => {
    const { jwt } = await makeLink({ signWithOther: true });
    await assert.rejects(() => verifyIdentityLink(jwt, AUD, NONCE, ACCOUNT), /link/i);
  });

  it("rejects a proof meant for another server", async () => {
    const { jwt } = await makeLink({ aud: "elsewhere.example:5000" });
    await assert.rejects(() => verifyIdentityLink(jwt, AUD, NONCE, ACCOUNT), /link/i);
  });

  it("rejects a replayed proof from an earlier join", async () => {
    const { jwt } = await makeLink({ nonce: "some-older-nonce" });
    await assert.rejects(() => verifyIdentityLink(jwt, AUD, NONCE, ACCOUNT), /link/i);
  });

  it("rejects one naming a different account", async () => {
    // Otherwise a proof captured while somebody linked their own account could
    // be replayed to attach that identity to an attacker's account instead.
    const { jwt } = await makeLink({ linkTo: "someone-else" });
    await assert.rejects(() => verifyIdentityLink(jwt, AUD, NONCE, ACCOUNT), /link/i);
  });

  it("accepts one from a clock that is merely wrong", async () => {
    // Freshness here is the nonce, not the clock: this server issued it, reads
    // it once and expires it on its own clock, so a proof cannot be reused
    // however new its `exp` looks. The test above this one is what enforces
    // that. Refusing a slow clock on top of it only cost people the carry-over
    // of an identity they still hold the key to.
    const { jwt } = await makeLink({ expiresIn: "-1m" });
    const { priorSub } = await verifyIdentityLink(jwt, AUD, NONCE, ACCOUNT);
    assert.match(priorSub, /^key:/);
  });

  it("rejects one from a clock further out than the tolerance", async () => {
    const { jwt } = await makeLink({ expiresIn: "-13h" });
    await assert.rejects(() => verifyIdentityLink(jwt, AUD, NONCE, ACCOUNT), /link/i);
  });

  it("rejects one that is not a link at all", async () => {
    const { jwt } = await makeLink({ issuer: "gryt:self" });
    await assert.rejects(() => verifyIdentityLink(jwt, AUD, NONCE, ACCOUNT), /link/i);
  });

  it("rejects private key material", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    const { jwt } = await makeLink({ jwkOverride: privateJwk });
    await assert.rejects(() => verifyIdentityLink(jwt, AUD, NONCE, ACCOUNT), /private key material/i);
  });

  it("rejects a malformed proof", async () => {
    await assert.rejects(
      () => verifyIdentityLink("not-a-jwt", AUD, NONCE, ACCOUNT),
      /well-formed/i,
    );
  });
});
