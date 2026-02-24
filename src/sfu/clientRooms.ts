import WebSocket from 'ws';
import { consola } from 'consola';
import { randomBytes } from 'crypto';

interface ServerRegistrationData {
  server_id: string;
  server_password: string;
  room_id: string;
}

interface ClientJoinData {
  room_id: string;
  server_id: string;
  server_password: string;
  user_token: string;
  user_id: string;
}

interface AudioControlData {
  room_id: string;
  user_id: string;
  server_id: string;
  server_password: string;
  is_muted: boolean;
  is_deafened: boolean;
}

interface WebSocketMessage {
  event: string;
  data: string;
}

export class SFURoomManager {
  registeredRooms = new Set<string>();
  roomsToReregister = new Set<string>();
  activeUsers = new Map<string, { roomId: string; userId: string; connectedAt: number }>();

  constructor(
    private getWs: () => WebSocket | null,
    private serverId: string,
    private serverToken: string,
  ) {}

  async reregisterRooms(): Promise<void> {
    if (this.roomsToReregister.size === 0) return;

    consola.info(`Re-registering ${this.roomsToReregister.size} rooms after reconnection...`);

    const roomsToProcess = Array.from(this.roomsToReregister);
    this.roomsToReregister.clear();

    for (const roomId of roomsToProcess) {
      try {
        await this.internalRegisterRoom(roomId);
        consola.success(`Re-registered room: ${roomId}`);
      } catch (error) {
        consola.error(`Failed to re-register room ${roomId}:`, error);
        this.roomsToReregister.add(roomId);
      }
    }

    consola.success('Room re-registration completed');
  }

  async internalRegisterRoom(roomId: string): Promise<void> {
    const ws = this.getWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('SFU connection not available');
    }

    if (!roomId || typeof roomId !== 'string') {
      throw new Error('Invalid room ID');
    }

    if (this.registeredRooms.has(roomId)) {
      consola.debug(`Room ${roomId} already registered`);
      return;
    }

    const registrationData: ServerRegistrationData = {
      server_id: this.serverId,
      server_password: this.serverToken,
      room_id: roomId,
    };

    const message: WebSocketMessage = {
      event: 'server_register',
      data: JSON.stringify(registrationData),
    };

    ws.send(JSON.stringify(message));
    this.registeredRooms.add(roomId);

    consola.info(`Registered room ${roomId} with SFU`);
  }

  async registerRoom(roomId: string): Promise<void> {
    this.roomsToReregister.add(roomId);
    await this.internalRegisterRoom(roomId);
  }

  async unregisterRoom(roomId: string): Promise<void> {
    this.registeredRooms.delete(roomId);
    this.roomsToReregister.delete(roomId);
    consola.info(`Unregistered room ${roomId} from SFU client`);
  }

  generateClientJoinToken(roomId: string, userId: string): ClientJoinData {
    if (!roomId || !userId) {
      throw new Error('Room ID and User ID are required for token generation');
    }

    const userToken = this.generateSecureToken(userId, roomId);

    return {
      room_id: roomId,
      server_id: this.serverId,
      server_password: this.serverToken,
      user_token: userToken,
      user_id: userId,
    };
  }

  private generateSecureToken(userId: string, roomId: string): string {
    const timestamp = Date.now();
    const randomData = randomBytes(16).toString('hex');
    const payload = `${userId}:${roomId}:${timestamp}:${randomData}`;
    return Buffer.from(payload).toString('base64');
  }

  async updateUserAudioState(roomId: string, userId: string, isMuted: boolean, isDeafened: boolean): Promise<void> {
    const ws = this.getWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      consola.warn('SFU connection not available for audio state update');
      return;
    }

    if (!roomId || !userId) {
      throw new Error('Room ID and User ID are required for audio state update');
    }

    const audioControlData: AudioControlData = {
      room_id: roomId,
      user_id: userId,
      server_id: this.serverId,
      server_password: this.serverToken,
      is_muted: isMuted,
      is_deafened: isDeafened,
    };

    const message: WebSocketMessage = {
      event: 'user_audio_control',
      data: JSON.stringify(audioControlData),
    };

    ws.send(JSON.stringify(message));
    consola.info(`Updated audio state for user ${userId} in room ${roomId}: muted=${isMuted}, deafened=${isDeafened}`);
  }

  trackUserConnection(roomId: string, userId: string): boolean {
    const existingConnection = this.activeUsers.get(userId);
    if (existingConnection) {
      consola.warn(`🚫 SFU: User ${userId} already connected to room ${existingConnection.roomId}`);
      return false;
    }

    this.activeUsers.set(userId, {
      roomId,
      userId,
      connectedAt: Date.now()
    });

    consola.info(`✅ SFU: User ${userId} connected to room ${roomId}`);
    return true;
  }

  untrackUserConnection(userId: string): void {
    const connection = this.activeUsers.get(userId);
    if (connection) {
      this.activeUsers.delete(userId);
      consola.info(`✅ SFU: User ${userId} disconnected from room ${connection.roomId}`);
    }
  }

  getTrackedUser(userId: string): { roomId: string; userId: string; connectedAt: number } | undefined {
    return this.activeUsers.get(userId);
  }

  getActiveUsers(): Map<string, { roomId: string; userId: string; connectedAt: number }> {
    return new Map(this.activeUsers);
  }

  async disconnectUser(roomId: string, userId: string): Promise<void> {
    const ws = this.getWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      consola.warn('SFU connection not available for disconnect_user');
      return;
    }

    const message: WebSocketMessage = {
      event: 'disconnect_user',
      data: JSON.stringify({
        room_id: roomId,
        user_id: userId,
        server_id: this.serverId,
        server_password: this.serverToken,
      }),
    };

    ws.send(JSON.stringify(message));
    consola.info(`[SFU] Sent disconnect_user for user=${userId} room=${roomId}`);
  }

  requestSync(): void {
    const ws = this.getWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      consola.warn('SFU connection not available for sync_request');
      return;
    }

    const message: WebSocketMessage = {
      event: 'sync_request',
      data: JSON.stringify({
        server_id: this.serverId,
        server_password: this.serverToken,
      }),
    };

    ws.send(JSON.stringify(message));
    consola.info('[SFU] Sent sync_request');
  }

  onConnectionClosed(): void {
    this.roomsToReregister = new Set([...this.roomsToReregister, ...this.registeredRooms]);
    this.registeredRooms.clear();
    consola.info(`Marked ${this.roomsToReregister.size} rooms for re-registration on reconnect`);
  }

  onDisconnect(): void {
    this.registeredRooms.clear();
    this.roomsToReregister.clear();
  }
}
