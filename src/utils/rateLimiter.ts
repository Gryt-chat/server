import consola from "consola";

export type RateLimitKeyParts = {
	userId?: string;
	ip?: string;
	event: string;
};

export interface RateLimitRule {
	limit: number; // max events
	windowMs: number; // sliding window size
	banMs?: number; // optional temporary ban duration when exceeded
	// Score-based limiting
	scorePerAction?: number; // points added per action (default: 1)
	maxScore?: number; // max score before rate limiting kicks in
	scoreDecayMs?: number; // how fast score decays (default: 1000ms per point)
}

type TimestampQueue = number[];

interface ScoreData {
	score: number;
	lastUpdate: number;
}

class SlidingWindowLimiter {
	private buckets: Map<string, TimestampQueue> = new Map();
	private bans: Map<string, number> = new Map();
	private scores: Map<string, ScoreData> = new Map();

	constructor(private defaultRule: RateLimitRule) {
		// Unref'd, so importing this module does not by itself hold the process
		// open — the same reason the nonce sweeper in auth/identity is. The
		// server runs forever regardless; anything that only wants a handler,
		// like a test, should be able to exit when it is done. Without it a
		// test file that imports any handler hangs after the last assertion.
		setInterval(() => this.evictStale(), 60_000).unref();
	}

	private evictStale(): void {
		const now = Date.now();
		for (const [k, ts] of this.bans) {
			if (ts <= now) this.bans.delete(k);
		}
		for (const [k, q] of this.buckets) {
			if (q.length === 0 || q[q.length - 1] < now - this.defaultRule.windowMs) this.buckets.delete(k);
		}
		for (const [k, s] of this.scores) {
			if (s.score <= 0 || now - s.lastUpdate > 300_000) this.scores.delete(k);
		}
	}

	/** Forget everything. Tests only — a live server has no reason to. */
	reset(): void {
		this.buckets.clear();
		this.bans.clear();
		this.scores.clear();
	}

	private key(parts: RateLimitKeyParts): string {
		const uid = parts.userId || "anonymous";
		const ip = parts.ip || "unknown";
		return `${parts.event}:${uid}:${ip}`;
	}

	check(parts: RateLimitKeyParts, rule?: RateLimitRule): { allowed: boolean; retryAfterMs?: number; bannedUntil?: number; currentScore?: number; maxScore?: number } {
		const now = Date.now();
		const effective = rule || this.defaultRule;
		const k = this.key(parts);

		const bannedUntil = this.bans.get(k);
		if (bannedUntil && bannedUntil > now) {
			return { allowed: false, bannedUntil };
		} else if (bannedUntil && bannedUntil <= now) {
			this.bans.delete(k);
		}

		// Score-based limiting (if enabled)
		if (effective.maxScore && effective.scorePerAction) {
			const scoreData = this.scores.get(k);
			const scorePerAction = effective.scorePerAction;
			const maxScore = effective.maxScore;
			const scoreDecayMs = effective.scoreDecayMs || 1000;

			let currentScore = 0;
			if (scoreData) {
				// Decay score based on time passed
				const timePassed = now - scoreData.lastUpdate;
				const decayAmount = Math.floor(timePassed / scoreDecayMs);
				currentScore = Math.max(0, scoreData.score - decayAmount);
			}

			// Add score for this action
			currentScore += scorePerAction;

			// Update score data
			this.scores.set(k, { score: currentScore, lastUpdate: now });

			// Check if score exceeds limit
			if (currentScore > maxScore) {
				const retryAfterMs = Math.max(0, currentScore * scoreDecayMs);
				if (effective.banMs && !this.bans.has(k)) {
					this.bans.set(k, now + effective.banMs);
					consola.warn("🚫 Rate limit ban applied (score-based)", { key: k, score: currentScore, maxScore, banMs: effective.banMs });
				}
				return { 
					allowed: false, 
					retryAfterMs, 
					bannedUntil: this.bans.get(k),
					currentScore,
					maxScore
				};
			}

			// Score-based limiting passed, but still check traditional window-based limiting
		}

		// Traditional sliding window limiting
		let q = this.buckets.get(k);
		if (!q) {
			q = [];
			this.buckets.set(k, q);
		}

		// Evict old timestamps outside window
		const windowStart = now - effective.windowMs;
		while (q.length > 0 && q[0] < windowStart) q.shift();

		if (q.length >= effective.limit) {
			const retryAfterMs = Math.max(0, (q[0] + effective.windowMs) - now);
			if (effective.banMs && !this.bans.has(k)) {
				this.bans.set(k, now + effective.banMs);
				consola.warn("🚫 Rate limit ban applied (window-based)", { key: k, banMs: effective.banMs });
			}
			return { allowed: false, retryAfterMs, bannedUntil: this.bans.get(k) };
		}

		q.push(now);
		return { allowed: true };
	}
}

// Global limiter instance (process-local). For multi-instance deployments, consider Redis.
export const limiter = new SlidingWindowLimiter({ limit: 100, windowMs: 60_000 });

export function checkRateLimit(event: string, userId?: string, ip?: string, rule?: RateLimitRule) {
	return limiter.check({ event, userId, ip }, rule);
}

/**
 * Clear every counter, for a test that drives one handler many times.
 *
 * The limiter is process-global and keyed on the caller, so a test file acting
 * as the same person twenty times looks exactly like somebody hammering the
 * server — which is the point of it, and makes it the wrong thing to leave
 * running between cases. The same seam `resetChannelIdCache` is.
 */
export function resetRateLimits(): void {
	limiter.reset();
}


