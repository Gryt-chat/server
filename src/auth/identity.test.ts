import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
      await assert.rejects(() => verifyCertificate(jwt), /not trusted/i);
    } finally {
      delete process.env.GRYT_TRUSTED_CERT_ISSUERS;
    }
  });

  it("rejects a malformed certificate", async () => {
    await assert.rejects(() => verifyCertificate("not-a-jwt"), /well-formed/i);
  });
});

// ── Issuer-qualified ids (GRYT-267) ─────────────────────────────────
//
// These stand up real JWKS endpoints on loopback rather than pointing at a
// closed port, because the property under test only exists on the far side of a
// successful CA verification: two trusted CAs, and whether one of them can name
// the other's user.

async function startJwksServer(publicJwk: JWK, kid: string) {
  const server = createServer((req, res) => {
    if (req.url === "/.well-known/jwks.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [{ ...publicJwk, kid, alg: "ES256", use: "sig" }] }));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A certificate authority: a signing key, a JWKS endpoint, and a way to issue. */
async function startCa(kid: string) {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const jwks = await startJwksServer(await exportJWK(publicKey), kid);

  return {
    origin: jwks.origin,
    close: jwks.close,
    async issue(sub: string, holderJwk: JWK) {
      return new SignJWT({ jwk: holderJwk })
        .setProtectedHeader({ alg: "ES256", typ: "JWT", kid })
        .setIssuer(jwks.origin)
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime("24h")
        .sign(privateKey);
    },
  };
}

describe("issuer-qualified ids", () => {
  it("stores the primary issuer's users under a bare sub", async () => {
    const ca = await startCa("primary");
    const holder = await makeKeyPair();
    process.env.GRYT_TRUSTED_CERT_ISSUERS = ca.origin;
    try {
      const jwt = await ca.issue("abc-123", holder.publicJwk);
      const result = await verifyCertificate(jwt);

      assert.equal(result.tier, "account");
      assert.equal(result.sub, "abc-123");
      assert.equal(result.grytUserId, "abc-123");
    } finally {
      delete process.env.GRYT_TRUSTED_CERT_ISSUERS;
      await ca.close();
    }
  });

  it("writes the issuer into the id for every other trusted issuer", async () => {
    const primary = await startCa("primary");
    const other = await startCa("other");
    const holder = await makeKeyPair();
    process.env.GRYT_TRUSTED_CERT_ISSUERS = `${primary.origin},${other.origin}`;
    try {
      const jwt = await other.issue("abc-123", holder.publicJwk);
      const result = await verifyCertificate(jwt);

      // The `sub` is untouched — it is what the client signed its assertion
      // with and has to keep matching.
      assert.equal(result.sub, "abc-123");
      assert.equal(result.grytUserId, `${other.origin}|abc-123`);
    } finally {
      delete process.env.GRYT_TRUSTED_CERT_ISSUERS;
      await Promise.all([primary.close(), other.close()]);
    }
  });

  it("refuses to let a second CA name the first CA's user", async () => {
    // The whole point. The `sub` is not a secret — it is handed to every server
    // on every join — so an operator who runs a trusted CA already knows it and
    // can put it in their own Keycloak. What must not follow is inheriting that
    // user's roles, ownership and ban state, all of which key on the stored id.
    const primary = await startCa("primary");
    const hostile = await startCa("hostile");
    const victim = await makeKeyPair();
    const attacker = await makeKeyPair();
    process.env.GRYT_TRUSTED_CERT_ISSUERS = `${primary.origin},${hostile.origin}`;
    try {
      const real = await verifyCertificate(
        await primary.issue("abc-123", victim.publicJwk),
      );
      const impostor = await verifyCertificate(
        await hostile.issue("abc-123", attacker.publicJwk),
      );

      assert.equal(real.sub, impostor.sub);
      assert.notEqual(real.grytUserId, impostor.grytUserId);
    } finally {
      delete process.env.GRYT_TRUSTED_CERT_ISSUERS;
      await Promise.all([primary.close(), hostile.close()]);
    }
  });

  it("refuses a sub that already looks qualified", async () => {
    // Otherwise the primary issuer, whose users are stored bare, could mint a
    // sub that lands exactly on another issuer's user.
    const primary = await startCa("primary");
    const other = await startCa("other");
    const holder = await makeKeyPair();
    process.env.GRYT_TRUSTED_CERT_ISSUERS = `${primary.origin},${other.origin}`;
    try {
      const jwt = await primary.issue(`${other.origin}|abc-123`, holder.publicJwk);
      await assert.rejects(() => verifyCertificate(jwt), /must not contain/i);
    } finally {
      delete process.env.GRYT_TRUSTED_CERT_ISSUERS;
      await Promise.all([primary.close(), other.close()]);
    }
  });

  it("refuses a CA sub in the self-signed namespace", async () => {
    const ca = await startCa("primary");
    const holder = await makeKeyPair();
    process.env.GRYT_TRUSTED_CERT_ISSUERS = ca.origin;
    try {
      const jwt = await ca.issue("key:pretending", holder.publicJwk);
      await assert.rejects(() => verifyCertificate(jwt), /reserved/i);
    } finally {
      delete process.env.GRYT_TRUSTED_CERT_ISSUERS;
      await ca.close();
    }
  });

  it("rejects an untrusted issuer without contacting it", async () => {
    // Dispatching on the claimed issuer means an unknown one costs nothing:
    // no signature check per trusted issuer, and no JWKS fetch. The unroutable
    // address in the trusted list would hang if it were still being tried.
    const rogue = await startCa("rogue");
    const holder = await makeKeyPair();
    process.env.GRYT_TRUSTED_CERT_ISSUERS = "http://192.0.2.1:1";
    try {
      const jwt = await rogue.issue("abc-123", holder.publicJwk);
      await assert.rejects(() => verifyCertificate(jwt), /not trusted/i);
    } finally {
      delete process.env.GRYT_TRUSTED_CERT_ISSUERS;
      await rogue.close();
    }
  });
});
