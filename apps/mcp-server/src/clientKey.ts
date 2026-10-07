import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

/** Is `peer` a reverse proxy of ours: loopback (host nginx) or Docker's default
 *  bridge pool 172.16.0.0/12, from which the BunkerWeb frontend container
 *  reaches the MCP (172.20.0.0/16 on ansible installs, 172.18.0.0/24 on
 *  morphit.io). The same default the relay trusts
 *  (apps/relay/src/middleware/ip.ts DEFAULT_TRUSTED_PROXY_CIDRS) and the
 *  frontend nginx's `geo $morphit_edge_peer`. A peer in that pool is inside the
 *  operator's own network, and UFW opens the MCP port to nothing else; the most
 *  such a host can do is pick its own bucket. */
export function isTrustedProxyPeer(peer: string): boolean {
	const p = peer.replace(/^::ffff:/i, '');
	if (p === '::1' || p.startsWith('127.')) return isIP(p) !== 0;
	if (isIP(p) !== 4) return false;
	const [a, b] = p.split('.').map(Number) as [number, number];
	return a === 172 && b >= 16 && b <= 31;
}

/**
 * Resolve the client identity for rate-limiting.
 *
 * When the direct peer is one of our reverse proxies (isTrustedProxyPeer), the
 * proxy says who the client is. It used to be the LEFTMOST X-Forwarded-For
 * entry — but nginx's `$proxy_add_x_forwarded_for` keeps whatever the visitor
 * sent on the left, so a visitor could claim a new address on every request
 * and never be limited (the MCP twin of the relay's H1). The proxy's own
 * `X-Real-IP` wins: host nginx sets it to `$remote_addr`, and the frontend
 * container's /mcp route overwrites it with the visitor's address
 * ($morphit_relay_xff), never a value the visitor typed. Failing that, the
 * RIGHTMOST X-Forwarded-For entry, which is the one our proxy wrote. A value
 * that is not an address did not come from our proxy and is ignored. Any other
 * peer is keyed on its socket address.
 *
 * Until v1.21.1 only a loopback peer was trusted, so behind BunkerWeb every
 * agent was keyed on the frontend container and shared one bucket.
 *
 * Privacy: the key is used only as the in-memory rate-limit bucket
 * (rateLimiter.ts); it is never logged or written anywhere.
 */
export function clientKey(req: IncomingMessage): string {
	const peer = req.socket.remoteAddress ?? 'unknown';
	if (isTrustedProxyPeer(peer)) {
		const real = req.headers['x-real-ip'];
		const realIp = (Array.isArray(real) ? real[real.length - 1] : real)?.trim();
		if (realIp && isIP(realIp) !== 0) return realIp;
		const xff = req.headers['x-forwarded-for'];
		const joined = Array.isArray(xff) ? xff.join(',') : xff;
		const last = joined
			?.split(',')
			.map((s) => s.trim())
			.filter((s) => s.length > 0)
			.pop();
		if (last && isIP(last) !== 0) return last;
	}
	return peer;
}
