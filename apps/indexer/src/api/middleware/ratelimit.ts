/**
 * Morphit indexer — per-IP rate-limit middleware.
 *
 * Sliding-window token bucket, in-memory. Three tiers:
 *   - `list`:     orderbook, feedback list, chat history — busier
 *                 endpoints, lower limit (default 120/min)
 *   - `resource`: profile by account, release, single order —
 *                 cheap lookups, higher limit (default 600/min)
 *   - `federation`: instance-to-instance traffic (chat fast push).
 *                 Its own tier for a reason that is easy to miss:
 *                 THE BUCKET KEY IS `tier:ip`, NOT `tier:ip:limit`.
 *                 Two middlewares on the same tier share one
 *                 timestamp array and each compares its length
 *                 against its OWN limit, so the lower limit wins
 *                 for both. Federation runs at thousands/min while
 *                 /v1/broadcast runs at hundreds; on the same tier,
 *                 a few hundred peer pushes a minute would 429 every
 *                 user write on the instance — and over Tor/I2P
 *                 every peer AND every user arrives as 127.0.0.1,
 *                 so that is one shared bucket for the whole world.
 *                 Adding a tier is how you get a separate bucket.
 *
 * Client-IP derivation (Finding B; v1.20.0 E2): forwarded-address
 * headers are honoured only when the socket peer is a TRUSTED proxy.
 * Untrusted peers have their socket address used as the bucket key
 * regardless of what headers they sent — otherwise a direct-connection
 * attacker could forge the header per request and get a fresh bucket
 * every time, bypassing the limiter.
 *
 * TRUSTED means loopback (bare-metal nginx on the same host) AND the Docker
 * bridge the BunkerWeb frontend container sits on. On a BunkerWeb box that
 * container is the socket peer of EVERY request (clearnet, Tor and I2P);
 * left untrusted, every visitor shares ONE bucket. The default trusts the
 * subnet the ansible role pins for that bridge, 172.20.0.0/16. A box whose
 * bridge is elsewhere (morphit.io's is 172.18.0.0/24) sets
 * MORPHIT_INDEXER_TRUSTED_PROXY_CIDRS to its bridge — `morphit-ops upgrade`
 * writes the detected bridge CIDR there — and that setting replaces the
 * default. The default used to be all of 172.16.0.0/12, which also trusted
 * every OTHER container network on the host: any of them could rotate
 * X-Forwarded-For per request and get a fresh bucket each time.
 *
 * Trust changes one thing: which header names the client for the rate-limit
 * and stream-cap KEYS. No route authorises anything on it, and nothing logs
 * it. The indexer's port (:8081) must never be reachable except from that
 * bridge and loopback: it binds 127.0.0.1 unless the operator widens it, and
 * the ansible install binds 0.0.0.0 behind UFW default-deny, allowing :8081
 * only from the bunkerweb_net CIDR.
 *
 * IPv6 clients are keyed by their /64: one host is routinely given a whole
 * /64, so keying on the full address gave it 2^64 buckets.
 *
 * THE SHARED KEY. Every Tor/I2P visitor arrives with the same key
 * (our own proxy's address). A per-client limit on that key is a limit on the
 * whole hidden-service audience — one Tor client spending 120 list requests
 * locked every other hidden visitor out for a minute. So a shared key gets
 * SHARED_KEY_MULTIPLIER times the tier's ceiling: still a bound on the
 * instance, no longer one any single visitor reaches by ordinary use. Open
 * streams have their own shared ceiling (streamCaps.ts).
 *
 * FAIL SAFE (verifier P1). A PRIVATE peer outside the trusted set that
 * sends a forwarded client address is a proxy nobody told us about. Its
 * address stands for everyone behind it, so the per-client stream cap is
 * not applied to it (only the instance-wide cap), and the rate limiter —
 * which cannot tell those visitors apart either — says so once in the log.
 * A PUBLIC peer gains nothing by sending the same headers.
 *
 * WHICH HEADER (the contract with ops/nginx/web.conf and
 * ops/bunkerweb/frontend/nginx.conf):
 *   - from a LOOPBACK peer, a non-empty X-Real-IP wins — bare-metal
 *     nginx sets it to `$remote_addr`, which the visitor cannot choose;
 *   - otherwise X-Forwarded-For is walked from the RIGHT, skipping
 *     trusted hops, and the first untrusted address is the client. The
 *     BunkerWeb frontend sends exactly one entry (BunkerWeb's view of
 *     the visitor, or the bridge gateway for Tor/I2P); anything a
 *     visitor typed sits to the LEFT of what our proxy appended and is
 *     never reached;
 *   - every entry trusted (Tor/I2P through the bridge gateway) → the
 *     rightmost entry: all hidden-service visitors share one bucket, as
 *     documented, and cannot type their way out of it;
 *   - X-Real-IP from a NON-loopback proxy is ignored: the frontend
 *     clears it, and an older frontend config passed the visitor's own.
 *
 * State is per-process. If the operator runs multiple indexer
 * instances behind a load balancer they'll want a shared limiter,
 * but that's a Phase 5 concern — one instance handles the entire
 * foreseeable load.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { BlockList, SocketAddress, isIP } from 'node:net';
import { isPrivateIp } from '@morphit/net-defense';
import { logger } from '$log';

const log = logger('ratelimit');

type Tier = 'list' | 'resource' | 'federation';

interface Bucket {
	/** Unix-ms timestamps of requests still within the window. */
	timestamps: number[];
}

const WINDOW_MS = 60_000;

/** The default trusted set: loopback, and Docker's default bridge pool —
 *  where the BunkerWeb frontend container sits, whatever subnet the daemon
 *  gave it (the ansible role pins 172.20.0.0/16; morphit.io's is 172.18.0.0/24). */
export const DEFAULT_TRUSTED_PROXY_CIDRS: readonly string[] = [
	'127.0.0.0/8',
	'::1/128',
	'172.20.0.0/16'
];

/** How many times a tier's per-minute ceiling a SHARED key gets: the
 *  key that stands for every Tor/I2P visitor at once. */
export const SHARED_KEY_MULTIPLIER = 25;

/** The bucket key for a client address: IPv4 as is, IPv6 by its /64. */
export function bucketKeyFor(ip: string): string {
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
	if (mapped) return mapped[1]!;
	if (isIP(ip) !== 6) return ip;
	const sl = new SocketAddress({ address: ip, family: 'ipv6' });
	// Expand to eight groups, keep four.
	const [head = '', tail = ''] = sl.address.split('::');
	const h = head === '' ? [] : head.split(':');
	const t = tail === '' ? [] : tail.split(':');
	const groups = sl.address.includes('::')
		? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
		: h;
	return `${groups
		.slice(0, 4)
		.map((g) => (parseInt(g, 16) || 0).toString(16))
		.join(':')}::/64`;
}

function isLoopback(ip: string): boolean {
	const v4 = ip.replace(/^::ffff:/i, '');
	return v4.startsWith('127.') || ip === '::1';
}

function buildTrusted(specs: readonly string[]): BlockList {
	const b = new BlockList();
	// Loopback is always trusted: it is nginx on this host, and refusing it
	// would silently merge every bare-metal visitor into one bucket.
	b.addSubnet('127.0.0.0', 8, 'ipv4');
	b.addAddress('::1', 'ipv6');
	for (const raw of specs) {
		const spec = raw.trim();
		if (spec.length === 0) continue;
		const [addr, bits] = spec.split('/');
		const fam = isIP(addr ?? '');
		if (fam === 0) continue;
		const type = fam === 4 ? 'ipv4' : 'ipv6';
		const max = fam === 4 ? 32 : 128;
		const n = bits === undefined ? max : Number(bits);
		if (!Number.isInteger(n) || n < 0 || n > max) continue;
		b.addSubnet(addr!, n, type);
	}
	return b;
}

let trusted = buildTrusted(DEFAULT_TRUSTED_PROXY_CIDRS);

/** Set the trusted-proxy CIDRs (from MORPHIT_INDEXER_TRUSTED_PROXY_CIDRS).
 *  `undefined` restores the default. Returns the entries that did not parse,
 *  so the caller can say so at boot. */
export function configureTrustedProxies(specs: readonly string[] | undefined): string[] {
	const list = specs ?? DEFAULT_TRUSTED_PROXY_CIDRS;
	const rejected = list.filter((raw) => {
		const [addr, bits] = raw.trim().split('/');
		const fam = isIP(addr ?? '');
		if (fam === 0) return raw.trim().length > 0;
		const max = fam === 4 ? 32 : 128;
		const n = bits === undefined ? max : Number(bits);
		return !Number.isInteger(n) || n < 0 || n > max;
	});
	trusted = buildTrusted(list);
	return rejected;
}

function isTrusted(ip: string): boolean {
	const fam = isIP(ip);
	if (fam === 0) return false;
	if (fam === 6) {
		const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
		if (mapped) return trusted.check(mapped[1]!, 'ipv4');
		return trusted.check(ip, 'ipv6');
	}
	return trusted.check(ip, 'ipv4');
}

/** A usable address from a header value, or null. */
function headerIp(v: string | undefined): string | null {
	if (v === undefined) return null;
	const t = v.trim().replace(/^\[|\]$/g, '');
	return t.length > 0 && t.length < 64 && isIP(t) !== 0 ? t : null;
}

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
	if (peer === null) {
		// No socket info. Degrade to 'unknown' — this bucket-keys all
		// unknown-peer requests together, which is fine as a last resort
		// but would cripple legitimate load. Real deployments always have a
		// Node adapter.
		return 'unknown';
	}
	// Untrusted peer: the socket IS the client. Ignore any forwarded-address
	// headers it sent (Finding B).
	if (!isTrusted(peer)) {
		if (!warnedUntrustedProxy && isUntrustedPrivateProxy(c, peer)) {
			warnedUntrustedProxy = true;
			// No address in the message: privacy first, and the operator knows
			// which proxy is theirs.
			log.warn('untrusted_private_proxy', {
				note: 'a private-network peer outside MORPHIT_INDEXER_TRUSTED_PROXY_CIDRS is forwarding client addresses; every visitor behind it shares one rate-limit bucket. Add its subnet to MORPHIT_INDEXER_TRUSTED_PROXY_CIDRS.'
			});
		}
		return peer;
	}

	// Bare-metal nginx on this host sets X-Real-IP to $remote_addr.
	if (isLoopback(peer)) {
		const real = headerIp(c.req.header('x-real-ip'));
		if (real !== null) return real;
	}
	// X-Forwarded-For from the RIGHT: the first address our own proxies did
	// not add is the client. A visitor's own entries are to its left.
	const xff = c.req.header('x-forwarded-for');
	if (xff !== undefined) {
		const hops = xff
			.split(',')
			.map((h) => headerIp(h))
			.filter((h): h is string => h !== null);
		for (let i = hops.length - 1; i >= 0; i--) {
			if (!isTrusted(hops[i]!)) return hops[i]!;
		}
		// Every hop is ours (Tor/I2P via the bridge gateway): one shared
		// bucket, keyed on what our proxy wrote.
		const last = hops[hops.length - 1];
		if (last !== undefined) return last;
	}
	// A trusted peer that forwarded nothing usable: key on the peer.
	return peer;
}

let warnedUntrustedProxy = false;

/** Does this request carry a forwarded client address at all? */
function forwardsAClient(c: Context): boolean {
	return (
		headerIp(c.req.header('x-real-ip')) !== null ||
		(c.req.header('x-forwarded-for') ?? '').split(',').some((h) => headerIp(h) !== null)
	);
}

/** An untrusted peer on a private network that forwards a client address: a
 *  proxy of the operator's we were not told about (FAIL SAFE, verifier P1). */
function isUntrustedPrivateProxy(c: Context, peer: string): boolean {
	const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(peer)?.[1];
	return isPrivateIp(v4 ?? peer) && forwardsAClient(c);
}

/**
 * The client a request is attributed to, exactly as the limiter keys it, and
 * whether that key is SHARED — our own proxy's address, standing for every
 * Tor/I2P visitor (or 'unknown'), or an untrusted private proxy's address,
 * standing for everyone behind it (FAIL SAFE). Used by the open-stream caps
 * (streamCaps.ts), which must not apply a per-client cap to a key that is
 * everybody.
 */
export function requestClient(c: Context): { readonly key: string; readonly shared: boolean } {
	const ip = clientIp(c);
	if (ip === 'unknown' || isTrusted(ip)) return { key: ip, shared: true };
	const peer = socketPeer(c);
	return { key: bucketKeyFor(ip), shared: peer === ip && isUntrustedPrivateProxy(c, peer) };
}

/** Test seam — forget every bucket. */
export function _resetRateLimitForTest(): void {
	buckets.clear();
}

export function rateLimit(tier: Tier, perMin: number): MiddlewareHandler {
	return async (c, next) => {
		const client = requestClient(c);
		const key = `${tier}:${client.key}`;
		const limit = client.shared ? perMin * SHARED_KEY_MULTIPLIER : perMin;
		const now = Date.now();
		const cutoff = now - WINDOW_MS;

		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = { timestamps: [] };
			buckets.set(key, bucket);
		}
		// Drop expired timestamps. Entries are pushed in arrival order and
		// Date.now() does not go backwards, so the expired ones are always a
		// PREFIX — scan it and splice once, rather than .filter()ing (which
		// allocates a whole new array on every request). At the federation
		// tier this array holds thousands of entries and is touched ~100
		// times a second, so the difference is not academic.
		let expired = 0;
		while (expired < bucket.timestamps.length && (bucket.timestamps[expired] ?? 0) <= cutoff) {
			expired++;
		}
		if (expired > 0) bucket.timestamps.splice(0, expired);

		if (bucket.timestamps.length >= limit) {
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
