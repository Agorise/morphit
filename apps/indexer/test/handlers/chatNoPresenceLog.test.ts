/**
 * The durable chat handler logs no one's chat pairs, whatever
 * MORPHIT_CHAT_DEBUG says (A1 part — A2's test covers the stream).
 *
 * A "temporary" trace, on when MORPHIT_CHAT_DEBUG=1, logged every message's
 * sender, recipient, order and admission decision — a server-side record of
 * who talks to whom. The head tailer carried the same trace.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const original = process.env.MORPHIT_CHAT_DEBUG;
afterEach(() => {
	if (original === undefined) delete process.env.MORPHIT_CHAT_DEBUG;
	else process.env.MORPHIT_CHAT_DEBUG = original;
	vi.resetModules();
});

describe('chat handler with MORPHIT_CHAT_DEBUG=1', () => {
	it('admitting or dropping a message between two people leaves no trace of the pair in the log', async () => {
		vi.resetModules();
		process.env.MORPHIT_CHAT_DEBUG = '1';
		const log = await import('$log');
		const records: string[] = [];
		const restore = log.setLogSink((r) => records.push(JSON.stringify(r)));
		try {
			const { default: chat } = await import('$indexer/handlers/chat');
			const { makeCtx } = await import('../testutils/context');
			const db = {
				query: async (text: string) =>
					/EXISTS/.test(text) && /admitted/.test(text)
						? { rows: [{ admitted: false }], rowCount: 1 }
						: { rows: [], rowCount: 0 }
			};
			await chat(
				makeCtx({
					signer: 'carolsender',
					payload: {
						recipient: 'davereceiver',
						ciphertext: 'AAAA',
						header: { v: 1, client_tag: 't' }
					}
				}),
				db as never
			);
			expect(
				records.filter((r) => r.includes('carolsender') || r.includes('davereceiver'))
			).toEqual([]);
		} finally {
			restore();
		}
	});
});
