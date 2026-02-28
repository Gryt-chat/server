export type ServerIdParts = {
  serverName?: string;
  port?: string | number;
  instanceId?: string;
};

export function computeServerId(parts: ServerIdParts): string {
  const serverName = (parts.serverName || "unknown_server").toString().replace(/\s+/g, "_").toLowerCase();
  const port = (parts.port ?? "5000").toString();
  const instanceId = (parts.instanceId || "default").toString();
  return `${serverName}_${port}_${instanceId}`;
}

export function getServerIdFromEnv(): string {
  return computeServerId({
    serverName: process.env.SERVER_NAME,
    port: process.env.PORT,
    instanceId: process.env.SERVER_INSTANCE_ID,
  });
}

