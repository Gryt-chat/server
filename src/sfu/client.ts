import WebSocket from 'ws';
import { consola } from 'consola';
import { SFURoomManager } from './clientRooms';

interface WebSocketMessage {
  event: string;
  data: string;
}

export interface SFUPeerEvent {
  roomId: string;
  userId: string;
}

export interface SFUSyncRoom {
  room_id: string;
  user_ids: string[];
}

export interface SFUEventCallbacks {
  onPeerJoined?: (event: SFUPeerEvent) => void;
  onPeerLeft?: (event: SFUPeerEvent) => void;
  onSyncResponse?: (rooms: SFUSyncRoom[]) => void;
}

export class SFUClient {
  private ws: WebSocket | null = null;
  private serverId: string;
  private serverToken: string;
  private sfuHost: string;
  private reconnectAttempts = 0;
  private reconnectDelay = 10000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;
  private healthInterval: NodeJS.Timeout | null = null;
  private syncInterval: NodeJS.Timeout | null = null;
  private connectionHealth = {
    lastPing: 0,
    isHealthy: true,
  };
  private roomManager: SFURoomManager;
  private callbacks: SFUEventCallbacks = {};

  constructor(serverId: string, serverPassword: string, sfuHost: string) {
    this.serverId = serverId;
    this.serverToken = serverPassword;
    this.sfuHost = sfuHost;
    
    if (!serverId || !serverPassword || !sfuHost) {
      throw new Error('SFU client requires serverId, serverPassword, and sfuHost');
    }

    this.roomManager = new SFURoomManager(() => this.ws, serverId, serverPassword);
  }

  setCallbacks(cb: SFUEventCallbacks): void {
    this.callbacks = cb;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const wsUrl = this.buildWebSocketUrl();
        consola.info(`[SFU-Client:Step 1] Connecting to SFU server at ${wsUrl}`);
        
        this.ws = new WebSocket(wsUrl);
        this.shouldReconnect = true;

        const connectionTimeout = setTimeout(() => {
          if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
            consola.error(`[SFU-Client:Step 1] Connection timeout (10s) to ${wsUrl}`);
            this.ws.terminate();
            reject(new Error('SFU connection timeout'));
          }
        }, 10000);

        this.ws.on('open', () => {
          clearTimeout(connectionTimeout);
          consola.success(`[SFU-Client:Step 2] Connected to SFU server at ${wsUrl}`);
          this.reconnectAttempts = 0;
          this.connectionHealth.isHealthy = true;
          this.startHealthCheck();
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          
          this.roomManager.reregisterRooms()
            .then(() => {
              this.roomManager.requestSync();
            })
            .catch(error => {
              consola.error('[SFU-Client] Failed to re-register rooms after reconnection:', error);
            });
          
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          try {
            const message: WebSocketMessage = JSON.parse(data.toString());
            this.handleMessage(message);
          } catch (error) {
            consola.error('[SFU-Client] Error parsing SFU message:', error);
          }
        });

        this.ws.on('close', (code, reason) => {
          clearTimeout(connectionTimeout);
          consola.warn(`[SFU-Client] Connection closed: code=${code} reason="${reason}"`);
          this.ws = null;
          this.connectionHealth.isHealthy = false;
          this.roomManager.onConnectionClosed();
          this.scheduleReconnect();
        });

        this.ws.on('error', (error) => {
          clearTimeout(connectionTimeout);
          consola.error('[SFU-Client] Connection error:', error);
          this.connectionHealth.isHealthy = false;
          
          if (this.reconnectAttempts === 0) {
            reject(error);
          }
          this.scheduleReconnect();
        });

      } catch (error) {
        consola.error('[SFU-Client] Failed to create connection:', error);
        reject(error);
      }
    });
  }

  private buildWebSocketUrl(): string {
    let url = this.sfuHost;
    
    if (url.startsWith('https://')) {
      url = url.replace('https://', 'wss://');
    } else if (url.startsWith('http://')) {
      url = url.replace('http://', 'ws://');
    } else if (!url.startsWith('wss://') && !url.startsWith('ws://')) {
      url = `wss://${url}`;
    }
    
    if (!url.endsWith('/server')) {
      url = url.replace(/\/$/, '') + '/server';
    }
    
    return url;
  }

  private stopHealthCheck(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.connectionHealth.lastPing = Date.now();
    
    this.healthInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.connectionHealth.isHealthy = false;
        this.stopHealthCheck();
        return;
      }

      this.connectionHealth.isHealthy = true;
      try {
        const msg: WebSocketMessage = {
          event: 'keep_alive',
          data: JSON.stringify({ timestamp: Date.now(), server_id: this.serverId }),
        };
        this.ws.send(JSON.stringify(msg));
      } catch {
        this.connectionHealth.isHealthy = false;
        this.stopHealthCheck();
      }
    }, 15000);

    this.syncInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.roomManager.requestSync();
      }
    }, 60_000);
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) {
      consola.info('Reconnect disabled (manual shutdown). Skipping reconnect scheduling.');
      return;
    }

    if (this.reconnectTimer) return;

    this.reconnectAttempts++;
    const delay = this.reconnectDelay;
    consola.info(`Reconnecting to SFU in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => {
        consola.error('SFU reconnection failed:', error);
        this.scheduleReconnect();
      });
    }, delay);
  }

  private handleMessage(message: WebSocketMessage): void {
    this.connectionHealth.lastPing = Date.now();
    
    switch (message.event) {
      case 'room_joined':
        consola.success(`[SFU-Client] Room registration confirmed by SFU: ${message.data}`);
        break;
      case 'room_error':
        consola.error(`[SFU-Client] Room error from SFU: ${message.data}`);
        break;
      case 'peer_joined': {
        try {
          const data = JSON.parse(message.data) as { room_id: string; user_id: string };
          consola.info(`[SFU-Client] Peer joined: user=${data.user_id} room=${data.room_id}`);
          this.callbacks.onPeerJoined?.({ roomId: data.room_id, userId: data.user_id });
        } catch (e) {
          consola.error('[SFU-Client] Failed to parse peer_joined:', e);
        }
        break;
      }
      case 'peer_left': {
        try {
          const data = JSON.parse(message.data) as { room_id: string; user_id: string };
          consola.info(`[SFU-Client] Peer left: user=${data.user_id} room=${data.room_id}`);
          this.callbacks.onPeerLeft?.({ roomId: data.room_id, userId: data.user_id });
        } catch (e) {
          consola.error('[SFU-Client] Failed to parse peer_left:', e);
        }
        break;
      }
      case 'sync_response': {
        try {
          const data = JSON.parse(message.data) as { rooms: SFUSyncRoom[] };
          consola.info(`[SFU-Client] Sync response: ${data.rooms?.length ?? 0} rooms`);
          this.callbacks.onSyncResponse?.(data.rooms ?? []);
        } catch (e) {
          consola.error('[SFU-Client] Failed to parse sync_response:', e);
        }
        break;
      }
      case 'keep_alive':
        break;
      default:
        consola.debug(`[SFU-Client] Message: event=${message.event} data=${message.data}`);
    }
  }

  // ── Delegated room/user methods ───────────────────────────────────

  async registerRoom(roomId: string): Promise<void> {
    return this.roomManager.registerRoom(roomId);
  }

  async unregisterRoom(roomId: string): Promise<void> {
    return this.roomManager.unregisterRoom(roomId);
  }

  generateClientJoinToken(roomId: string, userId: string) {
    return this.roomManager.generateClientJoinToken(roomId, userId);
  }

  async updateUserAudioState(roomId: string, userId: string, isMuted: boolean, isDeafened: boolean): Promise<void> {
    return this.roomManager.updateUserAudioState(roomId, userId, isMuted, isDeafened);
  }

  trackUserConnection(roomId: string, userId: string): boolean {
    return this.roomManager.trackUserConnection(roomId, userId);
  }

  untrackUserConnection(userId: string): void {
    this.roomManager.untrackUserConnection(userId);
  }

  getTrackedUser(userId: string): { roomId: string; userId: string; connectedAt: number } | undefined {
    return this.roomManager.getTrackedUser(userId);
  }

  getActiveUsers(): Map<string, { roomId: string; userId: string; connectedAt: number }> {
    return this.roomManager.getActiveUsers();
  }

  async disconnectUser(roomId: string, userId: string): Promise<void> {
    return this.roomManager.disconnectUser(roomId, userId);
  }

  requestSync(): void {
    this.roomManager.requestSync();
  }

  isConnected(): boolean {
    return this.ws !== null && 
           this.ws.readyState === WebSocket.OPEN && 
           this.connectionHealth.isHealthy;
  }

  getConnectionStatus(): {
    connected: boolean;
    healthy: boolean;
    registeredRooms: number;
    roomsToReregister: number;
    reconnectAttempts: number;
  } {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN || false,
      healthy: this.connectionHealth.isHealthy,
      registeredRooms: this.roomManager.registeredRooms.size,
      roomsToReregister: this.roomManager.roomsToReregister.size,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopHealthCheck();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      consola.info('Disconnecting from SFU server');
      this.ws.close(1000, 'Server shutdown');
      this.ws = null;
    }
    this.roomManager.onDisconnect();
    this.connectionHealth.isHealthy = false;
  }
}
