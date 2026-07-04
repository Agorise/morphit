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
 * NO DIRECT-RPC FALLBACK (cp410). Privacy is priority #1: the browser must
 * NEVER contact a Blurt RPC node directly, so there is no fallback path. If the
 * indexer is unreachable, the broadcast (or ref-block read) FAILS with a clear
 * error and the user retries — it does not silently leak to a third-party node.
 * A 400 from the broadcast proxy is a CHAIN REJECTION (the chain refused the
 * tx): that is surfaced with the chain's real reason (e.g. "missing required
 * posting authority", "insufficient mana"), not retried.
 */

import type { DynamicGlobalProperties } from './client';
import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';
import { fetchWithTimeout } from '$net/fetchWithTimeout';
import type { SignedTransaction } from '@beblurt/dblurt';

export interface BroadcastResult {
	block_num: number;
	trx_id: string;
}

/** Thrown when the CHAIN rejected the transaction (broadcast proxy → 400).
 *  The message carries the chain's reason; callers surface it. */
export class ChainRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ChainRejectedError';
	}
}

/** Thrown when the indexer relay itself is unreachable (transport error, 5xx,
 *  or a too-old indexer returning 404). There is NO direct-RPC fallback — the
 *  broadcast simply failed and the user should retry. */
export class BroadcastUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BroadcastUnavailableError';
	}
}

function indexerUrl(path: string): URL {
	return new URL(path, resolveOrigin(MORPHIT_INDEXER_ORIGIN));
}

/** Fetch the chain head (for ref_block / expiration) through the same-origin
 *  indexer proxy. Throws if the proxy is unreachable — no direct-RPC fallback. */
export async function fetchDynamicGlobalProperties(): Promise<DynamicGlobalProperties> {
	let res: Response;
	try {
		res = await fetchWithTimeout(
			indexerUrl('/v1/chain/properties'),
			{ method: 'GET', headers: { accept: 'application/json' } },
			15_000
		);
	} catch (e) {
		throw new BroadcastUnavailableError(
			`could not reach your Morphit instance: ${e instanceof Error ? e.message : String(e)}`
		);
	}
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
	throw new BroadcastUnavailableError('your Morphit instance returned no chain head');
}

/** Submit a SIGNED transaction through the same-origin indexer broadcast proxy.
 *  Surfaces a `ChainRejectedError` on chain rejection (400) and a
 *  `BroadcastUnavailableError` if the indexer is unreachable — NEVER falls back
 *  to a direct browser→node broadcast (privacy #1). */
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
	} catch (e) {
		throw new BroadcastUnavailableError(
			`could not reach your Morphit instance to broadcast: ${e instanceof Error ? e.message : String(e)}`
		);
	}

	if (res.ok) {
		const body = (await res.json()) as Partial<BroadcastResult>;
		if (typeof body.block_num === 'number' && typeof body.trx_id === 'string') {
			return { block_num: body.block_num, trx_id: body.trx_id };
		}
		throw new BroadcastUnavailableError('your Morphit instance returned an unexpected result');
	}

	if (res.status === 400) {
		// The chain rejected the tx — surface the real reason.
		let message = 'the chain rejected the transaction';
		try {
			const body = (await res.json()) as { message?: string };
			if (typeof body.message === 'string' && body.message) message = body.message;
		} catch {
			/* keep default */
		}
		throw new ChainRejectedError(message);
	}

	// 5xx (incl. 502 "couldn't reach the network") or a too-old indexer (404).
	// No direct-RPC fallback — fail and let the user retry.
	throw new BroadcastUnavailableError(
		`your Morphit instance could not broadcast right now (status ${res.status})`
	);
}
