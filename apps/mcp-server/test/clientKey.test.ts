/**
 * The MCP rate limiter's client identity cannot be chosen by the client
 * (v1.18.0 deep-deep — the MCP twin of the relay's X-Forwarded-For finding).
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
});
