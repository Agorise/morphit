<script lang="ts">
	/**
	 * FeaturedOrders — renders up to 5 featured slots.
	 *
	 * Self-fetches /v1/orderbook/featured on mount and on a 60s
	 * interval. 60s matches the backend's cache-control: asking
	 * more often is wasted, asking less often lets expired slots
	 * linger visibly past deadline. If the fetch fails the
	 * component renders nothing — featured slots are advertising,
	 * not a primary navigation surface, and a broken request
	 * shouldn't leave an error empty-state on the homepage.
	 *
	 * Variant prop controls layout density:
	 *   - 'grid'  — 5-across on desktop, stacked on mobile. Home.
	 *   - 'stack' — always stacked 1-per-row. Above the
	 *     orderbook list so it matches the regular-order cards.
	 */

	import { onMount, onDestroy } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { getFeaturedOrderbook } from '$lib/indexer/client';
	import { getProfilesBatch } from '$lib/indexer/profileCache';
	import { extractLabelPropsFromProfile } from '$lib/indexer/profileProps';
	import type { FeaturedSlot, ProfileResponse } from '@morphit/indexer-client';
	import IdentityLabel from '$components/IdentityLabel.svelte';
	import NewTraderChip from '$components/NewTraderChip.svelte';

	interface Props {
		variant?: 'grid' | 'stack';
		/** If false, the component renders nothing when empty. If
		 *  true, renders a muted "no featured orders yet" stub —
		 *  useful on the orderbook page where an empty featured
		 *  section still wants to educate about the feature. */
		showEmptyState?: boolean;
	}

	let { variant = 'grid', showEmptyState = false }: Props = $props();

	let slots = $state<readonly FeaturedSlot[]>([]);
	let loaded = $state(false);
	let abortController: AbortController | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	/** Profile data for featured slots' posters. Populated after
	 *  each refresh; up to 5 entries. Missing keys fall through to
	 *  identicons in IdentityLabel. */
	let profileMap = $state<Record<string, ProfileResponse | null>>({});

	async function hydrateProfiles(
		featuredSlots: readonly FeaturedSlot[],
		signal?: AbortSignal
	): Promise<void> {
		const accounts = Array.from(new Set(featuredSlots.map((s) => s.order.account)));
		if (accounts.length === 0) return;
		const fetched = await getProfilesBatch(accounts, signal);
		if (signal?.aborted) return;
		const next = { ...profileMap };
		for (const [account, profile] of fetched) {
			next[account] = profile;
		}
		profileMap = next;
	}

	async function refresh(): Promise<void> {
		abortController?.abort();
		abortController = new AbortController();
		const result = await getFeaturedOrderbook(abortController.signal);
		if (result.ok) {
			slots = result.data.featured;
			// Kick off profile hydration — non-blocking. 90s cache TTL
			// means the 60s refresh cycle usually hits cache for the
			// same accounts.
			void hydrateProfiles(result.data.featured, abortController.signal);
		}
		loaded = true;
	}

	onMount(() => {
		void refresh();
		pollTimer = setInterval(() => void refresh(), 60_000);
	});

	onDestroy(() => {
		abortController?.abort();
		if (pollTimer !== null) clearInterval(pollTimer);
	});

	function formatAmountRange(o: FeaturedSlot['order']): string {
		const min = o.amount_min;
		const max = o.amount_max;
		const cur = o.fiat_currency;
		if (min !== null && max !== null && min !== max) return `${min}–${max} ${cur}`;
		if (min !== null) return `≥ ${min} ${cur}`;
		if (max !== null) return `≤ ${max} ${cur}`;
		return cur;
	}
</script>

{#if loaded && slots.length > 0}
	<section aria-labelledby="featured-heading" class="space-y-3">
		<div class="flex items-center gap-2">
			<h2
				id="featured-heading"
				class="font-display text-sm font-bold uppercase tracking-widest text-ink-500 dark:text-ink-400"
			>
				{$_('featured.heading')}
			</h2>
			<span
				class="rounded-full bg-morphit-emerald/20 px-2 py-0.5 text-xs font-bold text-morphit-emerald"
			>
				{slots.length}/5
			</span>
		</div>

		<ul
			class={variant === 'grid'
				? 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5'
				: 'space-y-3'}
		>
			{#each slots as slot (slot.order.account + '/' + slot.order.permlink)}
				{@const o = slot.order}
				{@const labelProps = extractLabelPropsFromProfile(profileMap[o.account])}
				<li
					class="relative overflow-hidden rounded-2xl border-2 border-morphit-emerald/30 bg-gradient-to-br from-morphit-emerald/5 to-morphit-teal/5 p-4 transition hover:border-morphit-emerald/60 dark:border-morphit-emerald/40"
				>
					<!-- Featured badge: top-right corner, always visible -->
					<div
						class="absolute right-0 top-0 rounded-bl-xl bg-gradient-to-r from-morphit-emerald to-morphit-teal px-3 py-1 text-xs font-bold text-ink-950"
					>
						⭐ {$_('featured.badge')}
					</div>

					<div class="mt-4">
						<div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
							<span class="font-display text-base font-bold">
								{o.side === 'buy'
									? $_('orderbook.order.buying', { values: { asset: o.asset } })
									: $_('orderbook.order.selling', { values: { asset: o.asset } })}
							</span>
							<span class="text-xs text-ink-600 dark:text-ink-300">
								{formatAmountRange(o)}
							</span>
						</div>
						<div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
							<IdentityLabel
								account={o.account}
								displayName={labelProps.displayName}
								avatarSvg={labelProps.avatarSvg}
								avatarDataUri={labelProps.avatarDataUri}
								nostrUrl={labelProps.nostrUrl}
								blurtMediaUrl={labelProps.blurtMediaUrl}
								href={`/@${o.account}`}
							/>
							{#if o.is_new_trader}
								<NewTraderChip />
							{/if}
						</div>
						{#if o.location_region}
							<p class="mt-1 truncate text-xs text-ink-500 dark:text-ink-400">
								{o.location_region}
							</p>
						{/if}
						{#if o.payment_methods.length > 0}
							<p class="mt-1 truncate text-xs text-ink-500 dark:text-ink-400">
								{o.payment_methods.slice(0, 2).join(', ')}
								{#if o.payment_methods.length > 2}…{/if}
							</p>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	</section>
{:else if loaded && showEmptyState}
	<section
		class="rounded-2xl border border-dashed border-ink-300 p-4 text-center text-sm text-ink-500 dark:border-ink-700"
	>
		{$_('featured.empty_state')}
	</section>
{/if}
