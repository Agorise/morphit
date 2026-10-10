/**
 * The instance's switched-off assets (/v1/instance `disabled_assets`), as a
 * store with no dependencies of its own (v1.21.5). $stores/instance feeds it;
 * the i18n loader (coin tokens in copy, ./coinTokens.ts) reads it. Kept apart
 * from $stores/instance so the i18n module needs nothing that needs i18n.
 */
import { writable, type Readable } from 'svelte/store';

const store = writable<readonly string[]>([]);

/** Upper-case tickers this site does not accept; empty until /v1/instance
 *  answers (and on a site that accepts every coin). */
export const disabledAssets: Readable<readonly string[]> = { subscribe: store.subscribe };

/** Called by $stores/instance whenever its value changes. Ignores a value
 *  equal to the current one, so subscribers re-render only on a real change. */
export function setDisabledAssets(list: readonly string[]): void {
	const next = list.map((t) => t.toUpperCase()).sort();
	store.update((cur) =>
		cur.length === next.length && cur.every((t, i) => t === next[i]) ? cur : next
	);
}
