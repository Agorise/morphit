<script lang="ts">
	/**
	 * RelativeTime — render an ISO timestamp as a localized relative
	 * time string ("5 min ago" / "2h" / "3 days ago").
	 *
	 * Why one component instead of four inline `formatRelativeTime`
	 * functions: prior to Part 89 there were four near-identical
	 * impls scattered across `/my/orders`, `/orderbook`, `/@account`
	 * profile, and `/chat`. Three were terse ("2h"), one was
	 * descriptive ("2 hours ago"). Consolidating them gives:
	 *
	 *   - Native `<time datetime>` for free a11y and machine-
	 *     readability.
	 *   - Free `title` tooltip with the absolute time, so a user
	 *     hovering "2h" learns the exact instant. (Memory #15:
	 *     grandma-friendliness without sacrificing density.)
	 *   - Auto-tick: re-render once per minute (descriptive) or
	 *     once per minute capped at hour boundaries (terse), so a
	 *     long-mounted page doesn't show a frozen "just now" for
	 *     a message that arrived ten minutes ago.
	 *   - NaN-safe: a malformed ISO renders the localized
	 *     "earlier" fallback instead of "NaN min ago".
	 *
	 * Two formats:
	 *
	 *   - `terse` (default): "<1m" / "5m" / "2h" / "3d" / "4mo" / "2y".
	 *     For data-table chips and activity rows where horizontal
	 *     space is precious.
	 *
	 *   - `descriptive`: "just now" / "5 min ago" / "2h ago" /
	 *     "3 days ago". For chat inbox where the timestamp is the
	 *     primary indicator of recency.
	 *
	 * Both formats share the same locale namespace
	 * (`relative_time.descriptive` / `relative_time.terse`) so that
	 * a single translator pass keeps both in sync per locale.
	 *
	 * Notes:
	 *
	 *   - Tooltip uses the native HTML `title` attribute rather
	 *     than a Svelte Tooltip wrapper. Native title works
	 *     consistently across desktop (hover) and respects the
	 *     user's accessibility settings without adding DOM weight
	 *     or pointer-event overhead.
	 *   - The component intentionally does NOT memoize across
	 *     props changes — the parent owns the iso prop, and Svelte
	 *     5's runes-based reactivity handles re-render efficiency.
	 */
	import { onDestroy } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { formatDayMonthTime } from '$i18n/formatters';

	interface Props {
		/** ISO 8601 timestamp string. */
		iso: string;
		/**
		 * Display style. `terse` for inline chips, `descriptive`
		 * for chat / primary timestamps.
		 */
		format?: 'terse' | 'descriptive';
		/** Optional extra CSS classes for the rendered <time>. */
		class?: string;
	}

	let { iso, format = 'terse', class: cls = '' }: Props = $props();

	// Tick once per minute so a long-mounted view stays current.
	// Below the minute mark the change rate doesn't matter (terse
	// renders "<1m" or "{n}m"; descriptive renders "just now" then
	// "1 min ago"); above the minute mark a 60-second cadence is
	// the natural granularity.
	let now = $state(Date.now());
	const tickerId = setInterval(() => {
		now = Date.now();
	}, 60_000);
	onDestroy(() => clearInterval(tickerId));

	const then = $derived(new Date(iso).getTime());
	const valid = $derived(Number.isFinite(then));

	// Absolute display for the title tooltip — the project's
	// canonical translated day-month-year-time format.
	const absTitle = $derived.by(() => {
		if (!valid) return '';
		return formatDayMonthTime(iso);
	});

	const label = $derived.by(() => {
		if (!valid) {
			return $_(`relative_time.${format}.unknown`) as string;
		}
		const seconds = Math.max(0, Math.floor((now - then) / 1000));
		if (format === 'terse') {
			if (seconds < 60) return $_('relative_time.terse.lt1m') as string;
			const minutes = Math.floor(seconds / 60);
			if (minutes < 60)
				return $_('relative_time.terse.minutes', { values: { n: minutes } }) as string;
			const hours = Math.floor(minutes / 60);
			if (hours < 24)
				return $_('relative_time.terse.hours', { values: { n: hours } }) as string;
			const days = Math.floor(hours / 24);
			if (days < 30)
				return $_('relative_time.terse.days', { values: { n: days } }) as string;
			const months = Math.floor(days / 30);
			if (months < 12)
				return $_('relative_time.terse.months', { values: { n: months } }) as string;
			const years = Math.floor(months / 12);
			return $_('relative_time.terse.years', { values: { n: years } }) as string;
		}
		// descriptive
		if (seconds < 60) return $_('relative_time.descriptive.just_now') as string;
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60)
			return $_('relative_time.descriptive.minutes', { values: { n: minutes } }) as string;
		const hours = Math.floor(minutes / 60);
		if (hours < 24)
			return $_('relative_time.descriptive.hours', { values: { n: hours } }) as string;
		const days = Math.floor(hours / 24);
		if (days < 30)
			return $_('relative_time.descriptive.days', { values: { n: days } }) as string;
		const months = Math.floor(days / 30);
		if (months < 12)
			return $_('relative_time.descriptive.months', { values: { n: months } }) as string;
		const years = Math.floor(months / 12);
		return $_('relative_time.descriptive.years', { values: { n: years } }) as string;
	});
</script>

<time datetime={iso} title={absTitle} class={cls}>{label}</time>
