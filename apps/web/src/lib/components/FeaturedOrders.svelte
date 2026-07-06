<script lang="ts">
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { page } from '$app/stores';

	// cp242 — per-locale internal-link wrapper (cp7 design: every
	// internal link is locale-prefixed; bare 2-segment paths 404).
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
	/**
	 * FeaturedOrders — renders the live featured slots (up to max_slots, cap 3).
	 *
	 * cp428 — each slot now renders through the SHARED OrderCard (with its
	 * `featured` frame), so a featured order reads exactly like every other
	 * orderbook card (same layout on PC + mobile) — title, poster identity,
	 * pay/accept line, terms preview, expiry pill, price model — plus the
	 * emerald border + "🎉 Featured" badge. Previously it was a bespoke 4-line
	 * card that looked nothing like the orderbook.
	 *
	 * Self-fetches /v1/orderbook/featured on mount and on a 30s interval (matches
	 * the backend cache TTL — asking more often is wasted, less often lets
	 * expired slots linger). If the fetch fails the component renders nothing —
	 * featured slots are advertising, not primary navigation, and a broken
	 * request shouldn't leave an error state on the page.
	 *
	 * Layout:
	 *   - variant='grid'   — responsive grid (home showcase).
	 *   - variant='stack'  — one card per row (orderbook, matches the list).
	 *   - embedded=true    — render ONLY the <ul> of cards (no heading / section
	 *     wrapper), so it can live INSIDE the unified "🎉 Featured" card next to
	 *     the clearing-price history. Self-hides (renders nothing) when empty.
	 */

	import { onMount, onDestroy } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { getFeaturedOrderbook } from '$lib/indexer/client';
	import { getProfilesBatch } from '$lib/indexer/profileCache';
	import { extractLabelPropsFromProfile } from '$lib/indexer/profileProps';
	import { isOrderLive } from '$lib/orders/orderExpiry';
	import { orderTitleParts } from '$lib/utils/orderTitle';
	import { displayNamesForMethods } from '$lib/payments/display';
	import { formatOrderPriceModel } from '$lib/orders/priceModelDisplay';
	import type { FeaturedSlot, ProfileResponse } from '@morphit/indexer-client';
	import OrderCard from '$components/OrderCard.svelte';

	interface Props {
		variant?: 'grid' | 'stack';
		/** If false, the component renders nothing when empty. If true, renders a
		 *  muted "no featured orders yet" stub (standalone use only). */
		showEmptyState?: boolean;
		/** Embedded inside the unified "🎉 Featured" card: render only the card
		 *  list, no heading/section chrome, and nothing at all when empty. */
		embedded?: boolean;
	}

	let {
		variant = 'grid',
		showEmptyState = false,
		embedded = false
	}: Props = $props();

	let slots = $state<readonly FeaturedSlot[]>([]);
	let maxSlots = $state(3);
	let loaded = $state(false);
	let abortController: AbortController | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	// A coarse now-ticker (5s) so a featured offer whose own expires_at passes
	// BETWEEN backend polls disappears immediately rather than lingering. The
	// indexer already excludes cancelled/expired/unverified orders; this client
	// filter is the immediacy win + a defensive net. `isOrderLive` treats a
	// malformed/absent expires_at as still-live (fail-safe).
	let nowMs = $state(Date.now());
	let tickTimer: ReturnType<typeof setInterval> | null = null;
	const visibleSlots = $derived(slots.filter((s) => isOrderLive(s.order, nowMs)));

	/** Profile data for featured slots' posters. */
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
			// cp428 — surface the real cap from the API (fixes a hardcoded "/5"
			// that drifted from the backend's MAX_SLOTS=3).
			maxSlots = result.data.max_slots;
			void hydrateProfiles(result.data.featured, abortController.signal);
		}
		loaded = true;
	}

	onMount(() => {
		void refresh();
		// 30s — matches the backend cache TTL, so new featured slots appear about
		// as fast as the shared cache allows. (The bulk of any "why so slow"
		// delay is the indexer indexing the on-chain bid, which is inherent to
		// the federated model and can't be shortened client-side.)
		pollTimer = setInterval(() => void refresh(), 30_000);
		tickTimer = setInterval(() => (nowMs = Date.now()), 5_000);
	});

	onDestroy(() => {
		abortController?.abort();
		if (pollTimer !== null) clearInterval(pollTimer);
		if (tickTimer !== null) clearInterval(tickTimer);
	});

	/** Simple amount formatter for titles — mirrors the orderbook's so the
	 *  featured card title reads identically to the list card. */
	function formatAmount(n: number | null): string {
		if (n === null) return '';
		return n % 1 === 0 ? String(n) : n.toFixed(2);
	}
	function cardTitle(o: FeaturedSlot['order']): string {
		const tp = orderTitleParts(o, formatAmount, $_('order_title.goods_services') as string);
		return $_(tp.key, { values: tp.values }) as string;
	}
</script>

{#snippet cards()}
	<ul
		class={variant === 'grid'
			? 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5'
			: 'space-y-3'}
	>
		{#each visibleSlots as slot (slot.order.account + '/' + slot.order.permlink)}
			{@const o = slot.order}
			{@const labelProps = extractLabelPropsFromProfile(profileMap[o.account])}
			<OrderCard
				order={o}
				title={cardTitle(o)}
				displayName={labelProps.displayName}
				avatarSvg={labelProps.avatarSvg}
				avatarDataUri={labelProps.avatarDataUri}
				detailHref={lp(`/@${o.account}/${o.permlink}`)}
				profileHref={lp(`/@${o.account}`)}
				paymentLabels={displayNamesForMethods(o.payment_methods)}
				priceModelLabel={formatOrderPriceModel(
					o,
					$_ as unknown as Parameters<typeof formatOrderPriceModel>[1]
				)}
				featured
			/>
		{/each}
	</ul>
{/snippet}

{#if embedded}
	<!-- Nested inside the unified "🎉 Featured" card: cards only, nothing when
	     empty. locale referenced so titles re-render on language switch. -->
	{#if loaded && visibleSlots.length > 0}
		<div class="mb-4">
			{@render cards()}
		</div>
	{/if}
{:else if loaded && visibleSlots.length > 0}
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
				{visibleSlots.length}/{maxSlots}
			</span>
		</div>
		{@render cards()}
	</section>
{:else if loaded && showEmptyState}
	<section
		class="rounded-2xl border border-dashed border-ink-300 p-4 text-center text-sm text-ink-500 dark:border-ink-700"
	>
		{$_('featured.empty_state')}
	</section>
{/if}
