import { config } from "dotenv";
config({ override: false }); // Load environment variables from .env file
import { consola } from "consola";
import { socketHandler, setupSFUSync } from "./socket";
import { createServer } from "http";
import { Server } from "socket.io";
import express from "express"; // Import express
import { SFUClient } from "./sfu/client"; // Import SFU client
import {
	createServerConfigIfNotExists,
	getRegisteredUserCount,
	getServerConfig,
	initSqlite,
} from "./db";
import { getIssuer, getJwksResponse, initBuiltinIdentity } from "./auth/builtinIdentity";

import { initStorage, ensureBucket, getObject } from "./storage";
import { serverRouter } from "./routes/server";
import { messagesRouter } from "./routes/messages";
import { uploadsRouter } from "./routes/uploads";
import { membersRouter } from "./routes/members";
import { emojisRouter } from "./routes/emojis";
import { linkPreviewRouter } from "./routes/linkPreview";
import { oEmbedRouter } from "./routes/oembed";
import { mediaMetadataRouter } from "./routes/mediaMetadata";
import { startMediaSweep } from "./jobs/mediaSweep";
import { startEmojiQueueWorker } from "./jobs/emojiQueueWorker";
import { startImageQueueWorker } from "./jobs/imageQueueWorker";
import { metricsMiddleware, register, socketConnectionsActive } from "./metrics";
import { readFileSync } from "fs";
import { join } from "path";

const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
const VERSION = process.env.SERVER_VERSION || pkg.version || "0.0.0";

const app = express(); // Create an Express app

const allowedCorsOrigins = (process.env.CORS_ORIGIN || "http://127.0.0.1:15738,https://app.gryt.chat,https://beta.gryt.chat")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

// Electron production builds load from http://127.0.0.1:15738 or send Origin: "null" (file://).
function isAllowedOrigin(origin: string): boolean {
	if (allowedCorsOrigins.includes("*")) return true;
	if (origin === "null") return true;
	return allowedCorsOrigins.includes(origin);
}

// CORS for REST API (uploads, icons, etc.). Socket.IO has its own CORS config below.
// Without this, browser requests like POST /api/server/icon will fail preflight and show "Failed to fetch".
app.use((req, res, next) => {
	const origin = req.headers.origin as string | undefined;
	if (origin && isAllowedOrigin(origin)) {
		res.setHeader("Access-Control-Allow-Origin", origin);
		res.setHeader("Vary", "Origin");
		res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
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

// Prometheus metrics
app.use(metricsMiddleware);
app.get("/metrics", async (_req, res) => {
	res.setHeader("Content-Type", register.contentType);
	res.end(await register.metrics());
});

// Basic health check (used by docker-compose healthcheck)
app.get("/health", (_req, res) => {
	res.status(200).json({
		status: "healthy",
		service: "signaling-server",
		serverName: process.env.SERVER_NAME || "unknown",
		timestamp: new Date().toISOString(),
	});
});

// JWKS endpoint for built-in identity provider (self-hosted mode)
app.get("/.well-known/jwks.json", (_req, res) => {
	try {
		res.json(getJwksResponse());
	} catch {
		res.status(503).json({ error: "identity_not_initialized" });
	}
});

// Initialize storage and database
const disableS3 = (process.env.DISABLE_S3 || "").toLowerCase() === "true";

// S3 is optional in dev. We only initialize if not disabled.
try {
	if (disableS3) {
		consola.warn("S3 disabled via DISABLE_S3=true");
	} else {
		initStorage();
		consola.success("S3 client initialized");
		const bucket = (process.env.S3_BUCKET || "").trim();
		if (bucket) {
			ensureBucket(bucket)
				.then(() => consola.success(`S3 bucket "${bucket}" ready`))
				.catch((e) => consola.error(`Failed to ensure S3 bucket "${bucket}"`, e));
		}
	}
} catch (e) {
	consola.error("S3 initialization failed", e);
}

// Built-in identity provider (self-hosted mode)
const identityMode = (process.env.IDENTITY_MODE || "").toLowerCase();
if (identityMode === "builtin") {
	initBuiltinIdentity()
		.then(() => {
			const issuer = getIssuer();
			process.env.GRYT_IDENTITY_JWKS_URL = `${issuer}/.well-known/jwks.json`;
			process.env.GRYT_IDENTITY_ISSUER = issuer;
			consola.success(`Built-in identity provider initialized (issuer: ${issuer})`);
		})
		.catch((e) => consola.error("Built-in identity initialization failed", e));
}

// Database initialization (SQLite)
initSqlite()
	.then(async () => {
		consola.success("SQLite initialized");
		await createServerConfigIfNotExists();
	})
	.then(() => {
		if (!disableS3) startMediaSweep();
		if (!disableS3 && (process.env.S3_BUCKET || "").trim()) {
			startEmojiQueueWorker();
			startImageQueueWorker();
		}
	})
	.catch((e) => consola.error("SQLite initialization failed", e));

// Initialize SFU client if host is configured
let sfuClient: SFUClient | null = null;

if (process.env.SFU_WS_HOST) {
	const serverName = process.env.SERVER_NAME?.replace(/\s+/g, '_').toLowerCase() || 'unknown_server';
	const port = process.env.PORT || '5000';
	const instanceId = process.env.SERVER_INSTANCE_ID || 'default';
	const serverId = `${serverName}_${port}_${instanceId}`;
	const serverPassword = process.env.SERVER_PASSWORD || '';
	
	sfuClient = new SFUClient(serverId, serverPassword, process.env.SFU_WS_HOST);
	
	consola.info(`SFU Client initialized with server ID: ${serverId}`);
	
	// Connect to SFU server
	sfuClient.connect().catch((error) => {
		consola.error('Failed to connect to SFU:', error);
	});
} else {
	consola.error(
		"No SFU host defined! Server will not send or retrieve streams."
	);
}

// Public server info (used by the "Add Server" dialog & site invite page — no auth required)
app.get("/info", async (_req, res) => {
	res.setHeader("Access-Control-Allow-Origin", "*");

	let displayName = process.env.SERVER_NAME || "Unknown Server";
	let description = process.env.SERVER_DESCRIPTION || "A Gryt server";
	try {
		const cfg = await getServerConfig();
		if (cfg?.display_name) displayName = cfg.display_name;
		if (cfg?.description) description = cfg.description;
	} catch {
		// fall back to env
	}

	const memberCount = await getRegisteredUserCount().catch(() => 0);

	res.json({
		name: displayName,
		description,
		members: memberCount.toString(),
		version: process.env.SERVER_VERSION || "1.0.0",
	});
});

// Serve the uploaded server icon by streaming from S3.
// Streams through the API instead of redirecting to presigned URLs, because in
// dev/self-hosted setups the S3 endpoint is often an internal address (e.g.
// http://minio:9000 or 127.0.0.1:9000) that browsers cannot reach.
app.get("/icon", async (_req, res) => {
	try {
		const cfg = await getServerConfig();
		const iconKey = cfg?.icon_url;
		if (!iconKey || !process.env.S3_BUCKET) {
			res.status(404).json({ error: "no_icon", message: "No server icon configured" });
			return;
		}

		const obj = await getObject({ bucket: process.env.S3_BUCKET, key: iconKey });
		const body = obj.Body;
		if (!body) {
			res.status(502).json({ error: "s3_error", message: "Empty S3 response body" });
			return;
		}

		res.setHeader("Cache-Control", "public, max-age=60");
		if (obj.ContentType) res.setHeader("Content-Type", obj.ContentType);
		body.pipe(res);
	} catch {
		res.status(404).json({ error: "no_icon", message: "No server icon configured" });
	}
});

// API routes (all /api/* routes require Bearer token auth except /api/server/icon which has its own)
app.use("/api/server", serverRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/uploads", uploadsRouter);
app.use("/api/members", membersRouter);
app.use("/api/emojis", emojisRouter);
app.use("/api/link-preview", linkPreviewRouter);
app.use("/api/oembed", oEmbedRouter);
app.use("/api/media/metadata", mediaMetadataRouter);

// Basic error handler
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
	const e = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : {};
	if (e.code === "LIMIT_FILE_SIZE") {
		res.status(413).json({
			error: "file_too_large",
			message: "File too large.",
		});
		return;
	}
	if (typeof e.message === "string" && e.message.toLowerCase().includes("unsupported")) {
		res.status(400).json({ error: "invalid_file", message: e.message });
		return;
	}
	consola.error(err);
	const message = (typeof e.message === "string" && e.message.trim().length > 0)
		? e.message
		: "Internal Server Error";
	const errorCode =
		(typeof e.error === "string" && e.error.trim().length > 0)
			? e.error
			: (typeof e.code === "string" && e.code.trim().length > 0)
				? e.code
				: "internal_error";
	res.status(500).json({ error: errorCode, message });
});

const httpServer = createServer(app); // Pass the Express app to createServer

const io = new Server(httpServer, {
	cors: {
		origin: (origin, callback) => {
			if (!origin) return callback(null, true);
			if (isAllowedOrigin(origin)) return callback(null, true);
			return callback(new Error(`CORS origin not allowed: ${origin}`));
		},
	},
});

if (sfuClient) {
	setupSFUSync(io, sfuClient);
}

io.on("connection", (socket) => {
	socketConnectionsActive.inc();
	socket.on("disconnect", () => socketConnectionsActive.dec());

	const verboseLogs = (process.env.NODE_ENV || "").toLowerCase() !== "production";
	if (verboseLogs) {
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

const PORT = process.env.PORT || 5000;

httpServer.listen(PORT, () => {
	consola.box(`Gryt Server v${VERSION}`);
	consola.start(`Starting ${process.env.SERVER_NAME}...`);
	if (process.env.SFU_WS_HOST)
		consola.info("SFU host set to " + process.env.SFU_WS_HOST);
	consola.success("Signaling server started at port", PORT);
	console.log(`🔌 WEBSOCKET SERVER READY:`, {
		port: PORT,
		serverName: process.env.SERVER_NAME || "Unknown Server",
		corsOrigin: allowedCorsOrigins,
		ready: true
	});
});
