/**
 * The chat stream logs no one's chat pairs, whatever MORPHIT_CHAT_DEBUG says
 * (A2 part).
 *
 * A "temporary" trace, on when MORPHIT_CHAT_DEBUG=1, logged for every open
 * chat connection every fast-path message's sender and recipient and which
 * pair that connection had open — a server-side record of who talks to whom
 * and who is online.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

const original = process.env.MORPHIT_CHAT_DEBUG;
afterEach(() => {
	if (original === undefined) delete process.env.MORPHIT_CHAT_DEBUG;
	else process.env.MORPHIT_CHAT_DEBUG = original;
	vi.resetModules();
});

describe('chat stream with MORPHIT_CHAT_DEBUG=1', () => {
	it('a message between two other people leaves no trace in the log', async () => {
		vi.resetModules();
		process.env.MORPHIT_CHAT_DEBUG = '1';
		const log = await import('$log');
		const records: string[] = [];
		const restore = log.setLogSink((r) => records.push(JSON.stringify(r)));
		try {
			const { chatStreamRoute } = await import('$api/chatStream');
			const { chatEventBus } = await import('$indexer/chatEventBus');
			const db = {
				async query<R extends pg.QueryResultRow>() {
					return { rows: [] as R[], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
				}
			};
			const poller = { getStatus: () => ({ indexedBlock: 1 }) };
			const res = await chatStreamRoute(db as never, poller as never).request(
				'/alice/bob/stream',
				{},
				{ incoming: { socket: { remoteAddress: '127.0.0.1' } } }
			);
			const reader = res.body!.getReader();
			let text = '';
			while (!text.includes('event: snapshot')) {
				const { value, done } = await reader.read();
				if (done) break;
				text += new TextDecoder().decode(value);
			}
			chatEventBus.emitFast({
				lo: 'carol',
				hi: 'dave',
				sender: 'carol',
				recipient: 'dave',
				ciphertext: 'eA==',
				header: {},
				created_at: new Date().toISOString()
			} as never);
			// Barrier: a message for the pair this stream has open, emitted after
			// the carol→dave one, and read back off the stream — every listener
			// has then finished with the carol→dave event.
			chatEventBus.emitFast({
				lo: 'alice',
				hi: 'bob',
				sender: 'alice',
				recipient: 'bob',
				ciphertext: 'eQ==',
				header: { client_tag: 'barrier' },
				clientTag: 'barrier',
				orderPermlink: null,
				createdAt: new Date()
			});
			while (!text.includes('event: message_appended')) {
				const { value, done } = await reader.read();
				if (done) break;
				text += new TextDecoder().decode(value);
			}
			expect(text).toContain('event: message_appended');
			await reader.cancel();
			expect(records.filter((r) => r.includes('carol') || r.includes('dave'))).toEqual([]);
		} finally {
			restore();
		}
	});
});
