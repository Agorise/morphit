/**
 * Morphit indexer — per-IP rate-limit middleware.
 *
 * Sliding-window token bucket, in-memory. Two tiers:
 *   - `list`:     orderbook, feedback list, chat history — busier
 *                 endpoints, lower limit (default 120/min)
 *   - `resource`: profile by account, release, single order —
 *                 cheap lookups, higher limit (default 600/min)
 *
 * Client-IP derivation (Finding B): forwarded-address headers
 * (X-Real-IP, X-Forwarded-For) are honored only when the socket
 * peer is a loopback address (nginx on the same host). Non-
 * loopback peers have their socket address used as the bucket
 * key regardless of what headers they sent — otherwise a
 * direct-connection attacker could forge the header per request
 * and get a fresh bucket every time, bypassing the limiter.
 *
 * State is per-process. If the operator runs multiple indexer
 * instances behind a load balancer they'll want a shared limiter,
 * but that's a Phase 5 concern — one instance handles the entire
 * foreseeable load.
 */

import type { Context, MiddlewareHandler } from 'hono';

type Tier = 'list' | 'resource';

interface Bucket {
	/** Unix-ms timestamps of requests still within the window. */
	timestamps: number[];
}

const WINDOW_MS = 60_000;

/** Peer addresses we trust to set forwarded-address headers. */
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const buckets = new Map<string, Bucket>();

/** Evict old entries periodically so the Map doesn't grow
 *  unboundedly under scanner traffic. Runs every 5 minutes. */
setInterval(() => {
	const cutoff = Date.now() - WINDOW_MS;
	for (const [key, bucket] of buckets) {
		const trimmed = bucket.timestamps.filter((t) => t > cutoff);
		if (trimmed.length === 0) {
			buckets.delete(key);
		} else {
			bucket.timestamps = trimmed;
		}
	}
}, 5 * 60_000).unref();

/** Raw socket peer from Hono's Node adapter. Null if not
 *  available (non-Node adapter or test harness). */
function socketPeer(c: Context): string | null {
	const info = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
		?.incoming?.socket?.remoteAddress;
	if (!info) return null;
	return info.replace(/^\[|\]$/g, '');
}

function clientIp(c: Context): string {
	const peer = socketPeer(c);

	// Loopback peer = trusted nginx. Honor the forwarded-address
	// headers it set on our behalf.
	if (peer !== null && LOOPBACK_PEERS.has(peer)) {
		const real = c.req.header('x-real-ip');
		if (real && real.length < 64) return real;
		const xff = c.req.header('x-forwarded-for');
		if (xff) {
			const comma = xff.indexOf(',');
			const first = (comma > 0 ? xff.slice(0, comma) : xff).trim();
			if (first.length > 0 && first.length < 64) return first;
		}
		// Loopback peer with no forwarded headers — unusual but
		// harmless; fall back to the peer itself.
		return peer;
	}

	// Non-loopback peer: the socket IS the client. Ignore any
	// forwarded-address headers they sent (this is the Finding B
	// fix — previously we trusted these unconditionally).
	if (peer !== null) return peer;

	// No socket info. Degrade to 'unknown' — this bucket-keys all
	// unknown-peer requests together, which is fine as a last
	// resort but would cripple legitimate load. Real deployments
	// always have a Node adapter.
	return 'unknown';
}

export function rateLimit(tier: Tier, perMin: number): MiddlewareHandler {
	return async (c, next) => {
		const ip = clientIp(c);
		const key = `${tier}:${ip}`;
		const now = Date.now();
		const cutoff = now - WINDOW_MS;

		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = { timestamps: [] };
			buckets.set(key, bucket);
		}
		// Drop expired timestamps.
		bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);

		if (bucket.timestamps.length >= perMin) {
			// Compute retry-after from the oldest timestamp in the window.
			const oldest = bucket.timestamps[0] ?? now;
			const retryAfterSec = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
			c.header('retry-after', String(retryAfterSec));
			return c.json(
				{
					status: 'error',
					code: 'rate_limited',
					message: `Too many ${tier} requests. Retry in ${retryAfterSec}s.`
				},
				429
			);
		}
		bucket.timestamps.push(now);
		await next();
	};
}
