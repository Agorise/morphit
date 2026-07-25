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
	import TrustScoreModal from '$components/TrustScoreModal.svelte';

	interface Props {
		/** Number of feedback rows this account has received.
		 *  Zero → chip hidden (caller should check too, but we
		 *  defend). */
		count: number;
		/** Weighted average rating 1-5, or null when count=0. */
		rating: number | null;
	}

	const { count, rating }: Props = $props();

	/** v1.8.14 (Ken) — the chip is now a BUTTON that explains itself.
	 *  The number is a Bayesian-shrunk trust score, not the plain average, and
	 *  nothing on screen said so: Ken had to ask why a profile showing "Average
	 *  rating: 5.00" carried a 4.24 headline. If the person who commissioned the
	 *  system has to ask, every trader will quietly assume the site is
	 *  inconsistent — which is worse than the number being lower.
	 *  The docblock above called this chip "informational, not interactive";
	 *  that is now out of date by design. */
	let explainerOpen = $state(false);

	/** Small-sample threshold. 3+ ratings feels like the
	 *  smallest count where an average starts conveying signal;
	 *  below that the star goes HOLLOW (☆) to flag "take this
	 *  rating with a grain of salt."
	 *
	 *  v1.5.5 (Ken): this used to grey the WHOLE chip out. That's what made
	 *  the reputation star look white next to the emerald ★★★★★ used for
	 *  feedback everywhere else — Ken asked for one green star convention
	 *  sitewide. The chip is now always emerald and the small-sample signal
	 *  moved onto the star's SHAPE, which is strictly better: hollow-vs-solid
	 *  still reads for a colourblind user where emerald-vs-grey may not, and
	 *  it reuses the ★/☆ convention the feedback stars already established. */
	const SAMPLE_CONFIDENCE = 3;

	const muted = $derived(count < SAMPLE_CONFIDENCE);
	// cp123: 2-decimal precision (per Ken's reputation-hardening
	// ask).  Server returns NUMERIC(3,2); displaying `.toFixed(1)`
	// discards information.  4.74 conveys more than 4.7.
	const ratingStr = $derived(rating === null ? '—' : rating.toFixed(2));
</script>

{#if count > 0 && rating !== null}
	<button
		type="button"
		onclick={(e) => {
			// The chip often sits inside a card-wide STRETCHED link (OrderCard's
			// `<a class="absolute inset-0 z-0">`). Opening the explainer there needs
			// BOTH: `relative z-10` on this button (class below) to lift it above
			// that overlay so the click reaches the button at all (v1.8.15, t.txt
			// #1 — Ken: clickable on review cards but not order cards, because the
			// overlay swallowed it), AND stopPropagation so it doesn't also
			// navigate to the order/profile.
			e.preventDefault();
			e.stopPropagation();
			explainerOpen = true;
		}}
		class="rating-chip relative z-10 inline-flex items-center gap-1 rounded-full bg-morphit-emerald/10 px-2 py-0.5 text-xs font-medium text-morphit-emerald ring-1 ring-morphit-emerald/30 hover:bg-morphit-emerald/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald"
		aria-label={$t('orderbook.order.rating_aria', {
			values: { rating: ratingStr, count }
		})}
		title={$t('orderbook.order.rating_tooltip', {
			values: { rating: ratingStr, count }
		})}
	>
		<!-- v1.5.5 (Ken): the star is ALWAYS emerald, and the small-sample signal
	     is carried by its SHAPE — hollow ☆ below 3 ratings, solid ★ at or
	     above. Ken: "make it the green star hollowed-out (the stroke outline
	     only of the star and the center of the star is transparent)."
	     The "white star" he spotted was this chip at count < 3: the whole pill
	     greyed to flag a thin sample, which greyed the star with it and made
	     the reputation star look like a different thing from the emerald
	     ★★★★★ used for feedback everywhere else. Stars are green, sitewide.
	     Shape beats colour here: hollow-vs-solid still reads for a colourblind
	     user, where emerald-vs-grey may not. Same ★/☆ convention the feedback
	     stars already use. -->
	<span aria-hidden="true" class="text-morphit-emerald">{muted ? '☆' : '★'}</span>
		<span aria-hidden="true">{ratingStr}</span>
		<!-- v1.7.5 (t.txt #7) — full opacity.
		     Ken asked for this pill to be "just as bright as the Expires pill", so I
		     measured his screenshot rather than guessing. The pill's tokens ALREADY
		     match it: both peak at #00DA69, both ring at emerald/30 (#0B4F33 vs
		     #0B4F34 on screen), and this chip's background is actually the brighter
		     of the two (/10 vs the Expires pill's /5 — #0D2824 vs #0E1E20 rendered).
		     The one thing genuinely dimmed was this count, at 70%. That's now gone.
		     The hollow ☆ is deliberately untouched: it is Ken's own v1.5.5
		     small-sample signal (<3 ratings), and its thin stroke is most of why the
		     chip reads quieter than a pill full of solid glyphs. -->
		<span aria-hidden="true">({count})</span>
	</button>

	<!-- Rendered next to the chip rather than in a layout-level portal: the
	     backdrop is `fixed inset-0` so stacking context is not an issue, and
	     keeping it here means every surface that shows a chip gets the
	     explanation without wiring anything. -->
	<TrustScoreModal
		score={rating}
		open={explainerOpen}
		onClose={() => (explainerOpen = false)}
	/>
{/if}
