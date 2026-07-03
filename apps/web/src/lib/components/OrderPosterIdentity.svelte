<script lang="ts">
	/**
	 * OrderPosterIdentity — the poster identity + reputation row shown on an
	 * order. Extracted from OrderCard (cp406, Ken) so the order DETAIL page's
	 * "POSTED BY" card renders the EXACT same layout as the orderbook cards:
	 * avatar, then display name · new-trader chip · ⭐ reputation, then the
	 * truncated posting key · trade-count line. The trade specifics (side,
	 * asset, range, fiat, payment methods, terms, location, timing) live in the
	 * DETAILS card below on the detail page, so they are intentionally NOT here.
	 *
	 * All fields derive from the OrderRecord, so both call sites (OrderCard and
	 * the detail page — both fed by getOrdersByAccount) produce identical
	 * output.
	 */
	import { _ } from 'svelte-i18n';
	import type { OrderRecord } from '@morphit/indexer-client';
	import IdentityLabel from '$lib/components/IdentityLabel.svelte';
	import NewTraderChip from '$lib/components/NewTraderChip.svelte';
	import { truncatePublicKey } from '$lib/crypto/publicKeyDisplay';
	import { formatCountCompact, formatMonthYear } from '$lib/i18n/formatters';

	interface Props {
		order: OrderRecord;
		/** Resolved display name (null → the @handle is shown instead). */
		displayName?: string | null;
		avatarSvg?: string | null;
		avatarDataUri?: string | null;
		/** Locale-aware href to the poster's profile. */
		profileHref: string;
		/** Optional posting key to show instead of order.posting_pubkey. The
		 *  order detail page fetches a fresh /keys value; the orderbook card
		 *  uses the record's own field. Both are truncated identically, so the
		 *  layout is unchanged either way. */
		postingKeyOverride?: string | null;
	}

	let {
		order,
		displayName = null,
		avatarSvg = null,
		avatarDataUri = null,
		profileHref,
		postingKeyOverride = null
	}: Props = $props();

	const handle = $derived('@' + order.account);
	const count = $derived(order.feedback_count ?? 0);
	const score = $derived(order.reputation_score ?? null);
	const postingKey = $derived(truncatePublicKey(postingKeyOverride ?? order.posting_pubkey ?? ''));

	// "852 trades since July, 2026" — count always shown (0 when none); the
	// "since {month}" tail only when a first trade exists.
	const tradesLine = $derived.by(() => {
		const c = formatCountCompact(count);
		return order.first_trade_at
			? ($_('orderbook.card.trades_since', {
					values: { count: c, month: formatMonthYear(order.first_trade_at) }
				}) as string)
			: ($_('orderbook.card.trades_only', { values: { count: c } }) as string);
	});
</script>

<!-- Identity row: avatar tucks up under the title; name + key beside. -->
<div class="flex items-start gap-3">
	<div class="relative z-0 flex-none">
		<IdentityLabel account={order.account} {avatarSvg} {avatarDataUri} avatarSize={52} hideHandle />
	</div>
	<div class="min-w-0 flex-1 pt-1">
		<!-- Line 1: display name · new-trader · reputation score -->
		<div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
			<a
				href={profileHref}
				class="relative z-10 truncate font-bold text-ink-900 hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:text-white"
			>
				{displayName || handle}
			</a>
			{#if order.is_new_trader}
				<NewTraderChip />
			{/if}
			{#if score !== null}
				<span
					class="inline-flex items-center gap-1 text-sm font-semibold text-morphit-emerald"
					aria-label={$_('orderbook.card.reputation_aria', {
						values: { score: score.toFixed(2) }
					}) as string}
					title={$_('orderbook.card.reputation_aria', {
						values: { score: score.toFixed(2) }
					}) as string}
				>
					<span aria-hidden="true">⭐</span>
					<span aria-hidden="true">{score.toFixed(2)}</span>
				</span>
			{/if}
		</div>
		<!-- Line 2: truncated posting key · trade count since {month} -->
		<div
			class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-500 dark:text-ink-400"
		>
			{#if postingKey}
				<span class="font-mono">({postingKey})</span>
			{/if}
			<span>{tradesLine}</span>
		</div>
	</div>
</div>
