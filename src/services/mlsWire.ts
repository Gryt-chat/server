import { createHash, createHmac, timingSafeEqual } from "crypto";

import type { KeyPackage } from "ts-mls/dist/src/keyPackage";
import type { MLSMessage } from "ts-mls/dist/src/message";

/**
 * The few MLS header fields the delivery service reads (GRYT-1500). Decoding only:
 * nothing here holds a key, checks a signature or opens a ciphertext.
 */

/* Through the package's exports map, which only these subpaths get past. The index
   would pull in the noble provider the server has no use for. */

/* eslint-disable @typescript-eslint/no-require-imports */
const { decodeMlsMessage } = require("ts-mls/message.js") as typeof import("ts-mls/dist/src/message");
const { makeKeyPackageRef } = require("ts-mls/keyPackage.js") as typeof import("ts-mls/dist/src/keyPackage");
/* eslint-enable @typescript-eslint/no-require-imports */

/** Suite 1, the only one Gryt uses (decision 1 in docs/mls-design.md). */
export const MLS_CIPHERSUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";
export const MLS_CIPHERSUITE_ID = 1;

export type WireRefusal = { error: string; message: string };

const refuse = (error: string, message: string): { ok: false } & WireRefusal => ({ ok: false, error, message });

/** Socket.io hands binary over as a Buffer, and some clients send an ArrayBuffer. */
export function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

/* The whole input or nothing: trailing bytes would be stored and fanned out
   without anybody having looked at them. */
function decodeWhole(bytes: Uint8Array): MLSMessage | null {
  try {
    const decoded = decodeMlsMessage(bytes, 0);
    if (!decoded || decoded[1] !== bytes.length || decoded[0].version !== "mls10") return null;
    return decoded[0];
  } catch {
    return null;
  }
}

const sha256: Parameters<typeof makeKeyPackageRef>[1] = {
  digest: async (data) => new Uint8Array(createHash("sha256").update(data).digest()),
  mac: async (key, data) => new Uint8Array(createHmac("sha256", key).update(data).digest()),
  verifyMac: async (key, mac, data) => {
    const want = createHmac("sha256", key).update(data).digest();
    return want.length === mac.length && timingSafeEqual(want, mac);
  },
};

export async function keyPackageRef(kp: KeyPackage): Promise<string> {
  return Buffer.from(await makeKeyPackageRef(kp, sha256)).toString("hex");
}

export async function parseKeyPackage(
  bytes: Uint8Array,
): Promise<{ ok: true; ref: string } | ({ ok: false } & WireRefusal)> {
  const msg = decodeWhole(bytes);
  if (!msg || msg.wireformat !== "mls_key_package") return refuse("invalid_key_package", "That isn't an MLS KeyPackage.");
  if (msg.keyPackage.cipherSuite !== MLS_CIPHERSUITE) {
    return refuse("unsupported_ciphersuite", `Only ${MLS_CIPHERSUITE} is accepted here.`);
  }
  return { ok: true, ref: await keyPackageRef(msg.keyPackage) };
}

export interface ParsedHandshake {
  kind: "commit" | "proposal" | "application";
  groupId: string;
  epoch: number;
  /** Refs of the KeyPackages a commit or proposal adds by value. */
  addedRefs: string[];
  /** Proposals a commit names by reference; their Adds were checked on arrival. */
  referencedProposals: number;
}

/**
 * Commits and proposals as PublicMessage, so their Adds can be checked; application
 * messages as PrivateMessage, so nothing about them is readable (docs/mls-design.md §2).
 */
export async function parseGroupMessage(
  bytes: Uint8Array,
): Promise<({ ok: true } & ParsedHandshake) | ({ ok: false } & WireRefusal)> {
  const msg = decodeWhole(bytes);
  if (!msg) return refuse("invalid_message", "That isn't an MLS message.");

  if (msg.wireformat === "mls_private_message") {
    const pm = msg.privateMessage;
    if (pm.contentType !== "application") {
      return refuse("must_be_public", "Commits and proposals have to be sent as PublicMessage.");
    }
    return { ok: true, kind: "application", groupId: hex(pm.groupId), epoch: Number(pm.epoch), addedRefs: [], referencedProposals: 0 };
  }

  if (msg.wireformat !== "mls_public_message") return refuse("invalid_message", "That isn't a group message.");
  const content = msg.publicMessage.content;
  if (content.sender.senderType !== "member") {
    return refuse("unsupported_sender", "Only a member of the group can send a commit or proposal here.");
  }
  const base = { groupId: hex(content.groupId), epoch: Number(content.epoch) };

  if (content.contentType === "proposal") {
    const p = content.proposal;
    const addedRefs = p.proposalType === "add" ? [await keyPackageRef(p.add.keyPackage)] : [];
    return { ok: true, kind: "proposal", ...base, addedRefs, referencedProposals: 0 };
  }
  if (content.contentType === "commit") {
    const addedRefs: string[] = [];
    let referencedProposals = 0;
    for (const entry of content.commit.proposals) {
      if (entry.proposalOrRefType === "reference") referencedProposals += 1;
      else if (entry.proposal.proposalType === "add") addedRefs.push(await keyPackageRef(entry.proposal.add.keyPackage));
    }
    return { ok: true, kind: "commit", ...base, addedRefs, referencedProposals };
  }
  return refuse("must_be_private", "Application messages have to be sent as PrivateMessage.");
}

/** Who a Welcome is for, as KeyPackage refs. */
export function parseWelcome(bytes: Uint8Array): { ok: true; recipients: string[] } | ({ ok: false } & WireRefusal) {
  const msg = decodeWhole(bytes);
  if (!msg || msg.wireformat !== "mls_welcome") return refuse("invalid_welcome", "That isn't an MLS Welcome.");
  if (msg.welcome.cipherSuite !== MLS_CIPHERSUITE) {
    return refuse("unsupported_ciphersuite", `Only ${MLS_CIPHERSUITE} is accepted here.`);
  }
  return { ok: true, recipients: msg.welcome.secrets.map((s) => hex(s.newMember)) };
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
