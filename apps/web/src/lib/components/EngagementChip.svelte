<script lang="ts">
	/**
	 * EngagementChip — shows "💬 N" next to an order row when other
	 * users are actively asking the seller about THIS order in the
	 * last 24h.  Reasoned through in the Part-13/Q11 work as the
	 * right answer to "what if two people try to take the same
	 * trade at the same time": NOT a lock (orders are negotiations
	 * — parallel inquiries are healthy), but a real-time signal so
	 * a viewer who's about to message knows they're not the only
	 * one in line.
	 *
	 * Drives: the `engagement_24h` field from OrderRecord (Q11
	 * orderbook signal, schema-v25).
	 *
	 * Privacy: aggregate-only.  No counterparty identities
	 * exposed.  Anyone scraping Blurt can already derive this
	 * from public chat ops + the plaintext order_permlink field
	 * Q11 plumbed.
	 *
	 * Design:
	 *   - Small, inline, amber accent (different from emerald
	 *     "new trader" so the two chips don't look identical).
	 *   - Subtle pulse animation when count >= 2 (the "competition
	 *     is real" tier).  prefers-reduced-motion suppresses.
	 *   - Suppressed entirely when count is 0 — caller should
	 *     check `count > 0` before rendering.  Suppressing inside
	 *     the component too would mask render bugs.
	 *
	 * Usage:
	 *   {#if (o.engagement_24h ?? 0) > 0}
	 *     <EngagementChip count={o.engagement_24h ?? 0} />
	 *   {/if}
	 *
	 * Why an explicit `count > 0` check at the call site rather
	 * than a `display: none` here: when the indexer is older than
	 * v25 (no engagement_24h field), we want to render NOTHING
	 * rather than "💬 0" — the caller's `?? 0` collapses the
	 * undefined-vs-zero distinction; we treat both as "do not
	 * render" by virtue of the `> 0` gate.
	 */

	import { _ } from 'svelte-i18n';

	interface Props {
		/** Distinct accounts who've messaged the seller about
		 *  this order in the last 24h.  Always > 0 by the
		 *  caller's contract; rendering 0 is a caller bug. */
		count: number;
	}
	let { count }: Props = $props();
</script>

<span
	class="engagement-chip inline-flex items-center gap-1 rounded-full
	       bg-amber-500/10 px-2 py-0.5 text-xs font-medium
	       text-amber-700 ring-1 ring-amber-500/30
	       dark:text-amber-300 dark:ring-amber-400/30"
	class:pulse={count >= 2}
	aria-label={$_('orderbook.order.engagement_aria', { values: { count } }) as string}
	title={$_('orderbook.order.engagement_tooltip', { values: { count } }) as string}
>
	<span aria-hidden="true">💬</span>
	<span>{count}</span>
</span>

<style>
	.engagement-chip {
		/* Counter widths shouldn't shift between 1-digit and
		   2-digit values — tabular-nums keeps the column tidy. */
		font-variant-numeric: tabular-nums;
	}
	.pulse {
		animation: engagement-pulse 2.4s ease-in-out infinite;
	}
	@keyframes engagement-pulse {
		0%,
		100% {
			transform: scale(1);
		}
		50% {
			transform: scale(1.06);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.pulse {
			animation: none;
		}
	}
</style>
