<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	/**
	 * Morphit — orderbook page.
	 *
	 * Reads from the indexer over HTTP. The indexer is read-only;
	 * all trades actually settle via ops broadcast to Blurt through
	 * each user's session keys. The orderbook just shows WHO is
	 * advertising WHAT and HOW to reach them.
	 *
	 * State model:
	 *   phase:
	 *     - 'loading'   first fetch after mount or filter change
	 *     - 'ready'     results shown (may be empty list or items)
	 *     - 'error'     last fetch failed; retry surfaces the call
	 *   Pagination: cursor maintained across "load more" taps;
	 *   when cursor is null, we've reached the end of the list.
	 *
	 * Filter application: debounced by 250ms on any filter change
	 * to avoid hammering the indexer while the user tweaks things.
	 *
	 * Cancellation: each fetch gets its own AbortController; a
	 * new filter application cancels any in-flight request so
	 * stale results never overwrite fresh ones.
	 */

	import { onMount, onDestroy } from 'svelte';
	import { slide } from 'svelte/transition';
	import { _ } from 'svelte-i18n';

	import Head from '$components/Head.svelte';
	import RssFeedPicker from '$components/RssFeedPicker.svelte';
	import BusyButton from '$components/BusyButton.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import { isUsdtNetwork, isUsdcNetwork, isDaiNetwork } from '$lib/assets/networks';
	// cp165 byte-budget: FeaturedOrders + FeaturedAuctionHistory are
	// lazy-imported below.  Both render below the orderbook fold
	// AND each fires an HTTP fetch on onMount — for visitors who
	// don't scroll, that's bytes downloaded and requests issued
	// they never benefit from.  Converting to {#await} means the
	// chunks ship only when the orderbook list has scrolled
	// past them.
	// import FeaturedOrders from '$components/FeaturedOrders.svelte';
	// import FeaturedAuctionHistory from '$components/FeaturedAuctionHistory.svelte';
	import WelcomeFirstBuyHero from '$components/WelcomeFirstBuyHero.svelte';
	import AssetFilterSelect from '$components/AssetFilterSelect.svelte';
	import FiatCurrencySelect from '$components/FiatCurrencySelect.svelte';
	import PaymentFilterSelect from '$components/PaymentFilterSelect.svelte';

	import { getOrderbook } from '$lib/indexer/client';
	import { displayNamesForMethods } from '$lib/payments/display';
	import { ASSETS } from '$lib/assets/registry';
	import { instanceAdditions, instanceNameLookup } from '$lib/stores/instanceAdditions';
	import { instance } from '$lib/stores/instance';
	import { getProfilesBatch } from '$lib/indexer/profileCache';
	import { extractLabelPropsFromProfile } from '$lib/indexer/profileProps';
	import OrderCard from '$lib/components/OrderCard.svelte';
	import { formatOrderPriceModel } from '$lib/orders/priceModelDisplay';
	import { createOrderbookStream } from '$lib/orderbook/stream';
	import type { AssetTicker } from '@morphit/asset-registry';
	import type { OrderbookQuery, OrderRecord, ProfileResponse } from '@morphit/indexer-client';

	import { hiddenAccounts, hideAccount, unhideAccount } from '$lib/utils/hiddenAccounts';
	import { orderTitleParts } from '$lib/utils/orderTitle';
	import { blockedAccounts, loadBlocks } from '$lib/chat/blocks';
	import { recordOrderView } from '$lib/orders/views';
	import { checkWaiverEligibility } from '$lib/orders/listingFee';
	import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';
	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import { isUnlocked, hasAnySession } from '$stores/identity';

	// ─── Filter state ────────────────────────────────────────────────
	type AssetFilter = '' | AssetTicker | 'barter';
	type SideFilter = '' | 'buy' | 'sell' | 'buy_goods' | 'sell_goods';

	let asset = $state<AssetFilter>('');
	let side = $state<SideFilter>('');
	let fiatList = $state<string[]>([]);
	let region = $state('');
	// Region filter: an animated "someone is typing" placeholder. These
	// are proper-noun place names — deliberately NOT translated, so
	// "北京" / "Москва" / "München" appear verbatim in every UI locale.
	// Plain text bound to the native input placeholder, so RTL scripts,
	// CJK, accents, and spaces all render correctly.
	//
	// The typewriter types each place name out one character at a time,
	// holds it, backspaces it, then types the next — so it reads like a
	// person typing into the field rather than whole strings swapping in.
	// It runs only while the field is EMPTY: it stops the instant the
	// field has any text (driven by `regionHasText`, NOT a one-way flag)
	// and RESUMES the moment the field goes empty again — whether the
	// user deleted their text by hand or hit Clear-filters. prefers-
	// reduced-motion shows a single static place name with no animation.
	const REGION_PLACEHOLDERS = [
		'North America',
		'Polska',
		'Sydney',
		'Berlin',
		'Fort Myers Beach',
		'Россия',
		'San Francisco',
		'北京',
		'Nigeria',
		'Москва',
		'Kraków Nowa Huta',
		'München'
	] as const;
	let regionPlaceholder = $state<string>(REGION_PLACEHOLDERS[0]);
	// True whenever the field has real text — the typewriter pauses while
	// true and resumes (the $effect re-runs) when it flips back to false.
	const regionHasText = $derived(region.trim().length > 0);
	$effect(() => {
		// Pause while the user has typed something; resume when empty.
		if (regionHasText) return;
		// Respect reduced-motion: a single static place name, no typing.
		if (
			typeof window !== 'undefined' &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches
		) {
			regionPlaceholder = REGION_PLACEHOLDERS[0];
			return;
		}
		const TYPE_MS = 70; // per-character typing speed
		const DELETE_MS = 35; // per-character backspacing speed (snappier)
		const HOLD_MS = 1600; // pause on the fully-typed name
		const GAP_MS = 450; // blank beat before the next name
		let cityIdx = 0;
		let charIdx = 0;
		let phase: 'typing' | 'holding' | 'deleting' = 'typing';
		let timer: ReturnType<typeof setTimeout>;
		const tick = (): void => {
			const city = REGION_PLACEHOLDERS[cityIdx] ?? REGION_PLACEHOLDERS[0];
			if (phase === 'typing') {
				charIdx += 1;
				regionPlaceholder = city.slice(0, charIdx);
				if (charIdx >= city.length) {
					phase = 'holding';
					timer = setTimeout(tick, HOLD_MS);
				} else {
					timer = setTimeout(tick, TYPE_MS);
				}
			} else if (phase === 'holding') {
				phase = 'deleting';
				timer = setTimeout(tick, DELETE_MS);
			} else {
				charIdx -= 1;
				regionPlaceholder = city.slice(0, Math.max(charIdx, 0));
				if (charIdx <= 0) {
					phase = 'typing';
					charIdx = 0;
					cityIdx = (cityIdx + 1) % REGION_PLACEHOLDERS.length;
					timer = setTimeout(tick, GAP_MS);
				} else {
					timer = setTimeout(tick, DELETE_MS);
				}
			}
		};
		// Start by typing the first name in from an empty field.
		regionPlaceholder = '';
		timer = setTimeout(tick, GAP_MS);
		return () => clearTimeout(timer);
	});

	// cp165 byte-budget: lazy-load below-the-fold featured components.
	// Each kicks off a network fetch in its onMount, so deferring the
	// import also defers the fetch for visitors who don't scroll past
	// the orderbook list.
	const loadFeaturedOrders = () =>
		import('$components/FeaturedOrders.svelte').then((m) => m.default);
	const loadFeaturedAuctionHistory = () =>
		import('$components/FeaturedAuctionHistory.svelte').then((m) => m.default);
	/** Batch L: payment-method display lookup.  Reading
	 *  `$instanceAdditions` here triggers the lazy fetch of the
	 *  instance-additions store; the value itself is ignored,
	 *  but the subscription ensures `instanceNameLookup` finds
	 *  populated data after the fetch resolves.  Svelte
	 *  re-renders on the store update, so the orderbook rows
	 *  pick up the proper display names automatically. */
	const instLookup = $derived.by(() => {
		// Read $instanceAdditions to register a reactive
		// dependency — the lookup helper is a stable function,
		// but it reads the store-backed cache, so we want this
		// derived to re-evaluate when additions change.
		void $instanceAdditions;
		return instanceNameLookup;
	});
	/** Comma-separated payment-method filter. Matches orders that
	 *  accept ANY of the listed methods (array-overlap semantics
	 *  on the indexer side). Case-insensitive match — the indexer
	 *  lowercases both sides, so "paypal" here finds orders posted
	 *  with "PayPal". */
	let paymentMethods = $state<string[]>([]);

	/** Discrete minimum-trades filter: show only orders from
	 *  accounts that have received at least this many feedback
	 *  rows. 0 = any (default). Other preset values chosen
	 *  deliberately — a free-form integer would invite
	 *  "reputation gate" misuse; presets keep the UX healthier. */
	type MinTradesFilter = 0 | 5 | 20;
	let minTrades = $state<MinTradesFilter>(0);

	/** Sort mode. "recent" (default) keeps the historical
	 *  behavior; "rating" surfaces highest-rated first; "trades"
	 *  surfaces most-experienced first. New traders remain
	 *  visible in all modes — sort is not a filter. */
	type SortMode = 'recent' | 'rating' | 'trades';
	let sortMode = $state<SortMode>('recent');

	// Payment-methods filter: an animated typewriter placeholder, same
	// "someone is typing" treatment as the Region field above, cycling
	// through example payment methods.  Like the place names, these are
	// brand/method names shown verbatim in every locale (NOT translated).
	// HOLD_MS is deliberately 1s LONGER than the Region field's so the two
	// placeholders never cycle in lockstep (Ken's ask).  Runs only while
	// NOTHING is selected; reduced-motion shows a single static name.
	// (Declared here, after paymentMethods, so the $derived below can read it.)
	const PAYMENT_PLACEHOLDERS = [
		'PayPal',
		'Cash (in person)',
		'Monero',
		'Barter (goods/services)',
		'BLURT',
		'Bitcoin Cash (BCH)',
		'Apple Pay',
		'Monero (XMR)',
		'Klarna'
	] as const;
	let paymentPlaceholder = $state<string>(PAYMENT_PLACEHOLDERS[0]);
	// True whenever a method is selected — the typewriter pauses while true
	// and resumes (the $effect re-runs) when selections clear back to none.
	const paymentHasSelection = $derived(paymentMethods.length > 0);
	$effect(() => {
		// Pause while the user has selected something; resume when cleared.
		if (paymentHasSelection) return;
		// Respect reduced-motion: a single static method name, no typing.
		if (
			typeof window !== 'undefined' &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches
		) {
			paymentPlaceholder = PAYMENT_PLACEHOLDERS[0];
			return;
		}
		const TYPE_MS = 70; // per-character typing speed (matches Region)
		const DELETE_MS = 35; // per-character backspacing speed (matches Region)
		const HOLD_MS = 2600; // Region holds 1600 — +1s here to desync the two
		const GAP_MS = 450; // blank beat before the next name (matches Region)
		let idx = 0;
		let charIdx = 0;
		let phase: 'typing' | 'holding' | 'deleting' = 'typing';
		let timer: ReturnType<typeof setTimeout>;
		const tick = (): void => {
			const name = PAYMENT_PLACEHOLDERS[idx] ?? PAYMENT_PLACEHOLDERS[0];
			if (phase === 'typing') {
				charIdx += 1;
				paymentPlaceholder = name.slice(0, charIdx);
				if (charIdx >= name.length) {
					phase = 'holding';
					timer = setTimeout(tick, HOLD_MS);
				} else {
					timer = setTimeout(tick, TYPE_MS);
				}
			} else if (phase === 'holding') {
				phase = 'deleting';
				timer = setTimeout(tick, DELETE_MS);
			} else {
				charIdx -= 1;
				paymentPlaceholder = name.slice(0, Math.max(charIdx, 0));
				if (charIdx <= 0) {
					phase = 'typing';
					charIdx = 0;
					idx = (idx + 1) % PAYMENT_PLACEHOLDERS.length;
					timer = setTimeout(tick, GAP_MS);
				} else {
					timer = setTimeout(tick, DELETE_MS);
				}
			}
		};
		// Start by typing the first name in from an empty field.
		paymentPlaceholder = '';
		timer = setTimeout(tick, GAP_MS);
		return () => clearTimeout(timer);
	});

	/** When true, render orders from hidden accounts in-place (still
	 *  marked as hidden). Flipped by the transparency link under the
	 *  filter bar. Per-session only — doesn't touch the hidden set. */
	let showHiddenTemporarily = $state(false);

	// ─── Free-text "Order details" filter (cp411) ────────────────────
	/** Raw query for the free-text search over each order's terms/details.
	 *  This is a CLIENT-SIDE filter over the already-loaded page(s) — it
	 *  never hits the indexer (it is deliberately NOT part of currentQuery,
	 *  so typing here doesn't refetch). As the orderbook grows to thousands
	 *  of posts this becomes the fastest way to find "orange trees" or a
	 *  neighbourhood name buried in someone's terms, in any language. */
	let orderDetailsQuery = $state('');
	/** Lowercased, de-duped query tokens (≥2 chars) used for BOTH the filter
	 *  (every token must appear in an order's terms) and the in-card
	 *  highlight. A 1-char query yields no tokens → no filtering, no noise. */
	const orderDetailsTokens = $derived(
		Array.from(
			new Set(
				orderDetailsQuery
					.toLowerCase()
					.split(/\s+/)
					.map((t) => t.trim())
					.filter((t) => t.length >= 2)
			)
		)
	);
	// Order-details filter: an animated typewriter placeholder, same "someone
	// is typing" treatment as Region/Payment above, cycling through a
	// deliberately MULTILINGUAL set of example searches (Polish / Spanish /
	// Russian / Italian / English) to signal the field searches free text in
	// any language. Shown verbatim in every locale (NOT translated). HOLD_MS
	// (2100) sits between Region's 1600 and Payment's 2600 so all three
	// placeholders cycle out of lockstep. Runs only while the field is empty;
	// reduced-motion shows a single static example.
	const ORDER_DETAILS_PLACEHOLDERS = [
		'Myjnia samochodowa',
		'Orange trees',
		'Te hago recados',
		'Car wash',
		'Housecleaning',
		'Dog walking',
		'Выгул собак',
		'Dog walker',
		'Servizio di pulizia',
		'Errand runner',
		'Caretaker'
	] as const;
	let orderDetailsPlaceholder = $state<string>(ORDER_DETAILS_PLACEHOLDERS[0]);
	const orderDetailsHasText = $derived(orderDetailsQuery.trim().length > 0);
	$effect(() => {
		// Pause while the user has typed something; resume when empty.
		if (orderDetailsHasText) return;
		// Respect reduced-motion: a single static example, no typing.
		if (
			typeof window !== 'undefined' &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches
		) {
			orderDetailsPlaceholder = ORDER_DETAILS_PLACEHOLDERS[0];
			return;
		}
		const TYPE_MS = 70; // per-character typing speed (matches Region/Payment)
		const DELETE_MS = 35; // per-character backspacing speed (matches)
		const HOLD_MS = 2100; // between Region (1600) and Payment (2600) — desync
		const GAP_MS = 450; // blank beat before the next example (matches)
		let idx = 0;
		let charIdx = 0;
		let phaseT: 'typing' | 'holding' | 'deleting' = 'typing';
		let timer: ReturnType<typeof setTimeout>;
		const tick = (): void => {
			const name = ORDER_DETAILS_PLACEHOLDERS[idx] ?? ORDER_DETAILS_PLACEHOLDERS[0];
			if (phaseT === 'typing') {
				charIdx += 1;
				orderDetailsPlaceholder = name.slice(0, charIdx);
				if (charIdx >= name.length) {
					phaseT = 'holding';
					timer = setTimeout(tick, HOLD_MS);
				} else {
					timer = setTimeout(tick, TYPE_MS);
				}
			} else if (phaseT === 'holding') {
				phaseT = 'deleting';
				timer = setTimeout(tick, DELETE_MS);
			} else {
				charIdx -= 1;
				orderDetailsPlaceholder = name.slice(0, Math.max(charIdx, 0));
				if (charIdx <= 0) {
					phaseT = 'typing';
					charIdx = 0;
					idx = (idx + 1) % ORDER_DETAILS_PLACEHOLDERS.length;
					timer = setTimeout(tick, GAP_MS);
				} else {
					timer = setTimeout(tick, DELETE_MS);
				}
			}
		};
		// Start by typing the first example in from an empty field.
		orderDetailsPlaceholder = '';
		timer = setTimeout(tick, GAP_MS);
		return () => clearTimeout(timer);
	});

	// ─── Paging state ────────────────────────────────────────────────
	type Phase = 'loading' | 'ready' | 'error';
	let phase = $state<Phase>('loading');
	let items = $state<OrderRecord[]>([]);
	let cursor: string | null = $state(null);
	let errorMessage = $state('');
	let loadingMore = $state(false);

	/** cp411 — don't flash the load-error card during a transient first-load
	 *  hiccup. On a fresh page the indexer/SSE stream can briefly be
	 *  unreachable before the first snapshot lands; a bright red "couldn't
	 *  load" card that appears for a beat and then vanishes reads like the
	 *  site is broken. So the error card is gated behind this flag, which only
	 *  flips true after the page has stayed in 'error' for 2s. A quick retry
	 *  or the stream recovering flips `phase` back to 'ready'/'loading' first,
	 *  cancelling the reveal — so in the common case the card is never seen. */
	let showLoadError = $state(false);
	$effect(() => {
		if (phase !== 'error') {
			showLoadError = false;
			return;
		}
		// Entered (and still in) 'error' — reveal only if it persists 2s.
		const t = setTimeout(() => {
			showLoadError = true;
		}, 2000);
		return () => clearTimeout(t);
	});

	// ─── SSE streaming state (Phase E) ───────────────────────────────
	/** True while the orderbook stream is connected and fed.  Drives
	 *  the "Live" pip in the header so users know the page is
	 *  auto-updating; flips false on transient EventSource errors and
	 *  back true when the next snapshot arrives. */
	let streaming = $state(false);
	/** Set of (account/permlink) ids the SSE stream has told us about
	 *  since connect.  Used to know whether an order_removed event is
	 *  for something currently rendered.  Bounded by the indexer's
	 *  per-connection cap; we don't replicate that bound here because
	 *  the server enforces it.  Updated by the upsert/remove
	 *  callbacks below. */
	const streamedIds = new Set<string>();

	/** The signed-in user's Blurt account name, or null if signed
	 *  out / not yet registered.  Derived so the banner above and
	 *  the per-row Message CTA below re-evaluate when the user
	 *  unlocks/locks/registers within the same page mount.  Pre-
	 *  Part-68 this was a script-init `const` which was wrong for
	 *  the Sally-skipped-registration case (she could come back
	 *  and complete registration without a page reload). */
	const viewerAccount = $derived.by((): string | null => {
		// Read $isUnlocked to register a reactive dependency — when
		// the session locks/unlocks the account-name lookup re-runs.
		void $isUnlocked;
		return getUserBlurtAccount();
	});

	// cp384 (#2): the "Posted an order but don't see it? Check fee status"
	// hint only makes sense once the viewer has actually posted an order, so
	// gate it on waiver eligibility — checkWaiverEligibility returns
	// `ineligible_has_orders` exactly when the account has ≥1 order. Fetched
	// once per account (re-runs on login); a failure just hides the hint.
	let viewerHasOrdered = $state(false);
	let eligibilityCheckedFor: string | null = null;
	$effect(() => {
		const acct = viewerAccount;
		if (!acct || acct === eligibilityCheckedFor) return;
		eligibilityCheckedFor = acct;
		void (async () => {
			try {
				const result = await checkWaiverEligibility(resolveOrigin(MORPHIT_INDEXER_ORIGIN), acct);
				viewerHasOrdered = result.kind === 'ineligible_has_orders';
			} catch {
				viewerHasOrdered = false;
			}
		})();
	});

	/** Profile data keyed by account. Populated asynchronously AFTER
	 *  the orderbook loads — orderbook rows render with identicons
	 *  first, then custom avatars swap in as profiles arrive. A null
	 *  value means the server confirmed no profile (cached so we
	 *  don't refetch). Missing key means we haven't tried yet.
	 *
	 *  Uses a plain Record rather than a Map because Svelte 5 $state
	 *  handles reactive deep-updates on plain objects well, and the
	 *  lookup idiom `profileMap[account]` in the template is natural. */
	let profileMap = $state<Record<string, ProfileResponse | null>>({});

	/** Items filtered by the user's hidden-accounts AND blocked-
	 *  accounts sets.  Hidden is local-only ("invisible to me on
	 *  this device"); blocked is chain-broadcast ("I want nothing
	 *  to do with this user, syncs across devices").  Both
	 *  represent intentional moderation choices and orderbook is
	 *  one of the surfaces that should respect them.
	 *
	 *  For unauthenticated viewers, $blockedAccounts is the empty
	 *  set (loadBlocks runs only when there's a logged-in user)
	 *  so the AND is a no-op for them.
	 *
	 *  When showHiddenTemporarily is true, we return `items`
	 *  unchanged (render path still shows the moderation marker
	 *  per-row).  Note the toggle reveals BOTH hidden and blocked
	 *  accounts since it's a "show me what I'd otherwise be
	 *  filtering" transparency control. */
	const visibleItems = $derived.by(() => {
		const tokens = orderDetailsTokens;
		const hidden = $hiddenAccounts;
		const blocked = $blockedAccounts;
		return items.filter((o) => {
			// Moderation filter — skipped when the transparency toggle is on.
			if (!showHiddenTemporarily) {
				const acct = o.account.toLowerCase();
				if (hidden.has(acct) || blocked.has(acct)) return false;
			}
			// cp411 — free-text "Order details" filter: every query token must
			// appear (case-insensitively) somewhere in the order's terms text.
			if (tokens.length > 0) {
				const terms = (o.terms ?? '').toLowerCase();
				for (const t of tokens) {
					if (!terms.includes(t)) return false;
				}
			}
			return true;
		});
	});

	/** Count of items filtered out by the moderation sets. Surfaces
	 *  in the transparency line below the filters. */
	const hiddenInView = $derived.by(() => {
		const hidden = $hiddenAccounts;
		const blocked = $blockedAccounts;
		return items.filter((o) => {
			const acct = o.account.toLowerCase();
			return hidden.has(acct) || blocked.has(acct);
		}).length;
	});

	/** Cancels the in-flight fetch if any. Replaced on each new fetch. */
	let currentAbort: AbortController | null = null;
	/** Debounce handle for filter changes. */
	let filterDebounce: ReturnType<typeof setTimeout> | null = null;

	function currentQuery(): OrderbookQuery {
		// OrderbookQuery's public surface is `readonly` so callers
		// can't accidentally mutate after passing to the client.
		// We need a mutable shape for the piecemeal build below;
		// the assignment back to OrderbookQuery on return is a
		// type-level no-op (the values are identical).
		const q: { -readonly [K in keyof OrderbookQuery]: OrderbookQuery[K] } = {};
		// 'barter' is a payment method (barter_goods), not a tradable
		// asset, so it never goes on q.asset.
		if (asset && asset !== 'barter') q.asset = asset;
		// The "products/services" side options are the normal buy/sell
		// side PLUS a barter payment-method constraint (added below).
		const sideForQuery = side === 'buy_goods' ? 'buy' : side === 'sell_goods' ? 'sell' : side;
		if (sideForQuery) q.side = sideForQuery;
		// One or more ISO codes (already uppercase from the dataset);
		// the indexer matches orders in ANY of them.
		if (fiatList.length) q.fiat_currency = fiatList.join(',');
		const regionTrim = region.trim();
		if (regionTrim) q.location_region = regionTrim;
		// Barter selection (asset=barter, or a products/services side)
		// maps to payment_methods ⊇ barter_goods. The indexer matches
		// orders accepting ANY listed method, so combining with a typed
		// payment filter ORs them (broadens) — acceptable; an exclude
		// filter (to make a "crypto" view hide barter-only orders) would
		// need indexer support and is intentionally not done here.
		const wantsBarter = asset === 'barter' || side === 'buy_goods' || side === 'sell_goods';
		const paymentTokens: string[] = [];
		if (wantsBarter) paymentTokens.push('barter_goods');
		paymentTokens.push(...paymentMethods);
		const uniquePayment = [...new Set(paymentTokens)];
		if (uniquePayment.length) q.payment_methods = uniquePayment.join(',');
		if (minTrades > 0) q.min_trades = minTrades;
		if (sortMode !== 'recent') q.sort = sortMode;
		return q;
	}

	/** The human-readable feed title handed to the per-asset RSS feed, built
	 *  from the orderbook form's OWN labels + registries so it always mirrors
	 *  exactly what the form shows: change a filter label or option and the
	 *  feed title follows automatically (single source of truth).  Lists only
	 *  the ACTIVE criteria — blank fields, "Any"/"Everything", and the default
	 *  ("Most recent") sort are omitted.  Passed to the indexer via the feed
	 *  URL's `feed_title` param; the indexer echoes it as the feed <title> and
	 *  never reconstructs any label itself (the labels live here).  Sort IS
	 *  shown in the title because it mirrors the user's search, even though the
	 *  feed contents are always recency-ordered (see rssQuery + the indexer's
	 *  sort note). */
	const rssTitle = $derived.by(() => {
		const parts: string[] = [];
		// Side — its option label is self-describing ("Posts wanting to sell
		// crypto"), so it carries no field-name prefix, matching the form.
		if (side) parts.push($_(`orderbook.filters.side_${side}`));
		// Asset — "Asset: Blurt (BLURT)", the same name+ticker format
		// AssetFilterSelect renders.  (The pill only shows for a real asset,
		// but guard 'barter' + an unknown ticker defensively.)
		if (asset && asset !== 'barter') {
			const a = ASSETS.find((x) => x.displayTicker === asset);
			const label = a ? `${a.displayName} (${a.displayTicker})` : asset;
			parts.push(`${$_('orderbook.filters.asset_label')}: ${label}`);
		}
		if (fiatList.length) {
			parts.push(`${$_('orderbook.filters.fiat_label')}: ${fiatList.join(', ')}`);
		}
		const regionTrim = region.trim();
		if (regionTrim) {
			parts.push(`${$_('orderbook.filters.region_label')}: "${regionTrim}"`);
		}
		if (paymentMethods.length) {
			// Same resolver the rendered orders use, so a method's name in the
			// title and in a row never disagree.
			const names = displayNamesForMethods(paymentMethods, instLookup);
			if (names.length) {
				parts.push(`${$_('orderbook.filters.payment_methods_label')}: ${names.join(', ')}`);
			}
		}
		if (minTrades > 0) {
			parts.push(
				`${$_('orderbook.filters.min_trades_label')}: ${$_(`orderbook.filters.min_trades_${minTrades}`)}`
			);
		}
		if (sortMode !== 'recent') {
			parts.push(
				`${$_('orderbook.filters.sort_label')}: ${$_(`orderbook.filters.sort_${sortMode}`)}`
			);
		}
		const prefix = $_('orderbook.filters.rss_title_prefix', {
			values: { site: $_('seo.site_name') }
		});
		return parts.length ? `${prefix} ${parts.join(', ')}` : prefix;
	});

	/** The query string handed to the per-asset RSS feed so the feed
	 *  mirrors the current search.  Reuses currentQuery() as the single
	 *  source of filter logic, then keeps the filters the feed honors —
	 *  side, fiat_currency, location_region, payment_methods, min_trades.
	 *  asset is intentionally dropped from the filters (it's already in the
	 *  feed PATH); sort is dropped as a FILTER because a feed is always
	 *  recency-ordered (readers re-sort by date) — see
	 *  apps/indexer/src/api/rssOrderbookHandlers.ts.  A cosmetic `feed_title`
	 *  (rssTitle) is appended so the served <title> spells out the active
	 *  criteria (including asset + sort) without changing what matches. */
	const rssQuery = $derived.by(() => {
		const q = currentQuery();
		const params = new URLSearchParams();
		if (q.side) params.set('side', q.side);
		if (q.fiat_currency) params.set('fiat_currency', q.fiat_currency);
		if (q.location_region) params.set('location_region', q.location_region);
		if (q.payment_methods) params.set('payment_methods', q.payment_methods);
		if (q.min_trades) params.set('min_trades', String(q.min_trades));
		// Cosmetic only: drives the served feed <title>, built from the form's
		// own labels (single source of truth).  Functional filtering uses only
		// the params above.
		params.set('feed_title', rssTitle);
		return params.toString();
	});

	/** The GLOBAL (cross-asset) RSS pill shows when no single asset is
	 *  selected — so the per-asset pill isn't showing — but the search
	 *  still carries at least one filter the feed honors: side, fiat,
	 *  region, payment, min_trades, or the barter payment constraint
	 *  (asset === 'barter'). This is what surfaces an RSS subscription
	 *  for a side/region/experience search without an asset (orderbook
	 *  items 1/4/6). `sort` is deliberately excluded — feeds are always
	 *  recency-ordered, so a sort-only change produces no feed pill. */
	const globalRssActive = $derived(
		(asset === '' || asset === 'barter') &&
			(side !== '' ||
				fiatList.length > 0 ||
				region.trim() !== '' ||
				paymentMethods.length > 0 ||
				minTrades > 0 ||
				asset === 'barter')
	);

	/** Fetch profile data for the accounts in the given order set,
	 *  deduplicated and batched via the shared profile cache. Merges
	 *  results into profileMap so the UI reactively swaps identicons
	 *  for custom avatars as data arrives.
	 *
	 *  Fire-and-forget: we do NOT await this from fetchFirstPage /
	 *  loadMore because blocking orderbook render on profile fetch
	 *  would delay the main content. The UI shows identicons first
	 *  and upgrades them once profiles land (typically < 300ms).
	 *
	 *  Errors are silently tolerated — the cache stores null for any
	 *  account that failed to fetch, so repeated hydrate calls
	 *  don't hammer the network. The UI keeps the identicon as
	 *  fallback.
	 *
	 *  Signal is optional and inherits from the page's currentAbort
	 *  so navigating or filtering aborts profile fetches too. */
	async function hydrateProfiles(
		orders: readonly OrderRecord[],
		signal?: AbortSignal
	): Promise<void> {
		const accounts = Array.from(new Set(orders.map((o) => o.account)));
		if (accounts.length === 0) return;
		const fetched = await getProfilesBatch(accounts, signal);
		if (signal?.aborted) return;
		const next = { ...profileMap };
		for (const [account, profile] of fetched) {
			next[account] = profile;
		}
		profileMap = next;
	}

	async function fetchFirstPage(): Promise<void> {
		if (currentAbort) currentAbort.abort();
		currentAbort = new AbortController();

		phase = 'loading';
		items = [];
		cursor = null;
		errorMessage = '';

		const result = await getOrderbook(currentQuery(), currentAbort.signal);
		if (currentAbort.signal.aborted) return;

		if (!result.ok) {
			console.warn('[orderbook] first-page fetch failed:', result.message);
			errorMessage = $_('orderbook.error.fetch_failed');
			phase = 'error';
			return;
		}
		items = [...result.data.items];
		cursor = result.data.next_cursor;
		phase = 'ready';
		// Kick off profile hydration — deliberately not awaited.
		// The identicon fallback renders immediately; custom avatars
		// swap in as profiles arrive.
		void hydrateProfiles(result.data.items, currentAbort.signal);
	}

	async function loadMore(): Promise<void> {
		if (!cursor || loadingMore) return;
		loadingMore = true;
		const signal = currentAbort?.signal;
		const result = await getOrderbook({ ...currentQuery(), cursor }, signal);
		loadingMore = false;
		if (!result.ok) {
			// Non-fatal — show the error inline but keep the list so
			// the user doesn't lose scroll position.
			console.warn('[orderbook] load-more failed:', result.message);
			errorMessage = $_('orderbook.error.load_more_failed');
			return;
		}
		// Append rather than replace; dedupe by (account, permlink)
		// in case reordering caused overlap.
		const seen = new Set(items.map((o) => `${o.account}/${o.permlink}`));
		for (const o of result.data.items) {
			const key = `${o.account}/${o.permlink}`;
			if (!seen.has(key)) {
				items.push(o);
				seen.add(key);
			}
		}
		cursor = result.data.next_cursor;
		void hydrateProfiles(result.data.items, signal);
	}

	function scheduleRefetch(): void {
		if (filterDebounce) clearTimeout(filterDebounce);
		filterDebounce = setTimeout(() => {
			fetchFirstPage();
			// Restart the SSE stream with the new filter.  EventSource
			// can't change its URL after construction, so we close the
			// old one and open a fresh one — same pattern the
			// instances stream uses.
			restartStream();
		}, 250);
	}

	/** Filter-card collapse.  Expanded on page load; the user controls it
	 *  via the header toggle (clicking anywhere on the title row).  There
	 *  is deliberately NO auto-collapse on filter changes — folding the
	 *  card away mid-adjustment was disorienting, so it stays open until
	 *  the user chooses to collapse it. */
	let filtersExpanded = $state(false);

	// Re-fetch when any filter changes.
	$effect(() => {
		void asset;
		void side;
		void fiatList;
		void region;
		void paymentMethods;
		void minTrades;
		void sortMode;
		scheduleRefetch();
	});

	// ─── SSE stream handle (Phase E) ─────────────────────────────────

	let streamHandle: ReturnType<typeof createOrderbookStream> | null = null;

	function buildStream(): ReturnType<typeof createOrderbookStream> {
		return createOrderbookStream({
			query: () => currentQuery(),
			onSnapshot: (snap) => {
				// Snapshot is authoritative: replace the live-page
				// portion of items with the server's view.  We don't
				// touch any rows the user has already paginated into
				// via loadMore (those live in items past the snapshot
				// boundary; the SSE stream doesn't track them).
				//
				// To stay simple: replace the first SNAPSHOT_SIZE
				// items with the snapshot, leave any later pages
				// alone.  If the user hasn't paginated, items.length
				// is at most SNAPSHOT_SIZE, so this is just "set
				// items = snapshot.items".
				const SNAPSHOT_SIZE = 50;
				const tail = items.slice(SNAPSHOT_SIZE);
				items = [...snap.items, ...tail];
				streamedIds.clear();
				for (const e of snap.items) {
					streamedIds.add(`${e.account}/${e.permlink}`);
				}
				// Hydrate profiles for any new accounts we hadn't seen.
				void hydrateProfiles(snap.items);
			},
			applyUpsert: (entry) => {
				const id = `${entry.account}/${entry.permlink}`;
				const idx = items.findIndex(
					(o) => o.account === entry.account && o.permlink === entry.permlink
				);
				if (idx >= 0) {
					// Replace in place; preserve list position.  The
					// REST endpoint sorts by updated_at desc, but
					// recomputing sort order here would cause rows
					// to jump around as they update — distracting.
					// Keep position; user-perceptible "new at top"
					// still happens via genuinely-new orders below.
					items[idx] = entry;
					items = items;
				} else {
					// New row — prepend (recent sort puts newest first).
					items = [entry, ...items];
				}
				if (!streamedIds.has(id)) {
					streamedIds.add(id);
					void hydrateProfiles([entry]);
				}
			},
			applyRemove: ({ account, permlink }) => {
				const id = `${account}/${permlink}`;
				items = items.filter((o) => !(o.account === account && o.permlink === permlink));
				streamedIds.delete(id);
			},
			onStreamingChange: (s) => {
				streaming = s;
			}
		});
	}

	function restartStream(): void {
		if (streamHandle !== null) {
			streamHandle.stop();
		}
		streamHandle = buildStream();
		streamHandle.start();
	}

	onMount(() => {
		fetchFirstPage();
		// Open the SSE stream alongside.  Snapshot will replace
		// items with the live-paged view shortly; diffs keep it
		// fresh.  See restartStream() above for the reconnect path
		// on filter change.
		streamHandle = buildStream();
		streamHandle.start();
		// Populate the blocked-accounts store if user is logged in,
		// so visibleItems can filter chain-blocked peers from the
		// orderbook view.  Fire-and-forget: the derived re-runs
		// reactively when blockedSet updates.  Anon viewers never
		// trigger this (no account → no fetch).
		const me = getUserBlurtAccount();
		if (me) void loadBlocks(me);
		return () => {
			if (currentAbort) currentAbort.abort();
			if (filterDebounce) clearTimeout(filterDebounce);
		};
	});

	onDestroy(() => {
		if (streamHandle !== null) {
			streamHandle.stop();
			streamHandle = null;
		}
	});

	function clearFilters(): void {
		asset = '';
		side = '';
		fiatList = [];
		region = '';
		paymentMethods = [];
		minTrades = 0;
		sortMode = 'recent';
		orderDetailsQuery = '';
	}

	// ─── Formatting helpers ──────────────────────────────────────────

	function formatAmount(n: number | null): string {
		if (n === null) return '';
		return n % 1 === 0 ? String(n) : n.toFixed(2);
	}

	function cardTitle(o: OrderRecord): string {
		const tp = orderTitleParts(o, formatAmount);
		return $_(tp.key, { values: tp.values }) as string;
	}

	// Part 121 cp7 — per-locale internal-link wrapper.  See
	// $i18n/path.localePath() + the analogous helper in
	// [lang]/+layout.svelte for design rationale.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<Head
	routeKey="orderbook"
	feeds={[
		{ title: $_('seo.site_name') + ' — orderbook (RSS)', href: '/rss/orderbook.xml' },
		{
			title: $_('seo.site_name') + ' — orderbook (Atom)',
			href: '/rss/orderbook.atom',
			type: 'atom'
		},
		{
			title: $_('seo.site_name') + ' — orderbook (JSON Feed)',
			href: '/rss/orderbook.json',
			type: 'json'
		}
	]}
/>

<div class="mx-auto max-w-4xl px-4 py-10 md:py-14">
	<header class="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
		<div>
			<h1 class="font-display text-3xl font-extrabold">
				<span class="brand-gradient-text">{$_('orderbook.heading')}</span>
			</h1>
			<p class="mt-2 flex items-center gap-3 text-ink-700 dark:text-ink-200">
				<span>{$_('orderbook.subtitle')}</span>
				{#if streaming}
					<span class="inline-flex items-center gap-1.5 text-xs">
						<span class="relative inline-flex h-2 w-2">
							<span
								class="absolute inline-flex h-full w-full animate-ping rounded-full bg-morphit-emerald opacity-60"
							></span>
							<span class="relative inline-flex h-2 w-2 rounded-full bg-morphit-emerald"></span>
						</span>
						<span class="uppercase tracking-widest text-ink-500">{$_('orderbook.live')}</span>
					</span>
				{/if}
			</p>
		</div>
		<a href={lp('/post')} class="btn-primary self-start whitespace-nowrap">
			{$_('orderbook.post_cta')}
		</a>
	</header>

	<!-- cp420: the fee-status recovery link that used to sit here (Tier 2.7 /
	     Part 91 — a user who paid a listing fee but doesn't see their order,
	     because fee verification silently failed, gets a path back to
	     /my/orders) moved to the FOOT of the filter card below. It was too
	     prominent at the top of the page. Same gating: signed-in users with a
	     registered account name who've actually posted an order. -->

	<WelcomeFirstBuyHero />

	<!-- Sally finding H4 (Part 68): if the user is unlocked but
	     hasn't completed account-name registration, the per-row
	     "Message" CTA is silently invisible (see line where
	     `viewerAccount !== null` gates it).  Without this banner
	     a Sally who skipped /onboarding/register-name can browse
	     orders but has no idea why she can't reach sellers.
	     Renders only when unlocked-without-account so it doesn't
	     bother signed-out browsers (who see the same gating but
	     get the home-page CTAs to onboard from). -->
	{#if $isUnlocked && viewerAccount === null}
		<section
			class="card mb-6 border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-950"
			role="status"
			aria-live="polite"
		>
			<div class="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div class="flex items-start gap-3">
					<span class="text-2xl" aria-hidden="true">👋</span>
					<div>
						<p class="font-semibold text-red-900 dark:text-red-100">
							{$_('orderbook.needs_account.title')}
						</p>
						<p class="mt-1 text-sm text-red-800 dark:text-red-200">
							{$_('orderbook.needs_account.body')}
						</p>
					</div>
				</div>
				<a href={lp('/onboarding/register-name')} class="btn-primary flex-none whitespace-nowrap">
					{$_('orderbook.needs_account.cta')}
				</a>
			</div>
		</section>
	{/if}

	<!-- Filters -->
	<section
		class="card mb-6 {filtersExpanded ? '' : 'px-4 py-2'}"
		aria-labelledby="filters-heading"
	>
		<h2 id="filters-heading" class={filtersExpanded ? 'mb-4' : 'mb-0'}>
			<button
				type="button"
				onclick={() => (filtersExpanded = !filtersExpanded)}
				aria-expanded={filtersExpanded}
				aria-controls="orderbook-filters-body"
				title={filtersExpanded ? $_('orderbook.filters.collapse') : $_('orderbook.filters.expand')}
				class="group -mx-2 flex w-full items-center justify-between gap-3 rounded-xl px-2 py-1.5 text-start transition hover:bg-ink-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:hover:bg-ink-800/60"
			>
				<span class="font-display text-lg font-bold">
					{$_('orderbook.filters.heading')}
				</span>
				<span
					class="flex flex-none items-center justify-center rounded-full bg-ink-100 text-ink-600 transition group-hover:bg-emerald-50 group-hover:text-morphit-emerald dark:bg-ink-800 dark:text-ink-300 dark:group-hover:bg-ink-700 {filtersExpanded
						? 'h-8 w-8'
						: 'h-7 w-7'}"
					aria-hidden="true"
				>
					<svg
						class="h-4 w-4 transition-transform duration-200 {filtersExpanded ? 'rotate-45' : ''}"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="M12 5v14M5 12h14" />
					</svg>
				</span>
			</button>
		</h2>
		{#if filtersExpanded}
			<div id="orderbook-filters-body" transition:slide={{ duration: 250 }}>
				<div class="grid gap-4 sm:grid-cols-2">
					<label class="block">
						<span class="mb-1 block text-sm font-semibold">
							{$_('orderbook.filters.side_label')}
						</span>
						<select
							bind:value={side}
							class="w-full cursor-pointer rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
						>
							<option value="">{$_('orderbook.filters.side_any')}</option>
							<option value="buy">{$_('orderbook.filters.side_buy')}</option>
							<option value="sell">{$_('orderbook.filters.side_sell')}</option>
							<option value="buy_goods">{$_('orderbook.filters.side_buy_goods')}</option>
							<option value="sell_goods">{$_('orderbook.filters.side_sell_goods')}</option>
						</select>
						<p class="mt-1 text-xs text-ink-500 dark:text-ink-400">
							{$_('orderbook.filters.side_help')}
						</p>
					</label>

					<div class="block">
						<span class="mb-1 block text-sm font-semibold">
							{$_('orderbook.filters.asset_label')}
						</span>
						<AssetFilterSelect bind:value={asset} />
					</div>

					<div class="block">
						<span class="mb-1 block text-sm font-semibold">
							{$_('orderbook.filters.fiat_label')}
						</span>
						<FiatCurrencySelect bind:value={fiatList} />
					</div>

					<label class="block">
						<span class="mb-1 block text-sm font-semibold">
							{$_('orderbook.filters.region_label')}
						</span>
						<input
							type="text"
							bind:value={region}
							maxlength="128"
							autocomplete="off"
							class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
							placeholder={regionPlaceholder}
						/>
					</label>
				</div>

				<div class="mt-4 block">
					<span class="mb-1 block text-sm font-semibold">
						{$_('orderbook.filters.payment_methods_label')}
					</span>
					<PaymentFilterSelect
						bind:value={paymentMethods}
						additions={$instanceAdditions}
						disabled={$instance.disabled_payment_methods}
						placeholder={paymentPlaceholder}
					/>
					<p class="mt-1 text-xs text-ink-500">
						{$_('orderbook.filters.payment_methods_hint')}
					</p>
				</div>

				<!-- cp411 — free-text search over each order's terms/details.
				     Client-side over the loaded page(s); no help text under it
				     (Ken's ask). Animated multilingual typewriter placeholder. -->
				<label class="mt-4 block">
					<span class="mb-1 block text-sm font-semibold">
						{$_('orderbook.filters.order_details_label')}
					</span>
					<input
						type="text"
						bind:value={orderDetailsQuery}
						maxlength="128"
						autocomplete="off"
						class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
						placeholder={orderDetailsPlaceholder}
					/>
				</label>

				<!-- Trader experience + sort. These two controls surface
		     reputation data without hiding newcomers — new traders
		     remain visible under every sort mode; the min-trades
		     filter defaults to "Any" so the default view never
		     excludes them. -->
				<div class="mt-4 grid gap-4 sm:grid-cols-2">
					<label class="block">
						<span class="mb-1 block text-sm font-semibold">
							{$_('orderbook.filters.min_trades_label')}
						</span>
						<select
							bind:value={minTrades}
							class="w-full cursor-pointer rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
						>
							<option value={0}>{$_('orderbook.filters.min_trades_any')}</option>
							<option value={5}>{$_('orderbook.filters.min_trades_5')}</option>
							<option value={20}>{$_('orderbook.filters.min_trades_20')}</option>
						</select>
						<p class="mt-1 text-xs text-ink-500">
							{$_('orderbook.filters.min_trades_hint')}
						</p>
					</label>

					<label class="block">
						<span class="mb-1 block text-sm font-semibold">
							{$_('orderbook.filters.sort_label')}
						</span>
						<select
							bind:value={sortMode}
							class="w-full cursor-pointer rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
						>
							<option value="recent">{$_('orderbook.filters.sort_recent')}</option>
							<option value="rating">{$_('orderbook.filters.sort_rating')}</option>
							<option value="trades">{$_('orderbook.filters.sort_trades')}</option>
						</select>
					</label>
				</div>

				{#if asset || side || fiatList.length || region || paymentMethods.length || minTrades > 0 || sortMode !== 'recent' || orderDetailsQuery.trim()}
					<div class="mt-4 flex flex-wrap items-center gap-3">
						<BusyButton variant="ghost" onclick={clearFilters}>
							{$_('orderbook.filters.clear')}
						</BusyButton>

						<!-- Per-asset RSS subscribe link.
					Only meaningful when an asset is selected — without one,
					the global /rss/orderbook.xml from the footer already
					covers the use case. Keeps the URL space small (3 valid
					asset feeds) so a passive observer learns at most "this
					subscriber cares about <asset>."
					Privacy and use case documented in rss_feeds FAQ. -->
						{#if asset && asset !== 'barter'}
							<RssFeedPicker
								base={`/rss/orderbook/by-asset/${asset.toLowerCase()}`}
								query={rssQuery}
								label={$_('orderbook.filters.rss_asset_title', { values: { asset } }) as string}
								text={$_('orderbook.filters.rss_generated_label') as string}
								triggerClass="chip text-xs"
								iconClass="h-3.5 w-3.5"
							/>
						{:else if globalRssActive}
							<!-- Cross-asset filtered feed: no single asset selected, but
					     the search has filters the feed honors. Same global
					     /rss/orderbook the footer links, with the active filters
					     in the query. aria-label is the dynamic, already-localized
					     criteria summary (rssTitle). -->
							<RssFeedPicker
								base="/rss/orderbook"
								query={rssQuery}
								label={rssTitle}
								text={$_('orderbook.filters.rss_generated_label') as string}
								triggerClass="chip text-xs"
								iconClass="h-3.5 w-3.5"
							/>
						{/if}
					</div>
				{/if}
				<!-- cp420: the "posted an order but don't see it? check fee
				     status" recovery link lives at the FOOT of the filter card
				     now — it was too prominent at the top of the page. Signed-in
				     users who've actually posted an order only. -->
				{#if $hasAnySession && viewerAccount !== null && viewerHasOrdered}
					<p class="mt-4 border-t border-ink-100 pt-3 text-xs dark:border-ink-800">
						<a
							href={lp('/my/orders#fee-status')}
							class="inline-flex items-center gap-1 text-ink-900 transition-colors hover:text-morphit-emerald dark:text-white"
						>
							{$_('orderbook.fee_rejected_check')}
							<span class="nav-arrow nav-arrow-right" aria-hidden="true">⇨</span>
						</a>
					</p>
				{/if}
			</div>
		{/if}
	</section>

	<!-- Phase 5 item 5: Featured slots pinned above the main list.
	     'stack' variant to match the single-column orderbook row
	     layout below. Self-hides when empty so no promotional noise
	     on a fresh marketplace. -->
	<div class="mt-6">
		{#await loadFeaturedOrders() then FeaturedOrders}
			<FeaturedOrders variant="stack" />
		{/await}
	</div>

	<!-- Item 5 (Group 1 #2): clearing-price history for the
	     featured-slot auction.  Self-hides until there's at
	     least one bid in the window.  Below the live featured
	     panel because "is the auction competitive?" is more
	     interesting AFTER you've seen who's currently winning. -->
	{#await loadFeaturedAuctionHistory() then FeaturedAuctionHistory}
		<FeaturedAuctionHistory />
	{/await}

	<!-- Loading status -->
	{#if phase === 'loading'}
		<StatusLine kind="loading">{$_('orderbook.loading')}</StatusLine>
	{/if}

	<!-- Error (cp411: 2s-delayed reveal + dimmed so a transient load blip
	     doesn't read as a big red "site is broken" flag) -->
	{#if showLoadError}
		<section
			class="card mt-4 border-amber-300/50 bg-amber-50/40 dark:border-amber-800/40 dark:bg-amber-950/20"
			role="status"
			aria-live="polite"
		>
			<h2 class="font-display text-lg font-bold text-amber-900 dark:text-amber-200">
				{$_('orderbook.error_title')}
			</h2>
			<p class="mt-2 text-sm text-ink-700 dark:text-ink-300">
				{$_('orderbook.error_body')}
			</p>
			<p class="mt-1 text-xs text-ink-500 dark:text-ink-400">
				{errorMessage}
			</p>
			<div class="mt-4">
				<BusyButton variant="primary" onclick={fetchFirstPage}>
					{$_('common.retry')}
				</BusyButton>
			</div>
		</section>
	{/if}

	<!-- Ready: items or empty -->
	{#if phase === 'ready'}
		{#if visibleItems.length === 0 && items.length === 0}
			<section class="card text-center">
				<h2 class="font-display text-lg font-bold">
					{$_('orderbook.empty_title')}
				</h2>
				<p class="mt-2 text-ink-600 dark:text-ink-300">
					{$_('orderbook.empty_body')}
				</p>
			</section>
		{:else if visibleItems.length === 0 && orderDetailsTokens.length > 0}
			<!-- cp411 — the free-text "Order details" search filtered every
			     loaded order out. Offer a clear-search escape hatch rather than
			     an empty list, and echo the query so it's obvious what matched
			     nothing. -->
			<section class="card text-center">
				<h2 class="font-display text-lg font-bold">
					{$_('orderbook.search_no_results_title')}
				</h2>
				<p class="mt-2 text-ink-600 dark:text-ink-300">
					{$_('orderbook.search_no_results_body', {
						values: { query: orderDetailsQuery.trim() }
					})}
				</p>
				<button
					type="button"
					onclick={() => (orderDetailsQuery = '')}
					class="mt-4 rounded-xl border border-ink-300 px-4 py-2 text-sm font-semibold hover:border-morphit-emerald hover:text-morphit-emerald dark:border-ink-700"
				>
					{$_('orderbook.search_clear')}
				</button>
			</section>
		{:else if visibleItems.length === 0 && hiddenInView > 0}
			<!-- Every item in the fetched page is from an account the
			     user has hidden. Offer the temporary-reveal escape
			     hatch rather than falsely claiming the orderbook is
			     empty. -->
			<section class="card text-center">
				<h2 class="font-display text-lg font-bold">
					{$_('orderbook.all_hidden_title')}
				</h2>
				<p class="mt-2 text-ink-600 dark:text-ink-300">
					{$_('orderbook.all_hidden_body', { values: { count: hiddenInView } })}
				</p>
				<button
					type="button"
					onclick={() => (showHiddenTemporarily = true)}
					class="mt-4 rounded-xl border border-ink-300 px-4 py-2 text-sm font-semibold hover:border-morphit-emerald hover:text-morphit-emerald dark:border-ink-700"
				>
					{$_('orderbook.show_hidden_temporarily')}
				</button>
			</section>
		{:else}
			{#if hiddenInView > 0}
				<!-- Transparency line: some items filtered. Users can
				     toggle temporary-reveal to see them in-place (still
				     visually marked) or manage the list in Settings. -->
				<p class="mb-3 text-xs text-ink-500">
					{$_('orderbook.hidden_count_notice', { values: { count: hiddenInView } })}
					{#if !showHiddenTemporarily}
						<button
							type="button"
							onclick={() => (showHiddenTemporarily = true)}
							class="ml-2 font-semibold text-morphit-emerald hover:underline"
						>
							{$_('orderbook.show_hidden_temporarily')}
						</button>
					{:else}
						<button
							type="button"
							onclick={() => (showHiddenTemporarily = false)}
							class="ml-2 font-semibold text-morphit-emerald hover:underline"
						>
							{$_('orderbook.rehide')}
						</button>
					{/if}
				</p>
			{/if}
			<ul class="space-y-3">
				{#each visibleItems as o (o.account + '/' + o.permlink)}
					{@const accountIsHidden = $hiddenAccounts.has(o.account.toLowerCase())}
					{@const accountIsBlocked = $blockedAccounts.has(o.account.toLowerCase())}
					{@const labelProps = extractLabelPropsFromProfile(profileMap[o.account])}
					{@const usdtRowNetwork =
						o.asset === 'USDT' && o.asset_network && isUsdtNetwork(o.asset_network)
							? o.asset_network
							: null}
					{@const usdcRowNetwork =
						o.asset === 'USDC' && o.asset_network && isUsdcNetwork(o.asset_network)
							? o.asset_network
							: null}
					{@const daiRowNetwork =
						o.asset === 'DAI' && o.asset_network && isDaiNetwork(o.asset_network)
							? o.asset_network
							: null}
					{@const networkChip = usdtRowNetwork
						? { label: $_(`assets.usdt.network.${usdtRowNetwork}.displayName`) as string, tone: 'usdt' as const }
						: usdcRowNetwork
							? { label: $_(`assets.usdc.network.${usdcRowNetwork}.displayName`) as string, tone: 'usdc' as const }
							: daiRowNetwork
								? { label: $_(`assets.dai.network.${daiRowNetwork}.displayName`) as string, tone: 'dai' as const }
								: null}
					<OrderCard
						order={o}
						title={cardTitle(o)}
						displayName={labelProps.displayName}
						avatarSvg={labelProps.avatarSvg}
						avatarDataUri={labelProps.avatarDataUri}
						detailHref={lp(`/@${o.account}/${o.permlink}`)}
						profileHref={lp(`/@${o.account}`)}
						messageHref={viewerAccount !== null && viewerAccount !== o.account
							? lp(`/chat/${o.account}?order=${encodeURIComponent(o.permlink)}`)
							: null}
						paymentLabels={displayNamesForMethods(o.payment_methods, instLookup)}
						{networkChip}
						priceModelLabel={formatOrderPriceModel(
							o,
							$_ as unknown as Parameters<typeof formatOrderPriceModel>[1]
						)}
						hidden={accountIsHidden}
						blocked={accountIsBlocked}
						onToggleHide={() => (accountIsHidden ? unhideAccount(o.account) : hideAccount(o.account))}
						onMessageClick={() => void recordOrderView(o.account, o.permlink)}
						highlightTokens={orderDetailsTokens}
						class="animate-fade-up"
					/>
				{/each}
			</ul>

			{#if cursor}
				<div class="mt-6 flex justify-center">
					<BusyButton
						variant="secondary"
						busy={loadingMore}
						busyLabel={$_('common.loading')}
						onclick={loadMore}
					>
						{$_('orderbook.load_more')}
					</BusyButton>
				</div>
			{/if}
		{/if}
	{/if}
</div>
