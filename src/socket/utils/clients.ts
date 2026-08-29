import { Server, Socket } from "socket.io";
import { Clients } from "../../types";
import { getAllRegisteredUsers, getFilesByIds, isConversationId, listServerRoles } from "../../db";
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

export function broadcastMemberList(io: Server, clientsInfo: Clients, _instanceId: string): void {
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
