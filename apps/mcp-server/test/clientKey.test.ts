/**
 * The MCP rate limiter's client identity cannot be chosen by the client
 * (the MCP twin of the relay's X-Forwarded-For finding).
 *
 * nginx's `$proxy_add_x_forwarded_for` APPENDS the real address to whatever the
 * visitor sent, so the leftmost entry is the visitor's own claim. Keyed on it,
 * one visitor rotating the header got a fresh bucket per request.
 */
import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { clientKey } from '../src/clientKey';

const req = (peer: string, headers: Record<string, string>): IncomingMessage =>
	({ socket: { remoteAddress: peer }, headers }) as unknown as IncomingMessage;

describe('who the MCP limits', () => {
	it('a visitor rotating X-Forwarded-For behind nginx stays one client', () => {
		const keys = new Set<string>();
		for (let i = 0; i < 20; i++) {
			keys.add(
				clientKey(
					req('127.0.0.1', {
						'x-forwarded-for': `10.${i}.0.1, 203.0.113.7`,
						'x-real-ip': '203.0.113.7'
					})
				)
			);
		}
		expect([...keys]).toEqual(['203.0.113.7']);
	});

	it('without X-Real-IP, the entry our proxy appended (rightmost) is used', () => {
		expect(clientKey(req('127.0.0.1', { 'x-forwarded-for': '10.9.9.9, 203.0.113.8' }))).toBe(
			'203.0.113.8'
		);
	});

	it('a non-loopback peer is keyed on its own socket address, headers ignored', () => {
		expect(
			clientKey(req('198.51.100.4', { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '1.2.3.4' }))
		).toBe('198.51.100.4');
	});

	// Behind BunkerWeb the frontend container reaches the MCP across the Docker
	// bridge (172.20.0.0/16 on ansible installs, 172.18.0.0/24 on morphit.io),
	// not from loopback. Its /mcp route overwrites X-Real-IP with the visitor's
	// address. Keyed on the container instead, every agent shared one bucket.
	it('behind BunkerWeb (peer on the Docker bridge) each visitor is its own client', () => {
		for (const peer of ['172.20.0.5', '172.18.0.2', '::ffff:172.20.0.5', '172.31.255.254']) {
			const a = clientKey(
				req(peer, { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.7' })
			);
			const b = clientKey(
				req(peer, { 'x-real-ip': '198.51.100.9', 'x-forwarded-for': '198.51.100.9' })
			);
			expect([a, b], `peer ${peer}`).toEqual(['203.0.113.7', '198.51.100.9']);
		}
	});

	it('trusts only the Docker pool the relay trusts (172.16.0.0/12): other peers are keyed on the socket', () => {
		for (const peer of ['172.15.255.1', '172.32.0.1', '192.168.1.5', '10.0.0.8', '203.0.113.50']) {
			expect(clientKey(req(peer, { 'x-real-ip': '1.2.3.4' })), `peer ${peer}`).toBe(peer);
		}
	});

	it('a forwarded value that is not an address is not a key (it did not come from our proxy)', () => {
		expect(clientKey(req('172.20.0.5', { 'x-real-ip': 'pick-a-new-bucket-42' }))).toBe(
			'172.20.0.5'
		);
	});
});
