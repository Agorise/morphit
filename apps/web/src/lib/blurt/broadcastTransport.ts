/**
 * Morphit frontend — broadcast transport.
 *
 * Routes the two RPC touchpoints of a broadcast — the ref-block read that
 * builds the transaction, and the broadcast that submits it — through the
 * operator's OWN indexer (same-origin) instead of the browser calling a
 * third-party Blurt RPC node directly.
 *
 * WHY (priority #1 privacy + reliability). A direct browser→RPC broadcast
 * leaked the user's IP + their exact on-chain action (every order, chat
 * message, profile edit, feedback, block) to RPC operators Morphit doesn't
 * control — the WRITE-side twin of the deanonymizing read leak the
 * account-keys proxy closed — and it depended on whichever public node the
 * browser reached returning a browser-valid CORS header and staying up, so
 * one node flipping its CORS config or going down silently broke every
 * broadcast. Relayed through the same-origin indexer (the read
 * proxies' write sibling), third parties see only the indexer's request and
 * the browser opens no cross-origin RPC connection.
 *
 * NON-CUSTODIAL IS UNTOUCHED. Signing is pure client-side crypto; only the
 * already-signed transaction bytes (never a private key) leave the browser.
 *
 * NO DIRECT-RPC FALLBACK. Privacy is priority #1: the browser must
 * NEVER contact a Blurt RPC node directly, so there is no fallback path. If the
 * indexer is unreachable, the broadcast (or ref-block read) FAILS with a clear
 * error and the user retries — it does not silently leak to a third-party node.
 * A 400 from the broadcast proxy is a CHAIN REJECTION (the chain refused the
 * tx): that is surfaced with the chain's real reason (e.g. "missing required
 * active authority", or not enough liquid BLURT to cover the network fee —
 * Blurt meters ops with a small BLURT fee, not mana/RC), not retried.
 */

import type { DynamicGlobalProperties } from './client';
import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';
import { fetchWithTimeout } from '$net/fetchWithTimeout';
import { chainCallTimeoutMs } from '$net/transportBudget';
import type { SignedTransaction } from '@beblurt/dblurt';

export interface BroadcastResult {
	block_num: number;
	trx_id: string;
}

/**
 * What a CHAT MESSAGE send gets back.
 *
 * `block_num` is null because a chat message is broadcast asynchronously: the
 * indexer answers as soon as the Blurt node has accepted and validated the
 * transaction, rather than waiting up to a full 3,000 ms block interval for a
 * witness to seal it into a block. On a zero-clearnet instance that wait sat on
 * top of two hidden round trips and pushed the sender past six seconds before
 * they were told their own message had gone.
 *
 * It is a separate type rather than a nullable `block_num` on BroadcastResult
 * because every OTHER caller — orders, feature bids, transfers, account
 * creation, chat-identity publication — writes that block number into a receipt
 * and genuinely needs it. Widening the shared type would have made those
 * callers handle a null that can never reach them, and the compiler would have
 * stopped telling them the truth.
 */
export interface ChatBroadcastResult {
	block_num: null;
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

/**
 * Thrown when a broadcast can't proceed because of a structural issue
 * (not a transport failure). UI code catches this and maps `code` to a
 * localized message.
 */
export class BroadcastError extends Error {
	constructor(
		public readonly code: 'no_account' | 'locked' | 'missing_external_tx_id' | 'key_mismatch',
		message: string
	) {
		super(message);
		this.name = 'BroadcastError';
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
			// Same-origin, but the indexer answers it with a real chain RPC —
			// up to 60s on a hidden-only instance. A flat 15s here aborted every
			// chat send on Tor/I2P while the identity check beside it succeeded.
			chainCallTimeoutMs(15_000)
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

/**
 * POST the signed transaction and return the parsed success body.
 *
 * Shared by both submit functions below so that the error handling — chain
 * rejection, unreachable instance, no direct-RPC fallback — has exactly one
 * implementation. The only thing the two callers disagree about is whether a
 * missing `block_num` is a failure, and that is decided by each of them rather
 * than duplicated here.
 */
async function postSignedTransaction(
	signed: SignedTransaction,
	/**
	 * Ask the indexer to answer as soon as the node accepts the transaction,
	 * rather than when a witness seals it into a block.
	 *
	 * Sent only by the chat path, and only because the indexer cannot safely
	 * assume it. A browser tab can be older than the indexer serving it, and a
	 * bundle from before this release would read the resulting `block_num: null`
	 * as a malformed reply and show a permanent failure for a message that was
	 * in fact delivered. Asking for the behaviour is what makes the two versions
	 * safe in both directions.
	 */
	chatAsync = false
): Promise<{ block_num?: unknown; trx_id?: unknown }> {
	let res: Response;
	try {
		res = await fetchWithTimeout(
			indexerUrl('/v1/broadcast'),
			{
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify(chatAsync ? { trx: signed, chat_async: true } : { trx: signed })
			},
			// A chain WRITE through the indexer — same reasoning as the head
			// fetch above, and the step the whole send depends on.
			chainCallTimeoutMs(30_000)
		);
	} catch (e) {
		throw new BroadcastUnavailableError(
			`could not reach your Morphit instance to broadcast: ${e instanceof Error ? e.message : String(e)}`
		);
	}

	if (res.ok) {
		return (await res.json()) as { block_num?: unknown; trx_id?: unknown };
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

/** Submit a SIGNED transaction through the same-origin indexer broadcast proxy.
 *  Surfaces a `ChainRejectedError` on chain rejection (400) and a
 *  `BroadcastUnavailableError` if the indexer is unreachable — NEVER falls back
 *  to a direct browser→node broadcast (privacy #1). */
export async function submitSignedTransaction(signed: SignedTransaction): Promise<BroadcastResult> {
	const body = await postSignedTransaction(signed);
	if (typeof body.block_num === 'number' && typeof body.trx_id === 'string') {
		return { block_num: body.block_num, trx_id: body.trx_id };
	}
	throw new BroadcastUnavailableError('your Morphit instance returned an unexpected result');
}

/**
 * Submit a signed CHAT MESSAGE, which is answered before it reaches a block.
 *
 * Identical to `submitSignedTransaction` except that a null `block_num` is the
 * expected, successful answer rather than a malformed one — see
 * {@link ChatBroadcastResult}. A NUMBER is still accepted, so this keeps working
 * against an older indexer that still broadcasts chat synchronously and ignores
 * the flag below; what is refused is a reply with no usable transaction id at
 * all. Between the flag and that tolerance, either half of this pair can be the
 * older one without anybody seeing an error.
 */
export async function submitSignedChatTransaction(
	signed: SignedTransaction
): Promise<ChatBroadcastResult> {
	const body = await postSignedTransaction(signed, true);
	if (typeof body.trx_id === 'string' && body.trx_id.length > 0) {
		return { block_num: null, trx_id: body.trx_id };
	}
	throw new BroadcastUnavailableError('your Morphit instance returned an unexpected result');
}
