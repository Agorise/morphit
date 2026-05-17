<script lang="ts">
	/**
	 * FeaturedBidHistory — shows the current user's recent
	 * featured-slot bid history.  Renders inline above the
	 * FeatureBidForm so the user has context before bidding
	 * again:
	 *
	 *   - "Your last bid: 24h @ 50 BLURT/hr, expired yesterday,
	 *     visible the whole time"
	 *   - "Active: 1h left, currently outranked (paid but not
	 *     visible)"
	 *
	 * Self-fetches /v1/orderbook/featured/bids?account=X on
	 * mount and on a 60s interval.  Renders nothing on empty
	 * (first-time bidder) — no error card, no "you haven't bid
	 * yet" pep talk; just yield space to the bid form.
	 *
	 * Part 122 cp17.
	 */

	import { onMount, onDestroy } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { getFeaturedBidHistory } from '$lib/indexer/client';
	import type { FeaturedBidHistoryEntry } from '@morphit/indexer-client';

	interface Props {
		/** Account to fetch bids for.  Always the current user's
		 *  account; passed in so the component doesn't pull from
		 *  the identity store (lets the parent control it on
		 *  /my/orders impersonation paths). */
		account: string;
		/** Cap the rendered rows — full list is fetched (so
		 *  visibility counts are accurate) but only N are shown.
		 *  Default 5; "Show all" toggles to the full 30. */
		preview?: number;
	}

	let { account, preview = 5 }: Props = $props();

	let bids = $state<readonly FeaturedBidHistoryEntry[]>([]);
	let loaded = $state(false);
	let expanded = $state(false);
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
	});

	const visibleBids = $derived.by((): readonly FeaturedBidHistoryEntry[] => {
		return expanded ? bids : bids.slice(0, preview);
	});

	/** Bucket a bid into one of three display states. */
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
		try {
			return new Date(iso).toLocaleDateString(undefined, {
				month: 'short',
				day: 'numeric'
			});
		} catch {
			return iso.slice(0, 10);
		}
	}
</script>

{#if loaded && bids.length > 0}
	<section class="card mb-3" aria-labelledby="bid-history-heading">
		<div class="mb-2 flex items-center justify-between">
			<h3 id="bid-history-heading" class="font-display text-sm font-bold">
				{$_('feature_bid.history_heading')}
			</h3>
			{#if bids.length > preview}
				<button
					type="button"
					class="text-xs font-semibold text-morphit-emerald hover:underline"
					onclick={() => (expanded = !expanded)}
					aria-expanded={expanded}
				>
					{expanded
						? $_('feature_bid.history_collapse')
						: $_('feature_bid.history_expand', { values: { extra: bids.length - preview } })}
				</button>
			{/if}
		</div>
		<ul class="space-y-1.5">
			{#each visibleBids as b (b.order_permlink + b.effective_at)}
				{@const state = bidState(b)}
				<li
					class="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-ink-100 px-3 py-2 text-sm dark:border-ink-700"
				>
					<div class="min-w-0 flex-1">
						<div class="font-mono text-xs text-ink-500 dark:text-ink-400">
							{b.order_permlink}
						</div>
						<div class="mt-0.5">
							{$_('feature_bid.history_row', {
								values: {
									hours: b.hours_requested,
									blurt: parseFloat(b.blurt_paid).toFixed(3),
									rate: parseFloat(b.blurt_per_hour).toFixed(2),
									start: shortDate(b.effective_at)
								}
							})}
						</div>
					</div>
					<div class="flex items-center gap-1.5">
						{#if b.extension_count > 0}
							<!-- cp18 — flag anti-snipe extensions on a
							     bid.  Operator-visible "your bid got
							     extended N times because someone tried
							     to snipe at the deadline" — context
							     for why expires_at is later than the
							     hours_requested would suggest. -->
							<span
								class="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-bold text-blue-800 dark:bg-blue-900/30 dark:text-blue-200"
								title={$_('feature_bid.history_extended_title', {
									values: { n: b.extension_count }
								}) as string}
							>
								{$_('feature_bid.history_extended', {
									values: { n: b.extension_count }
								})}
							</span>
						{/if}
						<span
							class="rounded-full px-2 py-0.5 text-[11px] font-bold {state === 'visible'
								? 'bg-morphit-emerald/10 text-morphit-emerald'
								: state === 'outranked'
									? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
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
					</div>
				</li>
			{/each}
		</ul>
	</section>
{/if}
