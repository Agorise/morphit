import { describe, expect, it } from 'vitest';

import handler from '$indexer/handlers/chat';
import { makeCtx } from '../testutils/context';
import { makeMockClient } from '../testutils/mockClient';

/** A minimal valid payload the handler accepts (modulo the
 *  SQL gates tested via mocks below). */
function goodPayload(): {
	recipient: string;
	ciphertext: string;
	header: Record<string, unknown>;
} {
	return {
		recipient: 'bob',
		// short valid base64 ciphertext — content doesn't matter,
		// the handler just stores it.
		ciphertext: 'aGVsbG8=',
		header: { n: 1, dh: 'a'.repeat(43) }
	};
}

describe('chat handler — payload validation (pre-gates)', () => {
	it('rejects non-object payload', async () => {
		const mock = makeMockClient();
		const r = await handler(makeCtx({ signer: 'alice', payload: 'nope' as unknown }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'payload_not_object' });
	});

	it('rejects invalid recipient name', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: { ...goodPayload(), recipient: 'X' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'recipient_invalid' });
	});

	it('rejects self-chat', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: { ...goodPayload(), recipient: 'alice' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'self_chat' });
	});

	it('rejects empty ciphertext', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: { ...goodPayload(), ciphertext: '' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'ciphertext_empty' });
	});

	it('rejects non-base64 ciphertext', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: { ...goodPayload(), ciphertext: 'not base64!!' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'ciphertext_not_base64' });
	});

	it('rejects oversized ciphertext', async () => {
		const mock = makeMockClient();
		// MAX_CIPHERTEXT_CHARS is 1536 (well above the typical
		// E2E-encrypted message envelope).  Use 1540 = 385*4, which
		// is over the cap AND a valid base64 length, so the length
		// check fires before the base64 check.
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: { ...goodPayload(), ciphertext: 'a'.repeat(1540) }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'ciphertext_too_long' });
	});
});

describe('chat handler — layer 1 block-list gate', () => {
	it('rejects recipient_blocked_sender when block row exists', async () => {
		const mock = makeMockClient([
			// Block check returns exists=true → short-circuit reject.
			{ match: 'FROM blocks', rows: [{ exists: true }] }
		]);
		const r = await handler(makeCtx({ signer: 'alice', payload: goodPayload() }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'recipient_blocked_sender' });
		// Only the block-check query ran; rate-limit query and
		// INSERT did NOT.
		expect(mock.queries).toHaveLength(1);
	});

	it('proceeds past the gate when no block row exists', async () => {
		const mock = makeMockClient([
			{ match: 'FROM blocks', rows: [{ exists: false }] },
			{ match: 'admitted', rows: [{ admitted: true }] },
			// Rate-limit query returns safe counters.
			{
				match: 'unique_fan_in',
				rows: [{ unique_fan_in: '1', per_pair_count: null }]
			},
			{ match: 'INSERT INTO chat_messages' }
		]);
		const r = await handler(makeCtx({ signer: 'alice', payload: goodPayload() }), mock.client);
		expect(r).toEqual({ ok: true });
		// All four queries ran in order: block / admission / rate-limit / INSERT.
		expect(mock.queries).toHaveLength(4);
	});
});

describe('chat handler — layer 2 stranger-fee admission gate', () => {
	it('rejects stranger_fee_required when pair has no exchange and no fee', async () => {
		const mock = makeMockClient([
			{ match: 'FROM blocks', rows: [{ exists: false }] },
			{ match: 'admitted', rows: [{ admitted: false }] }
		]);
		const r = await handler(makeCtx({ signer: 'alice', payload: goodPayload() }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'stranger_fee_required' });
		// block + admission ran; rate-limit + INSERT did not.
		expect(mock.queries).toHaveLength(2);
	});

	it('admits when recipient has replied OR prior exchange OR paid fee', async () => {
		// The admission query returns `admitted: true` whenever
		// ANY of the three conditions is satisfied — which
		// specific condition fires is invisible to this handler
		// (Postgres does the OR). So one positive test with
		// admitted=true covers the entire "admit" branch.
		const mock = makeMockClient([
			{ match: 'FROM blocks', rows: [{ exists: false }] },
			{ match: 'admitted', rows: [{ admitted: true }] },
			{
				match: 'unique_fan_in',
				rows: [{ unique_fan_in: '1', per_pair_count: null }]
			},
			{ match: 'INSERT INTO chat_messages' }
		]);
		const r = await handler(makeCtx({ signer: 'alice', payload: goodPayload() }), mock.client);
		expect(r).toEqual({ ok: true });
		expect(mock.queries).toHaveLength(4);
	});
});

describe('chat handler — layer 3 rate-limit gates', () => {
	it('rejects recipient_fan_in_exceeded at 21 unique senders', async () => {
		const mock = makeMockClient([
			{ match: 'FROM blocks', rows: [{ exists: false }] },
			{ match: 'admitted', rows: [{ admitted: true }] },
			{
				match: 'unique_fan_in',
				rows: [{ unique_fan_in: '21', per_pair_count: '0' }]
			}
		]);
		const r = await handler(makeCtx({ signer: 'alice', payload: goodPayload() }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'recipient_fan_in_exceeded' });
		// INSERT did NOT run — block / admission / rate-limit / stop.
		expect(mock.queries).toHaveLength(3);
	});

	it('accepts at exactly 20 unique senders (at cap)', async () => {
		const mock = makeMockClient([
			{ match: 'FROM blocks', rows: [{ exists: false }] },
			{ match: 'admitted', rows: [{ admitted: true }] },
			{
				match: 'unique_fan_in',
				rows: [{ unique_fan_in: '20', per_pair_count: '0' }]
			},
			{ match: 'INSERT INTO chat_messages' }
		]);
		const r = await handler(makeCtx({ signer: 'alice', payload: goodPayload() }), mock.client);
		expect(r).toEqual({ ok: true });
	});

	it('rejects sender_no_reply_cap_exceeded when per_pair count hits 50', async () => {
		const mock = makeMockClient([
			{ match: 'FROM blocks', rows: [{ exists: false }] },
			{ match: 'admitted', rows: [{ admitted: true }] },
			{
				match: 'unique_fan_in',
				rows: [{ unique_fan_in: '1', per_pair_count: '50' }]
			}
		]);
		const r = await handler(makeCtx({ signer: 'alice', payload: goodPayload() }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'sender_no_reply_cap_exceeded' });
		expect(mock.queries).toHaveLength(3);
	});

	it('accepts the 50th message exactly (count=49 before)', async () => {
		const mock = makeMockClient([
			{ match: 'FROM blocks', rows: [{ exists: false }] },
			{ match: 'admitted', rows: [{ admitted: true }] },
			{
				match: 'unique_fan_in',
				rows: [{ unique_fan_in: '1', per_pair_count: '49' }]
			},
			{ match: 'INSERT INTO chat_messages' }
		]);
		const r = await handler(makeCtx({ signer: 'alice', payload: goodPayload() }), mock.client);
		expect(r).toEqual({ ok: true });
	});

	it('ignores per-pair cap when recipient has replied (null count)', async () => {
		const mock = makeMockClient([
			{ match: 'FROM blocks', rows: [{ exists: false }] },
			{ match: 'admitted', rows: [{ admitted: true }] },
			{
				match: 'unique_fan_in',
				rows: [{ unique_fan_in: '1', per_pair_count: null }]
			},
			{ match: 'INSERT INTO chat_messages' }
		]);
		const r = await handler(makeCtx({ signer: 'alice', payload: goodPayload() }), mock.client);
		expect(r).toEqual({ ok: true });
	});
});

describe('chat handler — duplicate detection', () => {
	it('translates unique-violation (23505) into duplicate_message', async () => {
		const pgErr = Object.assign(new Error('dup'), { code: '23505' });
		const mock = makeMockClient([
			{ match: 'FROM blocks', rows: [{ exists: false }] },
			{ match: 'admitted', rows: [{ admitted: true }] },
			{
				match: 'unique_fan_in',
				rows: [{ unique_fan_in: '1', per_pair_count: null }]
			},
			{ match: 'INSERT INTO chat_messages', throwError: pgErr }
		]);
		const r = await handler(makeCtx({ signer: 'alice', payload: goodPayload() }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'duplicate_message' });
	});
});
