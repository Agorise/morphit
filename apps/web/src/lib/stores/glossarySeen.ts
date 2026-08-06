/**
 * Per-route first-appearance tracker for `<Term>` glossary
 * tooltips.
 *
 * Why this needs to be a store rather than per-component
 * state: a `<Term key="fiat">` instance can't coordinate with
 * a sibling `<Term key="fiat">` further down the same page
 * — they're independent component instances.  But a grandma
 * doesn't need every occurrence of "fiat" underlined; the
 * design is "underline the FIRST appearance per page, plain
 * text after that."  So the components share a Set keyed by
 * glossary term, scoped by the current route pathname, reset
 * on navigation.
 *
 * SvelteKit re-runs page-level setup on navigation so the
 * `$effect` in the layout that calls `resetForRoute(...)`
 * fires automatically; components don't need to subscribe to
 * `$page` themselves.
 *
 * The tracker is intentionally per-PATHNAME, not per-TAB or
 * per-SESSION:
 *   - Per-tab would mean a user who opens /post in a new tab
 *     after reading /faq would see no glossary cues, which
 *     defeats the "first appearance per page" goal.
 *   - Per-session would mean once the user has hovered "fiat"
 *     anywhere, it's never highlighted again — also wrong;
 *     we want the cue to surface again on a new page where
 *     the term might come up in a new context.
 *
 * The tracker has no eviction logic.  In practice the set
 * grows only with the number of glossary terms used per
 * page (max ~20), and resets fully on every route change.
 */

import { writable, get } from 'svelte/store';

interface State {
	/** The route pathname that owns the current `seen` set. */
	readonly pathname: string;
	/** Glossary keys already rendered on this route. */
	readonly seen: Set<string>;
}

const _state = writable<State>({ pathname: '', seen: new Set() });

/**
 * Mark a glossary key as seen on the given route.  Returns
 * true if THIS call was the first one (caller should render
 * the tooltip-enabled UI), false if a prior call has already
 * registered the key (caller should render plain text).
 *
 * Idempotent in the false direction — a second call with the
 * same key returns false without mutating state.
 */
export function markSeen(pathname: string, key: string): boolean {
	const cur = get(_state);
	if (cur.pathname !== pathname) {
		// Route changed without a resetForRoute() call — happens
		// in unit tests where the layout's `$effect` doesn't run.
		// Be defensive: clear the set and start fresh.
		const seen = new Set<string>([key]);
		_state.set({ pathname, seen });
		return true;
	}
	if (cur.seen.has(key)) {
		return false;
	}
	cur.seen.add(key);
	// Mutating the same Set is fine here because we're not
	// using $state-rune reactivity on the contents — consumers
	// only read the boolean return value.
	return true;
}

/**
 * Reset the seen-set for a new route.  Called from the
 * top-level layout's `$effect` when `$page.url.pathname`
 * changes.  Idempotent for repeated calls with the same
 * pathname.
 */
export function resetForRoute(pathname: string): void {
	const cur = get(_state);
	if (cur.pathname === pathname) return;
	_state.set({ pathname, seen: new Set() });
}
