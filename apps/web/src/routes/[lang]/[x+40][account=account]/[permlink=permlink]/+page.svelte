<script lang="ts">
	import { formatDayMonth } from '$lib/i18n/formatters';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { orderTitleParts } from '$lib/utils/orderTitle';

	// cp242 — per-locale internal-link wrapper (cp7 design: every
	// internal link is locale-prefixed; bare 2-segment paths 404).
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
	/**
	 * Order detail page — /@{account}/{permlink}
	 *
	 * Public read-only view of a single order. Shows everything a
	 * counterparty needs to evaluate whether to trade: the offer
	 * itself (side, asset, range, fiat, payment methods, terms,
	 * location, expiry) plus the poster's identity and a link back
	 * to their profile for reputation.
	 *
	 * Owner actions live here too (cp363+): when the signed-in user
	 * is the poster, an owner-only card offers edit/cancel while the
	 * order is live, and Re-list once it has expired — mirroring the
	 * affordances on /my/orders so either entry point works.
	 *
	 * Anonymous browsing is intentional. Someone evaluating a
	 * potential trade shouldn't have to sign in to read the terms;
	 * only ACTING on the order (chatting, replying) requires auth,
	 * and those actions are handled elsewhere.
	 *
	 * Fetch strategy: the indexer has no single-order endpoint, so
	 * we fetch the account's orders (limit 100) and filter locally.
	 * Same pattern as /post/edit/[permlink]. A user with >100 orders
	 * would need pagination; not a Phase 5 problem.
	 */

	import { onMount, onDestroy } from 'svelte';
	import {
		EDIT_WINDOW_MS,
		editWindowRemainingSeconds,
		formatRemainingMmSs,
		withinEditWindow as withinEditWindowFor
	} from '$lib/orders/editWindow';
	import { _ } from 'svelte-i18n';
	import { page } from '$app/stores';
	import { gotoLocale } from '$i18n/navigate';
	import { get } from 'svelte/store';

	import Head from '$components/Head.svelte';
	import TermsText from '$components/TermsText.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import BusyButton from '$components/BusyButton.svelte';
	import ConfirmModal from '$components/ConfirmModal.svelte';
	import MessageIcon from '$components/MessageIcon.svelte';
	import OrderPosterIdentity from '$components/OrderPosterIdentity.svelte';
	import WriteBlockedReadOnly from '$components/WriteBlockedReadOnly.svelte';
	import { identity, isUnlocked, isPairedReadOnly } from '$stores/identity';
	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import { broadcastOrderCancel, BroadcastError } from '$blurt/ops/order';
	import { KeystoreError } from '$crypto/keystore';
	import { getOrdersByAccount } from '$lib/indexer/client';
	import { getProfileCached } from '$lib/indexer/profileCache';
	import { extractLabelPropsFromProfile } from '$lib/indexer/profileProps';
	import { fetchAccountKeys } from '$blurt/accountKeys';
	import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';
	import { displayNamesForMethods } from '$lib/payments/display';
	import { formatOrderPriceModel } from '$lib/orders/priceModelDisplay';
	import { isOrderExpired, isOrderLive } from '$lib/orders/orderExpiry';
	import { buildRelistPrefill, RELIST_PREFILL_KEY } from '$lib/orders/relist';
	import { safeSession } from '$lib/utils/safeStorage';
	import { instanceAdditions, instanceNameLookup } from '$lib/stores/instanceAdditions';
	import type { OrderRecord, ProfileResponse } from '@morphit/indexer-client';

	// account + permlink are route parameters; always defined.
	// The non-null assertions are safe because SvelteKit would
	// not have routed here without them.
	const account = $derived($page.params.account!);
	const permlink = $derived($page.params.permlink!);
	const viewerAccount = getUserBlurtAccount();

	// ─── State ─────────────────────────────────────────────────────
	type Phase = 'loading' | 'ready' | 'not_found' | 'error' | 'pending';
	let phase = $state<Phase>('loading');
	let order = $state<OrderRecord | null>(null);
	let errorMessage = $state('');

	// #16 — retry window for a freshly-posted order that hasn't indexed yet.
	// ~8 tries × 3s ≈ 24s, comfortably longer than Blurt block time + indexer
	// poll lag, so a just-posted order resolves to 'ready' without the user
	// ever seeing not-found.
	const ORDER_RETRY_ATTEMPTS = 8;
	const ORDER_RETRY_INTERVAL_MS = 3000;
	let orderRetryTimer: ReturnType<typeof setTimeout> | null = null;
	/** Batch L: payment-method display lookup with instance
	 *  additions (subscription side-effect populates the cache). */
	const instLookup = $derived.by(() => {
		// Read $instanceAdditions to register a reactive
		// dependency — the lookup helper is a stable function,
		// but it reads the store-backed cache, so we want this
		// derived to re-evaluate when additions change.
		void $instanceAdditions;
		return instanceNameLookup;
	});

	/** Price-model label.  Hoisted to the script (rather than via
	 *  {@const} inline in the template) because Svelte 5 requires
	 *  {@const} to be the immediate child of a control-flow block,
	 *  and this label is read at the top level of the template. */
	const priceModelLabel = $derived(
		order
			? formatOrderPriceModel(order, $_ as unknown as Parameters<typeof formatOrderPriceModel>[1])
			: null
	);

	/** Poster profile — for custom avatar + display name on the
	 *  poster card. Best-effort; null if the server has no profile
	 *  or the fetch fails, in which case OrderPosterIdentity falls back
	 *  to the identicon + account name. Hits the shared profile
	 *  cache, so a user who came from the orderbook page gets it
	 *  instantly without a second round-trip. */
	let posterProfile = $state<ProfileResponse | null>(null);

	/** Poster identity-label props derived from the profile fetch.
	 *  Hoisted for the same reason as priceModelLabel above. */
	const posterLabelProps = $derived(extractLabelPropsFromProfile(posterProfile));

	/** Poster's canonical BLT posting-key string, fetched from the
	 *  indexer's /keys proxy (same-origin, no dblurt). Rendered as a
	 *  truncated key under the poster's display name so a viewer can
	 *  verify the cryptographic identity behind the @name — the durable
	 *  anchor that survives display-name changes and helps expose
	 *  impersonation later. Best-effort; null if unavailable. */
	let posterPostingKey = $state<string | null>(null);

	// ─── Owner-only action state ──────────────────────────────────
	/** True once the user has clicked Cancel — opens the confirm
	 *  modal. A second tap is a no-op while already true. */
	let pendingCancel = $state(false);
	/** Non-empty when the last cancel attempt failed. */
	let cancelError = $state('');

	async function loadOrder(attempt = 0): Promise<void> {
		if (attempt === 0) phase = 'loading';
		const r = await getOrdersByAccount(account, { limit: 100 });
		if (!r.ok) {
			console.warn('[listing-detail] loadOrder failed:', r.message);
			errorMessage = $_('order_detail.error_load_failed');
			phase = 'error';
			return;
		}
		const found = r.data.items.find((o) => o.permlink === permlink);
		if (found) {
			order = found;
			phase = 'ready';
			return;
		}
		// Not found (yet). #16 — a user who just posted lands here via the
		// success screen's "View my order" button before the indexer has seen
		// the new block, so an instant "Order not found" reads as "my money
		// vanished". A freshly-posted order is almost always just mid-indexing
		// (block time + indexer poll lag), so show a reassuring "still posting"
		// state and retry a few times before ever saying not-found.
		if (attempt < ORDER_RETRY_ATTEMPTS) {
			phase = 'pending';
			orderRetryTimer = setTimeout(() => {
				void loadOrder(attempt + 1);
			}, ORDER_RETRY_INTERVAL_MS);
			return;
		}
		phase = 'not_found';
	}

	/** Manual "check again" from the pending / not-found state — restarts the
	 *  retry loop from scratch so an impatient user can re-poll on demand. */
	function retryLoadOrder(): void {
		if (orderRetryTimer !== null) {
			clearTimeout(orderRetryTimer);
			orderRetryTimer = null;
		}
		void loadOrder(0);
	}

	async function loadPosterProfile(): Promise<void> {
		// Silent: if the profile fetch fails, OrderPosterIdentity renders
		// its identicon fallback cleanly.
		posterProfile = await getProfileCached(account);
	}

	async function loadPosterPostingKey(): Promise<void> {
		// Best-effort, same-origin (indexer /keys proxy — no browser→RPC,
		// no dblurt on this page). Silent on failure: the poster card
		// still shows the name + identicon, just without the key line.
		try {
			const keys = await fetchAccountKeys(resolveOrigin(MORPHIT_INDEXER_ORIGIN), account, fetch);
			const k = keys?.posting?.key_auths?.[0]?.[0];
			posterPostingKey = typeof k === 'string' ? k : null;
		} catch {
			posterPostingKey = null;
		}
	}

	onMount(() => {
		void loadOrder();
		void loadPosterProfile();
		void loadPosterPostingKey();
	});

	onDestroy(() => {
		if (orderRetryTimer !== null) {
			clearTimeout(orderRetryTimer);
			orderRetryTimer = null;
		}
	});

	// ─── Ownership + owner-only actions ────────────────────────────

	/** True when the signed-in user is the account that posted this
	 *  order. Gates the visibility of edit/cancel affordances. The
	 *  indexer re-checks on broadcast — this derivation only controls
	 *  UI. A viewer with matching account but stale unlock state
	 *  still sees the buttons; the unlock gate triggers on submit. */
	const isOwner = $derived(
		viewerAccount !== null && order !== null && viewerAccount === order.account
	);

	// ─── Live "now" ticker ─────────────────────────────────────────
	// So the status pill flips Live→Expired and the "expires in"
	// countdown updates the instant an order crosses its expiry —
	// without a reload. 1s granularity; cleared on unmount. Mirrors
	// the /my/orders ticker. #21 — it also drives the Edit-button countdown, so
	// the button removes itself the second the 15-minute window closes.
	let nowMs = $state(Date.now());
	$effect(() => {
		const t = setInterval(() => {
			nowMs = Date.now();
		}, 1000);
		return () => clearInterval(t);
	});

	/** Effective (query-time) status. The indexer keeps an order's
	 *  stored status at 'live' until a sweep and enforces expiry at
	 *  query time (expires_at ≤ now), so an order the public orderbook
	 *  has already dropped still arrives here as 'live'. This reads it
	 *  as 'expired' — matching the orderbook and /my/orders — via the
	 *  shared orderExpiry helper. Reads nowMs to re-evaluate over time. */
	function effectiveStatus(o: OrderRecord): OrderRecord['status'] {
		return isOrderExpired(o, nowMs) ? 'expired' : o.status;
	}

	/** Re-list an expired order: hand /post a prefill of this order and
	 *  navigate. Uses the SAME shared builder as /my/orders so both
	 *  entry points re-list identically (a fresh order, fresh permlink
	 *  + expiry — never a silent re-sign of the old one). */
	function relistOrder(): void {
		if (!order) return;
		safeSession.set(RELIST_PREFILL_KEY, JSON.stringify(buildRelistPrefill(order)));
		void gotoLocale('/post');
	}

	/** Edit window: 15 minutes from creation, same rule as /my/orders — now
	 *  literally the same code (`$lib/orders/editWindow`), not a second copy.
	 *  The edit path at /post/edit/[permlink] also enforces this on entry, so a
	 *  stale UI state just lands the user on a "window expired" page rather than
	 *  letting them edit what they can't. */
	function withinEditWindow(o: OrderRecord): boolean {
		if (o.status !== 'live') return false;
		return withinEditWindowFor(o.created_at, nowMs);
	}

	/** Seconds left, or null once closed. Drives the countdown label. */
	function editSecondsLeft(o: OrderRecord): number | null {
		if (o.status !== 'live') return null;
		return editWindowRemainingSeconds(o.created_at, nowMs);
	}

	/** The "Editing closed (15 min window)" note is only worth showing
	 *  in the short grace period right after the 15-min edit window
	 *  lapses. Once the order has been live ≥20 minutes the note stops
	 *  showing — by then the user knows editing is closed and the note
	 *  is just clutter next to the Cancel button. */
	function withinEditClosedNotice(o: OrderRecord): boolean {
		if (o.status !== 'live') return false;
		const age = Date.now() - new Date(o.created_at).getTime();
		// EDIT_WINDOW_MS, not a second literal 15 minutes on the same page.
		return age >= EDIT_WINDOW_MS && age < EDIT_WINDOW_MS + 5 * 60 * 1000;
	}

	function requestCancel(): void {
		cancelError = '';
		pendingCancel = true;
	}

	function abortCancel(): void {
		pendingCancel = false;
	}

	async function confirmCancel(): Promise<void> {
		if (!order) return;
		const state = get(identity);
		if (state.state !== 'unlocked') {
			cancelError = $_('post_order.broadcast_error.body_locked') as string;
			pendingCancel = false;
			return;
		}
		cancelError = '';
		let cancelled = false;
		try {
			await broadcastOrderCancel(state.live, order.permlink);
			cancelled = true;
			// The 1.5s pause lets the indexer see the block first (same wait the
			// /my/orders page itself uses after a cancel), so the list we land on
			// already reflects the new status rather than flashing the old one.
			await new Promise((r) => setTimeout(r, 1_500));
		} catch (err) {
			console.warn('[listing-detail] cancel broadcast failed:', err);
			if (err instanceof BroadcastError && err.code === 'locked') {
				cancelError = $_('post_order.broadcast_error.body_locked') as string;
			} else if (err instanceof KeystoreError && err.kind === 'bad_password') {
				cancelError = $_('post_order.broadcast_error.body_bad_password') as string;
			} else if (err instanceof KeystoreError && err.kind === 'identity_mismatch') {
				cancelError = $_('crypto.error.identity_mismatch') as string;
			} else {
				cancelError = $_('post_order.broadcast_error.body_generic') as string;
			}
		} finally {
			pendingCancel = false;
		}

		// Ken: confirming the cancel used to leave you sitting on the same page,
		// still staring at the red "Cancel this order" button, with no evidence
		// anything happened. Take the user to /my/orders, where the order now
		// shows as Cancelled.
		//
		// This lives OUTSIDE the try on purpose. A SvelteKit navigation can
		// reject (an aborted/superseded navigation, a hook throwing). Inside the
		// try, that rejection would be caught by the `catch` above and rendered
		// as "the broadcast failed" — a flat lie about an order that IS cancelled
		// on chain, and an invitation to cancel it again. The modal is already
		// closed by `finally`, so a back-button return doesn't land on an open
		// dialog. We deliberately DON'T re-fetch the order we're leaving:
		// loadOrder() would start a retry timer we'd only have to tear down.
		if (cancelled) {
			await gotoLocale('/my/orders');
		}
	}

	// ─── Derived view state ────────────────────────────────────────

	function formatTimeUntil(iso: string): string {
		const diff = new Date(iso).getTime() - Date.now();
		if (diff <= 0) return $_('profile.expires_now') as string;
		const minutes = Math.floor(diff / 60_000);
		if (minutes < 1) return '<1m';
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h`;
		const days = Math.floor(hours / 24);
		return `${days}d`;
	}

	function formatAbsoluteDate(iso: string): string {
		// Sitewide canonical date format ("30 June, 2026").
		return formatDayMonth(iso);
	}

	/** Pretty label for the order status. */
	function statusLabel(s: OrderRecord['status']): string {
		switch (s) {
			case 'live':
				return $_('order_detail.status_live') as string;
			case 'cancelled':
				return $_('order_detail.status_cancelled') as string;
			case 'expired':
				return $_('order_detail.status_expired') as string;
			default:
				return '';
		}
	}

	/** CSS classes for the status chip, color-coded by meaning. */
	function statusChipClasses(s: OrderRecord['status']): string {
		const base = 'rounded-full border px-2 py-0.5 text-xs font-semibold ';
		switch (s) {
			case 'live':
				return (
					base +
					'border-morphit-emerald bg-emerald-50 text-emerald-900 dark:bg-ink-800 dark:text-emerald-100'
				);
			case 'cancelled':
				return (
					base +
					'border-ink-300 bg-ink-50 text-ink-700 dark:border-ink-600 dark:bg-ink-900 dark:text-ink-300'
				);
			case 'expired':
				return (
					base +
					'border-ink-300 bg-ink-50 text-ink-700 dark:border-ink-600 dark:bg-ink-900 dark:text-ink-300'
				);
			default:
				return base + 'border-ink-300 text-ink-600';
		}
	}
</script>

<Head routeKey="order_detail" />

<div class="mx-auto max-w-3xl px-4 py-10 md:py-14">
	{#if phase === 'loading'}
		<StatusLine kind="loading">{$_('order_detail.loading')}</StatusLine>
	{:else if phase === 'pending'}
		<!-- #16 — freshly posted, not yet indexed. Reassure instead of alarming
		     the user (their order isn't lost, the chain is still confirming it)
		     and keep auto-retrying; a manual "check again" is offered too. -->
		<section class="card text-center">
			<div
				class="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-ink-300 border-t-morphit-emerald dark:border-ink-700"
				aria-hidden="true"
			></div>
			<h1 class="font-display text-xl font-bold">
				{$_('order_detail.posting_title')}
			</h1>
			<p class="mt-2 text-ink-600 dark:text-ink-300">
				{$_('order_detail.posting_body')}
			</p>
			<div class="mt-4">
				<button
					type="button"
					onclick={retryLoadOrder}
					class="font-semibold text-morphit-emerald hover:underline"
				>
					{$_('order_detail.check_again')}
				</button>
			</div>
		</section>
	{:else if phase === 'not_found'}
		<section class="card text-center">
			<h1 class="font-display text-2xl font-extrabold">
				{$_('order_detail.not_found_title')}
			</h1>
			<p class="mt-2 text-ink-600 dark:text-ink-300">
				{$_('order_detail.not_found_body')}
			</p>
			<div class="mt-4 flex flex-col items-center gap-2 sm:flex-row sm:justify-center sm:gap-4">
				<button
					type="button"
					onclick={retryLoadOrder}
					class="font-semibold text-morphit-emerald hover:underline"
				>
					{$_('order_detail.check_again')}
				</button>
				<a href={lp(`/@${account}`)} class="font-semibold text-morphit-emerald hover:underline">
					{$_('order_detail.back_to_profile')}
				</a>
			</div>
		</section>
	{:else if phase === 'error'}
		<section class="card border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-950" role="alert">
			<h1 class="font-display text-lg font-bold text-red-900 dark:text-red-100">
				{$_('order_detail.error_title')}
			</h1>
			<p class="mt-2 text-sm text-red-800 dark:text-red-200">
				{$_('order_detail.error_body')}
			</p>
			<p class="mt-1 text-xs text-red-700 dark:text-red-300">{errorMessage}</p>
		</section>
	{:else if order}
		{@const orderTitle = orderTitleParts(order)}
		<!-- ─── Order headline ──────────────────────────────────── -->
		<section class="mb-6">
			<h1 class="mb-2 font-display text-3xl font-extrabold">
				<span class="brand-gradient-text"
					>{$_(orderTitle.key, { values: orderTitle.values }) as string}</span
				>
			</h1>
			{#if priceModelLabel !== null}
				<div
					class="mt-1 text-base text-ink-600 dark:text-ink-300"
					aria-label={$_('orderbook.price_model.tooltip') as string}
				>
					<span
						class="text-xs font-semibold uppercase tracking-wide text-ink-500 dark:text-ink-400"
					>
						{$_('order_detail.price_label')}:
					</span>
					{priceModelLabel}
				</div>
			{/if}
			<div class="mt-3 flex flex-wrap items-center gap-2">
				<span class={statusChipClasses(effectiveStatus(order))}>
					{statusLabel(effectiveStatus(order))}
				</span>
				{#if isOrderLive(order, nowMs) && order.expires_at}
					<span
						class="rounded-full border border-morphit-emerald/30 bg-morphit-emerald/5 px-2 py-0.5 text-xs text-morphit-emerald"
					>
						{$_('profile.expires_in', { values: { t: formatTimeUntil(order.expires_at) } })}
					</span>
				{/if}
			</div>
		</section>

		<!-- ─── Poster card ─────────────────────────────────────── -->
		<section class="card mb-6" aria-labelledby="poster-heading">
			<h2
				id="poster-heading"
				class="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500"
			>
				{$_('order_detail.posted_by')}
			</h2>
			<OrderPosterIdentity
				{order}
				displayName={posterLabelProps.displayName}
				avatarSvg={posterLabelProps.avatarSvg}
				avatarDataUri={posterLabelProps.avatarDataUri}
				profileHref={lp(`/@${order.account}`)}
				postingKeyOverride={posterPostingKey}
			/>
			<!-- Message button: non-owners on a live order get a
			     direct link into the chat with the poster. Owners
			     don't see it — they can't message themselves; the
			     inbox is how they'd reach inbound messages. -->
			{#if isOrderLive(order, nowMs) && !isOwner}
				<div class="mt-4">
					<a
						href={lp(`/chat/${order.account}?order=${encodeURIComponent(order.permlink)}`)}
						class="inline-flex items-center gap-1 rounded-xl border-2 border-morphit-emerald bg-morphit-emerald/10 px-3 py-1.5 text-sm font-semibold text-morphit-emerald transition hover:bg-morphit-emerald hover:text-ink-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald"
						aria-label={$_('chat.message_button_aria', {
							values: { peer: order.account }
						}) as string}
					>
						<MessageIcon />
						{$_('chat.message_button_label_named', { values: { account: order.account } })}
					</a>
				</div>
			{/if}
		</section>

		<!-- ─── Details ──────────────────────────────────────────── -->
		<section class="card mb-6" aria-labelledby="details-heading">
			<h2
				id="details-heading"
				class="mb-4 text-sm font-semibold uppercase tracking-wide text-ink-500"
			>
				{$_('order_detail.details_heading')}
			</h2>
			<dl class="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
				<!-- LEFT column: how and where this person wants to trade -->
				<div class="space-y-3">
					{#if order.payment_methods.length > 0}
						<div>
							<dt class="text-xs text-ink-500">{$_('order_detail.payment_methods')}</dt>
							<dd class="mt-1 flex flex-wrap gap-1.5">
								{#each displayNamesForMethods(order.payment_methods, instLookup) as pm}
									<span
										class="rounded-full border border-ink-200 bg-white px-2 py-0.5 text-xs dark:border-ink-700 dark:bg-ink-900"
									>
										{pm}
									</span>
								{/each}
							</dd>
						</div>
					{/if}

					{#if order.location_region}
						<div>
							<dt class="text-xs text-ink-500">{$_('order_detail.location')}</dt>
							<dd class="mt-1 text-sm">{order.location_region}</dd>
						</div>
					{/if}
				</div>

				<!-- RIGHT column: timing and listing fee -->
				<div class="space-y-3">
					<!-- Posted-on + Expires-on sit side by side (including on
					     mobile) so the two dates read as a pair instead of
					     stacking one above the other. -->
					<div class="grid grid-cols-2 gap-x-4">
						<div>
							<dt class="text-xs text-ink-500">{$_('order_detail.posted_on')}</dt>
							<dd class="mt-1 text-sm tabular-nums">
								{formatAbsoluteDate(order.created_at)}
							</dd>
						</div>

						{#if order.expires_at}
							<div>
								<dt class="text-xs text-ink-500">{$_('order_detail.expires_on')}</dt>
								<dd class="mt-1 text-sm tabular-nums">
									{formatAbsoluteDate(order.expires_at)}
								</dd>
							</div>
						{/if}
					</div>

					{#if order.fee_status}
						<div>
							<dt class="text-xs text-ink-500">{$_('order_detail.listing_fee')}</dt>
							<dd class="mt-1 text-sm">
								{#if order.fee_status === 'verified'}
									<span class="text-emerald-700 dark:text-emerald-300">
										✓ {$_('order_detail.fee_verified')}
									</span>
								{:else if order.fee_status === 'verified_by_attestation'}
									<span class="text-emerald-700 dark:text-emerald-300">
										✓ {$_('order_detail.fee_verified_by_attestation')}
									</span>
								{:else if order.fee_status === 'pending_external'}
									<span class="text-ink-600 dark:text-ink-300">
										⏳ {$_('order_detail.fee_pending_external')}
									</span>
								{:else if order.fee_status === 'underpaid'}
									<span class="text-red-700 dark:text-red-300">
										⚠ {$_('order_detail.fee_underpaid')}
									</span>
								{:else if order.fee_status === 'missing'}
									<span class="text-red-700 dark:text-red-300">
										⚠ {$_('order_detail.fee_missing')}
									</span>
								{:else if order.fee_status === 'reused'}
									<span class="text-red-700 dark:text-red-300">
										⚠ {$_('order_detail.fee_reused')}
									</span>
								{:else if order.fee_status === 'unverified'}
									<span class="text-ink-500">
										{$_('order_detail.fee_unverified')}
									</span>
								{:else}
									<!-- Future-proof: if the indexer adds a new
									     fee_status we don't know about, fall
									     back to the raw string rather than
									     showing nothing. -->
									<span class="text-ink-500">{order.fee_status}</span>
								{/if}
							</dd>
							{#if order.fee_status === 'pending_external'}
								<!-- Dedicated explainer for pending_external
								     because it's the status most likely to
								     confuse first-time viewers. Small,
								     non-alarming, explains the mechanism. -->
								<p class="mt-2 text-xs text-ink-600 dark:text-ink-400">
									{$_('order_detail.fee_pending_external_hint')}
								</p>
							{/if}
						</div>
					{/if}
				</div>

				<!-- Terms span the FULL width of the card (a row below both
				     columns) — multi-line markdown terms (headings, lists,
				     blockquotes, paragraphs) need the room to read, not a
				     squished half-width column. -->
				{#if order.terms}
					<div class="sm:col-span-2">
						<dt class="text-xs text-ink-500">{$_('order_detail.terms')}</dt>
						<dd class="mt-1 text-sm text-ink-700 dark:text-ink-200">
							<TermsText text={order.terms} />
						</dd>
					</div>
				{/if}
			</dl>
		</section>

		<!-- ─── Owner-only actions ────────────────────────────── -->
		{#if isOwner && (isOrderLive(order, nowMs) || isOrderExpired(order, nowMs))}
			<section
				class="card mb-6 border-morphit-emerald/30 bg-morphit-emerald/5"
				aria-labelledby="owner-actions-heading"
			>
				<h2
					id="owner-actions-heading"
					class="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500"
				>
					{$_('order_detail.owner_actions_heading')}
				</h2>

				{#if $isPairedReadOnly}
					<!-- Part 116: paired-readonly users see explicit
					     affordances for edit + cancel pointing at their
					     phone (with permlink preserved), instead of a
					     misleading "session locked" hint. -->
					<div class="flex flex-col gap-2">
						<WriteBlockedReadOnly variant="post_order" orderPermlink={permlink} density="inline" />
						<WriteBlockedReadOnly
							variant="cancel_order"
							orderPermlink={permlink}
							density="inline"
						/>
					</div>
				{:else if !$isUnlocked}
					<StatusLine kind="warn">
						{$_('order_detail.owner_locked_hint')}
					</StatusLine>
				{:else}
					<!-- Cleaner layout: edit + cancel side-by-side while
					     the order is still editable; once the edit window
					     has lapsed the "Editing closed" note (if still in
					     its brief grace period) sits on its own line above
					     a full-width Cancel button, instead of being
					     cramped beside it. -->
					{#if isOrderExpired(order, nowMs)}
						<!-- Expired: nothing live to cancel — offer a fresh
						     Re-list (a new order with a new permlink + expiry)
						     via the same prefill path as /my/orders. -->
						<BusyButton variant="secondary" onclick={relistOrder}>
							{$_('my_orders.order.action_relist')}
						</BusyButton>
					{:else if withinEditWindow(order)}
						{@const editLeft = editSecondsLeft(order)}
						<div class="flex flex-col gap-2 sm:flex-row">
							<!-- #21 (Ken) — the Edit button carries its own live countdown and
							     removes itself the instant the 15-minute window closes. The
							     branch is guarded by the same ticking `nowMs`, so there is no
							     window in which the label says 0s but the button still sits
							     there. -->
							<BusyButton
								variant="secondary"
								onclick={() => gotoLocale(`/post/edit/${order!.permlink}`)}
							>
								{#if editLeft !== null}
									{$_('order_detail.action_edit_countdown', {
										values: { remaining: formatRemainingMmSs(editLeft) }
									})}
								{:else}
									{$_('my_orders.order.action_edit')}
								{/if}
							</BusyButton>
							<BusyButton variant="danger" onclick={requestCancel}>
								{$_('order_detail.cancel_button')}
							</BusyButton>
						</div>
					{:else}
						<div class="flex flex-col gap-2">
							{#if withinEditClosedNotice(order)}
								<p class="text-xs text-ink-500">
									{$_('my_orders.order.action_edit_expired')}
								</p>
							{/if}
							<BusyButton variant="danger" onclick={requestCancel}>
								{$_('order_detail.cancel_button')}
							</BusyButton>
						</div>
					{/if}
				{/if}

				{#if cancelError}
					<StatusLine kind="warn">{cancelError}</StatusLine>
				{/if}

				<ConfirmModal
					bind:open={pendingCancel}
					title={$_('my_orders.cancel.confirm_title') as string}
					body={$_('my_orders.cancel.confirm_body') as string}
					confirmLabel={$_('my_orders.cancel.confirm_button') as string}
					cancelLabel={$_('my_orders.cancel.cancel_button') as string}
					busyLabel={$_('my_orders.cancel.cancelling') as string}
					onConfirm={confirmCancel}
					onCancel={abortCancel}
				/>
			</section>
		{/if}

		<!-- ─── CTA hint (non-owners only) ───────────────────── -->
		{#if isOrderLive(order, nowMs) && !isOwner}
			<section class="card border-morphit-teal/30 bg-morphit-teal/5">
				<p class="text-sm text-ink-700 dark:text-ink-200">
					{$_('order_detail.cta_hint')}
				</p>
			</section>
		{/if}
	{/if}
</div>
