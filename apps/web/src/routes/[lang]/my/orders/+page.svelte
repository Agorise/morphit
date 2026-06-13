<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	/**
	 * Morphit — "my orders" page.
	 *
	 * Lists the signer's own orders with actions: edit (within the
	 * 15-minute window) and cancel (while live). Cancellation uses a
	 * two-step inline confirm rather than a modal — grandma gets one
	 * explicit "are you sure" prompt before the broadcast.
	 *
	 * After a successful cancel, we refetch from the indexer rather
	 * than just flipping state locally — the indexer is the source
	 * of truth, and a refetch rules out the rare race where another
	 * device cancelled the same order concurrently.
	 */

	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { gotoLocale } from '$i18n/navigate';
	import { get } from 'svelte/store';

	import Head from '$components/Head.svelte';
	import BusyButton from '$components/BusyButton.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	// cp165 byte-budget: 3 disclosure/modal components below are
	// lazy-imported.  None render on first paint; all are gated by
	// state that toggles only after a user action.  Combined the
	// three are ~37 KB of component source plus transitive helpers
	// — non-trivial for /my/orders where Sally lands after every
	// trade.
	// import FeatureBidForm from '$components/FeatureBidForm.svelte';
	// import LeaveFeedbackForm from '$components/LeaveFeedbackForm.svelte';
	// import PendingFeedbackReminderBanner from '$components/PendingFeedbackReminderBanner.svelte';
	import PaymentStatusBadge from '$components/PaymentStatusBadge.svelte';
	import RelativeTime from '$components/RelativeTime.svelte';
	import WriteBlockedReadOnly from '$components/WriteBlockedReadOnly.svelte';

	import { identity, isUnlocked, isPairedReadOnly, hasAnySession } from '$stores/identity';
	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import { broadcastOrderCancel, BroadcastError } from '$blurt/ops/order';
	import { KeystoreError } from '$crypto/keystore';
	import { getOrdersByAccount } from '$lib/indexer/client';
	import { fetchListingFee } from '$lib/orders/listingFee';
	import { fetchOrderViews } from '$lib/orders/views';
	import { formatOrderPriceModel } from '$lib/orders/priceModelDisplay';
	import { MORPHIT_INDEXER_ORIGIN, resolveOrigin } from '$net/config';
	import { safeSession } from '$lib/utils/safeStorage';
	import type { OrderRecord } from '@morphit/indexer-client';

	const blurtAccount = getUserBlurtAccount();

	// ─── Phase + data ──────────────────────────────────────────────
	type Phase = 'loading' | 'ready' | 'error';
	let phase = $state<Phase>('loading');
	let items = $state<OrderRecord[]>([]);
	let errorMessage = $state('');

	// cp165 lazy-loaders for below-the-fold / behind-disclosure components
	const loadFeatureBidForm = () =>
		import('$components/FeatureBidForm.svelte').then((m) => m.default);
	const loadLeaveFeedbackForm = () =>
		import('$components/LeaveFeedbackForm.svelte').then((m) => m.default);
	const loadPendingFeedbackReminderBanner = () =>
		import('$components/PendingFeedbackReminderBanner.svelte').then((m) => m.default);

	// Task #14 — per-permlink viewcount.  Fetched lazily after
	// items load.  Display only — never used for routing or
	// gating.  See lib/orders/views.ts for the privacy-design
	// notes.
	const viewCounts: Record<string, number> = $state({});

	// ─── Filter state ──────────────────────────────────────────────
	type FilterKind = 'all' | 'live' | 'cancelled' | 'expired';
	let filter = $state<FilterKind>('all');

	// ─── Counts per state (derived) ────────────────────────────────
	const counts = $derived.by(() => {
		const c = { all: items.length, live: 0, cancelled: 0, expired: 0 };
		for (const o of items) {
			if (o.status === 'live') c.live++;
			else if (o.status === 'cancelled') c.cancelled++;
			else if (o.status === 'expired') c.expired++;
		}
		return c;
	});

	// ─── Cancel state (per-row) ────────────────────────────────────
	/** Permlink currently in "are you sure?" state. Only one at a
	 *  time — confirming a second one is rare enough that we don't
	 *  need a Set. */
	let pendingCancelPermlink: string | null = $state(null);
	/** Permlink currently mid-broadcast. */
	let cancellingPermlink: string | null = $state(null);
	let cancelErrorPermlink: string | null = $state(null);
	let cancelErrorMessage = $state('');

	// ─── Feature-bid state (per-row) ───────────────────────────────
	// Same one-at-a-time disclosure pattern as cancel. The form
	// component manages its own submit/error state; we just track
	// which row currently has the form open.
	let pendingFeaturePermlink: string | null = $state(null);
	let featureSuccessPermlink: string | null = $state(null);
	let featureSuccessBlurt: number | null = $state(null);

	// Feedback disclosure — parallels feature-bid. One row's form
	// open at a time; LeaveFeedbackForm manages its own submit state.
	let pendingFeedbackPermlink: string | null = $state(null);
	let feedbackSuccessPermlink: string | null = $state(null);

	// ─── Featured-bid rate ─────────────────────────────────────────
	// Lazy-fetched the first time the user opens a FeatureBidForm.
	// undefined → use the form's bundled default (50 BLURT/hr); a
	// number → operator's configured rate from /v1/listing-fee.
	// Per Finding O30 (order-placement audit): without this, an
	// operator running a non-default rate would have their users
	// underpaying feature bids.  Cached per session.
	let featureBlurtPerHour: number | undefined = $state(undefined);
	let featureBlurtPerHourFetched = false;

	async function ensureFeatureRateFetched(): Promise<void> {
		if (featureBlurtPerHourFetched) return;
		featureBlurtPerHourFetched = true;
		const r = await fetchListingFee(resolveOrigin(MORPHIT_INDEXER_ORIGIN));
		if (r.kind === 'ok') {
			const v = r.quote.feature_fee_blurt_per_hour;
			if (typeof v === 'number' && v > 0) {
				featureBlurtPerHour = v;
			}
		}
		// Fetch error: stay on the bundled default.  No user-facing
		// signal — the form will quote the default rate, the
		// indexer will reject if the rate is mismatched, and the
		// rejection UI will surface the issue.  Better than blocking
		// the form opening on a network round-trip.
	}

	async function load(): Promise<void> {
		if (!blurtAccount) {
			phase = 'error';
			errorMessage = $_('my_orders.error.no_account');
			return;
		}
		phase = 'loading';
		const result = await getOrdersByAccount(blurtAccount, { limit: 100 });
		if (!result.ok) {
			console.warn('[my/orders] load failed:', result.message);
			errorMessage = $_('my_orders.error.load_failed');
			phase = 'error';
			return;
		}
		items = [...result.data.items];
		phase = 'ready';
		// Task #14 — kick off viewcount fetches in parallel.
		// Each one independently updates viewCounts as it
		// resolves, so badges appear progressively rather than
		// blocking on the slowest network round-trip.
		void loadViewCounts();

		// cp17 — if the URL hash names a specific order (set by
		// the outbid-push deep link `/my/orders#order-<permlink>`),
		// scroll it into view after the rows have rendered.  Done
		// after `phase = 'ready'` so the {#each} has produced the
		// target element.  requestAnimationFrame gives the DOM one
		// commit cycle before we query.
		if (typeof window !== 'undefined' && window.location.hash.startsWith('#order-')) {
			const id = window.location.hash.slice(1); // 'order-<permlink>'
			// Validate to defend against a malicious hash
			// containing CSS selector special chars.
			if (/^order-[A-Za-z0-9-]+$/.test(id)) {
				requestAnimationFrame(() => {
					const el = document.getElementById(id);
					el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
				});
			}
		}
	}

	async function loadViewCounts(): Promise<void> {
		if (!blurtAccount) return;
		const account = blurtAccount;
		const fetchOne = async (permlink: string): Promise<void> => {
			const r = await fetchOrderViews(account, permlink);
			if (r !== null) {
				viewCounts[permlink] = r.count;
			}
		};
		await Promise.all(items.map((o) => fetchOne(o.permlink)));
	}

	onMount(() => {
		if (blurtAccount) void load();
		// Deep-link support: if URL is /my/orders#feedback=<permlink>,
		// auto-open that order's LeaveFeedbackForm.  The reminder
		// banner uses this to land users directly on the form they
		// need without a second click.  Only fires if the user is
		// unlocked — locked users see the form's "unlock to leave
		// feedback" prompt instead, which is correct.
		if (typeof window !== 'undefined' && window.location.hash) {
			const m = /^#feedback=([A-Za-z0-9-]+)/.exec(window.location.hash);
			if (m && m[1]) {
				pendingFeedbackPermlink = m[1];
			}
		}
		// Sally finding M1/M8 (Part 68): tick once a second so the
		// per-order edit-window countdown updates live.  Cleared on
		// component unmount.  1s granularity is fine — the window
		// is 15 minutes total.
		const t = setInterval(() => {
			nowMs = Date.now();
		}, 1000);
		return () => clearInterval(t);
	});

	/** Live "now" timestamp for edit-window countdowns.  Updated
	 *  by the ticker in onMount.  Per-render reactive: when this
	 *  flips, every {#each} order row re-evaluates its
	 *  remaining-time helper. */
	let nowMs = $state(Date.now());

	/** Edit window — 15 minutes from order creation.  Source of
	 *  truth: indexer's REPLACE_WINDOW_MS at
	 *  apps/indexer/src/indexer/handlers/orderReplace.ts.
	 *  Window extended from 3 to 15 minutes 2026-05-07 per
	 *  ADR-0001 Amendment.  Keep all five frontend mirrors and
	 *  the indexer in sync if changed again. */
	const EDIT_WINDOW_MS = 15 * 60 * 1000;

	const visibleItems = $derived.by(() => {
		switch (filter) {
			case 'live':
				return items.filter((o) => o.status === 'live');
			case 'cancelled':
				return items.filter((o) => o.status === 'cancelled');
			case 'expired':
				return items.filter((o) => o.status === 'expired');
			default:
				return items;
		}
	});

	// ─── Derived helpers ───────────────────────────────────────────
	function withinEditWindow(o: OrderRecord): boolean {
		if (o.status !== 'live') return false;
		const createdMs = new Date(o.created_at).getTime();
		// Read nowMs (the live ticker) so callers re-evaluate when
		// the second hand moves.  Pre-Part-68 this read Date.now()
		// directly, which only updated on full re-render.
		return nowMs - createdMs < EDIT_WINDOW_MS;
	}

	/** Sally finding M1/M8 (Part 68): live remaining-seconds helper
	 *  for the edit-window countdown chip.  Returns null when the
	 *  window has expired, so the template can fall back to the
	 *  "edit window expired" copy. */
	function editWindowRemainingSeconds(o: OrderRecord): number | null {
		if (o.status !== 'live') return null;
		const createdMs = new Date(o.created_at).getTime();
		const remaining = createdMs + EDIT_WINDOW_MS - nowMs;
		if (remaining <= 0) return null;
		return Math.ceil(remaining / 1000);
	}

	/** Format a seconds count as `1m 23s` / `42s` for the
	 *  countdown chip.  Hours are not possible inside a 15-minute
	 *  window, so the format only handles minutes + seconds. */
	function formatRemainingMmSs(seconds: number): string {
		const m = Math.floor(seconds / 60);
		const s = seconds % 60;
		if (m === 0) return `${s}s`;
		return `${m}m ${s}s`;
	}

	function formatAmount(n: number | null): string {
		if (n === null) return '';
		return n % 1 === 0 ? String(n) : n.toFixed(2);
	}

	function formatRange(o: OrderRecord): string {
		const fiat = o.fiat_currency;
		if (o.amount_min !== null && o.amount_max !== null) {
			return $_('my_orders.order.range_both', {
				values: { min: formatAmount(o.amount_min), max: formatAmount(o.amount_max), fiat }
			});
		}
		if (o.amount_min !== null)
			return $_('my_orders.order.range_min_only', {
				values: { min: formatAmount(o.amount_min), fiat }
			});
		if (o.amount_max !== null)
			return $_('my_orders.order.range_max_only', {
				values: { max: formatAmount(o.amount_max), fiat }
			});
		return $_('my_orders.order.range_open', { values: { fiat } });
	}

	function stateLabel(o: OrderRecord): string {
		switch (o.status) {
			case 'live':
				return $_('my_orders.order.state_live');
			case 'cancelled':
				return $_('my_orders.order.state_cancelled');
			case 'expired':
				return $_('my_orders.order.state_expired');
			default:
				return '';
		}
	}

	function feeStatusLabel(o: OrderRecord): string {
		switch (o.fee_status) {
			case 'verified':
				return $_('my_orders.order.fee_verified');
			case 'pending_external':
				return $_('my_orders.order.fee_pending_external');
			case 'verified_by_attestation':
				return $_('my_orders.order.fee_verified_by_attestation');
			case 'reused':
				return $_('my_orders.order.fee_reused');
			case 'missing':
				return $_('my_orders.order.fee_missing');
			case 'underpaid':
				return $_('my_orders.order.fee_underpaid');
			default:
				// Future-proof: if the indexer adds a new fee_status
				// we don't recognize, fall back to the raw string
				// rather than rendering an empty pill.  Order_detail
				// uses the same defensive pattern.
				return o.fee_status ?? '';
		}
	}

	// ─── Re-list flow (item 4) ─────────────────────────────────────
	/** Re-list an expired order.  Maps the OrderRecord back to the
	 *  ComposeDraft shape via the post-page's session-storage prefill
	 *  hook, then navigates.  The user reviews on /post (everything
	 *  pre-filled), edits if desired, optionally promotes to Featured,
	 *  pays a fresh listing fee.  This is NOT an "edit" — it produces
	 *  a brand new order with a fresh permlink and expiration; the
	 *  expired one stays expired.  No silent re-sign of an old listing.
	 *
	 *  Defensive about price_model shape: the on-chain field is
	 *  opaque (Record<string, unknown>) by typing.  We pattern-match
	 *  for the two known shapes ({kind:'spread',percent} or
	 *  {kind:'fixed',price}); anything else falls through to default
	 *  spread=0 so the user can fix manually.
	 */
	function relistOrder(o: OrderRecord): void {
		// Translate the wire price_model back to the form's split
		// state.  Defensive coding — the field is `unknown`-typed
		// because the indexer doesn't validate it; we accept the
		// known shapes and fall back gracefully on anything else.
		let priceModelKind: 'spread' | 'fixed' = 'spread';
		let spreadPercent = '0';
		let fixedPrice = '';
		const pm = o.price_model;
		if (pm && typeof pm === 'object') {
			const obj = pm as Record<string, unknown>;
			if (obj.kind === 'spread' && typeof obj.percent === 'number') {
				priceModelKind = 'spread';
				spreadPercent = String(obj.percent);
			} else if (obj.kind === 'fixed' && typeof obj.price === 'number') {
				priceModelKind = 'fixed';
				fixedPrice = String(obj.price);
			}
		}

		const payload = {
			side: o.side,
			asset: o.asset,
			// cp36 Bob-4 fix — carry forward the multi-network
			// asset's asset_network so /post can pre-hydrate its
			// network picker. Without this, relisting a USDT/USDC/DAI
			// order lands on /post with an empty picker and the user
			// has to remember which network they had.
			assetNetwork: o.asset_network ?? null,
			fiat: o.fiat_currency,
			amountMin: o.amount_min !== null ? String(o.amount_min) : '',
			amountMax: o.amount_max !== null ? String(o.amount_max) : '',
			priceModelKind,
			spreadPercent,
			fixedPrice,
			paymentMethods: [...o.payment_methods],
			region: o.location_region ?? '',
			terms: o.terms ?? '',
			// Default new expiry to 30 days; the user can adjust on
			// the post page.  We deliberately don't carry forward
			// the OLD expiresDays (which already passed) because
			// the user is re-upping fresh — make them pick again.
			expiresDays: 30,
			reason: 'relist'
		};
		safeSession.set('morphit.post.prefill', JSON.stringify(payload));
		void gotoLocale('/post');
	}

	// ─── Cancel flow ───────────────────────────────────────────────
	function requestCancel(permlink: string): void {
		pendingCancelPermlink = permlink;
		cancelErrorPermlink = null;
		cancelErrorMessage = '';
	}

	function abortCancel(): void {
		pendingCancelPermlink = null;
	}

	async function confirmCancel(permlink: string): Promise<void> {
		const state = get(identity);
		if (state.state !== 'unlocked') {
			cancelErrorPermlink = permlink;
			cancelErrorMessage = $_('post_order.broadcast_error.body_locked');
			return;
		}

		cancellingPermlink = permlink;
		pendingCancelPermlink = null;

		try {
			await broadcastOrderCancel(state.live, permlink);
			// Success — refetch to get the indexer's view. Briefly
			// wait 1.5s so the indexer catches the block before we
			// query it; if we race ahead the status will still be
			// 'live' in the response.
			await new Promise((r) => setTimeout(r, 1_500));
			await load();
		} catch (err) {
			console.warn('[my/orders] cancel broadcast failed:', err);
			cancelErrorPermlink = permlink;
			if (err instanceof BroadcastError && err.code === 'locked') {
				cancelErrorMessage = $_('post_order.broadcast_error.body_locked');
			} else if (err instanceof KeystoreError && err.kind === 'bad_password') {
				cancelErrorMessage = $_('post_order.broadcast_error.body_bad_password');
			} else if (err instanceof KeystoreError && err.kind === 'identity_mismatch') {
				cancelErrorMessage = $_('crypto.error.identity_mismatch');
			} else {
				cancelErrorMessage = $_('post_order.broadcast_error.body_generic');
			}
		} finally {
			cancellingPermlink = null;
		}
	}

	// Part 121 cp7 — per-locale internal-link wrapper.  See
	// $i18n/path.localePath() + the analogous helper in
	// [lang]/+layout.svelte for design rationale.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<Head routeKey="my_orders" noindex />

<div class="mx-auto max-w-4xl px-4 py-10 md:py-14">
	<header class="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
		<div>
			<h1 class="font-display text-3xl font-extrabold">
				<span class="brand-gradient-text">{$_('my_orders.heading')}</span>
			</h1>
			<p class="mt-2 text-ink-700 dark:text-ink-200">{$_('my_orders.subtitle')}</p>
			{#if blurtAccount}
				<!-- Batch K: link to user's account on our explorer.
				     Surfaces every chain op the user has authored,
				     including order posts, replace/cancel, feedback. -->
				<p class="mt-2 text-sm">
					<a
						href={lp('/explorer/account/{blurtAccount}')}
						class="text-morphit-emerald underline-offset-2 hover:underline"
					>
						{$_('my_orders.view_on_explorer')} →
					</a>
				</p>
			{/if}
		</div>
		<a href={lp('/post')} class="btn-primary self-start whitespace-nowrap">
			{$_('orderbook.post_cta')}
		</a>
	</header>

	<!-- Item 3: pending-feedback reminder banner.  Lists trades
	     where the counterparty has reviewed > 48h ago and the
	     user hasn't reciprocated.  Embeds LeaveFeedbackForm
	     inline so the user doesn't have to scroll-and-find. -->
	{#if blurtAccount}
		{#await loadPendingFeedbackReminderBanner() then PendingFeedbackReminderBanner}
			<PendingFeedbackReminderBanner />
		{/await}
	{/if}

	{#if !blurtAccount}
		<section class="card text-center">
			<h2 class="font-display text-xl font-bold">
				{$_('post_order.no_account.title')}
			</h2>
			<p class="mt-2 text-ink-600 dark:text-ink-300">
				{$_('post_order.no_account.body')}
			</p>
			<div class="mt-4">
				<BusyButton variant="primary" onclick={() => gotoLocale('/onboarding/register-name')}>
					{$_('post_order.no_account.cta')}
				</BusyButton>
			</div>
		</section>
	{:else if !$isUnlocked && !$isPairedReadOnly}
		<!-- Part 116: only block on "locked" when there is no
		     paired-readonly session either.  Paired sessions fall
		     through to the normal render path; the per-row write
		     affordances swap to WriteBlockedReadOnly inline cards
		     pointing the user at their phone.  Without this branch
		     widening, paired users hit a misleading "session locked,
		     unlock to continue" CTA they can't satisfy (their keys
		     live on their phone). -->
		<section class="card">
			<h2 class="font-display text-xl font-bold">{$_('post_order.locked.title')}</h2>
			<p class="mt-2 text-ink-600 dark:text-ink-300">{$_('post_order.locked.body')}</p>
			<div class="mt-4">
				<BusyButton variant="primary" onclick={() => gotoLocale('/onboarding/import')}>
					{$_('post_order.locked.unlock')}
				</BusyButton>
			</div>
		</section>
	{:else if phase === 'loading'}
		<StatusLine kind="loading">{$_('my_orders.loading')}</StatusLine>
	{:else if phase === 'error'}
		<section
			class="card border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950"
			role="alert"
		>
			<h2 class="font-display text-lg font-bold text-amber-900 dark:text-amber-100">
				{$_('my_orders.error_title')}
			</h2>
			<p class="mt-2 text-sm text-amber-800 dark:text-amber-200">{$_('my_orders.error_body')}</p>
			<p class="mt-1 text-xs text-amber-700 dark:text-amber-300">{errorMessage}</p>
			<div class="mt-4">
				<BusyButton variant="primary" onclick={load}>
					{$_('my_orders.retry')}
				</BusyButton>
			</div>
		</section>
	{:else if items.length === 0}
		<section class="card text-center">
			<h2 class="font-display text-lg font-bold">{$_('my_orders.empty_title')}</h2>
			<p class="mt-2 text-ink-600 dark:text-ink-300">{$_('my_orders.empty_body')}</p>
			<div class="mt-6">
				<BusyButton variant="primary" onclick={() => gotoLocale('/post')}>
					{$_('my_orders.empty_cta')}
				</BusyButton>
			</div>
		</section>

		<!-- Item 16 phase 3 (Item 1.2 from grandma investigation):
		     post-onboarding "what's next" panel.  Surfaces three
		     concrete next steps so a freshly-onboarded user doesn't
		     hit a dead end on /my/orders.  Only renders for the
		     truly-fresh case (zero orders).  -->
		<section class="mt-6">
			<h2 class="mb-4 font-display text-base font-bold">
				{$_('my_orders.next_steps.heading')}
			</h2>
			<div class="grid gap-3 sm:grid-cols-3">
				<a
					href={lp('/orderbook')}
					class="card text-left transition hover:border-morphit-emerald hover:shadow-lg"
				>
					<p class="text-2xl">🔍</p>
					<h3 class="mt-2 font-display text-base font-bold">
						{$_('my_orders.next_steps.browse_title')}
					</h3>
					<p class="mt-1 text-sm text-ink-600 dark:text-ink-300">
						{$_('my_orders.next_steps.browse_body')}
					</p>
				</a>
				<a
					href={lp('/post')}
					class="card text-left transition hover:border-morphit-emerald hover:shadow-lg"
				>
					<p class="text-2xl">✍️</p>
					<h3 class="mt-2 font-display text-base font-bold">
						{$_('my_orders.next_steps.post_title')}
					</h3>
					<p class="mt-1 text-sm text-ink-600 dark:text-ink-300">
						{$_('my_orders.next_steps.post_body')}
					</p>
				</a>
				<a
					href={lp('/faq#how_to_trade_walkthrough')}
					class="card text-left transition hover:border-morphit-emerald hover:shadow-lg"
				>
					<p class="text-2xl">📖</p>
					<h3 class="mt-2 font-display text-base font-bold">
						{$_('my_orders.next_steps.walkthrough_title')}
					</h3>
					<p class="mt-1 text-sm text-ink-600 dark:text-ink-300">
						{$_('my_orders.next_steps.walkthrough_body')}
					</p>
				</a>
			</div>
		</section>
	{:else}
		<!-- Filter chips -->
		<section class="mb-4">
			<p class="mb-2 text-sm font-semibold">{$_('my_orders.filter.heading')}</p>
			<div class="flex gap-2">
				{#each ['all', 'live', 'cancelled', 'expired'] as f}
					<button
						type="button"
						onclick={() => (filter = f as FilterKind)}
						class="rounded-full border-2 px-4 py-1 text-sm transition active:scale-[0.98] {filter ===
						f
							? 'border-morphit-emerald bg-emerald-50 dark:bg-ink-800'
							: 'border-ink-200 dark:border-ink-700'}"
					>
						{$_(`my_orders.filter.${f}`)}
						<span class="ml-1 text-xs text-ink-500">
							({counts[f as FilterKind]})
						</span>
					</button>
				{/each}
			</div>
		</section>

		<!-- Orders list -->
		<ul id="fee-status" class="space-y-3">
			{#each visibleItems as o (o.permlink)}
				{@const priceModelLabel = formatOrderPriceModel(
					o,
					$_ as unknown as Parameters<typeof formatOrderPriceModel>[1]
				)}
				<li id="order-{o.permlink}" class="card-interactive scroll-mt-20">
					<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
						<div class="flex-1">
							<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
								<span class="font-display text-lg font-bold">
									{o.side === 'buy'
										? $_('my_orders.order.buying', { values: { asset: o.asset } })
										: $_('my_orders.order.selling', { values: { asset: o.asset } })}
								</span>
								<span class="text-sm text-ink-600 dark:text-ink-300">
									{formatRange(o)}
								</span>
								{#if priceModelLabel !== null}
									<span
										class="text-sm text-ink-500 dark:text-ink-400"
										title={$_('orderbook.price_model.tooltip') as string}
									>
										· {priceModelLabel}
									</span>
								{/if}
							</div>
							<div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
								<span class="rounded-full border border-ink-300 px-2 py-0.5 dark:border-ink-600">
									{stateLabel(o)}
								</span>
								<PaymentStatusBadge orderPermlink={o.permlink} />
								{#if o.fee_status === 'verified' || o.fee_status === 'verified_by_attestation'}
									<span
										class="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-emerald-900 dark:bg-ink-800 dark:text-emerald-100"
									>
										{feeStatusLabel(o)}
									</span>
								{:else if o.fee_status}
									<span
										class="rounded-full border border-amber-400 bg-amber-50 px-2 py-0.5 text-amber-900 dark:bg-amber-950 dark:text-amber-100"
									>
										{feeStatusLabel(o)}
									</span>
									<a
										href={lp('/faq#order_fee_rejected')}
										class="text-ink-500 underline hover:no-underline"
									>
										{$_('my_orders.order.fee_learn_more')}
									</a>
								{/if}
								<span class="text-ink-500">
									{$_('my_orders.order.posted_prefix')}
									<RelativeTime iso={o.created_at} format="terse" />
								</span>
								{#if viewCounts[o.permlink] !== undefined && viewCounts[o.permlink]! > 0}
									<!-- Task #14 — viewcount badge.  Visible only
									     to the order's author (this page only ever
									     shows the author's own orders).  Count is
									     non-unique by design — see
									     lib/orders/views.ts for the privacy
									     rationale. -->
									<span class="text-ink-500" title={$_('my_orders.order.viewed_tooltip')}>
										<span aria-hidden="true">👁</span>
										{$_('my_orders.order.viewed_count', {
											values: { count: viewCounts[o.permlink] }
										})}
									</span>
								{/if}
							</div>

							{#if o.terms}
								<p class="mt-2 text-sm text-ink-700 dark:text-ink-200">{o.terms}</p>
							{/if}
						</div>

						<!-- Action column -->
						<div class="flex flex-none flex-col gap-2 sm:min-w-[10rem]">
							{#if o.status === 'live'}
								{#if withinEditWindow(o)}
									{@const remaining = editWindowRemainingSeconds(o)}
									<BusyButton variant="secondary" onclick={() => gotoLocale(`/post/edit/${o.permlink}`)}>
										{$_('my_orders.order.action_edit')}
									</BusyButton>
									<!-- Sally finding M1/M8 (Part 68): live
									     countdown.  Pre-Part-68 the user
									     saw a button that suddenly turned
									     into "edit window expired" with no
									     warning.  Now there's a visible
									     ticking timer that goes red+pulse
									     under 30s so the user feels the
									     deadline. -->
									{#if remaining !== null}
										<span
											class="self-end rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums {remaining <=
											30
												? 'animate-pulse bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200'
												: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'}"
											title={$_('my_orders.order.edit_window_tooltip') as string}
											aria-label={$_('my_orders.order.edit_window_aria', {
												values: { remaining: formatRemainingMmSs(remaining) }
											}) as string}
										>
											{$_('my_orders.order.edit_window_countdown', {
												values: { remaining: formatRemainingMmSs(remaining) }
											})}
										</span>
									{/if}
								{:else}
									<span class="text-xs text-ink-500">
										{$_('my_orders.order.action_edit_expired')}
									</span>
								{/if}

								<!-- Feature-bid disclosure. Only appears when requested
								     and hides itself on cancel / success. The form
								     pulls identity state itself; no prop plumbing
								     needed. -->
								{#if pendingFeaturePermlink === o.permlink && $isUnlocked}
									{#await loadFeatureBidForm() then FeatureBidForm}
										<FeatureBidForm
											orderPermlink={o.permlink}
											feeBlurtPerHour={featureBlurtPerHour}
											onSuccess={(r) => {
												pendingFeaturePermlink = null;
												featureSuccessPermlink = o.permlink;
												featureSuccessBlurt = r.blurtPaid;
											}}
											onCancel={() => (pendingFeaturePermlink = null)}
										/>
									{/await}
								{:else if featureSuccessPermlink === o.permlink}
									<StatusLine kind="ok">
										{$_('feature_bid.success', {
											values: { blurt: featureSuccessBlurt ?? 0 }
										})}
									</StatusLine>
								{:else if o.fee_status === 'verified' || o.fee_status === 'verified_by_attestation'}
									{#if $isPairedReadOnly}
										<!-- Part 116: paired-readonly users see an inline
										     affordance pointing them at their phone instead
										     of a button that opens a form they can't sign.
										     Permlink is preserved in the deep link
										     (#feature=<permlink>) so the phone lands on
										     the right order. -->
										<WriteBlockedReadOnly
											variant="feature_order"
											orderPermlink={o.permlink}
											density="inline"
										/>
									{:else}
										<BusyButton
											variant="secondary"
											onclick={() => {
												pendingFeaturePermlink = o.permlink;
												// Lazy-fetch the operator's configured
												// per-hour rate.  Resolves quickly; the
												// form opens with the bundled default and
												// re-renders once the real value lands.
												void ensureFeatureRateFetched();
											}}
										>
											⭐ {$_('my_orders.order.action_feature')}
										</BusyButton>
									{/if}
								{/if}

								<!-- Feedback disclosure: user marks this trade
								     complete + reviews their counterparty. Per
								     ADR-0011 §8, feedback IS the trade-complete
								     signal. -->
								{#if pendingFeedbackPermlink === o.permlink && $isUnlocked}
									{#await loadLeaveFeedbackForm() then LeaveFeedbackForm}
										<LeaveFeedbackForm
											orderPermlink={o.permlink}
											onSuccess={() => {
												pendingFeedbackPermlink = null;
												feedbackSuccessPermlink = o.permlink;
											}}
											onCancel={() => (pendingFeedbackPermlink = null)}
										/>
									{/await}
								{:else if feedbackSuccessPermlink === o.permlink}
									<StatusLine kind="ok">
										{$_('feedback.success_line')}
									</StatusLine>
								{:else if $isPairedReadOnly}
									<!-- Part 116: paired-readonly affordance.  The
									     `feedback` variant deep-link expects `peer`
									     (the counterparty); orderPermlink here points
									     at the *order* so the phone can resolve the
									     counterparty.  We use the `feedback` variant
									     copy verbatim but the deep link goes to
									     /my/orders so the user lands on the same row. -->
									<WriteBlockedReadOnly
										variant="feedback"
										peer={blurtAccount}
										orderPermlink={o.permlink}
										density="inline"
									/>
								{:else}
									<BusyButton
										variant="secondary"
										onclick={() => (pendingFeedbackPermlink = o.permlink)}
									>
										{$_('my_orders.order.action_feedback')}
									</BusyButton>
								{/if}

								{#if pendingCancelPermlink === o.permlink}
									<!-- Inline confirm card -->
									<div
										class="rounded-xl border-2 border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950"
									>
										<p class="mb-1 text-sm font-semibold text-amber-900 dark:text-amber-100">
											{$_('my_orders.cancel.confirm_title')}
										</p>
										<p class="mb-3 text-xs text-amber-800 dark:text-amber-200">
											{$_('my_orders.cancel.confirm_body')}
										</p>
										<div class="flex flex-col gap-2">
											<BusyButton
												variant="primary"
												busy={cancellingPermlink === o.permlink}
												busyLabel={$_('my_orders.cancel.cancelling')}
												onclick={() => confirmCancel(o.permlink)}
											>
												{$_('my_orders.cancel.confirm_button')}
											</BusyButton>
											<BusyButton variant="ghost" onclick={abortCancel}>
												{$_('my_orders.cancel.cancel_button')}
											</BusyButton>
										</div>
									</div>
								{:else if $isPairedReadOnly}
									<!-- Part 116: paired-readonly users see an inline
									     affordance.  Permlink preserved in the
									     #cancel=<permlink> deep link. -->
									<WriteBlockedReadOnly
										variant="cancel_order"
										orderPermlink={o.permlink}
										density="inline"
									/>
								{:else}
									<BusyButton variant="ghost" onclick={() => requestCancel(o.permlink)}>
										{$_('my_orders.order.action_cancel')}
									</BusyButton>
								{/if}
							{:else if o.status === 'cancelled'}
								<span class="text-xs text-ink-500">
									{$_('my_orders.order.action_cancelled')}
								</span>
							{:else if o.status === 'expired'}
								<!-- Item 4: Re-list expired orders.  Pre-fills the
								     post form with the original terms; user can edit,
								     promote to Featured, pays a fresh listing fee.
								     Avoids retyping. -->
								<BusyButton variant="secondary" onclick={() => relistOrder(o)}>
									{$_('my_orders.order.action_relist')}
								</BusyButton>
								<span class="text-xs text-ink-500 dark:text-ink-400">
									{$_('my_orders.order.action_relist_hint')}
								</span>
							{/if}
							{#if cancelErrorPermlink === o.permlink && cancelErrorMessage}
								<StatusLine kind="warn">{cancelErrorMessage}</StatusLine>
							{/if}
						</div>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>
