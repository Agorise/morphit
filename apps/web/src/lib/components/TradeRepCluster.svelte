<!--
	TradeRepCluster — "★5.00 (34) · 1 trade" as ONE unbreakable chunk.

	v1.7.5 (t.txt #6 + #7): the rating pill now comes FIRST and the trade count
	sits to its right at text-xs, matching the pill. The count is ICU-pluralised
	("1 trade" / "5 trades"), and zero trades still renders nothing at all.

	v1.5.5 (t155). Two changes ride in this component:

	  1. TRADES AND RATINGS ARE DIFFERENT NUMBERS NOW. Ken: "if an order was
	     marked as completed (not canceled or expired), then imo that counts as
	     1 completed trade even if no stars were left." So the trade count comes
	     from COMPLETED ORDERS (both sides credited), while the star average and
	     its "(34)" still come from RATINGS. Fusing them would make the chip
	     lie — "★5.00 (34)" has to mean 34 ratings back that 5.00, not 34
	     trades.

	  2. IT MUST NEVER BREAK. Ken: "that chunk looks ok on mobile and none of
	     that chunk ever gets broken, no wrap. it stays together as a chunk of
	     text or else it must go onto its own line, or at the end of another
	     line if it fits more nicely there. i like user identities and
	     ordercards to be nice and tight, on mobile and pc."

	     So: the whole cluster is ONE inline-flex with `whitespace-nowrap` and
	     `flex-none` — it cannot break internally, and it cannot be squeezed by
	     a long display name beside it. Put it in a `flex-wrap` parent and it
	     either sits at the end of the line or drops WHOLE onto the next one.
	     Never do `flex-1`/`min-w-0` on it or a narrow phone will shrink and
	     ellipsis it, which is exactly the mid-chunk break Ken doesn't want.

	Renders nothing at all when there is neither a trade nor a rating, so a
	brand-new account's identity row stays tight instead of carrying "0 trades".
-->
<script lang="ts">
	import { _ } from 'svelte-i18n';
	import RatingChip from '$components/RatingChip.svelte';
	import { formatCountCompact } from '$lib/i18n/formatters';

	interface Props {
		/** Completed trades (from completed ORDERS, not reviews). */
		tradeCount: number;
		/** Weighted average rating, or null when there are no ratings. */
		rating?: number | null;
		/** How many RATINGS back `rating` — never the trade count. */
		ratingCount?: number;
	}

	let { tradeCount, rating = null, ratingCount = 0 }: Props = $props();

	/** t.txt #6 rule 1: zero trades shows NOTHING — not "0 trades". Already the
	 *  behaviour since v1.5.5; pinned by a test so it stays. */
	const showTrades = $derived(tradeCount > 0);
	const showRating = $derived(ratingCount > 0 && rating !== null);
	/** t.txt #6 rules 2+3: "1 trade" singular, "5 trades" plural.
	 *
	 *  TWO values, deliberately. `n` is the RAW count and drives ICU plural
	 *  selection; `count` is the display string, which `formatCountCompact` may
	 *  have turned into "1.2K" — and a string can never match a plural rule, so
	 *  passing only the compacted value would silently pin every locale to
	 *  `other` and reintroduce "1 trades".
	 *
	 *  Doing this in ICU rather than a JS `=== 1` ternary matters beyond English:
	 *  Polish and Russian have FOUR forms (1 / 2-4 / 5-21 / fractions), so
	 *  "singular vs plural" isn't a distinction those languages actually make.
	 *  The locale file states each language's own rules. */
	const tradesText = $derived(
		$_('orderbook.card.trades_only', {
			values: { n: tradeCount, count: formatCountCompact(tradeCount) }
		}) as string
	);
</script>

{#if showTrades || showRating}
	<span class="inline-flex flex-none items-center gap-1.5 whitespace-nowrap">
		<!-- v1.7.5 (t.txt #7) — RATING FIRST, then the trade count.
		     Ken: "put that text to the right of the reputation pill, not to the
		     left of it. just reverse their order. this way, the reputation pill
		     will appear first right after the new-trader pill (or the display name
		     if the new-trader pill does not appear)."
		     The chunk stays ONE unbreakable inline-flex (see the header) — only the
		     internal order changed, so it still sits at the end of the name line or
		     drops WHOLE onto the next. -->
		{#if showRating}
			<RatingChip count={ratingCount} {rating} />
		{/if}
		{#if showTrades && showRating}
			<span aria-hidden="true" class="opacity-50">·</span>
		{/if}
		{#if showTrades}
			<!-- v1.7.5 (t.txt #7) — text-xs, matching the rating pill beside it.
			     This span had no size of its own, so it inherited the card's larger
			     body text and read a size bigger than the pill it sits against. -->
			<span class="text-xs">{tradesText}</span>
		{/if}
	</span>
{/if}
