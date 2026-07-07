<script lang="ts">
	/**
	 * RatingChip — inline reputation badge next to a trader name
	 * on orderbook rows.
	 *
	 * Renders "★ 4.8 (23)" in an emerald pill when the trader has
	 * received 3+ reviews. For 1-2 reviews the chip renders in a
	 * muted grey — same shape and data, but a weaker visual
	 * signal, because a single 5-star review tells you almost
	 * nothing on its own. The sample-size cue is there to nudge
	 * the reader toward interpretation rather than take-at-face-
	 * value.
	 *
	 * Not rendered at all when count is 0 — the NewTraderChip
	 * (🌱) covers that case. The two chips are mutually
	 * exclusive on a given row: sprout shows for feedback_count <
	 * 4, rating shows for feedback_count > 0 (so they overlap on
	 * 1-3 reviews, which is correct — a new trader WITH some
	 * feedback gets both chips, which is what you want for
	 * "young but has a track record").
	 *
	 * Accessibility:
	 *   - The visible text is a rating + count — locale-agnostic
	 *     number shape. The aria-label gets localized phrasing.
	 *   - The chip itself is a span, not a button. Clicking a
	 *     trader's NAME goes to their profile; the chip is
	 *     informational, not interactive.
	 */

	import { t } from '$lib/i18n';

	interface Props {
		/** Number of feedback rows this account has received.
		 *  Zero → chip hidden (caller should check too, but we
		 *  defend). */
		count: number;
		/** Weighted average rating 1-5, or null when count=0. */
		rating: number | null;
	}

	const { count, rating }: Props = $props();

	/** Small-sample threshold. 3+ reviews feels like the
	 *  smallest count where an average starts conveying signal;
	 *  fewer than that we show the same data in a muted color
	 *  to flag "take this rating with a grain of salt." */
	const SAMPLE_CONFIDENCE = 3;

	const muted = $derived(count < SAMPLE_CONFIDENCE);
	// cp123: 2-decimal precision (per Ken's reputation-hardening
	// ask).  Server returns NUMERIC(3,2); displaying `.toFixed(1)`
	// discards information.  4.74 conveys more than 4.7.
	const ratingStr = $derived(rating === null ? '—' : rating.toFixed(2));
</script>

{#if count > 0 && rating !== null}
	<span
		class="rating-chip inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 {muted
			? 'bg-ink-500/10 text-ink-500 ring-ink-500/30 dark:bg-ink-300/10 dark:text-ink-300 dark:ring-ink-300/30'
			: 'bg-morphit-emerald/10 text-morphit-emerald ring-morphit-emerald/30'}"
		aria-label={$t('orderbook.order.rating_aria', {
			values: { rating: ratingStr, count }
		})}
		title={$t('orderbook.order.rating_tooltip', {
			values: { rating: ratingStr, count }
		})}
	>
		<span aria-hidden="true">★</span>
		<span aria-hidden="true">{ratingStr}</span>
		<span aria-hidden="true" class="opacity-70">({count})</span>
	</span>
{/if}
