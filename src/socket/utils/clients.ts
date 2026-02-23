import consola from "consola";
import { Server, Socket } from "socket.io";
import { Clients } from "../../types";
import { getAllRegisteredUsers, listServerRoles } from "../../db/scylla";

export function verifyClient(socket: Socket) {
  socket.join("verifiedClients");
}

export function unverifyClient(socket: Socket) {
  socket.leave("verifiedClients");
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
      registeredClients[clientId] = client;
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
        voiceChannelId: client.voiceChannelId,
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

// Separate debounce tracking for member list
const lastMemberListEmitByIO = new WeakMap<Server, number>();
const lastMemberListStateByIO = new WeakMap<Server, string>();

export async function broadcastMemberList(io: Server, clientsInfo: Clients, _instanceId: string) {
  const now = Date.now();
  const last = lastMemberListEmitByIO.get(io) || 0;
  
  // Skip if too frequent
  if (now - last < MEMBER_LIST_DEBOUNCE_MS) {
    return;
  }
  
  try {
    const registeredUsers = await getAllRegisteredUsers();
    const roleRows = await listServerRoles();
    const roleMap = new Map(roleRows.map((r) => [r.server_user_id, r.role]));

    type ClientInfo = Clients[string];
    const onlineUsers = new Map<string, ClientInfo>();

    const activityRank = (c: ClientInfo): number =>
      c.hasJoinedChannel ? 2 : c.isAFK ? 0 : 1;

    Object.values(clientsInfo).forEach(client => {
      if (client.serverUserId && !client.serverUserId.startsWith('temp_')) {
        const existing = onlineUsers.get(client.serverUserId);
        if (!existing || activityRank(client) > activityRank(existing)) {
          onlineUsers.set(client.serverUserId, client);
        }
      }
    });
    
    // Combine registered users with online status, filtering out inactive users
    const members = registeredUsers
      .filter(user => user.is_active) // Only include active users
      .map(user => {
        const onlineClient = onlineUsers.get(user.server_user_id);
        
        let status: 'online' | 'in_voice' | 'afk' | 'offline' = 'offline';
        if (onlineClient) {
          if (onlineClient.isAFK) {
            status = 'afk';
          } else if (onlineClient.hasJoinedChannel) {
            status = 'in_voice';
          } else {
            status = 'online';
          }
        }
        
        return {
          serverUserId: user.server_user_id,
          nickname: user.nickname,
          avatarFileId: user.avatar_file_id || null,
          role: roleMap.get(user.server_user_id) || 'member',
          status,
          lastSeen: user.last_seen,
          isMuted: onlineClient?.isMuted || false,
          isDeafened: onlineClient?.isDeafened || false,
          isServerMuted: onlineClient?.isServerMuted || false,
          isServerDeafened: onlineClient?.isServerDeafened || false,
          color: onlineClient?.color || '#666666',
          isConnectedToVoice: onlineClient?.isConnectedToVoice || false,
          hasJoinedChannel: onlineClient?.hasJoinedChannel || false,
          voiceChannelId: onlineClient?.voiceChannelId || '',
          streamID: onlineClient?.streamID || '',
        };
      });
    
    // Create a hash of the member list to detect actual changes.
    // IMPORTANT: include fields that should trigger UI updates (e.g. avatar/nickname),
    // otherwise updates can get deduped away and clients won't refresh.
    const currentMemberStateHash = JSON.stringify(
      members.map(m => ({
        serverUserId: m.serverUserId,
        nickname: m.nickname,
        avatarFileId: m.avatarFileId,
        role: m.role,
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
    
    const lastMemberStateHash = lastMemberListStateByIO.get(io);
    
    // Skip if no actual member state change
    if (currentMemberStateHash === lastMemberStateHash) {
      return;
    }
    
    lastMemberListEmitByIO.set(io, now);
    lastMemberListStateByIO.set(io, currentMemberStateHash);
    
    io.to("verifiedClients").emit("members:list", members);
  } catch (error) {
    console.error('Failed to broadcast member list:', error);
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
