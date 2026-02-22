import { config } from "dotenv";
config({ override: false }); // Load environment variables from .env file
import { consola } from "consola";
import { socketHandler, setupSFUSync } from "./socket";
import { createServer } from "http";
import { Server } from "socket.io";
import express from "express"; // Import express
import { SFUClient } from "./sfu/client"; // Import SFU client
import {
	initScylla,
	createServerConfigIfNotExists,
	getServerConfig,
	setServerOwner,
	demoteAllOwnerRoles,
	ensureOwnerRoleForGrytUser,
	insertServerAudit,
} from "./db/scylla";
import { initS3 } from "./storage/s3";
import { serverRouter } from "./routes/server";
import { messagesRouter } from "./routes/messages";
import { uploadsRouter } from "./routes/uploads";
import { membersRouter } from "./routes/members";
import { emojisRouter } from "./routes/emojis";
import { getObject } from "./storage/s3";
import { startMediaSweep } from "./jobs/mediaSweep";

const app = express(); // Create an Express app

const allowedCorsOrigins = (process.env.CORS_ORIGIN || "https://app.gryt.chat")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

// Electron production builds load from file:// which sends Origin: "null" (literal string).
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
const disableScylla = (process.env.DISABLE_SCYLLA || "").toLowerCase() === "true";

// S3 is optional in dev. We only initialize if not disabled.
try {
	if (disableS3) {
		consola.warn("S3 disabled via DISABLE_S3=true");
	} else {
		initS3();
		consola.success("S3 client initialized");
	}
} catch (e) {
	consola.error("S3 initialization failed", e);
}

// Scylla is optional in dev. Avoid defaulting to 127.0.0.1:9042 unless explicitly configured.
const scyllaContactPoints = (process.env.SCYLLA_CONTACT_POINTS || "").trim();
if (disableScylla) {
	consola.warn("ScyllaDB disabled via DISABLE_SCYLLA=true");
} else if (!scyllaContactPoints) {
	consola.warn("ScyllaDB not configured (SCYLLA_CONTACT_POINTS missing). Skipping Scylla init.");
} else {
	const ownerId = (process.env.OWNER_ID || "").trim();
	initScylla()
		.then(async () => {
			consola.success("ScyllaDB initialized");
			if (!ownerId) {
				consola.warn("OWNER_ID is required; server will run without an owner until it is set.");
				await createServerConfigIfNotExists();
				return;
			}

			await createServerConfigIfNotExists();
			const cfg = await getServerConfig();
			const prev = cfg?.owner_gryt_user_id || null;
			if (prev === ownerId) {
				consola.info("OWNER_ID matches current owner; no change needed.");
				return;
			}

			await setServerOwner(ownerId);
			const demoted = await demoteAllOwnerRoles();
			const ensured = await ensureOwnerRoleForGrytUser(ownerId);

			insertServerAudit({
				actorServerUserId: null,
				action: "owner_override",
				target: ownerId,
				meta: { from: prev, to: ownerId, demotedOwners: demoted.demoted, ensuredOwnerRole: ensured.applied },
			}).catch(() => undefined);

			consola.warn("Server owner overridden from env", {
				from: prev,
				to: ownerId,
				demotedOwners: demoted.demoted,
				ensuredOwnerRole: ensured.applied,
			});
		})
		.then(() => {
			if (!disableS3) startMediaSweep();
		})
		.catch((e) => consola.error("ScyllaDB initialization failed", e));
}

// Initialize SFU client if host is configured
let sfuClient: SFUClient | null = null;

if (process.env.SFU_WS_HOST) {
	// Create unique server ID by combining SERVER_NAME with PORT and SCYLLA_KEYSPACE
	// This ensures each server instance gets a unique ID even if SERVER_NAME is the same
	const serverName = process.env.SERVER_NAME?.replace(/\s+/g, '_').toLowerCase() || 'unknown_server';
	const port = process.env.PORT || '5000';
	const keyspace = process.env.SCYLLA_KEYSPACE || 'default';
	const serverId = `${serverName}_${port}_${keyspace}`;
	const serverPassword = process.env.SERVER_PASSWORD || '';
	
	sfuClient = new SFUClient(serverId, serverPassword, process.env.SFU_WS_HOST);
	
	consola.info(`🔧 SFU Client initialized with unique server ID: ${serverId}`);
	consola.info(`   - Server Name: ${serverName}`);
	consola.info(`   - Port: ${port}`);
	consola.info(`   - Keyspace: ${keyspace}`);
	
	// Connect to SFU server
	sfuClient.connect().catch((error) => {
		consola.error('Failed to connect to SFU:', error);
	});
} else {
	consola.error(
		"No SFU host defined! Server will not send or retrieve streams."
	);
}

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
		const body: any = (obj as any)?.Body;
		if (!body) {
			res.status(502).json({ error: "s3_error", message: "Empty S3 response body" });
			return;
		}

		res.setHeader("Cache-Control", "public, max-age=60");
		if (obj.ContentType) res.setHeader("Content-Type", obj.ContentType);

		if (typeof body.pipe === "function") {
			body.pipe(res);
			return;
		}
		if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
			res.end(body);
			return;
		}
		const chunks: Uint8Array[] = [];
		for await (const chunk of body) chunks.push(chunk);
		res.end(Buffer.concat(chunks));
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

// Basic error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
	// Multer errors (file uploads)
	if (err?.code === "LIMIT_FILE_SIZE") {
		res.status(413).json({
			error: "file_too_large",
			message: "File too large.",
		});
		return;
	}
	if (typeof err?.message === "string" && err.message.toLowerCase().includes("unsupported")) {
		res.status(400).json({ error: "invalid_file", message: err.message });
		return;
	}
	consola.error(err);
	const message = (err && typeof err.message === "string" && err.message.trim().length > 0)
		? err.message
		: "Internal Server Error";
	// Always include both `error` (stable-ish code) and `message` (human readable).
	// If upstream code already provided a structured `error`, preserve it.
	const errorCode =
		(typeof err?.error === "string" && err.error.trim().length > 0)
			? err.error
			: (typeof err?.code === "string" && err.code.trim().length > 0)
				? err.code
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
