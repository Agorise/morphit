/**
 * Morphit — FAQ entries about one coin follow THIS site's coins (v1.21.5).
 *
 * The FAQ has an entry (or three) per tradable asset: "What is Litecoin?",
 * "Why does USDT carry a warning?", "Which USDT network should I use?". On a
 * site whose operator switched an asset off (/v1/instance `disabled_assets`),
 * those entries describe a coin that cannot be traded there, so they are left
 * out — from the list, from search, and from other entries' "Related" chips.
 * (BLURT's own entry stays: it explains the chain the site runs on.)
 *
 * PURE — no stores; the FAQ components pass the instance's list.
 */
import { ASSETS } from '$lib/assets/registry';
import { FAQ_KEYS, type FaqEntry, type FaqKey } from '$utils/faqIndex';

/** FAQ key → the display ticker of the one asset it is about. */
export const FAQ_ASSET_OF: ReadonlyMap<FaqKey, string> = (() => {
	const keys = new Set<string>(FAQ_KEYS);
	const out = new Map<FaqKey, string>();
	for (const a of ASSETS) {
		if (a.ticker === 'blurt') continue;
		for (const k of [
			`what_is_${a.ticker}`,
			`why_${a.ticker}_warning`,
			`which_${a.ticker}_network`
		]) {
			if (keys.has(k)) out.set(k as FaqKey, a.displayTicker.toUpperCase());
		}
	}
	return out;
})();

/** True when `key` is about an asset this site does not accept. */
export function faqKeyHidden(key: FaqKey, disabled: readonly string[]): boolean {
	const t = FAQ_ASSET_OF.get(key);
	return t !== undefined && disabled.some((d) => d.toUpperCase() === t);
}

/** The entries to show on this site: per-asset entries for switched-off
 *  assets removed, and removed from every other entry's related list. */
export function visibleFaqEntries(
	entries: readonly FaqEntry[],
	disabled: readonly string[]
): FaqEntry[] {
	if (disabled.length === 0) return [...entries];
	return entries
		.filter((e) => !faqKeyHidden(e.key, disabled))
		.map((e) => {
			const related = e.related.filter((k) => !faqKeyHidden(k, disabled));
			return related.length === e.related.length ? e : { ...e, related };
		});
}
