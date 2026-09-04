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

/**
 * Mark a socket as belonging to somebody the server has admitted, and cache
 * their permissions. A member whose permissions were never cached receives no
 * broadcasts, so all three admission paths call this and all three await it.
 */
export async function verifyClient(socket: Socket, clientsInfo: Clients) {
  socket.join("verifiedClients");
  await refreshClientPermissions(clientsInfo, socket.id);
}

export function unverifyClient(socket: Socket) {
  socket.leave("verifiedClients");
}

/**
 * The room to tell the whole server somebody is in: a channel, or nothing.
 * A one-to-one conversation id is derived from the sorted pair, so anybody
 * holding a member list could compute it and read back who is talking to whom.
 * `isConnectedToVoice` stays true, which is the part everyone may know.
 */
function publicVoiceRoom(voiceChannelId: string | undefined): string {
  const id = voiceChannelId || "";
  return isConversationId(id) ? "" : id;
}

/**
 * The same blanking, for a channel this particular recipient may not see — so
 * unlike `publicVoiceRoom` it takes the recipient. Only the id goes.
 */
function voiceRoomFor(visible: Set<string>, voiceChannelId: string | undefined): string {
  const id = publicVoiceRoom(voiceChannelId);
  if (!id) return "";
  return visible.has(id) ? id : "";
}

/**
 * Drop the dedupe memory for both broadcasts. A gate is not part of the hashed
 * state, so hiding a channel while somebody sits in its voice room changes what
 * each recipient should be told without changing the hash.
 */
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
      // Copied rather than passed through: this is the live record the rest of
      // the server reads, and blanking the field on it would take the person
      // out of their own call.
      registeredClients[clientId] = { ...client, voiceChannelId: publicVoiceRoom(client.voiceChannelId) };
    }
  });

  // One payload to the room while no channel is gated, which is every server
  // that has not used the setting. The per-socket branch below costs a standing
  // lookup each and only earns it once somebody can be shown less.
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

/**
 * The member list, built once. There were two of these, disagreeing about which
 * session wins when somebody has two clients open — so the moderation menu's
 * contents depended on which builder had answered most recently.
 */
export async function buildMemberList(clientsInfo: Clients) {
  const registeredUsers = await getAllRegisteredUsers();
  // Everybody's roles, highest ranked first. A member can hold several, and the
  // list carries all of them so a client can draw the rest as chips.
  const rolesByMember = await listRolesByMember();

  // Avatar colours, so a client can tint a voice tile to match the person
  // rather than to a hash of their id. Null until the image worker has
  // processed that avatar — the client falls back.
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
        /**
         * What this member says their DM public key is (GRYT-720). Passed
         * through untouched: a server vouching for the binding would be
         * vouching for the thing a peer has to establish for itself.
         */
        dmKeyBinding: user.dm_key_binding,
        avatarFileId: user.avatar_file_id || null,
        avatarColor: user.avatar_file_id
          ? avatarFiles.get(user.avatar_file_id)?.dominant_color ?? null
          : null,
        // What their owl is wearing. `avatarFileId` is still set, because
        // saving a design uploads a PNG too and that is what an older client
        // shows. Passed through as stored — see `utils/wornString.ts`.
        avatarWorn: user.avatar_worn,
        // The one their name is coloured by. Kept as a single string because
        // every client that exists reads this field; `roles` beside it is the
        // whole set, and a client that does not know about it loses nothing.
        role: rolesByMember.get(user.server_user_id)?.[0] || 'member',
        roles: rolesByMember.get(user.server_user_id) ?? [],
        // Read off the id, so it cannot be wrong and cannot be spoofed by
        // anything the member sends. Every surface that shows a name shows this
        // beside it — the one question a reader needs answered instantly is
        // whether they are talking to a person.
        isBot: isBotIdentity(user.gryt_user_id),
        status,
        lastSeen: user.last_seen.toISOString(),
        createdAt: user.created_at.toISOString(),
        // A count and a time, never the old names — those are the part
        // somebody may have had a good reason to leave behind.
        nicknameChangeCount: user.nickname_change_count,
        nicknameChangedAt: user.nickname_changed_at?.toISOString() ?? null,
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

/**
 * What the broadcast compares against the last one it sent. **Add a field to
 * `buildMemberList` and it must land here too**, or the hash is unchanged, the
 * broadcast returns early, and the value reaches nobody with nothing erroring
 * (GRYT-65). `memberStateHash.test.ts` fails instead now.
 *
 * Not every field belongs: `lastSeen` moves constantly and would defeat the
 * dedupe entirely. This is the set that should repaint somebody's row.
 */
export function memberStateHash(members: MemberListEntry[]): string {
  return JSON.stringify(
    members.map(m => ({
      serverUserId: m.serverUserId,
      nickname: m.nickname,
      // Changes when an identity is replaced (`replaceUserIdentity`), which
      // is exactly when a member list showing the old one would be wrong.
      identityFingerprint: m.identityFingerprint,
      // A member replacing their DM key is the one change here that other
      // clients must not miss: a peer holding the old one encrypts to a key
      // nobody has. Left out of this hash, a new binding would sit unsent until
      // something unrelated happened to move.
      dmKeyBinding: m.dmKeyBinding,
      // A rename changes the name above too, so this is redundant for the
      // dedupe — kept so that a rename back to a previous name, which leaves
      // `nickname` looking untouched, still reaches the client.
      nicknameChangedAt: m.nicknameChangedAt,
      avatarFileId: m.avatarFileId,
      avatarColor: m.avatarColor,
      // Designing a new owl changes nothing else about a member, so without
      // this line it would change nothing anybody sees.
      avatarWorn: m.avatarWorn,
      role: m.role,
      isBot: m.isBot,
      status: m.status,
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

    // Per socket rather than to the room, because who may see the list is a
    // permission. It is no longer the same list for everybody who gets it
    // either: the row carries `voiceChannelId`, so a member sitting in a
    // gated voice channel would otherwise name it to the whole server.
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

/**
 * Who is in each conversation call, told only to the people in it. Both clients
 * group participants by `voiceChannelId`, so the blanking `publicVoiceRoom`
 * does left a call showing nobody in it, including yourself.
 *
 * Addressing the socket.io room is the whole of the access rule — you cannot be
 * in the room without having gone through `resolveConversationAccess`, so there
 * is no second copy of it here to disagree.
 *
 * Channels are deliberately not sent; the member list already names those.
 */
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

  // A room nobody is in any more. Nobody there to tell, but the conversation's
  // other members were told it started and would keep a row saying it is still
  // going. The entry is forgotten either way, or the next call between the same
  // people is deduped against one that has ended.
  for (const room of [...seen.keys()]) {
    if (byRoom.has(room)) continue;
    seen.delete(room);
    tellConversation(io, clientsInfo, room, []);
  }
}

/**
 * Tell the rest of the conversation who is in its call, so a DM row can say a
 * call is happening to somebody who has not joined — and stop saying so.
 *
 * Fire and forget, after the room has been told. It reads membership from the
 * database, which only pays because the dedupe above means this runs on a
 * change of who is in a call rather than on every voice event.
 */
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

/**
 * Count how many OTHER sockets belong to the same grytUserId.
 * Used for logging when a user opens multiple clients concurrently.
 */
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
