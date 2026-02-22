import { Server, Socket } from "socket.io";
import { Clients } from "../../types";
import { getAllRegisteredUsers, listServerRoles } from "../../db/scylla";

export function verifyClient(socket: Socket) {
  socket.join("verifiedClients");
}

export function unverifyClient(socket: Socket) {
  socket.leave("verifiedClients");
}

// Enhanced debounce and state tracking per io instance
const lastEmitAtByIO = new WeakMap<Server, number>();
const lastClientsStateByIO = new WeakMap<Server, string>();
const EMIT_MIN_INTERVAL_MS = 100; // increased debounce time
const MEMBER_LIST_DEBOUNCE_MS = 200; // separate debounce for member list

export function syncAllClients(io: Server, clientsInfo: Clients) {
  const now = Date.now();
  const last = lastEmitAtByIO.get(io) || 0;
  
  // Create a hash of the current client state to detect actual changes
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
  
  const lastStateHash = lastClientsStateByIO.get(io);
  
  // Skip if no actual state change or too frequent
  if (currentStateHash === lastStateHash || now - last < EMIT_MIN_INTERVAL_MS) {
    return; // skip if no change or too frequent
  }
  
  lastEmitAtByIO.set(io, now);
  lastClientsStateByIO.set(io, currentStateHash);

  // Filter to only include registered users (those with real serverUserId, not temp IDs)
  const registeredClients: Clients = {};
  Object.entries(clientsInfo).forEach(([clientId, client]) => {
    // Only include clients who have been properly registered in the database
    // (i.e., have a real serverUserId that doesn't start with "temp_")
    if (client.serverUserId && !client.serverUserId.startsWith('temp_')) {
      registeredClients[clientId] = client;
    }
  });

  io.to("verifiedClients").emit("server:clients", registeredClients);
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

    const onlineUsers = new Map<string, any>();
    Object.values(clientsInfo).forEach(client => {
      if (client.serverUserId && !client.serverUserId.startsWith('temp_')) {
        onlineUsers.set(client.serverUserId, client);
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
