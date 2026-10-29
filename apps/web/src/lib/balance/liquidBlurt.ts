/**
 * Morphit — an account's liquid BLURT, kept current (v1.21.17).
 *
 * The same reading MyBalanceCard shows: through the instance's indexer
 * (same-origin — no RPC node learns who is looking), every 5 s while the tab
 * is visible, at once when the tab comes back or when something that moved
 * BLURT nudges the balance bus. For a form that must not offer a payment the
 * wallet cannot make (the Feature form).
 */

import { readable, type Readable } from 'svelte/store';
import { fetchAccountBalance, type AccountBalanceFetchResult } from '$blurt/accountBalance';
import { parseAssetAmount } from '$blurt/balanceMath';
import { subscribeBalanceRefresh } from '$lib/balance/bus';
import { MORPHIT_INDEXER_ORIGIN, resolveOrigin } from '$net/config';
import { chainCallTimeoutMs } from '$net/transportBudget';

export const LIQUID_BLURT_REFRESH_MS = 5_000;
/** A read that has not answered in this long counts as failed (clearnet;
 *  Tor/I2P get the chain floor): a stalled request must not freeze the
 *  balance — and with it the Pay button — for good (v1.21.17 review). */
export const LIQUID_BLURT_READ_TIMEOUT_MS = 15_000;

export type LiquidBlurt =
	| { readonly kind: 'loading' }
	| { readonly kind: 'error' }
	| { readonly kind: 'ok'; readonly liquidBlurt: number };

export function liquidOf(result: AccountBalanceFetchResult): LiquidBlurt {
	if (result.kind !== 'ok') return { kind: 'error' };
	const v = parseAssetAmount(result.data.account.balance);
	return Number.isFinite(v) ? { kind: 'ok', liquidBlurt: v } : { kind: 'error' };
}

export function watchLiquidBlurt(
	account: string,
	deps: {
		readonly read?: (account: string) => Promise<AccountBalanceFetchResult>;
		readonly intervalMs?: number;
		readonly timeoutMs?: number;
	} = {}
): Readable<LiquidBlurt> {
	const read =
		deps.read ??
		((a: string) => fetchAccountBalance(resolveOrigin(MORPHIT_INDEXER_ORIGIN), a, fetch));
	return readable<LiquidBlurt>({ kind: 'loading' }, (set) => {
		let stopped = false;
		let inFlight = false;
		let last: LiquidBlurt = { kind: 'loading' };
		const refresh = async (): Promise<void> => {
			if (inFlight || stopped) return;
			inFlight = true;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const timedOut = new Promise<AccountBalanceFetchResult>((resolve) => {
					timer = setTimeout(
						() => resolve({ kind: 'error', message: 'balance read timed out' }),
						deps.timeoutMs ?? chainCallTimeoutMs(LIQUID_BLURT_READ_TIMEOUT_MS)
					);
				});
				const next = liquidOf(await Promise.race([read(account), timedOut]));
				if (stopped) return;
				// A failed read after a good one keeps the good one (one blip
				// must not unblock or re-block the form); only a first read
				// that fails says "unknown".
				if (next.kind === 'error' && last.kind === 'ok') return;
				last = next;
				set(next);
			} catch {
				if (!stopped && last.kind === 'loading') set((last = { kind: 'error' }));
			} finally {
				clearTimeout(timer);
				inFlight = false;
			}
		};
		void refresh();
		let timer: ReturnType<typeof setInterval> | null = null;
		const start = (): void => {
			if (timer === null)
				timer = setInterval(() => void refresh(), deps.intervalMs ?? LIQUID_BLURT_REFRESH_MS);
		};
		const stop = (): void => {
			if (timer !== null) clearInterval(timer);
			timer = null;
		};
		const onVisibility = (): void => {
			if (document.visibilityState === 'visible') {
				void refresh();
				start();
			} else stop();
		};
		const hasDocument = typeof document !== 'undefined';
		if (hasDocument) {
			document.addEventListener('visibilitychange', onVisibility);
			if (document.visibilityState !== 'hidden') start();
		} else start();
		const unsubscribe = subscribeBalanceRefresh(() => void refresh());
		return () => {
			stopped = true;
			stop();
			unsubscribe();
			if (hasDocument) document.removeEventListener('visibilitychange', onVisibility);
		};
	});
}
