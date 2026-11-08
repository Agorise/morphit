/** v1.23.4: the explorer link carries the block a receipt's transaction is in. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/instance', () => ({ getInstanceSnapshot: () => ({}) }));

import { isBlockNumber, MAX_BLOCK_NUMBER } from './blockNumber';
import { morphitExplorerTxUrl } from './urls';

const ID = 'fbf37842f3baabf5bfb4b48c9be6558b97c42b7b';

describe('isBlockNumber', () => {
	it('a positive whole number up to the instance’s cap', () => {
		expect(isBlockNumber(1)).toBe(true);
		expect(isBlockNumber(65148473)).toBe(true);
		expect(isBlockNumber(MAX_BLOCK_NUMBER)).toBe(true);
		for (const n of [
			0,
			-1,
			1.5,
			Number.NaN,
			Infinity,
			MAX_BLOCK_NUMBER + 1,
			'7',
			null,
			undefined
		]) {
			expect(isBlockNumber(n), String(n)).toBe(false);
		}
	});
});

describe('morphitExplorerTxUrl', () => {
	it('with the block: ?block=N; without, or a bad one: the plain path', () => {
		expect(morphitExplorerTxUrl(ID, 65148473)).toBe(`/explorer/tx/${ID}?block=65148473`);
		expect(morphitExplorerTxUrl(ID)).toBe(`/explorer/tx/${ID}`);
		expect(morphitExplorerTxUrl(ID, 0)).toBe(`/explorer/tx/${ID}`);
		expect(morphitExplorerTxUrl('nope', 7)).toBeNull();
	});
});
