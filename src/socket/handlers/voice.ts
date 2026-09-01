import { sfuRoomId, voiceRoomName } from "../utils/voiceRooms";
import consola from "consola";
import type { HandlerContext, EventHandlerMap } from "./types";
import { requireAuth, requireOutranks } from "../middleware/auth";
import { syncAllClients, broadcastMemberList } from "../utils/clients";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";
import { getVoiceSeatLimit } from "../../utils/voiceSeats";
import { insertServerAudit } from "../../db";
import { socketIsIdentified, socketMay as socketMayFor } from "../utils/standing";
import { forgetStashedVoiceState } from "../utils/voiceStash";
import { DENIAL_RESPONSES, resolveConversationAccess } from "../utils/conversationAccess";
import { isConversationId } from "../../db";
import { endRingsFor } from "./calls";
import type { Permission } from "../../constants/permissions";
import { mayInChannel } from "../../services/channelPermissions";
import { CAP_SPEAK } from "../../sfu/clientToken";

const RL_REQUEST_ROOM: RateLimitRule = { limit: 10, windowMs: 60_000, scorePerAction: 1, maxScore: 8, scoreDecayMs: 5000 };
const RL_JOINED_CHANNEL: RateLimitRule = { limit: 10, windowMs: 60_000, scorePerAction: 0.5, maxScore: 6, scoreDecayMs: 3000 };
// Tighter than a real room request. Nobody needs to run the Doctor twice a
// minute, and this grants a live SFU credential, so the cheap way to abuse it
// is to ask repeatedly.
const RL_DOCTOR_ROOM: RateLimitRule = { limit: 3, windowMs: 60_000, scorePerAction: 2, maxScore: 6, scoreDecayMs: 10_000 };

export function registerVoiceHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, serverId, clientsInfo, sfuClient, getClientIp } = ctx;

  /**
   * Whether the socket's own member may do something.
   *
   * The voice events are the one family that carries no access token — they are
   * sent continuously by a client that has already joined, and the socket's
   * identity is what `clientsInfo` records. `socketMay` in utils/standing is
   * the shared version; this is the same call with the two things every use
   * here would repeat already filled in.
   */
  function socketMay(permission: Permission): Promise<boolean> {
    return socketMayFor(clientsInfo, clientId, permission);
  }

  /**
   * Refuse without closing the door, for a socket that has not said who it is.
   *
   * On a reconnect the client sends `session:restore` and its voice
   * re-announce together, and they race. Caught on prod on 2026-08-27, three
   * milliseconds apart:
   *
   *     15:37:31.804  voice:room:request  user=temp_rsBB
   *     15:37:31.807  FORBIDDEN           user=temp_rsBB lacks join_voice
   *     15:37:31.810  Restored session:   Sivert
   *
   * A placeholder user holds no permissions, so every gate here said
   * `forbidden` — and `forbidden` is the one answer the client will not retry,
   * on the reasonable grounds that a permission decision does not change if you
   * ask again. This one changed three milliseconds later, so the single case it
   * refused to retry was the case that would have worked. It gave up, fell back
   * to a full reconnect, and put the user out of the channel.
   *
   * So an unidentified socket gets its own code. The client's re-announce
   * backs off [0, 2000, 5000] on anything that is not `forbidden`, so the
   * second attempt lands well after the restore.
   *
   * Returns true when it has answered, so callers read as a guard.
   */
  function refusedAsUnidentified(): boolean {
    if (socketIsIdentified(clientsInfo, clientId)) return false;

    socket.emit("voice:room:error", {
      error: "unidentified",
      message: "Still working out who you are — try again in a moment.",
      retryAfterMs: 2000,
    });

    return true;
  }

  return {
    'voice:camera:state': async (payload: { enabled: boolean; streamId?: string }) => {
      if (!clientsInfo[clientId]) return;
      const enabled = typeof payload === 'boolean' ? payload : Boolean(payload?.enabled);
      const streamId = typeof payload === 'object' ? (payload.streamId || "") : "";
      // Same race as the room request, one event later (GRYT-717). The client
      // re-asserts its camera after a reconnect, and a socket mid-restore has
      // no permissions yet, so this said `forbidden` and the camera stayed off
      // in the room while it was still sending. Guarded before the permission
      // check, not instead of it.
      if (enabled && refusedAsUnidentified()) return;
      // Turning a camera *off* is never refused. A permission that was taken
      // away mid-call would otherwise leave somebody unable to stop streaming.
      if (enabled && !(await socketMay("share_video"))) {
        socket.emit("voice:room:error", {
          error: "forbidden",
          message: "You do not have permission to share video here.",
          permission: "share_video",
        });
        return;
      }
      clientsInfo[clientId].cameraEnabled = enabled;
      clientsInfo[clientId].cameraStreamID = enabled ? streamId : "";
      syncAllClients(io, clientsInfo);
    },

    'voice:screen:state': async (payload: { enabled: boolean; videoStreamId?: string; audioStreamId?: string }) => {
      if (!clientsInfo[clientId]) return;
      const enabled = typeof payload === 'object' ? Boolean(payload?.enabled) : Boolean(payload);
      const videoStreamId = typeof payload === 'object' ? (payload.videoStreamId || "") : "";
      const audioStreamId = typeof payload === 'object' ? (payload.audioStreamId || "") : "";
      // As above (GRYT-717). Turning a share off is never refused either.
      if (enabled && refusedAsUnidentified()) return;
      if (enabled && !(await socketMay("share_screen"))) {
        socket.emit("voice:room:error", {
          error: "forbidden",
          message: "You do not have permission to share your screen here.",
          permission: "share_screen",
        });
        return;
      }
      consola.info(`[ScreenShare] voice:screen:state from=${clientId} enabled=${enabled} videoStreamId=${videoStreamId} audioStreamId=${audioStreamId}`);
      clientsInfo[clientId].screenShareEnabled = enabled;
      clientsInfo[clientId].screenShareVideoStreamID = enabled ? videoStreamId : "";
      clientsInfo[clientId].screenShareAudioStreamID = enabled ? audioStreamId : "";
      syncAllClients(io, clientsInfo);
    },

    'voice:state:update': async (clientState: { isMuted: boolean; isDeafened: boolean; isAFK: boolean }) => {
      if (!clientsInfo[clientId]) return;
      // Somebody with `join_voice` and not `speak` is a listener: they are in
      // the room and cannot be heard. Enforced by refusing to record them as
      // unmuted rather than by refusing the event, so the client's mute button
      // still works in the direction that always has to — and the corrected
      // state comes straight back on the sync below.
      let isMuted = Boolean(clientState.isMuted);
      /* Unidentified is not the same as unpermitted here either. Forcing the
         mute on a socket mid-restore records the wrong state and tells somebody
         they cannot speak, both on the strength of not knowing yet. They are
         not in a member list while unidentified — clients.ts filters `temp_`
         out — so nothing is shown either way until the restore lands and the
         next update is evaluated properly. */
      if (!isMuted && socketIsIdentified(clientsInfo, clientId) && !(await socketMay("speak"))) {
        isMuted = true;
        socket.emit("voice:room:error", {
          error: "forbidden",
          message: "You can listen here, but not speak.",
          permission: "speak",
        });
      }
      clientsInfo[clientId].isMuted = isMuted;
      clientsInfo[clientId].isDeafened = Boolean(clientState.isDeafened);
      clientsInfo[clientId].isAFK = Boolean(clientState.isAFK);
      syncAllClients(io, clientsInfo);

      if (sfuClient && clientsInfo[clientId].hasJoinedChannel) {
        const ci = clientsInfo[clientId];
        const effectiveMuted = ci.isMuted || ci.isServerMuted;
        const effectiveDeafened = ci.isDeafened || ci.isServerDeafened;
        sfuClient.updateUserAudioState(sfuRoomId(serverId, ci.voiceChannelId), ci.serverUserId, effectiveMuted, effectiveDeafened).catch((e) => {
          consola.error("Failed to update SFU audio state:", e);
        });
      }
    },

    /**
     * Where the sender's face sits in their own camera frame, so everyone
     * else can move their crop to match.
     *
     * Deliberately not part of voice:state:update, which calls syncAllClients
     * and rebuilds the whole member list. This arrives a few times a second
     * per speaker with a camera on, so it is relayed as-is and nothing else
     * happens: two numbers, straight out to the room.
     *
     * Not stored either. A client that joins mid-call sees a centred crop
     * until the next update, which is at most a few seconds away, and that is
     * cheaper than putting a field that changes this often into the member
     * list.
     */
    'voice:framing:set': (framing: { x: number; y: number }) => {
      const ci = clientsInfo[clientId];
      if (!ci || !ci.hasJoinedChannel) return;

      const clamp = (n: number) =>
        Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;

      const roomName = ci.voiceChannelId
        ? voiceRoomName(serverId, ci.voiceChannelId)
        : "";
      if (!roomName) return;

      socket.to(roomName).emit('voice:framing', {
        clientId,
        x: clamp(framing?.x),
        y: clamp(framing?.y),
      });
    },

    'voice:stream:set': (streamID: string) => {
      if (!clientsInfo[clientId]) return;
      const wasInChannel = clientsInfo[clientId].hasJoinedChannel;
      const newJoinedState = streamID.length > 0;
      const serverUserId = clientsInfo[clientId].serverUserId;
      consola.info(`[Voice:stream:set] client=${clientId} user=${serverUserId} streamID="${streamID}" wasInChannel=${wasInChannel}`);

      // Duplicate connection detection
      if (newJoinedState && serverUserId) {
        const existingConnection = Object.entries(clientsInfo).find(
          ([otherId, ci]) => otherId !== clientId && ci.serverUserId === serverUserId && ci.hasJoinedChannel,
        );

        if (existingConnection) {
          const [existingClientId] = existingConnection;
          consola.warn(`Device switch detected for ${serverUserId}`);
          const existingSocket = io.sockets.sockets.get(existingClientId);
          if (existingSocket) {
            const prevChannelId = clientsInfo[existingClientId]?.voiceChannelId || "";
            if (prevChannelId) {
              existingSocket.leave(voiceRoomName(serverId, prevChannelId));
            }
            existingSocket.emit("voice:device:disconnect", {
              type: "device_switch",
              message: "Disconnected: you connected from another device.",
            });
            existingSocket.emit("voice:channel:joined", false);
            existingSocket.emit("voice:stream:set", "");
            existingSocket.emit("voice:room:leave");
            clientsInfo[existingClientId].hasJoinedChannel = false;
            clientsInfo[existingClientId].voiceChannelId = "";
            clientsInfo[existingClientId].streamID = "";
            clientsInfo[existingClientId].cameraEnabled = false;
            clientsInfo[existingClientId].cameraStreamID = "";
            clientsInfo[existingClientId].screenShareEnabled = false;
            clientsInfo[existingClientId].screenShareVideoStreamID = "";
            clientsInfo[existingClientId].screenShareAudioStreamID = "";
            if (sfuClient) sfuClient.untrackUserConnection(serverUserId);
          }
        }

        if (sfuClient) {
          sfuClient.untrackUserConnection(serverUserId);
          const roomId = `${serverUserId}:${streamID}`;
          const allowed = sfuClient.trackUserConnection(roomId, serverUserId);
          if (!allowed) {
            socket.emit("voice:error", { type: "duplicate_connection", message: "Already connected to a voice channel.", source: "sfu" });
            return;
          }
        }
      }

      const prevStreamID = clientsInfo[clientId].streamID;
      if (prevStreamID === streamID) return;

      clientsInfo[clientId].streamID = streamID;
      if (!newJoinedState) {
        if (serverUserId) forgetStashedVoiceState(serverUserId);
        clientsInfo[clientId].cameraEnabled = false;
        clientsInfo[clientId].cameraStreamID = "";
        clientsInfo[clientId].screenShareEnabled = false;
        clientsInfo[clientId].screenShareVideoStreamID = "";
        clientsInfo[clientId].screenShareAudioStreamID = "";
        if (sfuClient && serverUserId) sfuClient.untrackUserConnection(serverUserId);
      }

      syncAllClients(io, clientsInfo);
      broadcastMemberList(io, clientsInfo, serverId);
    },

    /**
     * A room of one, for finding out whether voice works at all.
     *
     * The Doctor can already reach the SFU over HTTP and open a WebSocket, but
     * neither proves media flows: that needs a real ICE negotiation against a
     * real room, and the selected candidate pair afterwards is the answer to
     * "which address did media actually take".
     *
     * Deliberately not `voice:room:request` with a made-up name, though that
     * would work — the SFU creates rooms on demand and the room id has always
     * come from the client. Two things make it its own event. It must not set
     * `voiceChannelId`, which would put the person in the member list as being
     * in a channel that does not exist. And it should be refusable on its own,
     * without taking voice with it.
     *
     * Same permission as joining voice for real, because it is the same act
     * against the same media plane. Somebody who may not speak here has no
     * business opening a peer connection to find out whether they could.
     */
    'voice:doctor:request': async () => {
      const userId = clientsInfo[clientId]?.serverUserId;
      consola.info(`[Voice:Doctor] request from client=${clientId} user=${userId}`);

      try {
        const rl = checkRateLimit("voice:doctor:request", userId, getClientIp(), RL_DOCTOR_ROOM);
        if (!rl.allowed) {
          socket.emit("voice:doctor:error", {
            error: "rate_limited",
            retryAfterMs: rl.retryAfterMs,
            message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.`,
          });
          return;
        }

        if (!(await socketMay("join_voice"))) {
          socket.emit("voice:doctor:error", {
            error: "forbidden",
            message: "You do not have permission to join voice on this server.",
            permission: "join_voice",
          });
          return;
        }

        if (!sfuClient || !sfuClient.isConnected()) {
          socket.emit("voice:doctor:error", {
            error: "sfu_unavailable",
            message: "The server cannot reach its own voice service, so there is nothing to test against.",
          });
          return;
        }

        // Named for the member, so two people testing at once do not land in
        // the same room and hear each other. Nothing else can address it: the
        // channel list is the server's, and this is not in it.
        const uniqueRoomId = sfuRoomId(serverId, `doctor:${userId ?? clientId}`);
        await sfuClient.registerRoom(uniqueRoomId);

        /* Always allowed to speak. This is a room of one, named for the member
         * and reachable from nothing else, and the whole point of it is to hear
         * your own microphone back. Applying a channel's `speak` denial here
         * would take the microphone test away from exactly the person most
         * likely to be wondering why nobody can hear them. */
        const joinToken = sfuClient.generateClientJoinToken(uniqueRoomId, userId, [CAP_SPEAK]);
        const sfuPublicRaw = process.env.SFU_PUBLIC_HOST || process.env.SFU_WS_HOST || "";
        const sfuPublicUrls = sfuPublicRaw.split(",").map((h) => h.trim()).filter(Boolean);

        consola.success(`[Voice:Doctor] granted client=${clientId} room=${uniqueRoomId}`);
        socket.emit("voice:doctor:granted", {
          room_id: uniqueRoomId,
          join_token: joinToken,
          sfu_url: sfuPublicUrls[0],
          sfu_urls: sfuPublicUrls,
          timestamp: Date.now(),
        });
      } catch (error) {
        consola.error(`[Voice:Doctor] failed for client=${clientId}:`, error);
        socket.emit("voice:doctor:error", {
          error: "failed",
          message: error instanceof Error ? error.message : "Could not set up a test room",
        });
      }
    },

    'voice:room:request': async (roomId: string) => {
      const userId = clientsInfo[clientId]?.serverUserId;
      consola.info(`[Voice:Step 1] voice:room:request from client=${clientId} user=${userId} room=${roomId}`);
      try {
        const ip = getClientIp();
        const rl = checkRateLimit("voice:room:request", userId, ip, RL_REQUEST_ROOM);
        if (!rl.allowed) {
          consola.warn(`[Voice:Step 1] RATE LIMITED client=${clientId}`);
          socket.emit("voice:room:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs, message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.` });
          return;
        }
        if (!roomId || typeof roomId !== "string") {
          consola.warn(`[Voice:Step 1] Invalid room ID from client=${clientId}: ${roomId}`);
          socket.emit("voice:room:error", "Invalid room ID");
          return;
        }
        if (refusedAsUnidentified()) {
          consola.info(`[Voice:Step 1] not identified yet client=${clientId} — asked to retry`);
          return;
        }
        if (!(await socketMay("join_voice"))) {
          consola.warn(`[Voice:Step 1] FORBIDDEN client=${clientId} user=${userId} lacks join_voice`);
          socket.emit("voice:room:error", {
            error: "forbidden",
            message: "You do not have permission to join voice on this server.",
            permission: "join_voice",
          });
          return;
        }
        /**
         * Whether this room is one of theirs.
         *
         * Until this check existed the handler granted an SFU token for any
         * string at all — the only gate was `join_voice`, which says whether
         * somebody may use voice on this server, not *where*. That was
         * survivable while every room id was a channel, because a channel is
         * open to every member anyway.
         *
         * A conversation is not. Its id is derived from the sorted pair of
         * member ids and `conversations.ts` says in as many words that it is
         * not a secret — anybody who can read a member list can compute the id
         * of any two people's conversation. So an ungated room request is a way
         * to sit in someone else's private call by working out its name, and it
         * becomes reachable the moment a client asks for a conversation room.
         *
         * `resolveConversationAccess` is the same answer the chat events get,
         * deliberately: two rules for who may touch a conversation is two rules
         * to disagree. It also refuses an id that is neither a channel nor a
         * conversation, which is how a made-up room stops being free.
         */
        const access = await resolveConversationAccess(roomId, userId);
        if (!access.allowed) {
          const denial = DENIAL_RESPONSES[access.reason];
          consola.warn(`[Voice:Step 1] REFUSED client=${clientId} user=${userId} room=${roomId} reason=${access.reason}`);
          socket.emit("voice:room:error", { error: denial.error, message: denial.message });
          return;
        }

        if (!sfuClient) {
          consola.error(`[Voice:Step 2] SFU client not initialized`);
          socket.emit("voice:room:error", "Voice service unavailable");
          return;
        }
        if (!sfuClient.isConnected()) {
          consola.error(`[Voice:Step 2] SFU client not connected`, sfuClient.getConnectionStatus());
          socket.emit("voice:room:error", "Voice service temporarily unavailable");
          return;
        }

        consola.info(`[Voice:Step 2] SFU client connected, checking seats…`);
        const seatLimit = getVoiceSeatLimit();
        if (seatLimit && seatLimit > 0) {
          const used = sfuClient.getActiveUsers().size;
          consola.info(`[Voice:Step 2] Seat check: ${used}/${seatLimit}`);
          if (used >= seatLimit) {
            consola.warn(`[Voice:Step 2] Server full: ${used}/${seatLimit}`);
            socket.emit("voice:room:error", { error: "server_full", message: `No seats left (${used}/${seatLimit}).`, used, max: seatLimit });
            return;
          }
        }

        if (clientsInfo[clientId]) {
          clientsInfo[clientId].voiceChannelId = roomId;
        }

        const uniqueRoomId = sfuRoomId(serverId, roomId);
        consola.info(`[Voice:Step 3] Registering room ${uniqueRoomId} with SFU…`);
        await sfuClient.registerRoom(uniqueRoomId);
        consola.info(`[Voice:Step 3] Room registered: ${uniqueRoomId}`);

        const serverUserId = clientsInfo[clientId]?.serverUserId;

        /* What the SFU will let them publish, decided here because this is
         * where the channel is known. Audio never reaches this server, so this
         * is the only chance to say it: the token is the whole mechanism.
         *
         * `mayInChannel` against the channel id rather than `uniqueRoomId` —
         * the latter is the SFU's name for the room and has the server id
         * folded into it, so it matches no scope and would answer from the
         * server-wide permission every time.
         *
         * Denied `speak` still joins. They hear everything and their microphone
         * is dropped at the SFU, which is the announcement-channel case this
         * exists for rather than a refusal to let them in. */
        const capabilities = (await mayInChannel(roomId, serverUserId, "speak")) ? [CAP_SPEAK] : [];

        consola.info(`[Voice:Step 4] Generating join token for client=${clientId} user=${serverUserId} room=${uniqueRoomId} caps=[${capabilities.join(",")}]`);
        const joinToken = sfuClient.generateClientJoinToken(uniqueRoomId, serverUserId, capabilities);
        const sfuPublicRaw = process.env.SFU_PUBLIC_HOST || process.env.SFU_WS_HOST || "";
        const sfuPublicUrls = sfuPublicRaw.split(",").map(h => h.trim()).filter(Boolean);
        const sfuPublicUrl = sfuPublicUrls[0];

        consola.success(`[Voice:Step 5] Granting room access: client=${clientId} room=${uniqueRoomId} sfu_urls=${sfuPublicUrls.join(", ")}`);
        socket.emit("voice:room:granted", { room_id: uniqueRoomId, join_token: joinToken, sfu_url: sfuPublicUrl, sfu_urls: sfuPublicUrls, timestamp: Date.now() });
      } catch (error) {
        consola.error(`[Voice:FAIL] Room access error for client=${clientId} room=${roomId}:`, error);
        socket.emit("voice:room:error", error instanceof Error ? error.message : "Failed to grant room access");
      }
    },

    'voice:channel:joined': async (hasJoined: boolean) => {
      if (!clientsInfo[clientId]) return;
      const ip = getClientIp();
      const userId = clientsInfo[clientId]?.serverUserId;
      consola.info(`[Voice:channel:joined] client=${clientId} user=${userId} hasJoined=${hasJoined}`);
      const rl = checkRateLimit("voice:channel:joined", userId, ip, RL_JOINED_CHANNEL);
      if (!rl.allowed) {
        socket.emit("voice:room:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs, message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.` });
        return;
      }

      const wasInChannel = clientsInfo[clientId].hasJoinedChannel;
      const newJoinedState = Boolean(hasJoined);
      if (wasInChannel === newJoinedState) return;

      // Joining is refused; leaving never is. Without a room grant this socket
      // has no media path anyway, but the flag is what puts somebody in the
      // member list as being in voice — so left ungated it is a way to appear
      // in a channel you were not let into.
      if (newJoinedState && refusedAsUnidentified()) return;

      if (newJoinedState && !(await socketMay("join_voice"))) {
        socket.emit("voice:room:error", {
          error: "forbidden",
          message: "You do not have permission to join voice on this server.",
          permission: "join_voice",
        });
        return;
      }

      const channelId = clientsInfo[clientId].voiceChannelId || "";
      const roomName = channelId ? voiceRoomName(serverId, channelId) : "";

      if (newJoinedState) {
        if (roomName) socket.join(roomName);

        // Answering a call is joining its room. There is no `call:accept` —
        // one message that says "I am in" is better than two that can
        // disagree, and this is the one that is already true when the media
        // starts flowing.
        //
        // Ends the ring for the caller and for this person's *other* devices,
        // which is the point: answering on the laptop has to stop the phone.
        if (channelId && isConversationId(channelId)) {
          endRingsFor(io, clientsInfo, {
            conversationId: channelId,
            answeredBy: clientsInfo[clientId].serverUserId,
          });
        }
      } else {
        if (roomName) socket.leave(roomName);
      }

      clientsInfo[clientId].hasJoinedChannel = newJoinedState;
      if (!newJoinedState) {
        // Leaving on purpose. Drop anything held against this user so the SFU
        // sync cannot put them back on the way out — the media connection takes
        // a moment to actually close, and for that moment the SFU still has
        // them (GRYT-611).
        const leavingUserId = clientsInfo[clientId].serverUserId;
        if (leavingUserId) forgetStashedVoiceState(leavingUserId);
        clientsInfo[clientId].isConnectedToVoice = false;
        clientsInfo[clientId].voiceChannelId = "";
        clientsInfo[clientId].cameraEnabled = false;
        clientsInfo[clientId].cameraStreamID = "";
        clientsInfo[clientId].screenShareEnabled = false;
        clientsInfo[clientId].screenShareVideoStreamID = "";
        clientsInfo[clientId].screenShareAudioStreamID = "";
      }

      syncAllClients(io, clientsInfo);

      /*
       * This is the event that sets `hasJoinedChannel`, so it is the one that
       * has to announce the call.
       *
       * A client sends `voice:stream:set` and then this, ten milliseconds
       * apart. `voice:stream:set` broadcasts; this one did not. So the count of
       * who is in a call was always taken a moment before the flag that puts
       * somebody in it — and for the first person into a room that count is
       * zero, which sends nothing at all.
       *
       * The caller pressed Call and got an empty voice view until somebody
       * answered, because the answer was the next thing to run the count
       * (GRYT-713).
       */
      broadcastMemberList(io, clientsInfo, serverId);

      if (newJoinedState && !wasInChannel) {
        if (roomName) {
          socket.to(roomName).emit("voice:peer:joined", {
            clientId,
            nickname: clientsInfo[clientId].nickname,
            channelId,
          });
        }
      } else if (!newJoinedState && wasInChannel) {
        if (roomName) {
          socket.to(roomName).emit("voice:peer:left", {
            clientId,
            nickname: clientsInfo[clientId].nickname,
            channelId,
          });
        }
      }
    },

    'voice:peer:connected': (streamId: string) => {
      const c = Object.keys(clientsInfo).find((id) => clientsInfo[id].streamID === streamId);
      if (c && clientsInfo[c]) {
        clientsInfo[c].isConnectedToVoice = true;
        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
      }
    },

    'voice:peer:disconnected': (streamId: string) => {
      const c = Object.keys(clientsInfo).find((id) => clientsInfo[id].streamID === streamId);
      if (c && clientsInfo[c]) {
        clientsInfo[c].isConnectedToVoice = false;
        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
      }
    },

    'voice:disconnect:user': async (payload: { accessToken: string; targetServerUserId: string }) => {
      try {
        if (!payload || typeof payload.targetServerUserId !== "string") {
          socket.emit("server:error", { error: "invalid_payload", message: "targetServerUserId required." });
          return;
        }

        const auth = await requireAuth(socket, payload, { permission: "disconnect_members" });
        if (!auth) return;

        const targetUserId = payload.targetServerUserId.trim();

        // There was no target check here at all — only the self-check — so an
        // admin could disconnect the owner from voice, which server:kick has
        // always refused.
        if (!(await requireOutranks(socket, auth, targetUserId, "disconnect"))) return;

        // Find the target user's socket(s)
        const targetEntry = Object.entries(clientsInfo).find(
          ([, ci]) => ci.serverUserId === targetUserId && ci.hasJoinedChannel,
        );

        if (!targetEntry) {
          socket.emit("server:error", { error: "not_found", message: "User is not in a voice channel." });
          return;
        }

        const [targetSocketId, targetClient] = targetEntry;
        const targetSocket = io.sockets.sockets.get(targetSocketId);

        consola.info(`[Voice:kick] actor=${auth.tokenPayload.serverUserId} target=${targetUserId} channel=${targetClient.streamID}`);

        // Tell the SFU to force-close the user's WebRTC connection
        if (sfuClient && targetClient.streamID) {
          // The channel id, not the stream id. The room registered with the SFU
          // is `${serverId}_${voiceChannelId}` (see the join path above), so
          // this was addressing a room that does not exist and the forced
          // disconnect quietly did nothing.
          const uniqueRoomId = sfuRoomId(serverId, targetClient.voiceChannelId);
          sfuClient.disconnectUser(uniqueRoomId, targetUserId).catch((e) => {
            consola.error("[Voice:kick] SFU disconnectUser failed:", e);
          });
        }

        // Notify the target client
        if (targetSocket) {
          targetSocket.emit("voice:kicked", { reason: "Disconnected from voice by an admin." });
          targetSocket.emit("voice:channel:joined", false);
          targetSocket.emit("voice:stream:set", "");
          targetSocket.emit("voice:room:leave");
        }

        // Notify other clients about the peer leaving
        if (targetSocket) {
          const channelId = targetClient.voiceChannelId || "";
          const roomName = channelId ? voiceRoomName(serverId, channelId) : "";
          if (roomName) {
            targetSocket.leave(roomName);
            targetSocket.to(roomName).emit("voice:peer:left", {
              clientId: targetSocketId,
              nickname: targetClient.nickname,
              channelId,
            });
          }
        }

        // Update server state
        targetClient.hasJoinedChannel = false;
        targetClient.voiceChannelId = "";
        targetClient.streamID = "";
        targetClient.isConnectedToVoice = false;
        targetClient.cameraEnabled = false;
        targetClient.cameraStreamID = "";
        targetClient.screenShareEnabled = false;
        targetClient.screenShareVideoStreamID = "";
        targetClient.screenShareAudioStreamID = "";
        if (sfuClient) sfuClient.untrackUserConnection(targetUserId);

        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);

        insertServerAudit({
          actorServerUserId: auth.tokenPayload.serverUserId,
          action: "voice_disconnect",
          target: targetUserId,
        }).catch((e) => consola.warn("audit log write failed", e));

        socket.emit("voice:disconnect:success", { targetServerUserId: targetUserId });
      } catch (e) {
        consola.error("voice:disconnect:user failed", e);
        socket.emit("server:error", { error: "disconnect_failed", message: "Failed to disconnect user." });
      }
    },
  };
}
