import { sfuRoomId, voiceRoomName } from "./utils/voiceRooms";
import consola from "consola";
import { Server, Socket } from "socket.io";
import { Clients } from "../types";
import { colors } from "../utils/colors";
import { SFUClient } from "../sfu/client";
import type { SFUPeerEvent, SFUSyncRoom } from "../sfu/client";
import { verifyAccessToken } from "../utils/jwt";
import { getServerConfig, effectiveModerationState } from "../db";
import { checkSessionAllowed } from "../moderation/sessionGate";
import { syncAllClients, verifyClient, broadcastMemberList, countOtherSessions } from "./utils/clients";
import { stashedVoiceState, type StashedVoiceState, voiceStateOf } from "./utils/voiceStash";
import { sendInfo, sendServerDetails, setSocketRefs, broadcastChatNew, broadcastCustomEmojisUpdate, broadcastEmojiQueueUpdate, broadcastServerUiUpdate } from "./utils/server";
import { getServerIdFromEnv } from "../utils/serverId";

import type { HandlerContext, EventHandlerMap } from "./handlers/types";
import { registerJoinHandlers } from "./handlers/join";
import { registerAdminHandlers } from "./handlers/admin";
import { getVouchChain, signServerProof } from "../auth/serverIdentity";
import { registerChatHandlers } from "./handlers/chat";
import { registerDirectMessageHandlers } from "./handlers/dm";
import { registerVoiceHandlers } from "./handlers/voice";
import { endRingsFor, registerCallHandlers } from "./handlers/calls";
import { registerMemberHandlers } from "./handlers/members";
import { registerDiagnosticsHandlers } from "./handlers/diagnostics";
import { registerVoiceLatencyHandlers } from "./handlers/voiceLatency";
import { registerReportHandlers } from "./handlers/reports";
import { registerBlockHandlers } from "./handlers/blocks";
import { registerTypingHandlers } from "./handlers/typing";
import { registerDmKeyHandlers } from "./handlers/dmKeys";
import { addressIsOwn, resolveClientIp, trustedProxyHops } from "../config/clientAddress";

export { broadcastChatNew, broadcastCustomEmojisUpdate, broadcastEmojiQueueUpdate, broadcastServerUiUpdate };

const clientsInfo: Clients = {};

// The client's nonce is echoed into something this server signs, so it is
// attacker-supplied input under our own signature. 256 is well clear of the
// 32-byte base64url value a client actually sends.
const MAX_CLIENT_NONCE_LENGTH = 256;

/**
 * Put a held voice state onto a socket, and put that socket in the room.
 *
 * Shared by the two things that restore voice: `session:restore`, which runs
 * the moment a client comes back, and the SFU sync, which catches everything
 * else. Both used to be written out longhand, and only one of them existed.
 *
 * `channelId` is passed separately because the two callers know it from
 * different places, and they do not always agree. The sync reads it from the
 * SFU's own room list, which is the better answer — the SFU is where the media
 * actually is, so if the held state says otherwise the held state is stale.
 */
function applyVoiceState(
  socket: Socket,
  clientId: string,
  state: StashedVoiceState,
  channelId: string,
  serverId: string,
): void {
  const ci = clientsInfo[clientId];
  if (!ci) return;

  ci.hasJoinedChannel = true;
  ci.voiceChannelId = channelId;
  ci.streamID = state.streamID;
  ci.isConnectedToVoice = true;
  ci.screenShareEnabled = state.screenShareEnabled;
  ci.screenShareVideoStreamID = state.screenShareVideoStreamID;
  ci.screenShareAudioStreamID = state.screenShareAudioStreamID;
  ci.cameraEnabled = state.cameraEnabled;
  ci.cameraStreamID = state.cameraStreamID;
  ci.isMuted = state.isMuted;
  ci.isDeafened = state.isDeafened;

  const roomName = channelId ? voiceRoomName(serverId, channelId) : "";
  if (roomName) socket.join(roomName);

  socket.emit("voice:state:restored", {
    channelId,
    streamID: state.streamID,
  });
}

/**
 * Wire SFU peer_joined / peer_left / sync_response callbacks so the server
 * stays in 1:1 sync with the SFU about who is connected.
 * Call this once after the io server and sfuClient are created.
 */
export function setupSFUSync(io: Server, sfuClient: SFUClient): void {
  const serverId = getServerIdFromEnv();

  sfuClient.setCallbacks({
    onPeerJoined(ev: SFUPeerEvent) {
      sfuClient.trackUserConnection(ev.roomId, ev.userId);
    },

    onPeerLeft(ev: SFUPeerEvent) {
      const RECONNECT_GRACE_MS = 10_000;
      const tracked = sfuClient.getTrackedUser(ev.userId);

      if (tracked && (Date.now() - tracked.connectedAt) < RECONNECT_GRACE_MS) {
        consola.info(
          `[SFU-Sync] Ignoring stale peer_left for ${ev.userId} — ` +
          `reconnected ${Date.now() - tracked.connectedAt}ms ago`,
        );
        return;
      }

      sfuClient.untrackUserConnection(ev.userId);

      let changed = false;
      for (const [sid, ci] of Object.entries(clientsInfo)) {
        if (ci.serverUserId === ev.userId && ci.hasJoinedChannel) {
          const nickname = ci.nickname;
          const channelId = ci.voiceChannelId || "";
          const roomName = channelId ? voiceRoomName(serverId, channelId) : "";
          ci.hasJoinedChannel = false;
          ci.voiceChannelId = "";
          ci.streamID = "";
          ci.isConnectedToVoice = false;
          ci.cameraEnabled = false;
          ci.cameraStreamID = "";
          ci.screenShareEnabled = false;
          ci.screenShareVideoStreamID = "";
          ci.screenShareAudioStreamID = "";

          const sock = io.sockets.sockets.get(sid);
          if (sock) {
            if (roomName) {
              sock.leave(roomName);
              sock.to(roomName).emit("voice:peer:left", { clientId: sid, nickname, channelId });
            }
            sock.emit("voice:channel:joined", false);
            sock.emit("voice:stream:set", "");
            sock.emit("voice:room:leave");
          }
          changed = true;
        }
      }

      if (changed) {
        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
      }
    },

    onSyncResponse(rooms: SFUSyncRoom[]) {
      const sfuUsers = new Set<string>();
      const userToChannelId = new Map<string, string>();
      const serverPrefix = `${serverId}_`;
      for (const room of rooms) {
        const channelId = room.room_id.startsWith(serverPrefix)
          ? room.room_id.substring(serverPrefix.length)
          : room.room_id;
        for (const uid of room.user_ids) {
          sfuUsers.add(uid);
          userToChannelId.set(uid, channelId);
          // Only if it is not already known. `trackUserConnection` warns when
          // it is — which is the right thing to say when a second device tries
          // to join, and pure noise thirty times a minute from a sync loop.
          //
          // It also stamps `connectedAt`, which `onPeerLeft` reads to tell a
          // stale peer_left from a real one. Re-stamping it every couple of
          // seconds would keep it permanently inside that window and every
          // leave would be ignored as stale.
          if (!sfuClient.getTrackedUser(uid)) {
            sfuClient.trackUserConnection(room.room_id, uid);
          }
        }
      }

      let changed = false;

      // Update voiceChannelId for active users from SFU state
      for (const [, ci] of Object.entries(clientsInfo)) {
        if (ci.hasJoinedChannel && sfuUsers.has(ci.serverUserId)) {
          const channelId = userToChannelId.get(ci.serverUserId);
          if (channelId && ci.voiceChannelId !== channelId) {
            ci.voiceChannelId = channelId;
            changed = true;
          }
        }
      }

      // Put back anyone the SFU is carrying that the socket layer has lost.
      //
      // This is the half that was missing, and it is why the whole thing could
      // only ever be wrong in one direction. Every path here was gated on
      // `hasJoinedChannel` already being true, so the SFU could take somebody
      // out of a channel and never put anybody in one — which is exactly the
      // state a reconnect leaves behind (GRYT-611).
      for (const uid of sfuUsers) {
        const alreadyLive = Object.values(clientsInfo).some(
          (ci) => ci.serverUserId === uid && ci.hasJoinedChannel,
        );
        if (alreadyLive) continue;

        const stashed = stashedVoiceState.get(uid);
        // Nothing held for them. The SFU is carrying a peer this server has no
        // record of ever being in voice — a leftover from a previous process,
        // or somebody mid-join. Not ours to invent a stream id for; peer_left
        // and the SFU's own room lifetime deal with it.
        if (!stashed) continue;

        // Their socket, if they have one. Somebody whose media is still up but
        // whose client has not reconnected yet has nothing to attach to, and
        // the entry keeps waiting for them.
        const sockets = Object.entries(clientsInfo).filter(
          ([, ci]) => ci.serverUserId === uid,
        );
        if (sockets.length === 0) continue;

        // The newest, which is insertion order. A user with two is mid-device
        // switch, and the one that just arrived is the one they are looking at.
        const [sid] = sockets[sockets.length - 1];
        const sock = io.sockets.sockets.get(sid);
        if (!sock) continue;

        const channelId = userToChannelId.get(uid) || stashed.voiceChannelId;
        stashedVoiceState.delete(uid);
        consola.info(`[SFU-Sync] Restoring voice for ${uid} in ${channelId} — SFU has them, this server did not`);
        applyVoiceState(sock, sid, stashed, channelId, serverId);

        // Deliberately no `voice:peer:joined`. That event plays the join sound,
        // and nobody in the room was ever told this person left — their socket
        // blipped, which is not something the room hears about. Announcing a
        // join here would put a chime on a recovery.
        changed = true;
      }

      // Anyone the SFU has stopped carrying is gone for good — drop what is
      // held for them so a later reconnect does not put them back into a call
      // that ended while they were away.
      for (const [uid, stashed] of [...stashedVoiceState.entries()]) {
        if (sfuUsers.has(uid)) continue;

        consola.info(`[SFU-Sync] Dropping held voice state for ${uid} — SFU no longer has them`);
        stashedVoiceState.delete(uid);

        // This is where somebody actually leaves now, so this is where the
        // room gets told. The disconnect handler used to say it the moment a
        // socket went, which meant a two second network blip played the leave
        // chime and then the join chime. Here we know the media connection is
        // really gone, because the SFU has stopped reporting it.
        const roomName = stashed.voiceChannelId
          ? voiceRoomName(serverId, stashed.voiceChannelId)
          : "";
        if (roomName) {
          io.to(roomName).emit("voice:peer:left", {
            clientId: "",
            nickname: stashed.nickname,
            channelId: stashed.voiceChannelId,
          });
        }
      }

      // Disconnect any server-side users that the SFU no longer knows about
      for (const [sid, ci] of Object.entries(clientsInfo)) {
        if (ci.hasJoinedChannel && !sfuUsers.has(ci.serverUserId)) {
          consola.info(`[SFU-Sync] Stale voice user ${ci.serverUserId}, forcing disconnect`);
          changed = true;
          const nickname = ci.nickname;
          const channelId = ci.voiceChannelId || "";
          const roomName = channelId ? voiceRoomName(serverId, channelId) : "";
          ci.hasJoinedChannel = false;
          ci.voiceChannelId = "";
          ci.streamID = "";
          ci.isConnectedToVoice = false;
          ci.cameraEnabled = false;
          ci.cameraStreamID = "";
          ci.screenShareEnabled = false;
          ci.screenShareVideoStreamID = "";
          ci.screenShareAudioStreamID = "";
          sfuClient.untrackUserConnection(ci.serverUserId);

          const sock = io.sockets.sockets.get(sid);
          if (sock) {
            if (roomName) {
              sock.leave(roomName);
              sock.to(roomName).emit("voice:peer:left", { clientId: sid, nickname, channelId });
            }
            sock.emit("voice:channel:joined", false);
            sock.emit("voice:stream:set", "");
            sock.emit("voice:room:leave");
          }
        }
      }

      // Only when something actually moved. This runs every couple of seconds
      // now rather than every minute, and `broadcastMemberList` reads three
      // tables before it works out it has nothing new to say — so an
      // unconditional call here is three queries a second, for ever, on a
      // server where nobody is doing anything.
      if (changed) {
        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
      }
    },
  });
}

/**
 * Socket-shaped wrappers over the decisions in config/clientAddress, which is
 * where the reasoning lives and where the tests are.
 */
function getClientIp(socket: Socket): string {
  return resolveClientIp(
    (socket.handshake.address as string) || "unknown",
    socket.handshake.headers["x-forwarded-for"],
    trustedProxyHops(),
  );
}

function clientAddressIsOwn(socket: Socket): boolean {
  return addressIsOwn(
    socket.handshake.headers["x-forwarded-for"],
    trustedProxyHops(),
  );
}

async function getTokenVersionForServer(): Promise<number> {
  const cfg = await getServerConfig();
  return cfg?.token_version ?? 0;
}

export function socketHandler(io: Server, socket: Socket, sfuClient: SFUClient | null) {
  const clientId = socket.id;
  const serverId = getServerIdFromEnv();
  const verboseLogs = (process.env.NODE_ENV || "").toLowerCase() !== "production";

  // Keep module-level refs for REST-triggered broadcasts
  setSocketRefs(io, serverId, clientsInfo);

  /* The resolved address rather than the handshake one. Everything public
     arrives through a tunnel, so `handshake.address` is the tunnel for every
     client and cannot tell two of them apart — which is the whole point of
     logging it. getClientIp reads X-Forwarded-For through the configured
     trusted hops. */
  consola.info(`Client ${clientId} connected from ${getClientIp(socket)}`);

  if (verboseLogs) {
    const originalEmit = socket.emit;
    socket.emit = function (event: string, ...args: unknown[]) {
      console.log(`SERVER EMIT ${clientId}:`, event, args.length > 0 ? args : "");
      return originalEmit.call(this, event, ...args);
    };
    socket.onAny((event: string, ...args: unknown[]) => {
      console.log(`SERVER RECV ${clientId}:`, event, args.length > 0 ? args : "");
    });
  }

  // Initialize client
  clientsInfo[clientId] = {
    serverUserId: `temp_${clientId}`,
    nickname: "User",
    isMuted: false,
    isDeafened: false,
    color: colors[Math.floor(Math.random() * colors.length)],
    streamID: "",
    hasJoinedChannel: false,
    voiceChannelId: "",
    isConnectedToVoice: false,
    isAFK: false,
    cameraEnabled: false,
    cameraStreamID: "",
    screenShareEnabled: false,
    screenShareVideoStreamID: "",
    screenShareAudioStreamID: "",
    isServerMuted: false,
    isServerDeafened: false,
  };

  // Build handler context
  const ctx: HandlerContext = {
    io,
    socket,
    clientId,
    serverId,
    clientsInfo,
    sfuClient,
    getClientIp: () => getClientIp(socket),
    clientAddressIsOwn: () => clientAddressIsOwn(socket),
  };

  // Collect all event handlers from domain modules
  const allHandlers: EventHandlerMap = {
    ...registerJoinHandlers(ctx),
    ...registerAdminHandlers(ctx),
    ...registerChatHandlers(ctx),
    ...registerDirectMessageHandlers(ctx),
    ...registerVoiceHandlers(ctx),
    ...registerCallHandlers(ctx),
    ...registerMemberHandlers(ctx),
    ...registerReportHandlers(ctx),
    ...registerBlockHandlers(ctx),
    ...registerDiagnosticsHandlers(ctx),
    ...registerVoiceLatencyHandlers(ctx),
    ...registerTypingHandlers(ctx),
    ...registerDmKeyHandlers(ctx),
  };

  // ── Base socket events ───────────────────────────────────────

  socket.on("error", (error) => consola.error(`Socket error from ${clientId}:`, error));

  socket.on("server:info", () => sendInfo(socket, clientsInfo, serverId));

  // Prove this server's identity to the client (GRYT-51).
  //
  // Deliberately a connection-level exchange rather than part of the join
  // handshake. A client that reconnects with a saved access token never joins,
  // so a proof carried on join would leave that path — the common one — handing
  // a bearer token to a server nobody has authenticated. Answering here means
  // every path is covered without each one having to remember to ask.
  socket.on("server:identify", async (payload: { clientNonce?: string }) => {
    const clientNonce = typeof payload?.clientNonce === "string" ? payload.clientNonce : "";
    if (!clientNonce || clientNonce.length > MAX_CLIENT_NONCE_LENGTH) {
      socket.emit("server:identity", { error: "invalid_nonce" });
      return;
    }

    try {
      // The vouch chain lets a client pinned to a key this server used to hold
      // follow the rotation forward rather than refusing (GRYT-54). Empty on a
      // server that has never rotated, which is almost all of them.
      socket.emit("server:identity", {
        proof: await signServerProof(clientNonce),
        vouches: await getVouchChain(),
      });
    } catch (e) {
      consola.error("Failed to sign server identity proof", e);
      socket.emit("server:identity", { error: "identity_unavailable" });
    }
  });

  socket.on("disconnect", (reason) => {
    const clientInfo = clientsInfo[clientId];
    const serverUserId = clientInfo?.serverUserId ?? "";

    /* Who and from where, not just which socket (GRYT-645).
     *
     * On 2026-08-27 two clients were dropped by ping timeout on prod and on
     * beta within five seconds, and the logs could not say whether that was one
     * uplink, two, or the tunnel — `Client disconnected: <socket id> (reason)`
     * names a socket that no longer exists and nothing else. Two stacks
     * agreeing on one address is a different diagnosis from two stacks
     * disagreeing, and both were consistent with what was written down. */
    consola.info(
      `Client disconnected: ${clientId} user=${serverUserId || "anonymous"} ip=${getClientIp(socket)} (${reason})`,
    );
    const wasRegistered = serverUserId && !serverUserId.startsWith("temp_");
    const hadVoice = clientInfo?.hasJoinedChannel ?? false;

    /**
     * Stop ringing on behalf of somebody who has gone.
     *
     * Only when this was their last socket. A person with a laptop and a phone
     * closing one of them has not given up on the call.
     *
     * The timer would end it anyway, but thirty seconds of a phone ringing for
     * a caller who is no longer there is thirty seconds of the other person
     * deciding whether to answer something that cannot be answered.
     */
    if (wasRegistered) {
      const stillHere = Object.entries(clientsInfo).some(
        ([cid, ci]) => cid !== clientId && ci.serverUserId === serverUserId,
      );
      if (!stillHere) endRingsFor(io, clientsInfo, { callerGone: serverUserId });
    }

    // Keep the voice state against the user, whatever took the socket away.
    //
    // This used to be gated on `reason === "transport close"`, which is one of
    // several ways a socket dies and not the interesting one. A ping timeout, a
    // server restart, a redeploy — all of them dropped the state on the floor
    // while the media connection carried on working. The SFU decides when this
    // entry dies now, so there is no reason to be picky about how the socket
    // went (GRYT-611).
    if (hadVoice && wasRegistered) {
      consola.info(`[Voice:Stash] Holding voice state for ${serverUserId} (socket gone: ${reason})`);
      stashedVoiceState.set(serverUserId, voiceStateOf(clientInfo));

      delete clientsInfo[clientId];
      syncAllClients(io, clientsInfo);
      broadcastMemberList(io, clientsInfo, serverId);
      return;
    }

    // Nothing in voice to hold on to. Cleanup as before.
    if (serverUserId && sfuClient) {
      sfuClient.untrackUserConnection(serverUserId);
    }
    if (hadVoice) {
      const channelId = clientInfo.voiceChannelId || "";
      const roomName = channelId ? voiceRoomName(serverId, channelId) : "";
      if (roomName) {
        socket.to(roomName).emit("voice:peer:left", {
          clientId,
          nickname: clientInfo.nickname,
          channelId,
        });
      }
    }
    delete clientsInfo[clientId];
    if (wasRegistered) {
      syncAllClients(io, clientsInfo);
      broadcastMemberList(io, clientsInfo, serverId);
    }
  });

  // Register all domain handlers
  for (const [event, handler] of Object.entries(allHandlers)) {
    socket.on(event, handler);
  }

  // ── Session restoration (access token on connect) ────────────

  sendInfo(socket, clientsInfo, serverId);

  const restoreSession = (clientAccessToken: string | undefined) => {
    if (!clientAccessToken) return;
    const tokenPayload = verifyAccessToken(clientAccessToken);
    if (tokenPayload && tokenPayload.serverHost === socket.handshake.headers.host) {
      (async () => {
        try {
          const currentVersion = await getTokenVersionForServer();
          if ((tokenPayload.tokenVersion ?? 0) !== currentVersion) {
            socket.emit("token:revoked", { reason: "token_version_mismatch", message: "Session stale. Please rejoin." });
            return;
          }

          const gate = await checkSessionAllowed({
            grytUserId: tokenPayload.grytUserId,
            serverUserId: tokenPayload.serverUserId,
          });
          if (!gate.ok) {
            // A banned user reconnecting with a live token used to be restored
            // in full here, which is most of why a ban did not hold.
            //
            // Only a ban says server:kicked, because the client takes the
            // server out of the sidebar when it hears that. "You are not a
            // member" reaching here is not necessarily moderation — a stale
            // token against a rebuilt server looks identical — and deleting
            // somebody's server entry over an ambiguous signal is not a
            // recoverable mistake. token:revoked is what this path said before,
            // and it stops the restore just as firmly.
            if (gate.code === "banned") {
              socket.emit("server:kicked", { action: "ban", reason: gate.message });
              socket.disconnect(true);
            } else {
              socket.emit("token:revoked", { reason: gate.code, message: gate.message });
            }
            return;
          }

          clientsInfo[clientId].accessToken = clientAccessToken;
          clientsInfo[clientId].grytUserId = tokenPayload.grytUserId;
          clientsInfo[clientId].serverUserId = tokenPayload.serverUserId;
          clientsInfo[clientId].nickname = tokenPayload.nickname;

          // Server mute and deafen belong to the user, not to this socket.
          // They were initialised to false when the socket connected, so a
          // reconnect — or a second tab — used to clear them. `gate.user` is
          // the row the session gate already read, so this costs no query.
          const moderation = effectiveModerationState(gate.user);
          clientsInfo[clientId].isServerMuted = moderation.isServerMuted;
          clientsInfo[clientId].isServerDeafened = moderation.isServerDeafened;

          // Put voice back on the new socket if this user still has state held
          // against them. The fast path — the SFU sync below is the backstop,
          // and doing it here means a reconnect is whole by the time the client
          // hears anything rather than up to one sync tick later.
          //
          // No window to be inside any more. The entry exists for exactly as
          // long as the SFU says the user is connected to it.
          const stashed = stashedVoiceState.get(tokenPayload.serverUserId);
          if (stashed) {
            stashedVoiceState.delete(tokenPayload.serverUserId);
            consola.info(`[Voice:Stash] Restored voice state for ${tokenPayload.nickname} (${tokenPayload.serverUserId})`);
            applyVoiceState(socket, clientId, stashed, stashed.voiceChannelId, serverId);
          }

          const otherCount = countOtherSessions(clientsInfo, clientId, tokenPayload.grytUserId);
          consola.info(
            `Restored session: ${tokenPayload.nickname} (${tokenPayload.serverUserId})` +
            (otherCount > 0 ? ` — ${otherCount} other session(s) active` : ""),
          );

          await verifyClient(socket, clientsInfo);
          syncAllClients(io, clientsInfo);
          broadcastMemberList(io, clientsInfo, serverId);
          sendServerDetails(socket, clientsInfo, serverId).catch((e) => consola.warn("sendServerDetails failed", e));
        } catch (error) {
          consola.error(`Error restoring session for ${clientId}:`, error);
          socket.emit("token:invalid", "Database error. Please rejoin.");
        }
      })();
    }
  };

  // Session restoration, two ways.
  //
  // Older clients put the access token in the socket.io handshake, which means
  // it arrives before the client has had any chance to check who it is talking
  // to. A server impersonating this one collects a working bearer token that
  // it can replay here as that user — a client-impersonation hole reached
  // through a spoofed server. Kept only so existing installs keep working.
  //
  // Current clients hold the token back until the server has proved its
  // identity (GRYT-51) and then send it here.
  restoreSession(socket.handshake.auth?.accessToken);

  socket.on("session:restore", (payload: { accessToken?: string }) => {
    if (clientsInfo[clientId]?.accessToken) return;   // already restored
    restoreSession(typeof payload?.accessToken === "string" ? payload.accessToken : undefined);
  });
}
