<script lang="ts">
	/**
	 * FeaturedBidHistory — cp453 (t.txt #2). Was an inline grey section above the
	 * bid form; now a small "View prior Featured orders" LINK (rendered in the
	 * form header, top-right) that opens an ELI5 modal listing ALL of the user's
	 * prior featured orders, newest first. Each row: the order's human summary
	 * line ("I'm buying 40–70 AUD worth of XMR") + its order id in parens, the bid
	 * detail ("6h · 300.000 BLURT @ 50.00/hr · from 8 Jul"), and a status pill.
	 *
	 * Self-fetches /v1/orderbook/featured/bids?account=X on mount + every 60s.
	 * Renders nothing on empty (first-time bidder) — just yields space to the form.
	 */
	import { onMount, onDestroy } from 'svelte';
	import { _, locale } from 'svelte-i18n';
	import { getFeaturedBidHistory } from '$lib/indexer/client';
	import type { FeaturedBidHistoryEntry } from '@morphit/indexer-client';
	import { orderTitleParts } from '$lib/utils/orderTitle';
	import { formatDayMonthShort } from '$lib/i18n/formatters';

	interface Props {
		/** Account to fetch bids for — always the current user's account. */
		account: string;
	}
	let { account }: Props = $props();

	let bids = $state<readonly FeaturedBidHistoryEntry[]>([]);
	let loaded = $state(false);
	let open = $state(false);
	let dialogEl = $state<HTMLDialogElement | undefined>(undefined);
	let abortController: AbortController | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	const POLL_MS = 60 * 1000;

	async function refresh(): Promise<void> {
		abortController?.abort();
		abortController = new AbortController();
		try {
			const result = await getFeaturedBidHistory(account, abortController.signal);
			if (result.ok) bids = result.data.bids;
			loaded = true;
		} catch {
			loaded = true;
		}
	}

	onMount(() => {
		refresh();
		pollTimer = setInterval(refresh, POLL_MS);
	});
	onDestroy(() => {
		abortController?.abort();
		if (pollTimer !== null) clearInterval(pollTimer);
		if (dialogEl?.open) dialogEl.close();
	});

	// Native <dialog>: showModal/close driven by `open` (focus trap + Escape free).
	$effect(() => {
		if (!dialogEl) return;
		if (open && !dialogEl.open) dialogEl.showModal();
		else if (!open && dialogEl.open) dialogEl.close();
	});
	function onDialogClose(): void {
		if (open) open = false;
	}
	function onBackdropClick(e: MouseEvent): void {
		if (e.target === dialogEl) open = false;
	}

	function bidState(
		b: FeaturedBidHistoryEntry
	): 'visible' | 'outranked' | 'expired' | 'order_inactive' {
		const now = Date.now();
		const expires = new Date(b.expires_at).getTime();
		if (b.order_status !== 'live') return 'order_inactive';
		if (expires <= now) return 'expired';
		return b.is_visible ? 'visible' : 'outranked';
	}

	function shortDate(iso: string): string {
		// cp509 (v1.8.4 D) — sitewide date standard: day-first, localized month
		// ("8 Jul", not the old month-first "Jul 8"). formatDayMonthShort is the
		// sanctioned compact form (day + 3-char localized month, UTC); fall back to
		// the ISO date prefix only if it can't parse (shouldn't happen for a real
		// bid timestamp).
		return formatDayMonthShort(iso) || iso.slice(0, 10);
	}

	/** The order's human summary parts ("I'm buying …"), or null when the order
	 *  has since been pruned (its summary fields are absent). */
	function summaryFor(
		b: FeaturedBidHistoryEntry
	): { key: string; values: Record<string, string | number> } | null {
		if (b.order_side === null || b.order_asset === null || b.order_fiat_currency === null) {
			return null;
		}
		return orderTitleParts(
			{
				side: b.order_side,
				asset: b.order_asset,
				fiat_currency: b.order_fiat_currency,
				amount_min: b.order_amount_min,
				amount_max: b.order_amount_max,
				accepted_assets: b.order_accepted_assets,
				payment_methods: b.order_payment_methods
			},
			undefined,
			undefined,
			{ locale: $locale ?? undefined }
		);
	}
</script>

{#if loaded && bids.length > 0}
	<button
		type="button"
		class="shrink-0 whitespace-nowrap text-xs font-semibold text-morphit-emerald hover:underline"
		onclick={() => (open = true)}
	>
		{$_('feature_bid.history_link')}
	</button>

	<dialog
		bind:this={dialogEl}
		onclose={onDialogClose}
		onclick={onBackdropClick}
		class="w-[min(32rem,calc(100vw-2rem))] rounded-2xl bg-white p-0 text-ink-900 shadow-morphit-card-hover backdrop:bg-ink-950/60 backdrop:backdrop-blur-sm dark:bg-ink-900 dark:text-ink-100"
	>
		<div class="p-5">
			<div class="mb-3 flex items-start justify-between gap-3">
				<div>
					<h2 class="font-display text-lg font-bold">{$_('feature_bid.history_heading')}</h2>
					<p class="mt-0.5 text-sm text-ink-600 dark:text-ink-300">
						{$_('feature_bid.history_modal_subtitle')}
					</p>
				</div>
				<button
					type="button"
					onclick={() => (open = false)}
					aria-label={$_('common.close')}
					class="shrink-0 rounded-lg px-2 py-1 text-2xl leading-none text-ink-400 transition hover:text-ink-700 dark:hover:text-ink-200"
				>
					×
				</button>
			</div>
			<ul class="max-h-[60dvh] space-y-2 overflow-y-auto">
				{#each bids as b (b.order_permlink + b.effective_at)}
					{@const state = bidState(b)}
					{@const summary = summaryFor(b)}
					<li
						class="flex flex-wrap items-start justify-between gap-2 rounded-xl border border-ink-200 bg-ink-50/60 px-3 py-2 dark:border-ink-700 dark:bg-ink-800/40"
					>
						<div class="min-w-0 flex-1">
							<p class="text-sm font-medium">
								{#if summary}{$_(summary.key, { values: summary.values })}
								{/if}<span class="font-mono text-xs text-ink-500 dark:text-ink-400"
									>({b.order_permlink})</span
								>
							</p>
							<p class="mt-0.5 text-xs text-ink-600 dark:text-ink-300">
								{$_('feature_bid.history_row', {
									values: {
										hours: b.hours_requested,
										blurt: parseFloat(b.blurt_paid).toFixed(3),
										rate: parseFloat(b.blurt_per_hour).toFixed(2),
										start: shortDate(b.effective_at)
									}
								})}
							</p>
						</div>
						<span
							class="shrink-0 self-center rounded-full px-2 py-0.5 text-[11px] font-bold {state ===
							'visible'
								? 'bg-morphit-emerald/10 text-morphit-emerald'
								: state === 'outranked'
									? 'bg-ink-100 text-ink-800 dark:bg-ink-900/40 dark:text-ink-300'
									: 'bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300'}"
						>
							{state === 'visible'
								? $_('feature_bid.history_state_visible')
								: state === 'outranked'
									? $_('feature_bid.history_state_outranked')
									: state === 'expired'
										? $_('feature_bid.history_state_expired')
										: $_('feature_bid.history_state_order_inactive')}
						</span>
					</li>
				{/each}
			</ul>
		</div>
	</dialog>
{/if}
