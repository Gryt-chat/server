import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Socket } from "socket.io";

import { sendInfo } from "./server";
import type { Clients } from "../../types";

const SOCKET_ID = "socket-1";

type Emitted = { event: string; payload: Record<string, unknown> };

function fakeSocket(emitted: Emitted[]): Socket {
  return {
    id: SOCKET_ID,
    emit: (event: string, payload: Record<string, unknown>) => {
      emitted.push({ event, payload });
      return true;
    },
  } as unknown as Socket;
}

function client(overrides: Partial<Clients[string]>): Clients[string] {
  return {
    serverUserId: "su_1",
    nickname: "someone",
    color: "#fff",
    isMuted: false,
    isDeafened: false,
    streamID: "",
    hasJoinedChannel: false,
    voiceChannelId: "",
    isAFK: false,
    cameraEnabled: false,
    cameraStreamID: "",
    screenShareEnabled: false,
    screenShareVideoStreamID: "",
    screenShareAudioStreamID: "",
    isServerMuted: false,
    isServerDeafened: false,
    ...overrides,
  };
}

beforeEach(() => {
  process.env.SERVER_VERSION = "9.9.9";
});

afterEach(() => {
  delete process.env.SERVER_VERSION;
});

describe("server:info version disclosure", () => {
  it("leaves the version out for a socket that has not joined", async () => {
    const emitted: Emitted[] = [];
    const clientsInfo: Clients = { [SOCKET_ID]: client({ serverUserId: "temp_1" }) };

    await sendInfo(fakeSocket(emitted), clientsInfo, "server-1");

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, "server:info");
    assert.ok(!("version" in emitted[0].payload));
  });

  it("leaves the version out when there is no client record at all", async () => {
    const emitted: Emitted[] = [];

    await sendInfo(fakeSocket(emitted), undefined, "server-1");

    assert.ok(!("version" in emitted[0].payload));
  });

  it("sends the version to a joined member", async () => {
    const emitted: Emitted[] = [];
    const clientsInfo: Clients = { [SOCKET_ID]: client({ grytUserId: "gu_1" }) };

    await sendInfo(fakeSocket(emitted), clientsInfo, "server-1");

    assert.equal(emitted[0].payload.version, "9.9.9");
  });

  it("does not leak the version to a second socket that has not joined", async () => {
    const emitted: Emitted[] = [];
    const clientsInfo: Clients = {
      "socket-other": client({ grytUserId: "gu_1", serverUserId: "su_other" }),
      [SOCKET_ID]: client({ serverUserId: "temp_2" }),
    };

    await sendInfo(fakeSocket(emitted), clientsInfo, "server-1");

    assert.ok(!("version" in emitted[0].payload));
  });
});
