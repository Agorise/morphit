import { describe, expect, it } from 'vitest';

import handler from '$indexer/handlers/chatRead';
import { makeCtx } from '../testutils/context';
import { makeMockClient } from '../testutils/mockClient';

// Default block time in makeCtx is 2026-04-19T12:00:00Z.
// Pick last_read_at values relative to that.

describe('chatRead handler', () => {
	it('rejects non-object payload', async () => {
		const mock = makeMockClient();
		const r = await handler(makeCtx({ payload: 'not an object' as unknown }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'payload_not_object' });
	});

	it('rejects missing peer', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: { last_read_at: '2026-04-19T11:00:00Z' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'peer_invalid' });
	});

	it('rejects malformed peer account name', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: {
					peer: 'NOT_LOWERCASE',
					last_read_at: '2026-04-19T11:00:00Z'
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'peer_invalid' });
	});

	it('rejects self-chat', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: {
					peer: 'alice',
					last_read_at: '2026-04-19T11:00:00Z'
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'self_chat' });
	});

	it('rejects non-string last_read_at', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: { peer: 'bob', last_read_at: 12345 }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'last_read_at_not_string' });
	});

	// ─── §F.21 O3.5 — strict ISO-8601 shape ──────────────────────

	it('O3.5: rejects US-style "12/31/2025" format', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: { peer: 'bob', last_read_at: '12/31/2025' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'last_read_at_invalid' });
	});

	it('O3.5: rejects "December 15, 2025" format', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: {
					peer: 'bob',
					last_read_at: 'December 15, 2025'
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'last_read_at_invalid' });
	});

	it('O3.5: rejects date-only "2026-04-15" without T-time', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: { peer: 'bob', last_read_at: '2026-04-15' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'last_read_at_invalid' });
	});

	it('O3.5: rejects ISO without timezone marker', async () => {
		// Strict regex requires Z or ±HH:MM; bare "T..:..:.." with
		// no zone indicator gets rejected.
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: {
					peer: 'bob',
					last_read_at: '2026-04-19T11:00:00'
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'last_read_at_invalid' });
	});

	it('O3.5: accepts strict ISO with Z suffix', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO chat_read_state', rowCount: 1 }]);
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: {
					peer: 'bob',
					last_read_at: '2026-04-19T11:00:00Z'
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
	});

	it('O3.5: accepts strict ISO with millisecond precision', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO chat_read_state', rowCount: 1 }]);
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: {
					peer: 'bob',
					last_read_at: '2026-04-19T11:00:00.123Z'
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
	});

	it('O3.5: accepts strict ISO with offset timezone', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO chat_read_state', rowCount: 1 }]);
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: {
					peer: 'bob',
					last_read_at: '2026-04-19T13:00:00+02:00'
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
	});

	// ─── Time-bound checks ───────────────────────────────────────

	it('rejects last_read_at far in the future', async () => {
		// Block time is 2026-04-19T12:00:00Z; 70s future is past the
		// 60s skew budget.
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: {
					peer: 'bob',
					last_read_at: '2026-04-19T12:01:10Z'
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'last_read_at_in_future' });
	});

	it('rejects last_read_at before 2020', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: {
					peer: 'bob',
					last_read_at: '2019-12-31T23:59:59Z'
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'last_read_at_too_old' });
	});

	it('happy path: upserts the read-state row', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO chat_read_state', rowCount: 1 }]);
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: {
					peer: 'bob',
					last_read_at: '2026-04-19T11:30:00Z'
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		expect(mock.queries).toHaveLength(1);
		expect(mock.queries[0]!.params[0]).toBe('alice');
		expect(mock.queries[0]!.params[1]).toBe('bob');
	});
});
