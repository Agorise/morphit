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
	import { networkChipFor } from '$lib/orders/networkChip';
	import {
		pendingFeatured,
		mergeablePending,
		pendingFeaturedKey
	} from '$stores/pendingFeatured';

	interface Props {
		variant?: 'grid' | 'stack';
		/** If false, the component renders nothing when empty. If true, renders a
		 *  muted "no featured orders yet" stub (standalone use only). */
		showEmptyState?: boolean;
		/** Embedded inside the unified "🎉 Featured" card: render only the card
		 *  list, no heading/section chrome, and nothing at all when empty. */
		embedded?: boolean;
		/** cp429 — reports the number of LIVE featured orders whenever it
		 *  changes. FeaturedAuctionHistory uses it to suppress a misleading
		 *  "no bids yet — be the first" prompt while a featured order is live
		 *  (the clearing-price *history* endpoint can be empty even when a
		 *  current bid exists). */
		oncount?: (n: number) => void;
	}

	let {
		variant = 'grid',
		showEmptyState = false,
		embedded = false,
		oncount
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

	// cp431 — the featured view is the indexer's confirmed slots PLUS any
	// order the current user just paid to feature (optimistic, display-only).
	// `confirmedKeys` lets us drop an optimistic entry the instant the indexer
	// serves the real slot, so there's no flicker or duplicate — the durable
	// indexer stays the source of truth; the optimistic card just fills the
	// ~50-90s gap before it confirms (and fades on its own if the bid lost).
	const confirmedKeys = $derived(new Set(slots.map((s) => pendingFeaturedKey(s.order))));
	const visibleSlots = $derived([
		...slots.filter((s) => isOrderLive(s.order, nowMs)),
		...mergeablePending($pendingFeatured, confirmedKeys, nowMs).filter((s) =>
			isOrderLive(s.order, nowMs)
		)
	]);

	// cp429 — surface the live count to a parent (FeaturedAuctionHistory) so it
	// can tell "no featured order at all" apart from "a featured order is live
	// but there's no settled clearing-price history yet".
	$effect(() => {
		oncount?.(visibleSlots.length);
	});

	/** Profile data for featured slots' posters. */
	let profileMap = $state<Record<string, ProfileResponse | null>>({});
	/** False until this surface's profile hydrate has completed once.
	 *  v1.8.13 (Ken) — while false, identity labels render a neutral placeholder
	 *  instead of asserting @account + identicon and then rewriting themselves.
	 *  An identity that visibly changes is indistinguishable from a swap attack. */

	/** False until this surface's profile hydrate has completed once.
	 *
	 *  v1.8.13 (Ken) — while false, identity labels render a neutral placeholder
	 *  instead of asserting `@account` + identicon and then rewriting themselves
	 *  once the fetch lands. Ken on chat: "imagine chatting with someone in the
	 *  chatroom and then all of a sudden their avatar and/or display name changes
	 *  on you like that. would you do a trade with that user? hell no." An
	 *  identity that visibly mutates is indistinguishable from a swap attack. */
	let profilesHydrated = $state(false);

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
		profilesHydrated = true;
	}

	// cp431 — refresh() only hydrates the indexer's slots; an optimistic
	// pending order (the user's own, not yet in the indexer) needs its poster
	// profile fetched too, else the card falls back to a bare @handle. Guarded
	// by the missing-set + profileCache, so it fires once per new account.
	$effect(() => {
		const missing = visibleSlots.filter((s) => !(s.order.account in profileMap));
		if (missing.length > 0) void hydrateProfiles(missing);
	});

	/** v1.8.16 (Ken) — build a ProfileResponse from the identity fields the
	 *  featured endpoint now serves inline, or null when absent (an older
	 *  instance, or an optimistic pending order from the client store — the
	 *  latter is the user's OWN order, so IdentityLabel's isSelf → selfProfile
	 *  fallback covers it). Mirrors the orderbook page's inlineProfileOf so a
	 *  featured card shows the real name + avatar on FIRST paint instead of
	 *  swapping @account + identicon for it a beat later (kentest3's "delayed"
	 *  avatar). The async profileMap still WINS when present — it is fresher
	 *  (a profile edited after this page loaded). */
	function inlineProfileOf(o: FeaturedSlot['order']): ProfileResponse | null {
		if (o.display_name === undefined && o.profile_json_metadata === undefined) return null;
		if (o.display_name === null && o.profile_json_metadata == null) return null;
		return {
			account: o.account,
			display_name: o.display_name ?? null,
			json_metadata: (o.profile_json_metadata ?? {}) as Record<string, unknown>
		} as ProfileResponse;
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
		// 10s — the person who featured sees their order instantly via the
		// optimistic pending path; this poll (matched to the backend's 10s
		// cache TTL) is how OTHER users pick up a newly-confirmed featured
		// slot. The remaining delay for them is the indexer indexing the
		// on-chain bid (~50-90s, last-irreversible), inherent to the
		// federated model and not shortenable client-side.
		pollTimer = setInterval(() => void refresh(), 10_000);
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
		// v1.9.0 (Ken) — a barter order with an inline title reads "…of bananas";
		// fall back to the generic "goods/services" label when none was set.
		const goodsLabel = o.specific_barter_title || ($_('order_title.goods_services') as string);
		const tp = orderTitleParts(o, formatAmount, goodsLabel, { locale: currentLang });
		return $_(tp.key, { values: tp.values }) as string;
	}
</script>

{#snippet cards()}
	<ul
		class={variant === 'grid'
			? 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3'
			: 'space-y-3'}
	>
		{#each visibleSlots as slot (slot.order.account + '/' + slot.order.permlink)}
			{@const o = slot.order}
			<!-- v1.8.16 (Ken) — prefer the INLINE profile the featured endpoint now
			     returns (like the orderbook), so the card is correct on FIRST paint.
			     The hydrated map still wins when present (fresher). `pending` is kept
			     but is harmless when inline identity is present: IdentityLabel renders
			     a supplied avatar/name regardless of pending, and only shows the
			     neutral placeholder when NEITHER inline nor async has an answer yet. -->
			{@const labelProps = extractLabelPropsFromProfile(
				profileMap[o.account] ?? inlineProfileOf(o)
			)}
			<!-- Ken — featured cards must name the network for multi-network assets
			     (USDT/USDC/DAI). Sending TRC20 to an ERC20 address loses the money;
			     the chip is not decoration. Same helper the orderbook rows use. -->
			{@const networkChip = networkChipFor(o, $_)}
			<OrderCard
				pending={!profilesHydrated}
				order={o}
				{networkChip}
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
	<!-- Ken — the "FEATURED RIGHT NOW" eyebrow is gone from the homepage: the
	     🚀 cards announce themselves, and the label was just noise above them.
	     The heading string is retained as the section's accessible NAME, so
	     screen-reader users still get told what this group of cards is —
	     removing the visible text shouldn't cost them the context. -->
	<section aria-label={$_('featured.heading')} class="space-y-3">
		{@render cards()}
	</section>
{:else if loaded && showEmptyState}
	<section
		class="rounded-2xl border border-dashed border-ink-300 p-4 text-center text-sm text-ink-500 dark:border-ink-700"
	>
		{$_('featured.empty_state')}
	</section>
{/if}
