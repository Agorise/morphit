/**
 * Client IP extraction.
 *
 * Used ONLY for rate-limit bucket keying. The returned string is
 * never logged, never persisted to disk, never transmitted anywhere.
 * If logging is ever added (it should not be), that's a regression
 * requiring SECURITY.md update and an ADR.
 *
 * Security contract: forwarded-address headers (X-Forwarded-For,
 * X-Real-IP) are ONLY honored when the immediate socket peer is a
 * trusted proxy — loopback (nginx on the same host) or, by default,
 * the Docker bridge pool 172.16.0.0/12 (the BunkerWeb frontend
 * container); X-Real-IP only from loopback. A direct-
 * connection client cannot forge these headers to get a fresh
 * rate-limit bucket per request, because we ignore their headers
 * and use their real socket address instead.
 *
 * This is Finding E from docs/REVISIT-LIST.md §F. The equivalent
 * fix on the indexer side is Finding B.
 */

import type { Context } from 'hono';

/** Addresses we trust to set X-Forwarded-For / X-Real-IP.
 *  In production these are nginx reverse-proxying on the same
 *  host.  If the relay ever moves to a multi-host deployment
 *  with nginx on a different machine — or sits behind BunkerWeb
 *  in Docker (which connects from the Docker bridge network,
 *  e.g. 172.18.0.x), or behind a CDN / TLS terminator that
 *  uses its own IP range — the additional trusted peer IPs/
 *  CIDRs must be supplied via MORPHIT_RELAY_TRUSTED_PROXY_IPS.
 *
 *  CRITICAL: misconfiguring this is dangerous in BOTH directions:
 *  - Too narrow → BunkerWeb / multi-host nginx isn't trusted, all
 *    requests look like they come from the proxy IP and share a
 *    rate-limit bucket; one abuser exhausts the limit for
 *    everyone.
 *  - Too broad (e.g., 0.0.0.0/0) → ANY remote attacker can
 *    forge X-Forwarded-For to bypass per-IP rate limits and
 *    drain the relay's BLURT.
 *
 *  See OPERATIONS.md §32 (BunkerWeb) for deployment-specific
 *  guidance on which IP/CIDRs to trust.
 *
 *  DEFAULT (v1.20.0 wave 5): loopback + 172.16.0.0/12, Docker's default
 *  bridge pool — the same set as the indexer (MORPHIT_INDEXER_TRUSTED_PROXY_CIDRS)
 *  and the frontend nginx `geo $morphit_edge_peer`. Until then it was loopback
 *  only and the installers pinned 172.20.0.0/16 (the ansible compose subnet);
 *  morphit.io's bridge is 172.18.0.0/24, so a relay without a matching env
 *  value saw the frontend container as the client of EVERY request and the
 *  per-IP signup limits (2/day, spacing) applied to the whole site at once.
 *  A peer in 172.16/12 is inside the operator's own network (the internet
 *  cannot complete a TCP connection from RFC 1918 space) and the relay binds
 *  loopback or the bridge gateway behind UFW; the most such a host can do is
 *  choose its own bucket. MORPHIT_RELAY_TRUSTED_PROXY_IPS, when set, REPLACES
 *  the CIDR default; loopback is always trusted. */
const DEFAULT_LOOPBACK_PEERS: readonly string[] = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
export const DEFAULT_TRUSTED_PROXY_CIDRS: readonly string[] = ['172.16.0.0/12'];

/** Module-level mutable state — the set of trusted-peer
 *  addresses.  Initialized to the default (loopback + 172.16.0.0/12).
 *  Operators whose proxy lives elsewhere set MORPHIT_RELAY_TRUSTED_PROXY_IPS
 *  and main.ts calls configureTrustedProxies() at boot.
 *
 *  Why module-level rather than per-call: the `clientIp()`
 *  function is invoked from middleware where we don't have a
 *  config-injection seam without refactoring every call site.
 *  The relay's main.ts calls configureTrustedProxies() exactly
 *  once at boot before any request handler runs.  Idempotent
 *  re-configuration is supported but not exercised in
 *  production. */
const trustedExactPeers = new Set<string>(DEFAULT_LOOPBACK_PEERS);
let trustedV4Cidrs: ReadonlyArray<{ network: number; mask: number }> = [];

/** Parse an IPv4 dotted-quad to a 32-bit integer.  Returns null
 *  on malformed input (a defensive precaution; the main parser
 *  for inbound packets is the kernel, which gives us already-
 *  normalized strings). */
function parseV4(s: string): number | null {
	const parts = s.split('.');
	if (parts.length !== 4) return null;
	let n = 0;
	for (const p of parts) {
		if (!/^\d+$/.test(p)) return null;
		const v = Number(p);
		if (v < 0 || v > 255) return null;
		n = (n << 8) | v;
	}
	return n >>> 0;
}

/** Parse a "CIDR" string (e.g. "172.18.0.0/16") into network +
 *  mask.  Returns null on malformed input — operators get a
 *  warning but the relay continues with whatever WAS parsed. */
function parseV4Cidr(s: string): { network: number; mask: number } | null {
	const slash = s.indexOf('/');
	if (slash === -1) return null;
	const addr = s.slice(0, slash);
	const bitsStr = s.slice(slash + 1);
	if (!/^\d+$/.test(bitsStr)) return null;
	const bits = Number(bitsStr);
	if (bits < 0 || bits > 32) return null;
	const ip = parseV4(addr);
	if (ip === null) return null;
	const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
	return { network: ip & mask, mask };
}

/**
 * Configure the trusted-proxy addresses / CIDR ranges.  Loopback is
 * always trusted; the given list REPLACES the CIDR default.  A list with
 * no non-blank entries (MORPHIT_RELAY_TRUSTED_PROXY_IPS unset or empty)
 * restores the default, loopback + 172.16.0.0/12.  Call ONCE at relay boot,
 * BEFORE any request handler runs.  Subsequent calls are
 * idempotent in production but no concurrency guarantee is
 * made for in-flight requests during reconfiguration.
 *
 * Inputs:
 *   - bare IPv4/IPv6 addresses (e.g. "172.18.0.5", "::1") —
 *     match by exact string equality
 *   - IPv4 CIDR ranges (e.g. "172.18.0.0/16") — useful for
 *     Docker bridge networks (the BunkerWeb common case)
 *   - IPv6 CIDR ranges are NOT yet supported; pass each address
 *     individually if you need to whitelist multiple v6 hops
 *
 * SECURITY: this is the most dangerous knob in the relay's
 * config.  An overly-broad CIDR (e.g. 0.0.0.0/0) lets ANY
 * client forge X-Forwarded-For and bypass per-IP rate limits,
 * draining the relay's BLURT.  The default (loopback + 172.16.0.0/12)
 * covers bare-metal nginx and every Docker bridge the daemon creates by
 * default; set the env value only for a proxy outside those ranges.
 */
export function configureTrustedProxies(specs: readonly string[]): {
	exactCount: number;
	cidrCount: number;
	rejected: readonly string[];
} {
	// No entries at all → the default (same rule as the indexer: an empty
	// env value means "unset").
	if (!specs.some((s) => s.trim().length > 0)) specs = DEFAULT_TRUSTED_PROXY_CIDRS;
	// Reset to default loopback set — operators who reconfigure
	// don't accidentally retain old entries.
	trustedExactPeers.clear();
	for (const p of DEFAULT_LOOPBACK_PEERS) trustedExactPeers.add(p);
	const cidrs: Array<{ network: number; mask: number }> = [];
	const rejected: string[] = [];

	for (const spec of specs) {
		const trimmed = spec.trim();
		if (trimmed.length === 0) continue;
		if (trimmed.includes('/')) {
			// CIDR — IPv4 only for now.
			const cidr = parseV4Cidr(trimmed);
			if (cidr === null) {
				rejected.push(trimmed);
				continue;
			}
			cidrs.push(cidr);
		} else {
			// Exact-match address (v4 or v6).  Validate the shape
			// so a typo / garbage entry doesn't silently land in
			// the trusted set.  We accept any non-empty string that
			// either parses as IPv4 OR contains a colon (IPv6 — we
			// don't fully parse, but the colon check rejects words
			// like 'not-an-ip').  This is intentionally lenient
			// for IPv6: full v6 parsing is out of scope and the
			// downstream comparison is exact-string anyway, so a
			// malformed v6 just won't ever match an inbound peer.
			const isV4 = parseV4(trimmed) !== null;
			const isLikelyV6 = trimmed.includes(':');
			if (!isV4 && !isLikelyV6) {
				rejected.push(trimmed);
				continue;
			}
			trustedExactPeers.add(trimmed);
		}
	}
	trustedV4Cidrs = cidrs;
	return {
		exactCount: trustedExactPeers.size,
		cidrCount: cidrs.length,
		rejected
	};
}

// Module default: loopback + Docker's default bridge pool.
configureTrustedProxies(DEFAULT_TRUSTED_PROXY_CIDRS);

/** Predicate: is `peer` in the trusted-proxy set?  Used by
 *  clientIp() before honoring forwarded-address headers. */
function isTrustedPeer(peer: string): boolean {
	if (trustedExactPeers.has(peer)) return true;
	// Try IPv4 CIDR matching.
	const stripped = peer.replace(/^::ffff:/i, ''); // dual-stack
	const ip = parseV4(stripped);
	if (ip === null) return false;
	for (const cidr of trustedV4Cidrs) {
		if ((ip & cidr.mask) === cidr.network) return true;
	}
	return false;
}

/** Extract the raw socket peer address from Hono's Node adapter
 *  context. Returns null if the context doesn't expose it (e.g.
 *  a non-Node adapter, or a test harness). */
function socketPeer(c: Context): string | null {
	const info = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
		?.incoming?.socket?.remoteAddress;
	if (!info) return null;
	// Strip IPv6 brackets if present.
	return info.replace(/^\[|\]$/g, '');
}

/** Is `s` shaped like an IP address (v4 dotted-quad, or v6 hex+colons with an
 *  optional trailing dotted-quad)? A proxy only ever appends real addresses to
 *  X-Forwarded-For, so anything else in the chain came from the client. */
function looksLikeIp(s: string): boolean {
	if (s.length === 0 || s.length > 64) return false;
	if (parseV4(s) !== null) return true;
	return s.includes(':') && /^[0-9a-fA-F:.]+$/.test(s);
}

/** Pick the client out of a trusted proxy's forwarded headers.
 *
 *  (v1.18.0 deep-deep, H1) This used to take the LEFTMOST X-Forwarded-For
 *  entry. But nginx's `$proxy_add_x_forwarded_for` means "whatever the client
 *  sent, then $remote_addr", so the leftmost entry is whatever the client typed:
 *  a request with `X-Forwarded-For: 10.N.0.1` got a fresh rate-limit bucket per
 *  request, defeating every per-IP signup defense. Now:
 *
 *    1. From a LOOPBACK peer (bare-metal nginx on this host), X-Real-IP wins.
 *       ops/nginx/*.conf set it to `$remote_addr`, which the client cannot
 *       choose. This is what the indexer already does. Over Tor/I2P that is
 *       127.0.0.1 for everyone: one shared bucket, exactly as before.
 *    2. Otherwise walk X-Forwarded-For from the RIGHT, skipping addresses we
 *       trust as proxies; the first untrusted address is the client. Every entry
 *       to the right of it was appended by a proxy we trust, so the client can't
 *       forge it. (BunkerWeb → frontend → relay: "…, client, bunkerweb".)
 *    3. If every entry is a trusted proxy address (a request that reached the
 *       proxy from a local address, like Tor via the frontend container), use
 *       the RIGHTMOST entry — the one our own proxy wrote. All such visitors
 *       share that one bucket, which is how Tor/I2P already behaved.
 *    4. Nothing usable → the peer itself. X-Real-IP is NOT read from a
 *       non-loopback proxy: the BunkerWeb frontend doesn't set it, so it would
 *       arrive exactly as the client typed it. */
function forwardedClient(c: Context, peer: string): string {
	const xri = c.req.header('x-real-ip')?.trim();
	const xriOk = xri !== undefined && xri.length > 0 && xri.length < 64;
	if (xriOk && DEFAULT_LOOPBACK_PEERS.includes(peer)) return xri;

	const xff = c.req.header('x-forwarded-for');
	if (xff) {
		const hops = xff.split(',').map((h) => h.trim().replace(/^\[|\]$/g, ''));
		for (let i = hops.length - 1; i >= 0; i--) {
			const hop = hops[i]!;
			// A malformed entry can only have come from the client (proxies append
			// real addresses), so stop walking: nothing left of it is trustworthy.
			if (!looksLikeIp(hop)) break;
			if (!isTrustedPeer(hop)) return hop;
		}
		// No untrusted address to the right of the first malformed entry (or at
		// all): the nearest hop is the one our own proxy wrote.
		const nearest = hops[hops.length - 1]!;
		if (looksLikeIp(nearest)) return nearest;
	}
	// Trusted peer with no usable forwarded headers — unusual (nginx always
	// sets them) — fall back to the peer itself rather than fabricating anything.
	return peer;
}

export function clientIp(c: Context): string {
	const peer = socketPeer(c);

	// If the peer is a trusted proxy (loopback nginx by default,
	// or any address/CIDR added via configureTrustedProxies()),
	// honor the forwarded-address headers it set.
	if (peer !== null && isTrustedPeer(peer)) return forwardedClient(c, peer);

	// Non-loopback peer: the socket address IS the client. Ignore
	// any forwarded-address headers they sent — they could be
	// forged, and trusting them would be the rate-limit bypass
	// from Finding E.
	if (peer !== null) return peer;

	// No socket info at all (non-Node adapter or test harness).
	// Degrade to 'unknown' — this bucket-keys all unknown-peer
	// requests together, which is fine as a last resort but
	// would cripple legitimate load; real deployments always
	// have a Node adapter.
	return 'unknown';
}

/**
 * Canonicalize a client IP to its rate-limit bucket key.
 *
 *   - IPv4: keep the /24 prefix (first three octets).
 *   - IPv6: keep the /64 prefix (first four hextets), normalized
 *     so different valid string forms of the same /64 collapse
 *     to the same bucket.
 *   - 'unknown' (no socket info): pass through.
 *   - Anything that doesn't parse as IPv4 or IPv6: pass through
 *     verbatim.  Defensive — better to bucket a weird value than
 *     to silently drop it.
 *
 * Why prefix bucketing matters:
 *
 *   IPv6 attackers typically have at least a /64 routed to them
 *   by their ISP — that's 2^64 source addresses, more than enough
 *   to defeat any per-full-address rate limit.  Bucketing by /64
 *   collapses an attacker's whole prefix into one bucket so the
 *   limit applies to them as a unit.  The same logic applies to
 *   IPv4 with /24 (256 addresses), though the attack budget is
 *   smaller; /24 catches single-AS botnets that share an upstream.
 *
 *   Legitimate users sharing a /64 (rare — usually one device per
 *   /64 in IPv6 SLAAC) or /24 (common — CGNAT, office NAT,
 *   university dorms) will share buckets too.  This is the
 *   "family of four on one Wi-Fi" tradeoff §18 layer 3 already
 *   accounts for in its sizing decisions; the fix here is that
 *   the bucket key reflects reality on IPv6 instead of treating
 *   each address as independent.
 *
 * Examples:
 *   192.0.2.55         → 192.0.2.0/24
 *   192.0.2.200        → 192.0.2.0/24      (same /24)
 *   2001:db8:1:2::1    → 2001:db8:1:2::/64
 *   2001:db8:1:2:a:b:c:d → 2001:db8:1:2::/64  (same /64)
 *   ::1                → ::1                (loopback — preserved
 *                                            so trusted-peer logic
 *                                            still recognizes it)
 *   unknown            → unknown
 */
export function canonicalBucketKey(ip: string): string {
	if (ip === 'unknown' || ip === '') return ip;
	// Loopback addresses must round-trip unchanged so trusted-
	// peer detection (isTrustedPeer) keeps working downstream.
	// We only check the EXACT-match set here — CIDR-trusted peers
	// shouldn't appear as IPs to bucket (they'd be the proxy
	// itself, not the actual client), but if one slips through
	// it bucket-keys normally which is acceptable.
	if (trustedExactPeers.has(ip)) return ip;
	// Strip IPv6 brackets defensively (forwardedClient and socketPeer
	// already do this, but a hand-passed value might not).
	const clean = ip.replace(/^\[|\]$/g, '');

	// IPv4-mapped IPv6 (::ffff:1.2.3.4) — extract the IPv4 part
	// and bucket as IPv4 /24.  The mapping is canonical for
	// dual-stack sockets that report incoming v4 connections in
	// v6 form.
	const v4mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(clean);
	if (v4mapped) {
		return ipv4Slash24(v4mapped[1]!) ?? clean;
	}

	// IPv4 dotted-quad
	if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) {
		return ipv4Slash24(clean) ?? clean;
	}

	// IPv6 (very loose check — colons present, hex-only chars).
	// Real validation happens in ipv6Slash64; on parse failure
	// we fall back to the raw string (defensive).
	if (clean.includes(':') && /^[0-9a-fA-F:]+$/.test(clean)) {
		return ipv6Slash64(clean) ?? clean;
	}

	// Anything else — return verbatim.  Better to bucket a weird
	// value into its own slot than to fabricate or discard it.
	return clean;
}

/** Return "A.B.C.0/24" for a valid IPv4 address, or null on
 *  parse failure. */
function ipv4Slash24(ip: string): string | null {
	const parts = ip.split('.');
	if (parts.length !== 4) return null;
	for (const p of parts) {
		if (p.length === 0 || p.length > 3) return null;
		const n = Number(p);
		if (!Number.isInteger(n) || n < 0 || n > 255) return null;
	}
	return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

/** Return the canonical "h1:h2:h3:h4::/64" form for a valid IPv6
 *  address, or null on parse failure.  Expands `::` shorthand,
 *  truncates to the first 4 hextets, normalizes to lowercase
 *  short-form (no leading zeros within each hextet). */
function ipv6Slash64(ip: string): string | null {
	// Expand "::" — there's at most one in a valid IPv6 address.
	let head: string;
	let tail: string;
	const dcolon = ip.indexOf('::');
	if (dcolon < 0) {
		head = ip;
		tail = '';
	} else {
		head = ip.slice(0, dcolon);
		tail = ip.slice(dcolon + 2);
		// "::" at start means empty head; same at end means empty tail.
		// Multiple "::" is invalid.
		if (head.includes('::') || tail.includes('::')) return null;
	}
	const headParts = head.length > 0 ? head.split(':') : [];
	const tailParts = tail.length > 0 ? tail.split(':') : [];
	const totalKnown = headParts.length + tailParts.length;
	if (totalKnown > 8) return null;
	const zerosNeeded = 8 - totalKnown;
	// "::" is required if zerosNeeded > 0; if it's 0 and we saw
	// a "::", that's a stricter interpretation of validity but
	// real-world implementations accept it.  We accept it too.
	if (dcolon < 0 && totalKnown !== 8) return null;
	const allParts = [...headParts, ...new Array(zerosNeeded).fill('0'), ...tailParts];
	// Validate each hextet
	const norm: string[] = [];
	for (const p of allParts) {
		if (p.length === 0 || p.length > 4) return null;
		if (!/^[0-9a-fA-F]+$/.test(p)) return null;
		// Lowercase + drop leading zeros (canonical short form).
		const lower = p.toLowerCase().replace(/^0+/, '') || '0';
		norm.push(lower);
	}
	// Take the /64 prefix — first 4 hextets — and emit short form
	// with `::` for the trailing host bits.
	const prefix = norm.slice(0, 4).join(':');
	return `${prefix}::/64`;
}
