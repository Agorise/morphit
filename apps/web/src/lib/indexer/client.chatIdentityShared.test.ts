// @vitest-environment jsdom
/**
 * Opening a conversation asks for our own chat key twice at once (the
 * re-publish check and the send path's own-status check). On Tor/I2P each
 * request is a slow round trip, so overlapping calls share one (v1.21.13).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getChatIdentity } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('getChatIdentity', () => {
	it('overlapping calls for one account share a request; later ones and other accounts ask again', async () => {
		const answers: Array<() => void> = [];
		const fetchStub = vi.fn(
			() =>
				new Promise<Response>((resolve) =>
					answers.push(() =>
						resolve(
							new Response('{"status":"error","code":"not_found","message":"none"}', {
								status: 404,
								headers: { 'content-type': 'application/json' }
							})
						)
					)
				)
		);
		vi.stubGlobal('fetch', fetchStub);
		const a = getChatIdentity('anna');
		const b = getChatIdentity('anna');
		const c = getChatIdentity('bob');
		expect(fetchStub).toHaveBeenCalledTimes(2);
		for (const answer of answers) answer();
		const [ra, rb] = await Promise.all([a, b, c]);
		expect(ra).toBe(rb);
		const d = getChatIdentity('anna');
		expect(fetchStub).toHaveBeenCalledTimes(3);
		answers[2]!();
		await d;
		// A caller with its own signal is never joined to another's request.
		void getChatIdentity('anna', new AbortController().signal);
		void getChatIdentity('anna', new AbortController().signal);
		expect(fetchStub).toHaveBeenCalledTimes(5);
	});
});
