import { Server, Socket } from "socket.io";
import { Clients } from "../../types";
import {
  getAllRegisteredUsers,
  getFilesByIds,
  isConversationId,
  listConversationMemberIds,
  listServerRoles,
} from "../../db";
import { voiceRoomName } from "./voiceRooms";
import { clientMayReceive, refreshClientPermissions } from "./standing";
import { isBotIdentity } from "../../auth/identity";
import { memberIdentity } from "./memberIdentity";

/**
 * Mark a socket as belonging to somebody the server has admitted.
 *
 * Takes `clientsInfo` so it can cache that member's permissions, which is what
 * decides whether broadcasts reach them. It is here rather than at each call
 * site because there are three ways a socket becomes a member — a fresh join, a
 * restored session, a refreshed token — and a fourth added later would have had
 * to remember. A member whose permissions were never cached receives nothing.
 *
 * Awaited by all three, because the first thing that happens after admission
 * is a broadcast — the "X joined" system message — and a socket whose
 * permissions have not landed yet would not receive it.
 */
export async function verifyClient(socket: Socket, clientsInfo: Clients) {
  socket.join("verifiedClients");
  await refreshClientPermissions(clientsInfo, socket.id);
}

export function unverifyClient(socket: Socket) {
  socket.leave("verifiedClients");
}

/**
 * The room to tell the whole server somebody is in.
 *
 * A channel, or nothing. Both of these payloads go to every member, and a
 * conversation id names who is talking to whom: a one-to-one id is derived from
 * the sorted pair, so anybody holding a member list can compute it and read the
 * answer back out. Broadcasting it would undo the reason
 * `memberIdentity.ts` refuses to hand out `gryt_user_id` in the first place.
 *
 * Blanking it costs nothing the clients use. The channel list draws people
 * under the channel this names, and a call is not in the channel list;
 * `isConnectedToVoice` still says the person is busy, which is the true part
 * everyone is allowed to know.
 *
 * Members of the conversation learn about the call through the conversation
 * itself, not through this.
 */
function publicVoiceRoom(voiceChannelId: string | undefined): string {
  const id = voiceChannelId || "";
  return isConversationId(id) ? "" : id;
}

const lastEmitAtByIO = new WeakMap<Server, number>();
const lastClientsStateByIO = new WeakMap<Server, string>();
const pendingEmitByIO = new WeakMap<Server, ReturnType<typeof setTimeout>>();
const EMIT_MIN_INTERVAL_MS = 100;
const MEMBER_LIST_DEBOUNCE_MS = 200;

function emitClientsNow(io: Server, clientsInfo: Clients, stateHash: string) {
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

  io.to("verifiedClients").emit("server:clients", registeredClients);
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
    emitClientsNow(io, clientsInfo, currentStateHash);
  } else {
    pendingEmitByIO.set(
      io,
      setTimeout(() => {
        pendingEmitByIO.delete(io);
        emitClientsNow(io, clientsInfo, currentStateHash);
      }, EMIT_MIN_INTERVAL_MS - elapsed),
    );
  }
}

// Separate debounce tracking for member list (trailing-edge, like syncAllClients)
const lastMemberListEmitByIO = new WeakMap<Server, number>();
const lastMemberListStateByIO = new WeakMap<Server, string>();
const pendingMemberListByIO = new WeakMap<Server, ReturnType<typeof setTimeout>>();

/**
 * The member list, built once.
 *
 * There used to be two of these — this one and the `members:fetch` handler's —
 * emitting the same event with the same 17 fields and disagreeing about which
 * session wins when somebody has two clients open. This picked the most active
 * one; the other took whichever it happened to see last. Since `isServerMuted`
 * and `role` drive the moderation menu, the menu's contents depended on which
 * builder had answered most recently.
 */
export async function buildMemberList(clientsInfo: Clients) {
  const registeredUsers = await getAllRegisteredUsers();
  const roleRows = await listServerRoles();
  const roleMap = new Map(roleRows.map((r) => [r.server_user_id, r.role]));

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
         * What this member says their DM public key is (GRYT-720).
         *
         * Passed through untouched. This server has never read it and cannot
         * usefully check it — the point of the feature is that the messages are
         * unreadable here, so a server vouching for the binding would be
         * vouching for the very thing a peer has to establish for itself.
         *
         * Null for anybody who has not published one, which is every client
         * older than this and everybody on a server that has not been updated.
         * No binding means no encrypted message, which is today's behaviour.
         */
        dmKeyBinding: user.dm_key_binding,
        avatarFileId: user.avatar_file_id || null,
        avatarColor: user.avatar_file_id
          ? avatarFiles.get(user.avatar_file_id)?.dominant_color ?? null
          : null,
        // What their owl is wearing, if they designed one. The client draws it
        // rather than fetching a picture, so it stays sharp at every size and
        // follows a palette change; `avatarFileId` above is still set, because
        // saving a design uploads a PNG as well and that is what a client too
        // old to know about this field shows.
        //
        // Passed through exactly as it was stored. The server never resolves a
        // key — see `utils/wornString.ts`.
        avatarWorn: user.avatar_worn,
        role: roleMap.get(user.server_user_id) || 'member',
        // Read off the id, so it cannot be wrong and cannot be spoofed by
        // anything the member sends. Every surface that shows a name shows this
        // beside it — the one question a reader needs answered instantly is
        // whether they are talking to a person.
        isBot: isBotIdentity(user.gryt_user_id),
        status,
        lastSeen: user.last_seen.toISOString(),
        createdAt: user.created_at.toISOString(),
        // A count and a time, never the old names. What tells you whether this
        // is the person you think it is is that the account took this name an
        // hour ago; what it used to be called is the part somebody may have had
        // a good reason to leave behind, and it is not needed to answer the
        // question.
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
 * What the broadcast compares against the last one it sent.
 *
 * Named and exported so it can be tested. The failure it guards is silent and
 * has happened: a field is added to `buildMemberList` and not to this, the list
 * is rebuilt with the new value, the hash comes out identical to the last one,
 * the broadcast returns early — and the value reaches nobody. Nothing errors,
 * the field is right in the builder, and it costs a debugging round to find
 * (GRYT-65). `memberStateHash.test.ts` now fails instead.
 *
 * Not every field belongs here. `lastSeen` moves constantly and would defeat
 * the dedupe entirely; this is the set that should repaint somebody's row.
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

    // Per socket rather than to the room, because who may see the list is now
    // a permission. Same list for everybody who gets it — this is about
    // delivery, not about showing different people different members.
    for (const [sid, s] of io.sockets.sockets) {
      if (clientMayReceive(clientsInfo, sid, "view_members")) {
        s.emit("members:list", members);
      }
    }
  } catch (error) {
    console.error('Failed to broadcast member list:', error);
  }
}

const lastCallMembersByIO = new WeakMap<Server, Map<string, string>>();

/**
 * Who is in each conversation call, told only to the people in it.
 *
 * `publicVoiceRoom` blanks a conversation id out of the member list and out of
 * `server:clients`, because those go to every member of the server and a
 * one-to-one id reads straight back to the pair. That is right, and it left the
 * people actually in the call unable to see each other: both clients group
 * participants by `voiceChannelId`, and blanking it means nothing matches — a
 * call showed nobody in it, including yourself.
 *
 * So the id goes to the one audience allowed to have it. Everybody in a call is
 * already in that call's socket.io room, and nobody else is, so addressing the
 * room is the whole of the access rule. Not a second copy of it — there is no
 * `if` here to disagree with `resolveConversationAccess`, because you cannot be
 * in the room without having gone through it.
 *
 * Channels are deliberately not sent. The member list already names those, and
 * sending this for them would put a payload on every voice event on the server
 * to say something already said.
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

  // A room nobody is in any more.
  //
  // Nobody in the room to tell — whoever was last has already left it — but the
  // conversation's other members were told the call started and would otherwise
  // be left with a row that says it is still going. So they get the empty list.
  //
  // The entry is forgotten either way, or the next call in this conversation
  // between the same people would be deduped against a call that has ended, and
  // its first message is the one that stops the view being empty.
  for (const room of [...seen.keys()]) {
    if (byRoom.has(room)) continue;
    seen.delete(room);
    tellConversation(io, clientsInfo, room, []);
  }
}

/**
 * Tell everybody in a conversation who is in its call, including the people
 * who are not.
 *
 * The room emit above reaches the participants. This reaches the rest of the
 * conversation, which is how a direct message row can say a call is happening
 * to somebody who has not joined it — and, when the list comes back empty, stop
 * saying so.
 *
 * Members of a conversation are entitled to this. It is the same audience that
 * can already read the messages in it, and for a one-to-one they are the two
 * people in the call anyway.
 *
 * Fire and forget, and deliberately after the room has been told. It reads the
 * conversation's membership from the database, which is a cost worth paying
 * only because this runs on a change of who is in a call rather than on every
 * voice event — the dedupe above is what makes that true.
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
