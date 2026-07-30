/**
 * pendingEcho — the shared rules behind Morphit's optimistic, DISPLAY-ONLY
 * echo stores (v1.7.0, ADR-0051).
 *
 * WHY THIS EXISTS. The durable indexer applies only irreversible blocks
 * (ADR-0008), so anything you just broadcast is invisible to it for ~45-63s.
 * But YOUR browser already knows what you did — it signed and broadcast the op.
 * An echo store stages that locally so the UI can show it immediately, and drops
 * it the moment the indexer's authoritative copy arrives.
 *
 * `pendingFeatured` (cp431) invented this shape and it works. v1.7.0 needed the
 * same shape for orders, and two hand-copies of the same TTL and the same expiry
 * rule is exactly how they drift apart — one gets a bug fix, the other doesn't,
 * and nobody notices because both still look right. So the two rules that would
 * actually drift live here, once.
 *
 * What deliberately does NOT live here: each store's `add`, and each store's
 * merge. Those carry real domain meaning (a featured slot is additive; an order
 * cancel MODIFIES a row that already exists), and forcing them through one
 * abstraction would buy nothing and cost clarity. This module is the mechanical
 * part only.
 *
 * THE INVARIANTS EVERY ECHO STORE INHERITS — read before adding a third:
 *   1. DISPLAY ONLY. Never touches money, the database, fee verification, or
 *      any derived state. The durable indexer is the SOLE source of truth and
 *      SUPERSEDES anything staged here. This is the same line ADR-0051 draws
 *      for the head-block tailer, for the same reason: a provisional thing that
 *      can drive state is a thing a reorg can corrupt.
 *   2. SELF-RECONCILING. An entry disappears the instant the indexer confirms
 *      it (`confirmedKeys`), and ages out on its own after the TTL if it never
 *      confirms. An echo that can outlive its own truth is a liar with a
 *      timer.
 *   3. LOCAL ONLY. In-memory; nothing persists across a reload. A refresh falls
 *      back to the authoritative indexer view, which is always the safe
 *      direction to fail.
 */

/** ~2.5 min: Blurt's last-irreversible lag (~45-63s) plus generous margin, so a
 *  slow indexer catch-up can't drop an entry before it confirms, while an entry
 *  that will NEVER confirm (a losing feature bid, a rejected op) still clears in
 *  bounded time rather than lying forever.
 *
 *  Shared rather than duplicated per store: this number encodes a fact about the
 *  CHAIN, not about featured slots or orders, so a change to one is a change to
 *  all of them. */
export const PENDING_TTL_MS = 150_000;

/** The minimum an echo entry must carry: when it was staged. */
export interface PendingEntryBase {
	readonly addedAt: number;
}

/**
 * The entries a store should actually show: not yet confirmed by the indexer,
 * and not yet expired.
 *
 * PURE — takes the store's value rather than reading it, so a component can pass
 * `$store` plus its own `nowMs` tick and have this re-evaluate as entries age
 * out. Reading the store here instead would make expiry invisible to Svelte and
 * strand dead entries on screen until some unrelated update happened to
 * re-render.
 */
export function liveEntries<E extends PendingEntryBase>(
	entries: readonly E[],
	keyOf: (entry: E) => string,
	confirmedKeys: ReadonlySet<string>,
	nowMs: number,
	ttlMs: number = PENDING_TTL_MS
): readonly E[] {
	return entries.filter((e) => !confirmedKeys.has(keyOf(e)) && nowMs - e.addedAt < ttlMs);
}

/**
 * Stage `entry`, replacing any existing entry with the same key and pruning
 * anything already expired.
 *
 * PURE — returns a new list. Pruning on write as well as on read is deliberate:
 * without it a long-lived tab accumulates dead entries forever, since a store
 * nobody is currently rendering never runs the read-side filter.
 */
export function upsertEntry<E extends PendingEntryBase>(
	list: readonly E[],
	entry: E,
	keyOf: (entry: E) => string,
	ttlMs: number = PENDING_TTL_MS
): readonly E[] {
	const key = keyOf(entry);
	return [
		...list.filter((e) => keyOf(e) !== key && entry.addedAt - e.addedAt < ttlMs),
		entry
	];
}

/** `account/permlink` — the identity of an order-shaped thing across every echo
 *  store. One definition so two stores can't disagree about what "the same
 *  order" means. */
export function orderEchoKey(o: { account: string; permlink: string }): string {
	return `${o.account}/${o.permlink}`;
}
