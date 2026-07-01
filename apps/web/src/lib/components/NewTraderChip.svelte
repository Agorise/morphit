<script lang="ts">
	/**
	 * NewTraderChip — shows a 🌱 sprout next to a user's name on the
	 * orderbook when they haven't completed their first trade yet.
	 *
	 * Drives: the `is_new_trader` field from OrderRecord (ADR-0011).
	 *
	 * Design:
	 *   - Small, inline, emerald accent color.
	 *   - Gentle pulse animation — subtle scale bump every 3s so the
	 *     eye catches it but it doesn't distract from the main data.
	 *   - prefers-reduced-motion: chip renders static (still visible,
	 *     just no animation).
	 *   - i18n-friendly: the visible content is just the emoji, and
	 *     the accessible label is translatable.
	 *   - Gets a translatable tooltip so hovering explains "first
	 *     trade not yet completed".
	 *
	 * Usage:
	 *   {#if order.is_new_trader}
	 *     <NewTraderChip />
	 *   {/if}
	 */

	import { t } from '$lib/i18n';

	// No props — the chip is a marker, not a configurable widget.
	// Callers decide whether to render it based on order data.
</script>

<span
	class="new-trader-chip inline-flex items-center gap-1 rounded-full
	       bg-morphit-emerald/10 px-2 py-0.5 text-xs font-medium
	       text-morphit-emerald ring-1 ring-morphit-emerald/30"
	aria-label={$t('orderbook.order.new_trader_aria')}
	title={$t('orderbook.order.new_trader_tooltip')}
>
	<span aria-hidden="true" class="sprout-emoji" role="presentation">🌱</span>
	<span class="sr-only">{$t('orderbook.order.new_trader_aria')}</span>
</span>

<style>
	/* Gentle pulse: 0.95 → 1.05 → 1.0 scale over 3s, infinite. The
	 * bounds keep the chip's bounding box stable-ish — it wobbles
	 * visually without shifting adjacent content. */
	@keyframes new-trader-pulse {
		0%,
		100% {
			transform: scale(1);
			filter: drop-shadow(0 0 0 rgba(0, 218, 105, 0));
		}
		50% {
			transform: scale(1.12);
			filter: drop-shadow(0 0 4px rgba(0, 218, 105, 0.55));
		}
	}

	.new-trader-chip .sprout-emoji {
		display: inline-block;
		animation: new-trader-pulse 3s ease-in-out infinite;
	}

	/* Respect user preference. Static chip still serves the
	 * informational purpose without motion. */
	@media (prefers-reduced-motion: reduce) {
		.new-trader-chip .sprout-emoji {
			animation: none;
		}
	}
</style>
