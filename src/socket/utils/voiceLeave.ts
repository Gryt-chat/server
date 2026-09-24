import consola from "consola";
import type { Server } from "socket.io";

import type { SFUClient } from "../../sfu/client";
import type { Clients } from "../../types";
import { sfuRoomId, voiceRoomName } from "./voiceRooms";
import { forgetStashedVoiceState } from "./voiceStash";

export type VoiceSfu = Pick<SFUClient, "disconnectUser" | "untrackUserConnection">;

/** Takes a socket out of its call on the server's say, not the client's: the SFU,
    the room and the socket are all told. False when it was not in one. */
export async function removeFromVoice(params: {
  io: Server;
  clientsInfo: Clients;
  serverId: string;
  sfuClient: VoiceSfu | null;
  sid: string;
}): Promise<boolean> {
  const { io, clientsInfo, serverId, sfuClient, sid } = params;
  const ci = clientsInfo[sid];
  if (!ci?.hasJoinedChannel || !ci.voiceChannelId) return false;

  const channelId = ci.voiceChannelId;
  const serverUserId = ci.serverUserId;
  if (sfuClient) {
    await sfuClient
      .disconnectUser(sfuRoomId(serverId, channelId), serverUserId)
      .catch((e) => consola.warn("SFU disconnect on voice removal failed", e));
    sfuClient.untrackUserConnection(serverUserId);
  }

  // Otherwise the next SFU sync puts back somebody who was taken out on purpose.
  forgetStashedVoiceState(serverUserId);

  const roomName = voiceRoomName(serverId, channelId);
  const s = io.sockets.sockets.get(sid);
  const left = { clientId: sid, nickname: ci.nickname, channelId };
  if (s) {
    s.leave(roomName);
    s.to(roomName).emit("voice:peer:left", left);
    s.emit("voice:channel:joined", false);
    s.emit("voice:stream:set", "");
    s.emit("voice:room:leave");
  } else {
    io.to(roomName).emit("voice:peer:left", left);
  }

  ci.hasJoinedChannel = false;
  ci.voiceChannelId = "";
  ci.streamID = "";
  ci.isConnectedToVoice = false;
  ci.cameraEnabled = false;
  ci.cameraStreamID = "";
  ci.screenShareEnabled = false;
  ci.screenShareVideoStreamID = "";
  ci.screenShareAudioStreamID = "";
  return true;
}
