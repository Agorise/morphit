/**
 * Chain reads for pushed messages have their own budget (independent review
 * 2, finding 10). A peer's push need never reach the chain, so pushes naming
 * made-up senders cost nothing; they must not spend the key reads that
 * messages ON the chain — the head tailer, local delivery — depend on for
 * accounts with no row here (most accounts older than Morphit).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { postingKeyLookupFromDb, _resetKeyRefreshForTest } from '$indexer/chatFastFederation';

const noRows = { query: async () => ({ rows: [] }) } as never;

describe('key reads for pushed messages', () => {
	beforeEach(() => _resetKeyRefreshForTest());

	it('a flood of pushes naming made-up senders leaves the chain route its reads', async () => {
		let reads = 0;
		const refresher = async (a: string) => {
			reads++;
			return `KEY_${a}`;
		};
		const intake = postingKeyLookupFromDb(noRows, refresher, { freeReadsBudget: 'push' });
		const tailer = postingKeyLookupFromDb(noRows, refresher);
		for (let i = 0; i < 60; i++) await intake(`junk${i}xyz`, { signedBy: () => false });
		// The pushes' own budget is spent…
		expect(await intake('anotherjunk', { signedBy: () => false })).toBeNull();
		// …a real sender with no row, seen in a block, is still read.
		expect(await tailer('realsender', { signedBy: (k) => k === 'KEY_realsender' })).toBe(
			'KEY_realsender'
		);
		expect(reads).toBeGreaterThan(0);
	});

	it('a key read once — by either route — serves the other from the cache', async () => {
		const refresher = async (a: string) => `KEY_${a}`;
		const intake = postingKeyLookupFromDb(noRows, refresher, { freeReadsBudget: 'push' });
		const tailer = postingKeyLookupFromDb(noRows, async () => {
			throw new Error('must not read again');
		});
		expect(await intake('alice', { signedBy: (k) => k === 'KEY_alice' })).toBe('KEY_alice');
		expect(await tailer('alice', { network: false })).toBe('KEY_alice');
	});
});
