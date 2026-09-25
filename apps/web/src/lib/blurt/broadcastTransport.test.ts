// @vitest-environment jsdom
/**
 * broadcastTransport — the wire contract between this browser and its indexer.
 *
 * WHY THIS FILE EXISTS
 *
 * v1.18.0 changed what a chat send is answered with: the indexer now replies as
 * soon as the Blurt node has ACCEPTED the transaction rather than waiting for a
 * witness to seal it into a block, so `block_num` comes back null where every
 * other broadcast returns a number. That is the change that removes up to three
 * seconds from the sender's own leg, and it is the change that can break a user
 * who has not reloaded the page.
 *
 * None of this module had a test. Not one. The release notes claimed both halves
 * of the activity-frame contract were pinned — true — while the contract this
 * release actually changed was pinned nowhere, and an independent review found
 * the failure that produces: an older cached bundle, talking to a new indexer,
 * calls the generic submit path, reads `block_num: null` as a malformed reply
 * and throws. The user sees a permanent red bubble for a message the recipient
 * already has, and the retry button beside it sends a second copy.
 *
 * So what is pinned here is VERSION SKEW IN BOTH DIRECTIONS, which is the only
 * interesting property of a wire contract that changed:
 *
 *   new browser + old indexer — a numeric block_num is still accepted
 *   old browser + new indexer — the fast answer is OPT-IN, so it is never sent
 *                               to a client that did not ask for it
 *
 * and the error mapping, which decides whether the user is told "retry" or told
 * what the chain actually refused.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
	submitSignedTransaction,
	submitSignedChatTransaction,
	BroadcastUnavailableError,
	ChainRejectedError
} from './broadcastTransport';
import type { SignedTransaction } from '@beblurt/dblurt';

/** A stand-in signed transaction. Nothing here inspects its contents — the
 *  indexer decides by op type, and that decision is tested on the indexer
 *  side (apps/indexer/scripts/fastchat-three-leg-smoke.ts). */
const SIGNED = {
	ref_block_num: 1,
	ref_block_prefix: 2,
	expiration: '2030-01-01T00:00:00',
	operations: [],
	extensions: [],
	signatures: ['aa']
} as unknown as SignedTransaction;

interface Call {
	url: string;
	body: Record<string, unknown>;
}

let calls: Call[] = [];

/** Install a fetch that answers every broadcast with `reply`. */
function stubFetch(reply: { status: number; body: unknown }): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: { body?: string }) => {
			calls.push({
				url: String(url),
				body: JSON.parse(init?.body ?? '{}') as Record<string, unknown>
			});
			return {
				ok: reply.status >= 200 && reply.status < 300,
				status: reply.status,
				json: async () => reply.body
			} as unknown as Response;
		})
	);
}

describe('broadcastTransport', () => {
	beforeEach(() => {
		calls = [];
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe('a chat send', () => {
		it('ASKS for the fast answer, rather than leaving the indexer to guess', async () => {
			// This flag is the whole version-skew defence. Without it the indexer
			// would have to decide from the transaction alone — and it cannot know
			// how old the browser asking is.
			stubFetch({ status: 200, body: { block_num: null, trx_id: 'abc123' } });
			await submitSignedChatTransaction(SIGNED);
			expect(calls[0]?.body.chat_async).toBe(true);
		});

		it('accepts the null block_num that the fast answer carries', async () => {
			stubFetch({ status: 200, body: { block_num: null, trx_id: 'abc123' } });
			const r = await submitSignedChatTransaction(SIGNED);
			expect(r).toEqual({ block_num: null, trx_id: 'abc123' });
		});

		it('also accepts a NUMBER, so a newer browser works against an older indexer', async () => {
			// An indexer from before this release ignores the flag and broadcasts
			// synchronously, so it answers with a real block number. That must be a
			// success, not a surprise — otherwise upgrading the frontend first
			// breaks chat for everyone until the backend catches up.
			stubFetch({ status: 200, body: { block_num: 4242, trx_id: 'abc123' } });
			const r = await submitSignedChatTransaction(SIGNED);
			expect(r.trx_id).toBe('abc123');
		});

		it('refuses a reply with no usable transaction id', async () => {
			// The one thing that genuinely is malformed. Everything downstream —
			// reconciliation, the chat PDF export's on-chain citation — keys on it.
			stubFetch({ status: 200, body: { block_num: null, trx_id: '' } });
			await expect(submitSignedChatTransaction(SIGNED)).rejects.toBeInstanceOf(
				BroadcastUnavailableError
			);
		});
	});

	describe('every other send', () => {
		it('does NOT ask for the fast answer', async () => {
			// An order, a transfer, a feature bid: each writes the block number into
			// a receipt. Sending this flag on one of those would be asking to be
			// told a transaction landed before it had.
			stubFetch({ status: 200, body: { block_num: 7, trx_id: 'x' } });
			await submitSignedTransaction(SIGNED);
			expect(calls[0]?.body.chat_async).toBeUndefined();
		});

		it('requires a real block number and rejects a null one', async () => {
			// The counterpart to the chat case above, and the reason the two are
			// separate functions rather than one with a nullable field. If this ever
			// starts passing, a caller that writes block_num into a receipt can be
			// handed a null.
			stubFetch({ status: 200, body: { block_num: null, trx_id: 'x' } });
			await expect(submitSignedTransaction(SIGNED)).rejects.toBeInstanceOf(
				BroadcastUnavailableError
			);
		});

		it('returns the block number when it gets one', async () => {
			stubFetch({ status: 200, body: { block_num: 7, trx_id: 'x' } });
			await expect(submitSignedTransaction(SIGNED)).resolves.toEqual({
				block_num: 7,
				trx_id: 'x'
			});
		});
	});

	describe('what the user is told when it fails', () => {
		it('surfaces a chain rejection with the chain’s own reason', async () => {
			// A 400 means the chain refused it — usually not enough liquid BLURT for
			// the network fee, or a missing authority. Retrying will refuse again,
			// so the user needs the real reason rather than "try again".
			stubFetch({
				status: 400,
				body: { message: 'missing required posting authority' }
			});
			await expect(submitSignedChatTransaction(SIGNED)).rejects.toThrow(
				/missing required posting authority/
			);
			stubFetch({ status: 400, body: { message: 'nope' } });
			await expect(submitSignedTransaction(SIGNED)).rejects.toBeInstanceOf(ChainRejectedError);
		});

		it('treats a 5xx as "your instance could not do it right now"', async () => {
			// Distinct from a rejection: nothing is wrong with the transaction, so
			// this one IS worth retrying.
			stubFetch({ status: 502, body: {} });
			await expect(submitSignedChatTransaction(SIGNED)).rejects.toBeInstanceOf(
				BroadcastUnavailableError
			);
		});

		it('never reaches a Blurt node directly when the indexer is unreachable', async () => {
			// Privacy is priority #1 for this module: a direct browser→node
			// broadcast would hand a third party the user's IP alongside the exact
			// action they just took. There is deliberately no fallback, so an
			// unreachable indexer must FAIL rather than find another way.
			vi.stubGlobal(
				'fetch',
				vi.fn(async (url: string) => {
					calls.push({ url: String(url), body: {} });
					throw new Error('network down');
				})
			);
			await expect(submitSignedChatTransaction(SIGNED)).rejects.toBeInstanceOf(
				BroadcastUnavailableError
			);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.url).toContain('/v1/broadcast');
		});
	});
});
