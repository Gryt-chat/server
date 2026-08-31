import { config } from "dotenv";
import { isOriginAllowed, readAllowedOrigins } from "./config/cors";
import { RL_HTTP_API, RL_HTTP_FILE, RL_HTTP_OUTBOUND, RL_HTTP_PUBLIC, RL_HTTP_UPLOAD, httpRateLimit } from "./middleware/rateLimitHttp";
config({ path: "config.env", override: false });
config({ override: false });
import { consola } from "consola";
import { stopMdns, syncMdnsAdvertising } from "./mdns";
import { socketHandler, setupSFUSync } from "./socket";
import { createServer } from "http";
import { networkInterfaces } from "os";
import { Server } from "socket.io";
import express from "express"; // Import express
import { managementRouter } from "./routes/management";
import { adminTokenConfigured } from "./middleware/requireAdminToken";
import { SFUClient } from "./sfu/client"; // Import SFU client
import {
  createServerConfigIfNotExists,
  getRegisteredUserCount,
  getServerConfig,
  initSqlite,
} from "./db";
import { getAcceptedIdentityTiers } from "./auth/identity";
import { logServerIdentity } from "./auth/serverIdentity";
import type { JoinPolicy } from "./db/interfaces";
import { verifyAccessToken } from "./utils/jwt";

import { initStorage, ensureBucket, getObject } from "./storage";
import { serverRouter } from "./routes/server";
import { messagesRouter } from "./routes/messages";
import { uploadsRouter } from "./routes/uploads";
import { membersRouter } from "./routes/members";
import { emojisRouter } from "./routes/emojis";
import { linkPreviewRouter } from "./routes/linkPreview";
import { oEmbedRouter } from "./routes/oembed";
import { mediaMetadataRouter } from "./routes/mediaMetadata";
import { webhooksRouter } from "./routes/webhooks";
import { startMediaSweep } from "./jobs/mediaSweep";
import { startEmojiQueueWorker } from "./jobs/emojiQueueWorker";
import {
  metricsMiddleware,
  register,
  socketConnectionsActive,
} from "./metrics";

const VERSION = process.env.SERVER_VERSION || "0.0.0";

const app = express(); // Create an Express app

const isProduction = (process.env.NODE_ENV || "").toLowerCase() === "production";

const allowedCorsOrigins = readAllowedOrigins(process.env.CORS_ORIGIN, isProduction);

function isAllowedOrigin(origin: string, requestHost?: string): boolean {
  return isOriginAllowed(origin, allowedCorsOrigins, requestHost);
}

// CORS for REST API (uploads, icons, etc.). Socket.IO has its own CORS config below.
// Without this, browser requests like POST /api/server/icon will fail preflight and show "Failed to fetch".
app.use((req, res, next) => {
  const origin = req.headers.origin as string | undefined;
  if (origin && isAllowedOrigin(origin, req.headers.host)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization,Content-Type,Accept,Origin,X-Requested-With"
    );
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// Parse JSON bodies
app.use(express.json({ limit: "2mb" }));

// Records the metrics. Serving them is further down, on a port of their own.
app.use(metricsMiddleware);

// Basic health check (used by docker-compose healthcheck)
app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "healthy",
    service: "signaling-server",
    serverName: process.env.SERVER_NAME || "unknown",
    timestamp: new Date().toISOString(),
  });
});

// Initialize storage and database
const disableS3 = (process.env.DISABLE_S3 || "").toLowerCase() === "true";

// S3 is optional in dev. We only initialize if not disabled.
try {
  if (disableS3) {
    consola.warn("S3 disabled via DISABLE_S3=true");
  } else {
    initStorage();
    const storageBackend = (process.env.STORAGE_BACKEND || "s3").toLowerCase();
    consola.success(`Storage initialized (${storageBackend})`);
    const bucket = (process.env.S3_BUCKET || "").trim();
    if (bucket) {
      ensureBucket(bucket)
        .then(() => consola.success(`Storage bucket "${bucket}" ready`))
        .catch((e) =>
          consola.error(`Failed to ensure storage bucket "${bucket}"`, e)
        );
    }
  }
} catch (e) {
  consola.error("S3 initialization failed", e);
}

// The server's own identity key, which clients pin on first join (GRYT-51).
// Generated here so it exists before the first connection and any failure is
// visible at boot; the module initializes itself on demand regardless.
logServerIdentity();

// Database initialization (SQLite)
initSqlite()
  .then(async () => {
    consola.success("SQLite initialized");
    // SERVER_DISCOVERABLE seeds the row on first run only, so the "Discoverable
    // on LAN" choice made when creating a server actually lands somewhere. After
    // that the config owns the setting and this is ignored — changing it is done
    // through server settings, which takes effect without a restart.
    await createServerConfigIfNotExists({
      discoverable: (process.env.SERVER_DISCOVERABLE || "").toLowerCase() !== "false",
    });
    // Now that the config is readable, advertise if `discoverable` allows it.
    await syncMdnsAdvertising(PORT);
  })
  .then(() => {
    if (!disableS3) startMediaSweep();
    if (!disableS3 && (process.env.S3_BUCKET || "").trim()) {
      startEmojiQueueWorker();
    }
  })
  .catch((e) => consola.error("SQLite initialization failed", e));

// Initialize SFU client if host is configured
let sfuClient: SFUClient | null = null;

if (process.env.SFU_WS_HOST) {
  const serverName =
    process.env.SERVER_NAME?.replace(/\s+/g, "_").toLowerCase() ||
    "unknown_server";
  const port = process.env.PORT || "5000";
  const instanceId = process.env.SERVER_INSTANCE_ID || "default";
  const serverId = `${serverName}_${port}_${instanceId}`;
  const serverPassword = process.env.SERVER_PASSWORD || "";

  sfuClient = new SFUClient(serverId, serverPassword, process.env.SFU_WS_HOST);

  consola.info(`SFU Client initialized with server ID: ${serverId}`);

  // Connect to SFU server
  sfuClient.connect().catch((error) => {
    consola.error("Failed to connect to SFU:", error);
  });
} else {
  consola.error(
    "No SFU host defined! Server will not send or retrieve streams."
  );
}

// Public server info (used by the "Add Server" dialog & site invite page — no auth required)
app.get("/info", httpRateLimit("http:public", RL_HTTP_PUBLIC), async (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  let displayName = process.env.SERVER_NAME || "Unknown Server";
  let description = process.env.SERVER_DESCRIPTION || "A Gryt server";
  let lanOpen = false;
  // Falls back to the stricter answer if the config cannot be read, so a
  // database wobble never advertises a server as easier to get into than it is.
  let joinPolicy: JoinPolicy = "invite";
  let serverId: string | null = null;
  let isMember = false;

  try {
    const cfg = await getServerConfig();

    // Identify the caller once. Two things depend on it: hiding an
    // undiscoverable server entirely, and whether the version is disclosed.
    if (cfg) {
      const authHeader = _req.headers["authorization"];
      const match =
        typeof authHeader === "string"
          ? authHeader.match(/^Bearer\s+(.+)$/i)
          : null;
      const token = match?.[1]?.trim();
      const payload = token
        ? verifyAccessToken(token, { ignoreExpiration: true })
        : null;
      const host = _req.headers.host || "unknown";
      isMember = !!(
        payload &&
        payload.serverHost === host &&
        (payload.tokenVersion ?? 0) === (cfg.token_version ?? 0)
      );
    }

    if (cfg && cfg.discoverable === false && !isMember) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    if (cfg?.display_name) displayName = cfg.display_name;
    if (cfg?.description) description = cfg.description;
    if (cfg?.lan_open) lanOpen = true;
    if (cfg?.join_policy) joinPolicy = cfg.join_policy;

    if ((cfg as { server_id?: string | null })?.server_id) {
      serverId = (cfg as { server_id?: string }).server_id!;
    }
  } catch {
    // fall back to env
  }

  if (!serverId) {
    serverId = process.env.SERVER_INSTANCE_ID || null;
  }

  const memberCount = await getRegisteredUserCount().catch(() => 0);

  res.json({
    serverId,
    name: displayName,
    description,
    members: memberCount.toString(),
    // Members only. A precise build number lets anyone on the network scan for
    // hosts running a version with a known vulnerability, and /info has to stay
    // reachable unauthenticated for the add-server flow, so the field is
    // omitted rather than the endpoint being closed.
    ...(isMember ? { version: process.env.SERVER_VERSION || "1.0.0" } : {}),
    lanOpen,
    // What this server asks of somebody who is not a member yet. Unauthenticated
    // on purpose: the whole point is that a client can say "you don't need an
    // account to join this one" before anybody tries. Neither field tells a
    // caller anything they could not learn by attempting the join and reading
    // the refusal.
    identityTiers: getAcceptedIdentityTiers(),
    joinPolicy,
  });
});

// Serve the uploaded server icon by streaming from S3.
// Streams through the API instead of redirecting to presigned URLs, because in
// dev/self-hosted setups the S3 endpoint is often an internal address (e.g.
// http://minio:9000 or 127.0.0.1:9000) that browsers cannot reach.
app.get("/icon", httpRateLimit("http:public", RL_HTTP_PUBLIC), async (req, res) => {
  try {
    const cfg = await getServerConfig();
    const iconKey = cfg?.icon_url;
    if (!iconKey || !process.env.S3_BUCKET) {
      res
        .status(404)
        .json({ error: "no_icon", message: "No server icon configured" });
      return;
    }

    const obj = await getObject({
      bucket: process.env.S3_BUCKET,
      key: iconKey,
    });
    const body = obj.Body;
    if (!body) {
      res
        .status(502)
        .json({ error: "s3_error", message: "Empty S3 response body" });
      return;
    }

    // Revalidate rather than cache blind. This used to be max-age=60, which
    // meant clearing an icon left every client showing the old one for up to a
    // minute — a reload does not bypass a fresh cache entry, so it looked like
    // the server was still serving it. The key is a fresh uuid per upload, so
    // it doubles as an ETag: unchanged icons still cost one 304 rather than a
    // transfer, and a cleared one is noticed immediately.
    const etag = `"${iconKey}"`;
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("ETag", etag);
    if (req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }

    if (obj.ContentType) res.setHeader("Content-Type", obj.ContentType);
    body.pipe(res);
  } catch {
    res
      .status(404)
      .json({ error: "no_icon", message: "No server icon configured" });
  }
});

// API routes (all /api/* routes require Bearer token auth except /api/server/icon which has its own)
// Limits go in front of the routers, so a refused request never reaches body
// parsing, signature checking or an outbound fetch. `webhooks` carries its own,
// keyed per webhook rather than per address, and is left alone.
// These three were mounted bare. The comment above has said "limits go in front
// of the routers" since #106, and these were the routers it did not cover.
//
// /api/server matters most of the three: its only routes write a server icon,
// and multer buffered an anonymous 25 MB body into the heap before anything
// checked a token (GRYT-788). The auth check moved in front of multer in the
// same change, so this is the second half rather than the fix.
app.use("/api/server", httpRateLimit("http:server", RL_HTTP_UPLOAD), serverRouter);
app.use("/api/messages", httpRateLimit("http:api", RL_HTTP_API), messagesRouter);
// Reading a file and writing one are the same mount, so they need different
// budgets: a busy channel legitimately fetches hundreds of attachments as it
// scrolls, while writing that many is not a thing anybody does by hand.
//
// The order matters and so does the skip. Express runs every mount that
// matches, so without it `/api/uploads/files/<id>` would be charged to the
// upload budget as well as the file one, and scrolling would trip a limit meant
// for uploading.
const limitUploadWrites = httpRateLimit("http:upload", RL_HTTP_UPLOAD);
app.use("/api/uploads/files", httpRateLimit("http:file", RL_HTTP_FILE));
app.use(
  "/api/uploads",
  (req, res, next) => (req.path.startsWith("/files") ? next() : limitUploadWrites(req, res, next)),
  uploadsRouter,
);
app.use("/api/members", httpRateLimit("http:api", RL_HTTP_API), membersRouter);
app.use("/api/emojis", httpRateLimit("http:emoji", RL_HTTP_UPLOAD), emojisRouter);
app.use("/api/link-preview", httpRateLimit("http:outbound", RL_HTTP_OUTBOUND), linkPreviewRouter);
app.use("/api/oembed", httpRateLimit("http:outbound", RL_HTTP_OUTBOUND), oEmbedRouter);
app.use("/api/media/metadata", httpRateLimit("http:outbound", RL_HTTP_OUTBOUND), mediaMetadataRouter);
app.use("/api/webhooks", webhooksRouter);

// Basic error handler
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    const e =
      typeof err === "object" && err !== null
        ? (err as Record<string, unknown>)
        : {};
    if (e.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({
        error: "file_too_large",
        message: "File too large.",
      });
      return;
    }
    if (
      typeof e.message === "string" &&
      e.message.toLowerCase().includes("unsupported")
    ) {
      res.status(400).json({ error: "invalid_file", message: e.message });
      return;
    }
    consola.error(err);
    const message =
      typeof e.message === "string" && e.message.trim().length > 0
        ? e.message
        : "Internal Server Error";
    const errorCode =
      typeof e.error === "string" && e.error.trim().length > 0
        ? e.error
        : typeof e.code === "string" && e.code.trim().length > 0
        ? e.code
        : "internal_error";
    res.status(500).json({ error: errorCode, message });
  }
);

const httpServer = createServer(app); // Pass the Express app to createServer

const io = new Server(httpServer, {
  cors: {
    // Headers only. The decision is `allowRequest` below, which is the one
    // place that can see the Host header and therefore tell a same-origin
    // request from a cross-origin one. Reflecting here is safe because nothing
    // reaches a socket without passing that.
    origin: (_origin, callback) => callback(null, true),
  },
  // The single decision point for who may open a socket.
  //
  // It has to be here rather than in `cors.origin` because that callback is
  // handed the origin and nothing else, and the question "is this origin the
  // same host the request was sent to" cannot be answered without the request.
  // That question is the whole of the native-client case.
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    // No origin at all is a non-browser client — curl, a bot, the SFU. Those
    // were always allowed and this does not change that.
    if (!origin) return callback(null, true);
    if (isAllowedOrigin(origin, req.headers.host)) return callback(null, true);
    return callback(`CORS origin not allowed: ${origin}`, false);
  },
  pingInterval: 15_000,
  pingTimeout: 10_000,
  perMessageDeflate: false,
});

if (sfuClient) {
  setupSFUSync(io, sfuClient);
}

io.on("connection", (socket) => {
  socketConnectionsActive.inc();
  socket.on("disconnect", () => socketConnectionsActive.dec());

  if (!isProduction) {
    console.log(`🔌 MAIN SERVER: New WebSocket connection established`);
    console.log(`🔌 Connection details:`, {
      id: socket.id,
      address: socket.handshake.address,
      userAgent: socket.handshake.headers["user-agent"],
      origin: socket.handshake.headers.origin,
    });
  }
  socketHandler(io, socket, sfuClient);
});

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 5000);

function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}

// The management API, on its own listener.
//
// A separate port on purpose. The main one is bound to whatever HOST says,
// which defaults to 0.0.0.0 and is meant to be reachable — so mounting
// management there would put it wherever the server is, including the public
// internet for anybody forwarding a port. This one is only ever reached
// through the Compose file's `127.0.0.1:<port>:<port>` publish, which Docker
// enforces at the host before anything reaches the container.
//
// It does not start at all unless GRYT_ADMIN_TOKEN is set, so a server run any
// other way has exactly the surface it had before.
if (adminTokenConfigured()) {
  const managementApp = express();
  managementApp.use("/management", managementRouter);
  const managementPort = Number(process.env.GRYT_ADMIN_PORT || 5099);
  managementApp.listen(managementPort, "0.0.0.0", () => {
    consola.success(`Management API listening on ${managementPort} (publish it to 127.0.0.1 only)`);
  });
}

/*
 * Metrics get a port of their own, and it is not the one the world talks to.
 *
 * They used to be served from the main app at /metrics, with no authentication,
 * which meant every deployment behind a reverse proxy or a tunnel published its
 * full Prometheus register to anybody who asked: socket counts, per-route
 * timings, memory, garbage collection. Not message content, but more than a
 * stranger has any business reading, and it undid the care taken elsewhere —
 * /info deliberately withholds the version from non-members, and /metrics gave
 * it away.
 *
 * A separate port rather than a token, because a token is only safe for people
 * who set one. The monitoring stack in the Compose file is opt-in
 * (profiles: ["monitoring"]), so most deployments run no Prometheus at all and
 * would never have set it — they would have kept the exposure and gained
 * nothing. This way the default is closed for them without anybody doing
 * anything.
 *
 * Prometheus reaches it as `server:<port>` over the Compose network, which
 * needs no published port. Publishing this one, or running the server with host
 * networking, puts it back on the public internet — so don't.
 */
const metricsPort = Number(process.env.METRICS_PORT || 9091);
if (metricsPort > 0) {
  const metricsApp = express();
  metricsApp.get("/metrics", async (_req, res) => {
    res.setHeader("Content-Type", register.contentType);
    res.end(await register.metrics());
  });
  const metricsServer = metricsApp.listen(metricsPort, "0.0.0.0", () => {
    consola.success(`Metrics on ${metricsPort} (container-only; do not publish this port)`);
  });

  // A port for telemetry being unavailable is not a reason to refuse to run a
  // chat server. Without this the listen error is an unhandled 'error' event,
  // which takes the process down and puts it in a restart loop — so the first
  // deployment to run two servers on one host with host networking lost the
  // second one entirely, and the logs said EADDRINUSE rather than anything
  // about metrics.
  //
  // Two servers sharing a host share its ports, so a collision here is ordinary
  // rather than exceptional, and the answer is to say so and carry on. Metrics
  // are still recorded either way; they are simply not served.
  metricsServer.on("error", (err: NodeJS.ErrnoException) => {
    const because = err.code === "EADDRINUSE"
      ? `port ${metricsPort} is already in use, most likely by another Gryt server on this host`
      : err.message;
    consola.warn(`Metrics are not being served: ${because}. Set METRICS_PORT to a free port, or METRICS_PORT=0 to stop trying.`);
  });
} else {
  consola.info("METRICS_PORT=0, so metrics are recorded but not served anywhere");
}

/**
 * The addresses this server answers on, as something a person can act on.
 *
 * IPv4 in full with the interface name, IPv6 as a count. A host has a couple
 * of IPv4 addresses and can easily have thirty IPv6 ones, nearly all
 * link-local, and printing them all buries the two anybody is looking for.
 *
 * Loopback is kept deliberately. "127.0.0.1 and nothing else" is a real state
 * and it is the one worth spotting, so filtering it would hide the diagnosis.
 *
 * A bind to one specific address rather than the wildcard is reported as
 * exactly that, since in that case the list would be a lie.
 */
function reachableAddresses(port: number, host: string): string[] {
  if (host !== "0.0.0.0" && host !== "::") {
    return [`Bound to ${host}:${port} only, so nothing else can reach it.`];
  }

  const v4: string[] = [];
  let v6 = 0;

  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv6") {
        v6 += 1;
        continue;
      }
      v4.push(`${addr.address}:${port} (${name})`);
    }
  }

  v4.sort();

  const suffix = v6 > 0 ? ` (and ${v6} IPv6)` : "";
  if (v4.length === 0) {
    return [`Reachable on: no IPv4${suffix}`];
  }

  return [`Reachable on: ${v4.join(", ")}${suffix}`];
}

httpServer.listen(PORT, HOST, () => {
  consola.box(`Gryt Server v${VERSION}`);
  consola.start(`Starting ${process.env.SERVER_NAME}...`);
  if (process.env.SFU_WS_HOST)
    consola.info("SFU host set to " + process.env.SFU_WS_HOST);
  consola.success(`Signaling server started at ${HOST}:${PORT}`);
  // Where, not just what it was told to bind. `0.0.0.0:5000` is the bind spec,
  // and nobody can type it into a browser or a router — so an address missing
  // from the list below, a VPN adapter that came up after this process for
  // instance, is invisible at exactly the moment somebody is trying to work
  // out why a friend cannot reach them. GRYT-482.
  for (const line of reachableAddresses(PORT, HOST)) consola.info(line);
  console.log(`🔌 WEBSOCKET SERVER READY:`, {
    host: HOST,
    port: PORT,
    serverName: process.env.SERVER_NAME || "Unknown Server",
    corsOrigin: allowedCorsOrigins,
    ready: true,
  });

  if (isLoopbackHost(HOST)) {
    consola.warn(
      `Bound to ${HOST}, so only this machine can reach the server, but it is ` +
        `still advertised over mDNS. Clients on the LAN will discover it and ` +
        `then fail to connect. Set HOST=0.0.0.0 to accept LAN connections.`
    );
  }

  // Advertising is not started here. It depends on the `discoverable` flag,
  // which lives in the database, and that is not reliably open yet at this
  // point — the SQLite init runs on its own promise chain. syncMdnsAdvertising
  // is called from there instead, once the config is actually readable.
});

const shutdownMdns = () => {
  // Wait for the goodbye packets before exiting, otherwise the record outlives
  // the process and clients keep listing a server that is gone.
  void stopMdns().finally(() => process.exit(0));
};
process.on("SIGTERM", shutdownMdns);
process.on("SIGINT", shutdownMdns);
