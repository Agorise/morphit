<!--
	TradeRepCluster — "1 trade · ★5.00 (34)" as ONE unbreakable chunk.

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

	const showTrades = $derived(tradeCount > 0);
	const showRating = $derived(ratingCount > 0 && rating !== null);
	const tradesText = $derived(
		$_('orderbook.card.trades_only', {
			values: { count: formatCountCompact(tradeCount) }
		}) as string
	);
</script>

{#if showTrades || showRating}
	<span class="inline-flex flex-none items-center gap-1.5 whitespace-nowrap">
		{#if showTrades}
			<span>{tradesText}</span>
		{/if}
		{#if showTrades && showRating}
			<span aria-hidden="true" class="opacity-50">·</span>
		{/if}
		{#if showRating}
			<RatingChip count={ratingCount} {rating} />
		{/if}
	</span>
{/if}
