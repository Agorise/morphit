/**
 * Morphit frontend — chain account-creation fee store.
 *
 * Mirrors the instance store pattern: fetched once from
 * /v1/chain-fee at first browser mount, then cached for the
 * session.
 *
 * Witnesses can change Blurt's account-creation fee.  When that
 * happens we want the FAQ ("currently 100 BLURT") and signup
 * helpers to show the right number without a Morphit code
 * release.  The indexer reads the chain value once per 24h and
 * surfaces it via /v1/chain-fee; the frontend fetches it once
 * per session.
 *
 * Failure mode: defaults to 100 BLURT (the long-stable value
 * at the time of writing) so prose like "Morphit pays the
 * Blurt account-creation fee (currently {n} BLURT) for every
 * new account" still renders gracefully if the indexer is
 * reachable but /v1/chain-fee specifically errors.
 */

import { writable, type Readable } from 'svelte/store';
import { browser } from '$app/environment';

export interface ChainFeeState {
	/** account_creation_fee in BLURT */
	readonly accountCreationFeeBlurt: number;
	/** ISO-8601 timestamp from the indexer's last chain read */
	readonly observedAt: string | null;
	/** 'chain' = live from chain RPC, 'fallback' = operator's
	 *  configured fallback (chain unreachable from indexer),
	 *  'session_default' = haven't fetched yet OR indexer
	 *  unreachable from frontend. */
	readonly source: 'chain' | 'fallback' | 'session_default';
	readonly loaded: boolean;
}

const FALLBACK: ChainFeeState = {
	accountCreationFeeBlurt: 100,
	observedAt: null,
	source: 'session_default',
	loaded: false
};

const store = writable<ChainFeeState>(FALLBACK);

export const chainFee: Readable<ChainFeeState> = {
	subscribe: store.subscribe
};

let initPromise: Promise<void> | null = null;

/** Trigger the one-time fetch.  Idempotent.  Called from
 *  +layout.svelte's onMount alongside initInstance(). */
export function initChainFee(): Promise<void> {
	if (!browser) return Promise.resolve();
	if (initPromise !== null) return initPromise;
	initPromise = (async () => {
		try {
			const res = await fetch('/v1/chain-fee', {
				headers: { Accept: 'application/json' }
			});
			if (!res.ok) {
				store.set({ ...FALLBACK, loaded: true });
				return;
			}
			const body = (await res.json()) as {
				account_creation_fee_blurt?: unknown;
				observed_at?: unknown;
				source?: unknown;
			};
			const fee = Number(body.account_creation_fee_blurt);
			if (!Number.isFinite(fee) || fee <= 0) {
				store.set({ ...FALLBACK, loaded: true });
				return;
			}
			const observedAt = typeof body.observed_at === 'string' ? body.observed_at : null;
			const source =
				body.source === 'chain' || body.source === 'fallback' ? body.source : 'session_default';
			store.set({
				accountCreationFeeBlurt: fee,
				observedAt,
				source,
				loaded: true
			});
		} catch {
			store.set({ ...FALLBACK, loaded: true });
		}
	})();
	return initPromise;
}

/** Test-only reset. */
export function resetChainFeeStore(): void {
	store.set(FALLBACK);
	initPromise = null;
}
