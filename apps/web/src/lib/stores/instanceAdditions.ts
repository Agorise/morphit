/**
 * Morphit — instance payment-method additions store (Batch L).
 *
 * Reads the indexer's `/v1/instance/payment-methods` endpoint
 * once on first access and exposes the operator-defined additions
 * as a Svelte readable.  The picker subscribes to this; orders
 * stored on chain that reference `@instance:foo` keys can be
 * displayed by the lookup helper.
 *
 * Lazy fetch: the store doesn't load until first subscribe.  No
 * polling — additions change rarely (operator-driven), so we
 * fetch once per page load.  A user who triggered an addition
 * via ops-cli then immediately reloads the page will see the new
 * entry; stale state between reloads is acceptable.
 *
 * Failure mode: if the indexer is down or returns an error, the
 * store stays empty.  The picker still works with the canonical
 * list alone — instance additions are an extension, not a
 * dependency.
 */

import { readable, type Readable } from 'svelte/store';
import { getInstancePaymentMethods } from '$lib/indexer/client';
import type { PaymentMethodEntry } from '$lib/payments/registry';

let cached: PaymentMethodEntry[] | null = null;
let inFlight: Promise<PaymentMethodEntry[]> | null = null;

async function fetchOnce(): Promise<PaymentMethodEntry[]> {
	if (cached !== null) return cached;
	if (inFlight !== null) return inFlight;
	const promise: Promise<PaymentMethodEntry[]> = (async (): Promise<PaymentMethodEntry[]> => {
		let result: PaymentMethodEntry[] = [];
		try {
			const r = await getInstancePaymentMethods();
			if (r.ok) {
				result = r.data.additions.map<PaymentMethodEntry>((a) => ({
					key: a.key,
					name: a.name,
					url: a.url,
					category: a.category,
					assetExclusion: undefined
				}));
			}
		} catch {
			// Empty result on any error.  The picker still works
			// with the canonical list alone.
		} finally {
			inFlight = null;
		}
		cached = result;
		return result;
	})();
	inFlight = promise;
	return promise;
}

/** Reactive list of instance additions.  Empty array until the
 *  fetch resolves, then populated.  Subscribers receive an update
 *  exactly once per page load. */
export const instanceAdditions: Readable<readonly PaymentMethodEntry[]> = readable<
	readonly PaymentMethodEntry[]
>([], (set) => {
	void fetchOnce().then((entries) => {
		set(entries);
	});
	return () => {};
});

/** Lookup helper for displayNameForMethod's instanceLookup
 *  callback.  Synchronous; reads from the cache populated by
 *  the store.  Returns the display name or undefined. */
export function instanceNameLookup(key: string): string | undefined {
	if (!cached) return undefined;
	const found = cached.find((e) => e.key === key);
	return found?.name;
}
