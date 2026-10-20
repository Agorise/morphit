// @vitest-environment jsdom
/**
 * An answer from the indexer's address that is not the indexer's JSON.
 *
 * morphit.io, v1.21.10: BunkerWeb's default replaced every 4xx/5xx from the
 * indexer with its own HTML page. A plain "no chat key yet" (404) reached the
 * chat screen as "Malformed response from indexer (status 404)" — naming
 * neither the layer that answered nor the fix. What is pinned here: the
 * indexer's own JSON still wins, and a page says who answered and what to do.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getChatIdentity, nonJsonAnswerMessage } from './client';

const PAGE = '<!doctype html> <html lang="en"> <head></head><body>404</body></html>';
function stub(status: number, body: string, type: string): void {
	vi.stubGlobal(
		'fetch',
		async () => new Response(body, { status, headers: { 'content-type': type } })
	);
}
afterEach(() => vi.unstubAllGlobals());

describe('a chat-key lookup', () => {
	it('the indexer’s own 404 is "not_found" with its reason (what the chat screen acts on)', async () => {
		stub(
			404,
			'{"status":"error","code":"not_found","message":"no chat identity for @new-member"}',
			'application/json'
		);
		const r = await getChatIdentity('new-member');
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.code).toBe('not_found');
			expect(r.message).toBe('no chat identity for @new-member');
		}
	});

	it('a firewall page in its place names the firewall and the fix, never "Malformed"', async () => {
		stub(404, PAGE, 'text/html; charset=utf-8');
		const r = await getChatIdentity('new-member');
		expect(r.ok).toBe(false);
		if (!r.ok) {
			// Not "not_found": the page proves nothing about the key, so nothing
			// may be published on its word.
			expect(r.code).toBe('network_error');
			expect(r.message).toMatch(/web firewall answered with its own page .*status 404/);
			expect(r.message).not.toMatch(/Malformed/);
		}
	});
});

describe('nonJsonAnswerMessage', () => {
	it('names the layer and the next step for each kind of answer', () => {
		expect(nonJsonAnswerMessage(404, 'text/html')).toMatch(
			/web firewall answered .*status 404.*upgrade/
		);
		expect(nonJsonAnswerMessage(400, 'text/html; charset=utf-8')).toMatch(/status 400/);
		expect(nonJsonAnswerMessage(429, 'text/html')).toMatch(/limiting requests .*429.*Wait/);
		expect(nonJsonAnswerMessage(403, 'text/html')).toMatch(/blocked this request .*403/);
		expect(nonJsonAnswerMessage(502, 'text/html')).toMatch(/could not reach its indexer .*502/);
		expect(nonJsonAnswerMessage(503, '')).toMatch(/could not reach its indexer .*503/);
		// Not a page, not a known status: still what it was.
		expect(nonJsonAnswerMessage(404, 'text/plain')).toBe(
			'Malformed response from indexer (status 404)'
		);
		expect(nonJsonAnswerMessage(200, '')).toBe('Malformed response from indexer (status 200)');
		// A 200 page (an anti-bot check, a captive portal) did not replace an error.
		expect(nonJsonAnswerMessage(200, 'text/html')).toBe(
			'Malformed response from indexer (status 200)'
		);
	});
});
