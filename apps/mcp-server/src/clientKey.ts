import type { IncomingMessage } from 'node:http';

/**
 * Resolve the client identity for rate-limiting.
 *
 * When the direct peer is loopback (the operator's reverse proxy), the proxy
 * says who the client is. It used to be the LEFTMOST X-Forwarded-For entry —
 * but nginx's `$proxy_add_x_forwarded_for` keeps whatever the visitor sent on
 * the left, so a visitor could claim a new address on every request and never
 * be limited (the MCP twin of the relay's H1). The proxy's
 * own `X-Real-IP` ($remote_addr) wins; failing that the RIGHTMOST entry, which
 * is the one our proxy appended. Any other peer is keyed on the socket.
 */
export function clientKey(req: IncomingMessage): string {
	const peer = req.socket.remoteAddress ?? 'unknown';
	const peerLoopback =
		peer === '127.0.0.1' ||
		peer === '::1' ||
		peer.startsWith('127.') ||
		peer === '::ffff:127.0.0.1';
	if (peerLoopback) {
		const real = req.headers['x-real-ip'];
		const realIp = (Array.isArray(real) ? real[real.length - 1] : real)?.trim();
		if (realIp) return realIp.slice(0, 64);
		const xff = req.headers['x-forwarded-for'];
		const joined = Array.isArray(xff) ? xff.join(',') : xff;
		const last = joined
			?.split(',')
			.map((s) => s.trim())
			.filter((s) => s.length > 0)
			.pop();
		if (last) return last.slice(0, 64);
	}
	return peer;
}
