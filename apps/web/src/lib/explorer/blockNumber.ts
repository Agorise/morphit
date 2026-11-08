/**
 * A Blurt block number as `?block=` may carry it (v1.23.4): the explorer's tx
 * page and `/v1/chain/tx/:id?block=N` (which refuses anything else). PURE.
 */
export const MAX_BLOCK_NUMBER = 2_147_483_647;

export function isBlockNumber(n: unknown): n is number {
	return typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= MAX_BLOCK_NUMBER;
}
