import consola from 'consola';

const GRYT_AUTH_URL = 'http://localhost:8050';

export interface GrytUser {
  userId: string;
  nickname?: string;
}

export interface GrytVerificationResponse {
  valid: boolean;
  user?: GrytUser;
  error?: string;
}

export async function verifyJoinToken(joinToken: string, serverId?: string): Promise<GrytVerificationResponse> {
  try {
    consola.info(`🔐 Verifying join token with server ${serverId || 'unknown'}`);
    
    const response = await fetch(`${GRYT_AUTH_URL}/api/verifyJoinToken`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        joinToken,
        serverId,
        timestamp: Date.now()
      })
    });

    if (!response.ok) {
      consola.error(`❌ Join token verification failed: ${response.status} ${response.statusText}`);
      return {
        valid: false,
        error: `Join token verification failed: ${response.status}`
      };
    }

    const result = await response.json();
    consola.success(`✅ Join token verified: ${result.valid ? 'valid' : 'invalid'}`);
    
    return result;
  } catch (error) {
    consola.error('❌ Join token verification error:', error);
    return {
      valid: false,
      error: 'Failed to connect to Gryt Auth'
    };
  }
}
