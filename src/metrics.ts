import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import type { Request, Response, NextFunction } from "express";

export const register = new Registry();

collectDefaultMetrics({ register });

export const httpRequestsTotal = new Counter({
	name: "gryt_http_requests_total",
	help: "Total HTTP requests",
	labelNames: ["method", "route", "status"] as const,
	registers: [register],
});

export const httpRequestDuration = new Histogram({
	name: "gryt_http_request_duration_seconds",
	help: "HTTP request duration in seconds",
	labelNames: ["method", "route"] as const,
	buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
	registers: [register],
});

export const socketConnectionsActive = new Gauge({
	name: "gryt_socketio_connections_active",
	help: "Number of active Socket.IO connections",
	registers: [register],
});

function normalizeRoute(req: Request): string {
	if (req.route?.path) {
		return req.baseUrl + req.route.path;
	}
	return req.path;
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
	const end = httpRequestDuration.startTimer({ method: req.method });
	res.on("finish", () => {
		const route = normalizeRoute(req);
		end({ route });
		httpRequestsTotal.inc({ method: req.method, route, status: String(res.statusCode) });
	});
	next();
}
