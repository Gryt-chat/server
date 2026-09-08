import { Server, Socket } from "socket.io";
import { Clients } from "../../types";
import {
  getAllRegisteredUsers,
  getFilesByIds,
  isConversationId,
  listConversationMemberIds,
} from "../../db";
import { voiceRoomName } from "./voiceRooms";
import { clientMayReceive, refreshClientPermissions } from "./standing";
import { isBotIdentity } from "../../auth/identity";
import { memberIdentity } from "./memberIdentity";
import { scopedChannelIds, visibleChannelIds } from "../../services/channelPermissions";
import { listRolesByMember } from "../../services/permissions";

/** A member whose permissions were never cached receives no broadcasts, so all
    three admission paths call this and all three await it. */
export async function verifyClient(socket: Socket, clientsInfo: Clients) {
  socket.join("verifiedClients");
  await refreshClientPermissions(clientsInfo, socket.id);
}

export function unverifyClient(socket: Socket) {
  socket.leave("verifiedClients");
}

/** A DM's id is derived from the sorted pair, so naming it says who is talking
    to whom. `isConnectedToVoice` stays true, which everyone may know. */
function publicVoiceRoom(voiceChannelId: string | undefined): string {
  const id = voiceChannelId || "";
  return isConversationId(id) ? "" : id;
}

/** The same blanking for a channel this recipient may not see, so unlike
    `publicVoiceRoom` it takes the recipient. */
function voiceRoomFor(visible: Set<string>, voiceChannelId: string | undefined): string {
  const id = publicVoiceRoom(voiceChannelId);
  if (!id) return "";
  return visible.has(id) ? id : "";
}

/** A gate is not part of the hashed state, so hiding a channel changes what
    each recipient should be told without changing the hash. */
export function invalidateBroadcastDedupe(io: Server): void {
  lastClientsStateByIO.delete(io);
  lastMemberListStateByIO.delete(io);
}

const lastEmitAtByIO = new WeakMap<Server, number>();
const lastClientsStateByIO = new WeakMap<Server, string>();
const pendingEmitByIO = new WeakMap<Server, ReturnType<typeof setTimeout>>();
const EMIT_MIN_INTERVAL_MS = 100;
const MEMBER_LIST_DEBOUNCE_MS = 200;

async function emitClientsNow(io: Server, clientsInfo: Clients, stateHash: string) {
  lastEmitAtByIO.set(io, Date.now());
  lastClientsStateByIO.set(io, stateHash);

  const registeredClients: Clients = {};
  Object.entries(clientsInfo).forEach(([clientId, client]) => {
    if (client.serverUserId && !client.serverUserId.startsWith('temp_')) {
      // Copied, not passed through: this is the live record, and blanking the
      // field on it would take the person out of their own call.
      registeredClients[clientId] = { ...client, voiceChannelId: publicVoiceRoom(client.voiceChannelId) };
    }
  });

  // One payload to the room while nothing is gated. The per-socket branch below
  // costs a standing lookup each and only earns it once.
  const scoped = await scopedChannelIds();
  if (scoped.size === 0) {
    io.to("verifiedClients").emit("server:clients", registeredClients);
    return;
  }

  const anyScopedInUse = Object.values(registeredClients).some((c) => scoped.has(c.voiceChannelId || ""));
  if (!anyScopedInUse) {
    io.to("verifiedClients").emit("server:clients", registeredClients);
    return;
  }

  for (const [sid, sock] of io.sockets.sockets) {
    if (!sock.rooms.has("verifiedClients")) continue;
    const visible = await visibleChannelIds(clientsInfo[sid]?.serverUserId, clientsInfo[sid]?.grytUserId);
    const forThem: Clients = {};
    for (const [cid, client] of Object.entries(registeredClients)) {
      forThem[cid] = { ...client, voiceChannelId: voiceRoomFor(visible, client.voiceChannelId) };
    }
    sock.emit("server:clients", forThem);
  }
}

export function syncAllClients(io: Server, clientsInfo: Clients) {
  const currentStateHash = JSON.stringify(
    Object.entries(clientsInfo)
      .filter(([_, client]) => client.serverUserId && !client.serverUserId.startsWith('temp_'))
      .map(([id, client]) => ({
        id,
        serverUserId: client.serverUserId,
        nickname: client.nickname,
        hasJoinedChannel: client.hasJoinedChannel,
        voiceChannelId: publicVoiceRoom(client.voiceChannelId),
        isConnectedToVoice: client.isConnectedToVoice,
        isMuted: client.isMuted,
        isDeafened: client.isDeafened,
        isAFK: client.isAFK,
        cameraEnabled: client.cameraEnabled,
        cameraStreamID: client.cameraStreamID,
        screenShareEnabled: client.screenShareEnabled,
        screenShareVideoStreamID: client.screenShareVideoStreamID,
        screenShareAudioStreamID: client.screenShareAudioStreamID,
        isServerMuted: client.isServerMuted,
        isServerDeafened: client.isServerDeafened,
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  );

  if (currentStateHash === lastClientsStateByIO.get(io)) return;

  const pending = pendingEmitByIO.get(io);
  if (pending) clearTimeout(pending);

  const now = Date.now();
  const elapsed = now - (lastEmitAtByIO.get(io) || 0);

  if (elapsed >= EMIT_MIN_INTERVAL_MS) {
    void emitClientsNow(io, clientsInfo, currentStateHash);
  } else {
    pendingEmitByIO.set(
      io,
      setTimeout(() => {
        pendingEmitByIO.delete(io);
        void emitClientsNow(io, clientsInfo, currentStateHash);
      }, EMIT_MIN_INTERVAL_MS - elapsed),
    );
  }
}

// Separate debounce tracking for member list (trailing-edge, like syncAllClients)
const lastMemberListEmitByIO = new WeakMap<Server, number>();
const lastMemberListStateByIO = new WeakMap<Server, string>();
const pendingMemberListByIO = new WeakMap<Server, ReturnType<typeof setTimeout>>();

/** Built once. Two of these disagreed about which session wins when somebody
    has two clients open, and the moderation menu followed whichever answered. */
export async function buildMemberList(clientsInfo: Clients) {
  const registeredUsers = await getAllRegisteredUsers();
  // Everybody's roles, highest ranked first. A member can hold several, and the
  // list carries all of them so a client can draw the rest as chips.
  const rolesByMember = await listRolesByMember();

  // Avatar colours, so a voice tile can match the person rather than a hash of
  // their id. Null until the image worker has been round; the client falls back.
  const avatarFiles = await getFilesByIds(
    registeredUsers
      .map((u) => u.avatar_file_id)
      .filter((id): id is string => Boolean(id)),
  );

  type ClientInfo = Clients[string];
  const onlineUsers = new Map<string, ClientInfo>();

  // Most active session wins. Two clients open should show you as being in
  // voice, not as whichever socket was iterated last.
  const activityRank = (c: ClientInfo): number =>
    c.hasJoinedChannel ? 2 : c.isAFK ? 0 : 1;

  Object.values(clientsInfo).forEach((client) => {
    if (client.serverUserId && !client.serverUserId.startsWith('temp_')) {
      const existing = onlineUsers.get(client.serverUserId);
      if (!existing || activityRank(client) > activityRank(existing)) {
        onlineUsers.set(client.serverUserId, client);
      }
    }
  });

  return registeredUsers
    .filter((user) => user.is_active)
    .map((user) => {
      const onlineClient = onlineUsers.get(user.server_user_id);

      let status: 'online' | 'in_voice' | 'afk' | 'offline' = 'offline';
      if (onlineClient) {
        if (onlineClient.isAFK) status = 'afk';
        else if (onlineClient.hasJoinedChannel) status = 'in_voice';
        else status = 'online';
      }

      return {
        serverUserId: user.server_user_id,
        nickname: user.nickname,
        ...memberIdentity(user.gryt_user_id),
        /** Passed through untouched: a server vouching for the binding would
            be vouching for what a peer has to establish for itself. */
        dmKeyBinding: user.dm_key_binding,
        avatarFileId: user.avatar_file_id || null,
        avatarColor: user.avatar_file_id
          ? avatarFiles.get(user.avatar_file_id)?.dominant_color ?? null
          : null,
        // `avatarFileId` is still set, because saving a design uploads a PNG
        // that an older client shows. Passed through as stored.
        avatarWorn: user.avatar_worn,
        // The one their name is coloured by. A single string because every
        // client reads this field; `roles` beside it is the whole set.
        role: rolesByMember.get(user.server_user_id)?.[0] || 'member',
        roles: rolesByMember.get(user.server_user_id) ?? [],
        // Read off the id, so nothing the member sends can spoof it. Shown
        // beside every name.
        isBot: isBotIdentity(user.gryt_user_id),
        status,
        lastSeen: user.last_seen.toISOString(),
        createdAt: user.created_at.toISOString(),
        // A count and a time, never the old names — those are the part
        // somebody may have had a good reason to leave behind.
        nicknameChangeCount: user.nickname_change_count,
        nicknameChangedAt: user.nickname_changed_at?.toISOString() ?? null,
        /* Undefined rather than null when unset or offline: it lives on the
           connection, so somebody who is not here is not doing anything. */
        activity: onlineClient?.activity,
        isMuted: onlineClient?.isMuted || false,
        isDeafened: onlineClient?.isDeafened || false,
        isServerMuted: onlineClient?.isServerMuted || false,
        isServerDeafened: onlineClient?.isServerDeafened || false,
        color: onlineClient?.color || '#666666',
        isConnectedToVoice: onlineClient?.isConnectedToVoice || false,
        hasJoinedChannel: onlineClient?.hasJoinedChannel || false,
        voiceChannelId: publicVoiceRoom(onlineClient?.voiceChannelId),
        streamID: onlineClient?.streamID || '',
      };
    });
}

/** One member, as far as the dedupe below is concerned. */
type MemberListEntry = Awaited<ReturnType<typeof buildMemberList>>[number];

/** Add a field to `buildMemberList` and it must land here too, or the hash is
    unchanged and the value reaches nobody. `memberStateHash.test.ts` catches it. */
export function memberStateHash(members: MemberListEntry[]): string {
  return JSON.stringify(
    members.map(m => ({
      serverUserId: m.serverUserId,
      nickname: m.nickname,
      // Changes when an identity is replaced (`replaceUserIdentity`), which
      // is exactly when a member list showing the old one would be wrong.
      identityFingerprint: m.identityFingerprint,
      // A peer holding the old key encrypts to one nobody has, so a new binding
      // must not sit unsent waiting for something else to move.
      dmKeyBinding: m.dmKeyBinding,
      // Redundant with `nickname`, except for a rename back to a previous name,
      // which leaves that field looking untouched.
      nicknameChangedAt: m.nicknameChangedAt,
      avatarFileId: m.avatarFileId,
      avatarColor: m.avatarColor,
      // Designing a new owl changes nothing else about a member, so without
      // this line it would change nothing anybody sees.
      avatarWorn: m.avatarWorn,
      role: m.role,
      isBot: m.isBot,
      status: m.status,
      // Changes on its own schedule, so without it here the new one sits unsent
      // until something unrelated moves.
      activity: m.activity,
      isConnectedToVoice: m.isConnectedToVoice,
      hasJoinedChannel: m.hasJoinedChannel,
      voiceChannelId: m.voiceChannelId,
      isMuted: m.isMuted,
      isDeafened: m.isDeafened,
      isServerMuted: m.isServerMuted,
      isServerDeafened: m.isServerDeafened,
    })).sort((a, b) => a.serverUserId.localeCompare(b.serverUserId))
  );
}

async function emitMemberListNow(io: Server, clientsInfo: Clients): Promise<void> {
  try {
    const members = await buildMemberList(clientsInfo);

    const currentMemberStateHash = memberStateHash(members);

    if (currentMemberStateHash === lastMemberListStateByIO.get(io)) {
      return;
    }

    lastMemberListEmitByIO.set(io, Date.now());
    lastMemberListStateByIO.set(io, currentMemberStateHash);

    // Per socket, not to the room: the row carries `voiceChannelId`, so a member
    // in a gated voice channel would otherwise name it to the whole server.
    const scoped = await scopedChannelIds();
    const anyScopedInUse = scoped.size > 0 && members.some((m) => scoped.has(m.voiceChannelId || ""));

    for (const [sid, s] of io.sockets.sockets) {
      if (!clientMayReceive(clientsInfo, sid, "view_members")) continue;
      if (!anyScopedInUse) {
        s.emit("members:list", members);
        continue;
      }
      const visible = await visibleChannelIds(clientsInfo[sid]?.serverUserId, clientsInfo[sid]?.grytUserId);
      s.emit("members:list", members.map((m) => ({ ...m, voiceChannelId: voiceRoomFor(visible, m.voiceChannelId) })));
    }
  } catch (error) {
    console.error('Failed to broadcast member list:', error);
  }
}

const lastCallMembersByIO = new WeakMap<Server, Map<string, string>>();

/** Told only to the people in the call, because `publicVoiceRoom`'s blanking
    left a DM call showing nobody in it. The socket.io room is the access rule. */
function broadcastCallParticipants(io: Server, clientsInfo: Clients, serverId: string): void {
  const byRoom = new Map<string, Set<string>>();

  for (const client of Object.values(clientsInfo)) {
    const room = client.voiceChannelId || "";
    if (!room || !isConversationId(room)) continue;
    if (!client.hasJoinedChannel) continue;
    if (!client.serverUserId || client.serverUserId.startsWith("temp_")) continue;

    let members = byRoom.get(room);
    if (!members) {
      members = new Set();
      byRoom.set(room, members);
    }
    members.add(client.serverUserId);
  }

  // Voice state changes constantly — every mute, every camera. Only a change of
  // who is in the room is worth a message.
  let seen = lastCallMembersByIO.get(io);
  if (!seen) {
    seen = new Map();
    lastCallMembersByIO.set(io, seen);
  }

  for (const [room, members] of byRoom) {
    const ids = [...members].sort();
    const key = ids.join(",");
    if (seen.get(room) === key) continue;
    seen.set(room, key);

    // The room first, and synchronously. These are the people in the call and
    // they are the ones for whom a late answer looks like a call that failed.
    io.to(voiceRoomName(serverId, room)).emit("voice:call:members", {
      conversation_id: room,
      server_user_ids: ids,
    });

    tellConversation(io, clientsInfo, room, ids);
  }

  // Nobody left to tell, but the rest of the conversation still shows a call.
  // Forgotten either way, or the next call dedupes against one that ended.
  for (const room of [...seen.keys()]) {
    if (byRoom.has(room)) continue;
    seen.delete(room);
    tellConversation(io, clientsInfo, room, []);
  }
}

/** So a DM row can say a call is happening to somebody who has not joined.
    Fire and forget, and only on a change of who is in the call. */
function tellConversation(
  io: Server,
  clientsInfo: Clients,
  conversationId: string,
  serverUserIds: string[],
): void {
  void (async () => {
    try {
      const memberIds = await listConversationMemberIds(conversationId);
      const inTheCall = new Set(serverUserIds);
      const payload = { conversation_id: conversationId, server_user_ids: serverUserIds };

      for (const [clientId, client] of Object.entries(clientsInfo)) {
        if (!client.serverUserId || inTheCall.has(client.serverUserId)) continue;
        if (!memberIds.includes(client.serverUserId)) continue;
        io.sockets.sockets.get(clientId)?.emit("voice:call:members", payload);
      }
    } catch {
      // A conversation that has gone, most likely. Nothing to tell anybody
      // about, and a broadcast is not worth taking the server down for.
    }
  })();
}

export function broadcastMemberList(io: Server, clientsInfo: Clients, instanceId: string): void {
  // Ahead of the debounce below, and not subject to it. A call view that draws
  // nobody for a fifth of a second reads as a call that failed.
  broadcastCallParticipants(io, clientsInfo, instanceId);

  const pending = pendingMemberListByIO.get(io);
  if (pending) clearTimeout(pending);

  const now = Date.now();
  const elapsed = now - (lastMemberListEmitByIO.get(io) || 0);

  if (elapsed >= MEMBER_LIST_DEBOUNCE_MS) {
    void emitMemberListNow(io, clientsInfo);
  } else {
    pendingMemberListByIO.set(
      io,
      setTimeout(() => {
        pendingMemberListByIO.delete(io);
        void emitMemberListNow(io, clientsInfo);
      }, MEMBER_LIST_DEBOUNCE_MS - elapsed),
    );
  }
}

/** How many other sockets belong to the same grytUserId. For logging. */
export function countOtherSessions(
  clientsInfo: Clients,
  currentClientId: string,
  grytUserId: string,
): number {
  let count = 0;
  for (const [sid, ci] of Object.entries(clientsInfo)) {
    if (sid === currentClientId) continue;
    if (ci.grytUserId === grytUserId) count++;
  }
  return count;
}
