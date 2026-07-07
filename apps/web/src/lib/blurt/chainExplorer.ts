/**
 * Morphit frontend — block-explorer block/tx fetchers (cp296).
 *
 * Fetches a block or a confirmed transaction FROM THE INDEXER,
 * same-origin, instead of calling Blurt `get_block` / `get_transaction`
 * straight from a public RPC node in the browser.
 *
 * Privacy (priority #1): reading blocks/txs straight from public RPC
 * nodes leaks the user's IP and exactly which block/tx they inspected to
 * third-party operators Morphit doesn't control. Routing through the
 * operator's own indexer means those third parties only ever see the
 * indexer's server-side request, and it sidesteps browser CORS entirely.
 * Bonus: the tx lookup is more reliable — not every node exposes
 * `get_transaction`, and the indexer's pool finds one that does.
 *
 * Thin — mirrors $lib/blurt/accountBalance.ts / accountHistory.ts. The
 * proxy relays the chain result verbatim; this helper narrows it to the
 * existing `BlurtBlock` / `BlurtTransaction` types so the explorer pages
 * render unchanged. `indexerOrigin`/`fetchImpl` are arguments for testing.
 */

import type { BlurtBlock, BlurtTransaction } from '$blurt/client';
import type { ChainBlockResponse, ChainTxResponse } from '@morphit/indexer-client';

export type ChainBlockFetchResult =
	| { kind: 'ok'; block: BlurtBlock }
	| { kind: 'not_found' }
	| { kind: 'error'; message: string };

export type ChainTxFetchResult =
	| { kind: 'ok'; tx: BlurtTransaction }
	| { kind: 'not_found' }
	| { kind: 'error'; message: string };

/** Fetch `GET /v1/chain/block/:num` from the indexer. */
export async function fetchChainBlock(
	indexerOrigin: string,
	blockNumber: number,
	fetchImpl: typeof fetch = fetch
): Promise<ChainBlockFetchResult> {
	let res: Response;
	try {
		res = await fetchImpl(`${indexerOrigin}/v1/chain/block/${encodeURIComponent(String(blockNumber))}`, {
			method: 'GET',
			headers: { accept: 'application/json' }
		});
	} catch (err) {
		return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
	}
	if (res.status === 404) return { kind: 'not_found' };
	if (!res.ok) return { kind: 'error', message: `indexer /v1/chain/block returned ${res.status}` };

	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return { kind: 'error', message: 'indexer returned non-JSON' };
	}
	const b = body as Partial<ChainBlockResponse>;
	if (b.block === null || b.block === undefined || typeof b.block !== 'object') {
		return { kind: 'error', message: 'indexer returned unexpected shape' };
	}
	return { kind: 'ok', block: b.block as BlurtBlock };
}

/** Fetch `GET /v1/chain/tx/:id` from the indexer. */
export async function fetchChainTx(
	indexerOrigin: string,
	trxId: string,
	fetchImpl: typeof fetch = fetch
): Promise<ChainTxFetchResult> {
	let res: Response;
	try {
		res = await fetchImpl(`${indexerOrigin}/v1/chain/tx/${encodeURIComponent(trxId)}`, {
			method: 'GET',
			headers: { accept: 'application/json' }
		});
	} catch (err) {
		return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
	}
	if (res.status === 404) return { kind: 'not_found' };
	if (!res.ok) return { kind: 'error', message: `indexer /v1/chain/tx returned ${res.status}` };

	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return { kind: 'error', message: 'indexer returned non-JSON' };
	}
	const b = body as Partial<ChainTxResponse>;
	if (b.tx === null || b.tx === undefined || typeof b.tx !== 'object') {
		return { kind: 'error', message: 'indexer returned unexpected shape' };
	}
	return { kind: 'ok', tx: b.tx as BlurtTransaction };
}
