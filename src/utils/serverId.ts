export type ServerIdParts = {
  serverName?: string;
  port?: string | number;
  keyspace?: string;
};

export function computeServerId(parts: ServerIdParts): string {
  const serverName = (parts.serverName || "unknown_server").toString().replace(/\s+/g, "_").toLowerCase();
  const port = (parts.port ?? "5000").toString();
  const keyspace = (parts.keyspace || "default").toString();
  return `${serverName}_${port}_${keyspace}`;
}

export function getServerIdFromEnv(): string {
  return computeServerId({
    serverName: process.env.SERVER_NAME,
    port: process.env.PORT,
    keyspace: process.env.SCYLLA_KEYSPACE,
  });
}

