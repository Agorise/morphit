/**
 * Morphit indexer — caps on open SSE streams.
 *
 * WHAT WAS WRONG. The SSE routes (orderbook, chat, chat-activity,
 * instances; the login-pairing wait since) had no limit of any kind: no rate limit on connecting, no cap on
 * how many stay open. The comments said per-IP connection caps "belong at the
 * reverse proxy" — but the shipped BunkerWeb frontend sets none, and Tor/I2P
 * visitors reach it without passing BunkerWeb at all. Every open stream costs
 * a snapshot query on connect and its own background work after, so a few
 * hundred idle connections from one client were a steady database load
 * nobody else could get past.
 *
 * NOW, three caps, all answered with 503 (the stream is unavailable right
 * now; the client's own backoff retries):
 *   - PER CLIENT, keyed exactly as the rate limiter keys requests. Not applied
 *     to a SHARED key — our own proxy's address, which stands for every Tor/I2P
 *     visitor at once; capping it like one client would cap the whole
 *     hidden-service audience.
 *   - SHARED: every shared key together holds at most this many, so
 *     the hidden-service audience cannot take the slots clearnet visitors
 *     need (on a zero-clearnet node it is simply the audience's ceiling).
 *   - INSTANCE-WIDE, which bounds everything else.
 *
 * A slot is released when the stream ends (the client leaves, or the stream
 * closes itself), exactly once.
 */
import type { Context } from 'hono';
import { requestClient } from '$api/middleware/ratelimit';

/** Streams one client may hold open. A browser tab opens up to four (orderbook,
 *  chat, chat activity, directory); this leaves room for several tabs. */
export const DEFAULT_STREAMS_PER_CLIENT = 24;
/** Streams the instance holds open in total. */
export const DEFAULT_STREAMS_GLOBAL = 2_000;
/** Streams all SHARED keys (the Tor/I2P gateway) may hold together. */
export const DEFAULT_STREAMS_SHARED = 1_500;

let perClientCap = DEFAULT_STREAMS_PER_CLIENT;
let globalCap = DEFAULT_STREAMS_GLOBAL;
let sharedCap = DEFAULT_STREAMS_SHARED;
const perClient = new Map<string, number>();
let open = 0;
let openShared = 0;

/**
 * Take a slot for a new stream. Returns the release function, or null when a
 * cap is reached (answer 503). The release is idempotent.
 */
export function acquireStreamSlot(c: Context): (() => void) | null {
	if (open >= globalCap) return null;
	const { key, shared } = requestClient(c);
	const held = perClient.get(key) ?? 0;
	if (!shared && held >= perClientCap) return null;
	if (shared && openShared >= sharedCap) return null;
	open++;
	if (shared) openShared++;
	perClient.set(key, held + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		open--;
		if (shared) openShared--;
		const n = (perClient.get(key) ?? 1) - 1;
		if (n <= 0) perClient.delete(key);
		else perClient.set(key, n);
	};
}

/** The 503 body every capped stream route returns. */
export function streamCapResponse(c: Context): Response {
	c.header('retry-after', '30');
	return c.json(
		{
			status: 'error',
			code: 'stream_capacity',
			message: 'Too many open live-update streams. Retry shortly.'
		},
		503
	);
}

/** Open streams right now, for /v1/health. */
export function openStreamCount(): number {
	return open;
}

/** Test seam. */
export function _setStreamCapsForTest(caps: {
	perClient: number;
	global: number;
	shared?: number;
}): void {
	perClientCap = caps.perClient;
	globalCap = caps.global;
	sharedCap = caps.shared ?? caps.global;
}
/** Test seam: restore defaults and forget every slot. */
export function _resetStreamCapsForTest(): void {
	perClientCap = DEFAULT_STREAMS_PER_CLIENT;
	globalCap = DEFAULT_STREAMS_GLOBAL;
	sharedCap = DEFAULT_STREAMS_SHARED;
	perClient.clear();
	open = 0;
	openShared = 0;
}
