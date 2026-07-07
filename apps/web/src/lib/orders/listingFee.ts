/**
 * Morphit frontend — listing-fee + waiver eligibility fetchers.
 *
 * The compose-order page needs two pieces of data from the
 * indexer that aren't part of the local fee math:
 *
 *   1. /v1/listing-fee — the operator's configured fee constants
 *      (base BLURT, featured-slot per-hour rate, and an optional
 *      USD echo when the operator has the price feed enabled).
 *      Frontends that don't display USD just ignore the optional
 *      fields.
 *   2. Waiver eligibility — whether this account can use its
 *      free first-BUY waiver. Derived from /v1/orders/:account:
 *      an account with no prior orders in the index is eligible.
 */

import type { ListingFeeResponse, OrderRecord } from '@morphit/indexer-client';

/** Result of a listing-fee fetch. */
export type ListingFeeFetchResult =
	| { kind: 'ok'; quote: ListingFeeResponse }
	| { kind: 'error'; message: string };

/** Fetch the current listing-fee constants from the indexer.
 *
 *  `indexerOrigin` is the base URL of the indexer (e.g.
 *  'https://indexer.morphit.io'). Typically comes from
 *  $lib/config or a runtime env; we take it as an argument so
 *  this function stays pure-ish and testable. */
export async function fetchListingFee(
	indexerOrigin: string,
	fetchImpl: typeof fetch = fetch
): Promise<ListingFeeFetchResult> {
	let res: Response;
	try {
		res = await fetchImpl(`${indexerOrigin}/v1/listing-fee`, {
			method: 'GET',
			headers: { accept: 'application/json' }
		});
	} catch (err) {
		return {
			kind: 'error',
			message: err instanceof Error ? err.message : String(err)
		};
	}

	if (!res.ok) {
		return {
			kind: 'error',
			message: `indexer /v1/listing-fee returned ${res.status}`
		};
	}

	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return { kind: 'error', message: 'indexer returned non-JSON' };
	}

	const q = body as Partial<ListingFeeResponse>;
	if (typeof q.base_fee_blurt !== 'number') {
		return { kind: 'error', message: 'indexer returned unexpected shape' };
	}

	return { kind: 'ok', quote: q as ListingFeeResponse };
}

/** Waiver eligibility states. */
export type WaiverEligibility =
	/** The account has no prior orders in the indexer. They may
	 *  post a single BUY order with fee_method='waived_first_buy'. */
	| { kind: 'eligible' }
	/** The account has posted before; the waiver isn't available.
	 *  This is the normal post-first-trade state.  We don't surface
	 *  the actual prior-order count here — the listing-eligibility
	 *  query uses `limit=1` so the response only confirms the
	 *  presence of at least one prior order. */
	| { kind: 'ineligible_has_orders' }
	/** The indexer has no record of this account (new local wallet,
	 *  registered outside Morphit, etc.). Treat as eligible — the
	 *  indexer's handler will confirm on submission. */
	| { kind: 'eligible_unknown_account' }
	/** Network or indexer error — don't show the waiver UI
	 *  speculatively, have the user proceed with regular BLURT
	 *  payment. */
	| { kind: 'error'; message: string };

/** Determine whether this account is eligible for the free
 *  first-BUY waiver. Queries /v1/orders/:account and counts. */
export async function checkWaiverEligibility(
	indexerOrigin: string,
	account: string,
	fetchImpl: typeof fetch = fetch
): Promise<WaiverEligibility> {
	let res: Response;
	try {
		res = await fetchImpl(`${indexerOrigin}/v1/orders/${encodeURIComponent(account)}?limit=1`, {
			method: 'GET',
			headers: { accept: 'application/json' }
		});
	} catch (err) {
		return {
			kind: 'error',
			message: err instanceof Error ? err.message : String(err)
		};
	}

	if (res.status === 404) {
		// Indexer doesn't know this account — safe to assume
		// waiver-eligible; the handler will verify on submit.
		return { kind: 'eligible_unknown_account' };
	}
	if (!res.ok) {
		return {
			kind: 'error',
			message: `indexer /v1/orders returned ${res.status}`
		};
	}

	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return { kind: 'error', message: 'indexer returned non-JSON' };
	}
	const b = body as { items?: readonly OrderRecord[] } | null;
	if (!b || !Array.isArray(b.items)) {
		return { kind: 'error', message: 'indexer returned unexpected shape' };
	}

	if (b.items.length === 0) {
		return { kind: 'eligible' };
	}
	return { kind: 'ineligible_has_orders' };
}
