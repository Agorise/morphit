/**
 * nowMs — a shared 1-second wall-clock store.
 *
 * WHY THIS EXISTS
 * ---------------
 * Several views show state that changes purely with the passage of time —
 * an order's expiry (`expires_at` passing), edit-window countdowns, and the
 * `(Live)/(Expired)/…` status pills. Each used to roll its own `setInterval`,
 * or (worse) not re-evaluate at all, so an order that expired while you were
 * looking at the orderbook lingered until the next fetch. This single clock
 * lets every such view re-derive from one ticker instead.
 *
 * LIFECYCLE / COST
 * ----------------
 * A `readable` store only runs its start fn while it has ≥1 subscriber and
 * runs the returned stop fn when the last one leaves — so the interval exists
 * only while something on screen actually needs the time, and never leaks.
 * One shared 1s tick is far cheaper than N per-component intervals.
 *
 * SSR SAFETY
 * ----------
 * On the server there is no `setInterval` to leak and no DOM to update, so we
 * hold a fixed `Date.now()` and never start a ticker. The browser sets the
 * current time on first subscribe and ticks from there.
 *
 * GRANULARITY
 * -----------
 * 1s. Expiry/countdown UIs need sub-second-feel freshness ("under 6 seconds"
 * for the orderbook, per-second for edit-window countdowns). The cost of a 1s
 * tick is a cheap re-derive; keyed `{#each}` blocks reconcile without
 * re-rendering unchanged rows.
 */
import { readable } from 'svelte/store';
import { browser } from '$app/environment';

export const nowMs = readable<number>(Date.now(), (set) => {
	if (!browser) return; // SSR: fixed value, no ticker to start or clean up.
	set(Date.now());
	const timer = setInterval(() => set(Date.now()), 1000);
	return () => clearInterval(timer);
});
