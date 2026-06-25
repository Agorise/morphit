/**
 * Morphit frontend — broadcast transport (cp344).
 *
 * Routes the two RPC touchpoints of a broadcast — the ref-block read that
 * builds the transaction, and the broadcast that submits it — through the
 * operator's OWN indexer (same-origin) instead of the browser calling a
 * third-party Blurt RPC node directly.
 *
 * WHY (priority #1 privacy + reliability). A direct browser→RPC broadcast
 * leaked the user's IP + their exact on-chain action (every order, chat
 * message, profile edit, feedback, block) to RPC operators Morphit doesn't
 * control — the WRITE-side twin of the deanonymizing read leak the cp298
 * account-keys proxy closed — and it depended on whichever public node the
 * browser reached returning a browser-valid CORS header and staying up, so
 * one node flipping its CORS config or going down silently broke every
 * broadcast. Relayed through the same-origin indexer (the cp295/296/298 read
 * proxies' write sibling), third parties see only the indexer's request and
 * the browser opens no cross-origin RPC connection.
 *
 * NON-CUSTODIAL IS UNTOUCHED. Signing is pure client-side crypto; only the
 * already-signed transaction bytes (never a private key) leave the browser.
 *
 * SAFETY NET. If the proxy is unreachable — network error, 5xx, or a stale
 * indexer that predates these endpoints (404) — we fall back to the legacy
 * direct-RPC path, so this can never be WORSE than the pre-cp344 behavior. A
 * 400 from the broadcast proxy is a CHAIN REJECTION (the chain refused the
 * tx): that is surfaced, not fallen back, because direct RPC would only
 * refuse it again — and the message is the chain's real reason (e.g. "missing
 * required posting authority", "insufficient mana"), which is far more useful
 * than the old generic "couldn't broadcast".
 */

import { getBlurtClient } from './client';
import type { DynamicGlobalProperties } from './client';
import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';
import { fetchWithTimeout } from '$net/fetchWithTimeout';
import type { SignedTransaction } from '@beblurt/dblurt';

export interface BroadcastResult {
	block_num: number;
	trx_id: string;
}

/** Thrown when the CHAIN rejected the transaction (broadcast proxy → 400).
 *  The message carries the chain's reason; callers surface it rather than
 *  silently retrying against a third-party node. */
export class ChainRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ChainRejectedError';
	}
}

function indexerUrl(path: string): URL {
	return new URL(path, resolveOrigin(MORPHIT_INDEXER_ORIGIN));
}

/** Fetch the chain head (for ref_block / expiration). Tries the same-origin
 *  indexer proxy first, falls back to direct RPC if the proxy is unreachable
 *  or returns an unexpected shape. */
export async function fetchDynamicGlobalProperties(): Promise<DynamicGlobalProperties> {
	try {
		const res = await fetchWithTimeout(
			indexerUrl('/v1/chain/properties'),
			{ method: 'GET', headers: { accept: 'application/json' } },
			15_000
		);
		if (res.ok) {
			const body = (await res.json()) as { properties?: Partial<DynamicGlobalProperties> };
			const p = body.properties;
			if (
				p &&
				typeof p.head_block_number === 'number' &&
				typeof p.head_block_id === 'string' &&
				typeof p.time === 'string'
			) {
				return p as DynamicGlobalProperties;
			}
		}
		// non-ok or unexpected shape → fall through to direct RPC
	} catch {
		// network error reaching the proxy → fall through to direct RPC
	}
	return getBlurtClient().getDynamicGlobalProperties();
}

/** Legacy fallback: broadcast straight to a Blurt RPC node from the browser.
 *  Used ONLY when the same-origin proxy is unreachable. */
async function directRpcBroadcast(signed: SignedTransaction): Promise<BroadcastResult> {
	const client = getBlurtClient();
	const r = await client.call<{ block_num: number; id?: string; trx_id?: string }>(
		'condenser_api.broadcast_transaction_synchronous',
		[signed]
	);
	// condenser names the tx hash `id`; normalize (the old code left trx_id undefined).
	return { block_num: r.block_num, trx_id: (r.trx_id ?? r.id) as string };
}

/** Submit a SIGNED transaction. Same-origin proxy first; direct-RPC fallback
 *  on proxy-unreachable; surfaces a `ChainRejectedError` on chain rejection. */
export async function submitSignedTransaction(signed: SignedTransaction): Promise<BroadcastResult> {
	let res: Response;
	try {
		res = await fetchWithTimeout(
			indexerUrl('/v1/broadcast'),
			{
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ trx: signed })
			},
			30_000
		);
	} catch {
		// Network error reaching the proxy → fall back to direct RPC.
		return directRpcBroadcast(signed);
	}

	if (res.ok) {
		const body = (await res.json()) as Partial<BroadcastResult>;
		if (typeof body.block_num === 'number' && typeof body.trx_id === 'string') {
			return { block_num: body.block_num, trx_id: body.trx_id };
		}
		// Unexpected success shape → fall back rather than return a half result.
		return directRpcBroadcast(signed);
	}

	if (res.status === 400) {
		// The chain rejected the tx — surface the real reason, do NOT fall back.
		let message = 'the chain rejected the transaction';
		try {
			const body = (await res.json()) as { message?: string };
			if (typeof body.message === 'string' && body.message) message = body.message;
		} catch {
			/* keep default */
		}
		throw new ChainRejectedError(message);
	}

	// 5xx (incl. 502 "couldn't reach the network") or a stale indexer (404) →
	// fall back to direct RPC. Worst case == the pre-cp344 behavior.
	return directRpcBroadcast(signed);
}
