import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, it } from "node:test";

import type { Permission } from "../../constants/permissions";
import { directConversationId } from "../../db/sqlite/conversations";
import type { Clients } from "../../types";
import { publicClientList, publicClientRecord } from "./clients";

/**
 * The allowlist both member broadcasts are built from, and the wiring that makes
 * it the only builder. GRYT-1239.
 */

/** What the web client reads off these records; mobile reads a subset. Adding one
    is deciding that every member may see it. */
const PUBLIC_FIELDS = [
  "cameraEnabled", "cameraStreamID", "hasJoinedChannel", "isAFK", "isConnectedToVoice",
  "isDeafened", "isMuted", "isServerDeafened", "isServerMuted", "nickname",
  "screenShareAudioStreamID", "screenShareEnabled", "screenShareVideoStreamID",
  "serverUserId", "streamID", "voiceChannelId",
];

/** Every field the record can hold, so a new one fails to compile here first. */
const everything: Required<Clients[string]> = {
  grytUserId: "key:alice-identity",
  serverUserId: "alice-server-id",
  nickname: "Alice",
  color: "#5865f2",
  isMuted: true,
  isDeafened: false,
  streamID: "stream-a",
  hasJoinedChannel: true,
  voiceChannelId: "lounge",
  isConnectedToVoice: true,
  isAFK: true,
  cameraEnabled: true,
  cameraStreamID: "camera-a",
  screenShareEnabled: true,
  screenShareVideoStreamID: "share-video-a",
  screenShareAudioStreamID: "share-audio-a",
  isServerMuted: false,
  isServerDeafened: true,
  activity: "Playing something",
  status: "in_voice",
  lastSeen: new Date(0),
  accessToken: "eyJhbGciOiJIUzI1NiJ9.alice.token",
  permissions: new Set<Permission>(["view_members"]),
  latencyStats: { estimatedOneWayMs: 1, networkRttMs: 2, jitterMs: 3, codec: "opus", bitrateKbps: 64 },
};

describe("publicClientRecord", () => {
  it("copies exactly the public fields", () => {
    assert.deepEqual(Object.keys(publicClientRecord(everything, "lounge")).sort(), PUBLIC_FIELDS);
  });

  it("puts none of the rest on the wire", () => {
    const wire = JSON.stringify(publicClientRecord(everything, "lounge"));
    for (const secret of [everything.accessToken, everything.grytUserId, "view_members", "opus", "Playing something"]) {
      assert.equal(wire.includes(secret), false, `${secret} reached the wire`);
    }
  });

  it("passes each public value through as it is", () => {
    const record: Record<string, unknown> = publicClientRecord(everything, "lounge");
    for (const field of PUBLIC_FIELDS) {
      assert.equal(record[field], (everything as Record<string, unknown>)[field], field);
    }
  });

  it("takes the room it is handed rather than the record's", () => {
    assert.equal(publicClientRecord(everything, "").voiceChannelId, "");
  });
});

describe("publicClientList", () => {
  const dm = directConversationId("alice-server-id", "bob-server-id");
  const clientsInfo: Clients = {
    "sock-alice": everything,
    "sock-joining": { ...everything, serverUserId: "temp_sock-joining" },
    "sock-bob": { ...everything, serverUserId: "bob-server-id", voiceChannelId: dm },
    "sock-staff": { ...everything, serverUserId: "staff-server-id", voiceChannelId: "staff-room" },
  };

  it("keys by socket id and leaves out a connection that has not joined", () => {
    assert.deepEqual(Object.keys(publicClientList(clientsInfo)).sort(), ["sock-alice", "sock-bob", "sock-staff"]);
  });

  it("blanks a DM call's room for everybody", () => {
    assert.equal(publicClientList(clientsInfo)["sock-bob"].voiceChannelId, "");
    assert.equal(publicClientList(clientsInfo)["sock-alice"].voiceChannelId, "lounge");
  });

  it("blanks a channel the recipient cannot see and keeps one they can", () => {
    const list = publicClientList(clientsInfo, new Set(["lounge"]));
    assert.equal(list["sock-alice"].voiceChannelId, "lounge");
    assert.equal(list["sock-staff"].voiceChannelId, "");
    assert.equal(list["sock-bob"].voiceChannelId, "");
  });

  it("copies nothing but the public fields for anybody", () => {
    for (const record of Object.values(publicClientList(clientsInfo, new Set(["lounge"])))) {
      assert.deepEqual(Object.keys(record).sort(), PUBLIC_FIELDS);
    }
  });
});

const SRC = join(__dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

function read(path: string): string {
  return readFileSync(join(SRC, path), "utf8");
}

/** The body between a function's own braces, found by counting them. */
function functionBody(text: string, name: string): string {
  const start = text.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} is gone`);
  let parens = 0;
  let open = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "(") parens++;
    if (text[i] === ")") parens--;
    if (text[i] === "{" && parens === 0) {
      open = i;
      break;
    }
  }
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error(`${name} never closes`);
}

describe("who builds these payloads", () => {
  it("emits server:clients from one file, and only what the allowlist built", () => {
    const emitters = sourceFiles(SRC)
      .filter((f) => readFileSync(f, "utf8").includes('"server:clients"'))
      .map((f) => relative(SRC, f).split(sep).join("/"));
    assert.deepEqual(emitters, ["socket/utils/clients.ts"]);

    const text = read("socket/utils/clients.ts");
    const payloads = [...text.matchAll(/emit\("server:clients",\s*([^;]+)\);/g)].map((m) => m[1].trim());
    assert.equal(payloads.length, 3, `expected the two room emits and the per-socket one, found ${payloads.length}`);
    for (const payload of payloads) {
      const built = payload.startsWith("publicClientList(") || text.includes(`const ${payload} = publicClientList(`);
      assert.ok(built, `server:clients sends \`${payload}\`, which publicClientList did not build`);
    }
  });

  it("fills server:details.clients from the same allowlist", () => {
    const text = read("socket/utils/server.ts");
    const fields = [...text.matchAll(/^\s*clients:\s*(.+?),?\s*$/gm)].map((m) => m[1]);
    assert.deepEqual(fields, ["publicClientList(clientsInfo, visibleToThem)"]);
  });

  it("builds each record from named fields, with no spread and no secret", () => {
    const text = read("socket/utils/clients.ts");
    const record = functionBody(text, "publicClientRecord").trim();
    assert.match(record, /^return \{[^{}]*\};$/, "publicClientRecord is no longer one object literal");
    assert.equal(record.includes("..."), false, "publicClientRecord spreads something into the record");
    for (const secret of ["accessToken", "grytUserId", "permissions", "latencyStats"]) {
      assert.equal(record.includes(secret), false, `publicClientRecord names ${secret}`);
    }

    const list = functionBody(text, "publicClientList");
    assert.equal(list.includes("..."), false, "publicClientList spreads something into the list");
    assert.match(list, /list\[clientId\] = publicClientRecord\(client, room\);/);
    assert.equal(list.match(/\breturn\b/g)?.length, 1, "publicClientList can return before it builds the list");
  });

  it("spreads no connection record anywhere a payload is made", () => {
    for (const file of ["socket/utils/clients.ts", "socket/utils/server.ts"]) {
      assert.doesNotMatch(
        read(file),
        /\.\.\.(?:clientsInfo\[|(?:client|clientInfo|ci|info)\b)/,
        `${file} spreads a connection record`,
      );
    }
  });
});
