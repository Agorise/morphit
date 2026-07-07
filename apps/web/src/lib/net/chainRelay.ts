/**
 * Morphit frontend — chain-read relay (cp410).
 *
 * The single path by which the browser reads the Blurt chain. Every read —
 * account lookups, account history, the chain head, block/tx fetches for chat
 * payment + identity verification — is relayed through the operator's OWN
 * indexer (same-origin `POST /v1/chain/condenser`), which performs the actual
 * RPC call server-side against its canonical node pool.
 *
 * WHY (priority #1 privacy). A direct browser→Blurt-RPC read leaks the user's
 * IP and exactly what they're reading to third-party node operators Morphit
 * doesn't control. Routed through the indexer, third parties only ever see the
 * indexer's request; the browser opens NO cross-origin RPC connection. This is
 * the read companion of the cp344 broadcast proxy. The browser no longer talks
 * to a Blurt node for anything.
 *
 * TRUST NOTE. Collapsing the browser's old multi-node quorum reads onto the
 * single indexer means the user trusts their chosen instance operator for these
 * reads (as they already do for the orderbook and balances). For the two
 * security-critical verifications this feeds — a payment landing and a chat
 * counterparty's identity — the UI additionally offers an independent
 * "Verify on a block explorer" link so a cautious user can confirm without
 * trusting the operator.
 */

import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';
import { fetchWithTimeout } from '$net/fetchWithTimeout';

const RELAY_TIMEOUT_MS = 15_000;
const CONDENSER_PREFIX = 'condenser_api.';

/** Thrown when the indexer chain relay is unreachable or returns an error
 *  status — lets callers distinguish "couldn't reach the indexer" from a
 *  legitimate null chain result (e.g. a not-yet-final transaction). */
export class ChainRelayError extends Error {
	readonly status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.name = 'ChainRelayError';
		this.status = status;
	}
}

function indexerUrl(path: string): URL {
	return new URL(path, resolveOrigin(MORPHIT_INDEXER_ORIGIN));
}

/**
 * Relay one read-only `condenser_api` call through the indexer. `method` may be
 * bare (`get_accounts`) or prefixed (`condenser_api.get_accounts`); the prefix
 * is stripped before it's sent. Returns the chain result verbatim (which may be
 * `null`, e.g. a transaction not yet in a block). Throws `ChainRelayError` on a
 * transport or relay failure.
 *
 * Only the read methods the indexer whitelists are accepted; anything else (in
 * particular any write / broadcast) is refused by the proxy with a 400, which
 * surfaces here as a ChainRelayError — the browser cannot use this to push to
 * the chain.
 */
export async function chainRelay<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
	const bareMethod = method.startsWith(CONDENSER_PREFIX)
		? method.slice(CONDENSER_PREFIX.length)
		: method;

	let res: Response;
	try {
		res = await fetchWithTimeout(
			indexerUrl('/v1/chain/condenser'),
			{
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ method: bareMethod, params })
			},
			RELAY_TIMEOUT_MS
		);
	} catch (e) {
		throw new ChainRelayError(
			`could not reach the indexer: ${e instanceof Error ? e.message : String(e)}`
		);
	}

	if (!res.ok) {
		let message = `chain relay error (${res.status})`;
		try {
			const body = (await res.json()) as { message?: string };
			if (typeof body.message === 'string' && body.message) message = body.message;
		} catch {
			/* keep default */
		}
		throw new ChainRelayError(message, res.status);
	}

	const body = (await res.json()) as { result?: T };
	return (body.result ?? null) as T;
}
