import consola from "consola";
import type { Server } from "socket.io";

import { blockedServerIdsFor, directConversationId, isConversationId } from "../../db";
import type { SFUClient } from "../../sfu/client";
import type { Clients } from "../../types";
import { endRingsFor } from "../handlers/calls";
import { removeFromVoice } from "./voiceLeave";
import { sfuRoomId } from "./voiceRooms";

interface VoiceWorld {
  io: Server;
  clientsInfo: Clients;
  serverId: string;
  sfuClient: SFUClient | null;
}

/** A block between two people ends their one-to-one call: the ring, and both of them
    in the room. Neither is told why, as the join refusal tells them nothing either. */
export async function endOneToOneCall(world: VoiceWorld, a: string, b: string): Promise<number> {
  const pairId = directConversationId(a, b);
  endRingsFor(world.io, world.clientsInfo, { withdrawn: pairId });

  const inCall = Object.entries(world.clientsInfo)
    .filter(([, ci]) => (ci.serverUserId === a || ci.serverUserId === b) && ci.hasJoinedChannel && ci.voiceChannelId === pairId)
    .map(([sid]) => sid);
  for (const sid of inCall) {
    await removeFromVoice({ ...world, sid });
  }
  if (inCall.length) consola.info(`[Block] ended the one-to-one call ${pairId}, ${inCall.length} socket(s) out`);
  return inCall.length;
}

/** In a group call a block takes nobody out. The SFU stops sending the blocker the
    media of whoever they blocked instead. Channels are left alone for now. */
export async function syncHiddenPeers(world: Omit<VoiceWorld, "io">, serverUserId: string): Promise<void> {
  const { clientsInfo, serverId, sfuClient } = world;
  if (!sfuClient) return;
  const inCall = Object.values(clientsInfo).find(
    (ci) => ci.serverUserId === serverUserId && ci.hasJoinedChannel && isConversationId(ci.voiceChannelId),
  );
  if (!inCall) return;
  const hidden = [...(await blockedServerIdsFor(serverUserId))];
  await sfuClient.setHiddenPeers(sfuRoomId(serverId, inCall.voiceChannelId), serverUserId, hidden);
}
