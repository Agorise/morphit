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
import {
	chainCallTimeoutMs,
	isHiddenHostname,
	INDEXER_HIDDEN_RPC_TIMEOUT_MS
} from '$net/transportBudget';

/** Budget for a chain read on a CLEARNET instance. */
const RELAY_TIMEOUT_CLEARNET_MS = 15_000;

/**
 * The chain-read budget for a given page hostname.
 *
 * THE BUG THIS FIXES. This was a flat 15s for every instance. But the browser is
 * not doing the chain read — the indexer is, on its own RPC pool, and on a
 * zero-clearnet instance every node in that pool is a hidden service. The
 * indexer allows itself 60s there (`MORPHIT_HIDDEN_RPC_TIMEOUT_MS`) precisely
 * because a cold .onion circuit or I2P tunnel has to be built before a single
 * byte moves. So the browser was giving up FOUR TIMES SOONER than the server it
 * was waiting on, and its own request had to cross the same kind of tunnel just
 * to arrive.
 *
 * On morphitlat — zero clearnet, hidden pool only — that made the abort the
 * normal outcome rather than the exceptional one. And the consequence was not a
 * spinner: the chat-identity verifier treats "no chain answer" as "the chain
 * reports no key", which pub-pinning reports as a TAMPER signal. A user opening
 * their first chat with someone was told their operator might be "fabricating
 * data", and advised to try a different instance — the one piece of advice that
 * is useless to someone on a hidden-only instance because the others are
 * blocked where they are.
 *
 * Pure, so the invariant can be executed rather than read. The hidden figure
 * comes from `chainCallTimeoutMs`, shared with every other chain-backed
 * endpoint (`/v1/chain/properties`, `/v1/chain/key-references`, `/v1/broadcast`),
 * so the four of them cannot drift apart. It is a CEILING, not a delay: a
 * healthy instance answers in well under a second and nothing waits.
 */
export function chainRelayTimeoutMs(hostname: string | null): number {
	if (hostname === null) return RELAY_TIMEOUT_CLEARNET_MS;
	return chainCallTimeoutMs(
		RELAY_TIMEOUT_CLEARNET_MS,
		isHiddenHostname(hostname) ? `http://${hostname}` : null
	);
}

export { isHiddenHostname as isHiddenOrigin, INDEXER_HIDDEN_RPC_TIMEOUT_MS };

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
			chainRelayTimeoutMs(typeof window === 'undefined' ? null : window.location.hostname)
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

	// The BODY read needs the same handling as the connection. `fetch()` resolves
	// on headers, so a hidden-transport connection that dies mid-body rejects
	// here — with a raw `TypeError: terminated`, not a ChainRelayError. That
	// slipped past the transport check in chainVerify, was swallowed into `null`,
	// and came back out as `chain_reports_none`: the exact false tamper warning
	// this file's budget was raised to prevent, re-entering one step later.
	let body: { result?: T };
	try {
		body = (await res.json()) as { result?: T };
	} catch (e) {
		throw new ChainRelayError(
			`could not read the indexer's reply: ${e instanceof Error ? e.message : String(e)}`
		);
	}
	return (body.result ?? null) as T;
}
