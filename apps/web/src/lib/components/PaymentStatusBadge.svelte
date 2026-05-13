<script lang="ts">
	/**
	 * PaymentStatusBadge — reactive trade-phase indicator for an
	 * order row.
	 *
	 * Phase F.5.  Subscribes to the tradeStatus store by permlink
	 * and renders a colored badge matching the current trade
	 * phase.  Auto-updates the moment any payload landing
	 * anywhere in the app advances the trade — chat, /my/orders,
	 * /orderbook, all see the same source of truth.
	 *
	 * Renders nothing when no trade entry exists for this
	 * permlink — keeps the rows clean for orders without trade
	 * activity yet.
	 *
	 * Forward-compat: phases the user's protocol version doesn't
	 * recognize render as a generic "trade in progress" rather
	 * than crashing.
	 */

	import { _ } from 'svelte-i18n';
	import { tradeStates } from '$lib/trades/tradeStatus';

	interface Props {
		orderPermlink: string;
	}

	let { orderPermlink }: Props = $props();

	// Phase F.5 audit fix (F-39) — read from the shared map
	// directly rather than allocating a per-permlink derived store.
	// One subscription on the underlying map, no per-instance
	// derived store overhead at scale.
	const state = $derived($tradeStates.get(orderPermlink) ?? null);
</script>

{#if state !== null}
	{#if state.phase === 'address_shared'}
		<span
			class="inline-flex items-center gap-1 rounded-full border border-blue-300 bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-900 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-100"
		>
			{$_('trade_status.address_shared')}
		</span>
	{:else if state.phase === 'paid'}
		<span
			class="inline-flex items-center gap-1 rounded-full border border-blue-400 bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-900 dark:border-blue-600 dark:bg-blue-950 dark:text-blue-100"
		>
			<span aria-hidden="true">⏳</span>
			{$_('trade_status.payment_pending')}
		</span>
	{:else if state.phase === 'paid_verified'}
		<span
			class="inline-flex items-center gap-1 rounded-full border border-emerald-400 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-900 dark:border-emerald-600 dark:bg-emerald-950 dark:text-emerald-100"
		>
			<span aria-hidden="true">✓</span>
			{$_('trade_status.paid')}
		</span>
	{:else if state.phase === 'paid_mismatch'}
		<span
			class="inline-flex items-center gap-1 rounded-full border border-amber-400 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-900 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-100"
		>
			<span aria-hidden="true">⚠</span>
			{$_('trade_status.payment_mismatch')}
		</span>
	{:else if state.phase === 'paid_unverifiable'}
		<span
			class="inline-flex items-center gap-1 rounded-full border border-ink-300 bg-ink-50 px-2 py-0.5 text-xs font-semibold text-ink-600 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-300"
		>
			{$_('trade_status.payment_unverifiable')}
		</span>
	{:else if state.phase === 'released'}
		<span
			class="inline-flex items-center gap-1 rounded-full border border-emerald-400 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-900 dark:border-emerald-600 dark:bg-emerald-950 dark:text-emerald-100"
		>
			<span aria-hidden="true">✓</span>
			{$_('trade_status.released')}
		</span>
	{:else if state.phase === 'disputed'}
		<span
			class="inline-flex items-center gap-1 rounded-full border border-red-400 bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-900 dark:border-red-600 dark:bg-red-950 dark:text-red-100"
		>
			<span aria-hidden="true">⚠</span>
			{$_('trade_status.disputed')}
		</span>
	{:else if state.phase === 'completed'}
		<span
			class="inline-flex items-center gap-1 rounded-full border border-emerald-400 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-900 dark:border-emerald-600 dark:bg-emerald-950 dark:text-emerald-100"
		>
			<span aria-hidden="true">✓</span>
			{$_('trade_status.completed')}
		</span>
	{:else}
		<!-- Forward-compat: unknown phase -->
		<span
			class="inline-flex items-center gap-1 rounded-full border border-ink-300 bg-ink-50 px-2 py-0.5 text-xs font-semibold text-ink-600 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-300"
		>
			{$_('trade_status.in_progress')}
		</span>
	{/if}
{/if}
