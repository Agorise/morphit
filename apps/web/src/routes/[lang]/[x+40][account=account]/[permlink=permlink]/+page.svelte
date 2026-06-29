<script lang="ts">
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';

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
	 * No edit/cancel actions here — those live on /my/orders where
	 * the signer already has their list in context. Keeping this
	 * page focused makes the shareable URL meaningful: "go look at
	 * this offer" vs. "here's a complicated admin screen."
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

	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { page } from '$app/stores';
	import { gotoLocale } from '$i18n/navigate';
	import { get } from 'svelte/store';

	import Head from '$components/Head.svelte';
	import TermsText from '$components/TermsText.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import BusyButton from '$components/BusyButton.svelte';
	import IdentityLabel from '$components/IdentityLabel.svelte';
	import WriteBlockedReadOnly from '$components/WriteBlockedReadOnly.svelte';
	import { identity, isUnlocked, isPairedReadOnly } from '$stores/identity';
	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import { broadcastOrderCancel, BroadcastError } from '$blurt/ops/order';
	import { KeystoreError } from '$crypto/keystore';
	import { getOrdersByAccount, getFeedback } from '$lib/indexer/client';
	import { getProfileCached } from '$lib/indexer/profileCache';
	import { extractLabelPropsFromProfile } from '$lib/indexer/profileProps';
	import { displayNamesForMethods } from '$lib/payments/display';
	import { formatOrderPriceModel } from '$lib/orders/priceModelDisplay';
	import { instanceAdditions, instanceNameLookup } from '$lib/stores/instanceAdditions';
	import type { OrderRecord, FeedbackSummary, ProfileResponse } from '@morphit/indexer-client';

	// account + permlink are route parameters; always defined.
	// The non-null assertions are safe because SvelteKit would
	// not have routed here without them.
	const account = $derived($page.params.account!);
	const permlink = $derived($page.params.permlink!);
	const viewerAccount = getUserBlurtAccount();

	// ─── State ─────────────────────────────────────────────────────
	type Phase = 'loading' | 'ready' | 'not_found' | 'error';
	let phase = $state<Phase>('loading');
	let order = $state<OrderRecord | null>(null);
	let errorMessage = $state('');
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

	// Reputation summary — fetched alongside the order so the poster
	// card can show ★X.X (N) without the user having to click through
	// to the profile. Best-effort; if it fails the badge just doesn't
	// render.
	let ratingSummary = $state<FeedbackSummary | null>(null);

	/** Poster profile — for custom avatar + display name on the
	 *  poster card. Best-effort; null if the server has no profile
	 *  or the fetch fails, in which case IdentityLabel falls back
	 *  to the identicon + account name. Hits the shared profile
	 *  cache, so a user who came from the orderbook page gets it
	 *  instantly without a second round-trip. */
	let posterProfile = $state<ProfileResponse | null>(null);

	/** Poster identity-label props derived from the profile fetch.
	 *  Hoisted for the same reason as priceModelLabel above. */
	const posterLabelProps = $derived(extractLabelPropsFromProfile(posterProfile));

	// ─── Owner-only action state ──────────────────────────────────
	/** True once the user has clicked Cancel — shows the inline
	 *  "are you sure?" confirm card. A second tap on Cancel is a
	 *  no-op while this is already true. */
	let pendingCancel = $state(false);
	/** True while the cancel broadcast is in flight. */
	let cancelling = $state(false);
	/** Non-empty when the last cancel attempt failed. */
	let cancelError = $state('');

	async function loadOrder(): Promise<void> {
		phase = 'loading';
		const r = await getOrdersByAccount(account, { limit: 100 });
		if (!r.ok) {
			console.warn('[listing-detail] loadOrder failed:', r.message);
			errorMessage = $_('order_detail.error_load_failed');
			phase = 'error';
			return;
		}
		const found = r.data.items.find((o) => o.permlink === permlink);
		if (!found) {
			phase = 'not_found';
			return;
		}
		order = found;
		phase = 'ready';
	}

	async function loadRatingSummary(): Promise<void> {
		// Fetch the first page with minimal limit just for the
		// summary. The items themselves aren't rendered here.
		const r = await getFeedback(account, { limit: 1 });
		if (r.ok) {
			ratingSummary = r.data.summary;
		}
		// Silent failure — reputation badge is decorative here.
	}

	async function loadPosterProfile(): Promise<void> {
		// Silent: if the profile fetch fails, IdentityLabel renders
		// its identicon fallback cleanly.
		posterProfile = await getProfileCached(account);
	}

	onMount(() => {
		void loadOrder();
		void loadRatingSummary();
		void loadPosterProfile();
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

	/** Edit window: 15 minutes from creation, same rule as /my/orders.
	 *  The edit path at /post/edit/[permlink] also enforces this on
	 *  entry, so a stale UI state just lands the user on a "window
	 *  expired" page rather than letting them edit what they can't. */
	function withinEditWindow(o: OrderRecord): boolean {
		if (o.status !== 'live') return false;
		const createdMs = new Date(o.created_at).getTime();
		return Date.now() - createdMs < 15 * 60 * 1000;
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
			return;
		}
		cancelling = true;
		pendingCancel = false;
		try {
			await broadcastOrderCancel(state.live, order.permlink);
			// Wait for the indexer to catch the block, then refetch
			// so the UI reflects the cancelled status. Same 1.5s as
			// the /my/orders pattern.
			await new Promise((r) => setTimeout(r, 1_500));
			await loadOrder();
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
			cancelling = false;
		}
	}

	// ─── Derived view state ────────────────────────────────────────

	function formatRange(o: OrderRecord): string {
		const min = o.amount_min;
		const max = o.amount_max;
		if (min !== null && max !== null) return `${min}–${max} ${o.asset}`;
		if (min !== null) return `≥${min} ${o.asset}`;
		if (max !== null) return `≤${max} ${o.asset}`;
		return `— ${o.asset}`;
	}

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
		// Long-form date for "created on" + "expires on" below the
		// relative-time chip. Locale-aware via Intl; the browser
		// picks its own formatting.
		return new Date(iso).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	function starString(n: 1 | 2 | 3 | 4 | 5): string {
		return '★'.repeat(n) + '☆'.repeat(5 - n);
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
	{:else if phase === 'not_found'}
		<section class="card text-center">
			<h1 class="font-display text-2xl font-extrabold">
				{$_('order_detail.not_found_title')}
			</h1>
			<p class="mt-2 text-ink-600 dark:text-ink-300">
				{$_('order_detail.not_found_body')}
			</p>
			<div class="mt-4">
				<a href={lp(`/@${account}`)} class="font-semibold text-morphit-emerald hover:underline">
					{$_('order_detail.back_to_profile')}
				</a>
			</div>
		</section>
	{:else if phase === 'error'}
		<section
			class="card border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950"
			role="alert"
		>
			<h1 class="font-display text-lg font-bold text-amber-900 dark:text-amber-100">
				{$_('order_detail.error_title')}
			</h1>
			<p class="mt-2 text-sm text-amber-800 dark:text-amber-200">
				{$_('order_detail.error_body')}
			</p>
			<p class="mt-1 text-xs text-amber-700 dark:text-amber-300">{errorMessage}</p>
		</section>
	{:else if order}
		<!-- ─── Order headline ──────────────────────────────────── -->
		<section class="mb-6">
			<h1 class="mb-2 font-display text-3xl font-extrabold">
				{order.side === 'buy'
					? ($_('profile.order_buying', { values: { asset: order.asset } }) as string)
					: ($_('profile.order_selling', { values: { asset: order.asset } }) as string)}
			</h1>
			<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<span class="text-lg text-ink-700 dark:text-ink-200">
					{formatRange(order)}
				</span>
				<span class="text-lg text-ink-600 dark:text-ink-300">
					· {order.fiat_currency}
				</span>
			</div>
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
				<span class={statusChipClasses(order.status)}>
					{statusLabel(order.status)}
				</span>
				{#if order.status === 'live' && order.expires_at}
					<span
						class="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
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
			<div class="flex flex-wrap items-center gap-3">
				<IdentityLabel
					account={order.account}
					displayName={posterLabelProps.displayName}
					avatarSvg={posterLabelProps.avatarSvg}
					avatarDataUri={posterLabelProps.avatarDataUri}
					nostrUrl={posterLabelProps.nostrUrl}
					blurtMediaUrl={posterLabelProps.blurtMediaUrl}
					href={lp(`/@${order.account}`)}
					weight="bold"
					avatarSize={40}
				/>
				{#if ratingSummary && ratingSummary.count > 0}
					<a
						href={lp(`/@${order.account}`)}
						class="flex items-center gap-1 text-sm text-ink-600 hover:text-morphit-emerald dark:text-ink-300"
					>
						<span class="text-morphit-emerald" aria-hidden="true">
							{starString(Math.round(ratingSummary.weighted_rating) as 1 | 2 | 3 | 4 | 5)}
						</span>
						<span class="tabular-nums">
							{ratingSummary.weighted_rating.toFixed(1)}
						</span>
						<span class="text-xs text-ink-500">
							({ratingSummary.count})
						</span>
					</a>
				{:else if order.is_new_trader}
					<span
						class="rounded-full border border-morphit-teal/40 bg-morphit-teal/10 px-2 py-0.5 text-xs text-morphit-teal"
					>
						{$_('order_detail.new_trader')}
					</span>
				{/if}
				<!-- Message button: non-owners on a live order get a
				     direct link into the chat with the poster. Owners
				     don't see it — they can't message themselves; the
				     inbox is how they'd reach inbound messages. -->
				{#if order.status === 'live' && !isOwner}
					<a
						href={lp(`/chat/${order.account}?order=${encodeURIComponent(order.permlink)}`)}
						class="ml-auto inline-flex items-center gap-1 rounded-xl border-2 border-morphit-emerald bg-morphit-emerald/10 px-3 py-1.5 text-sm font-semibold text-morphit-emerald transition hover:bg-morphit-emerald hover:text-ink-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald"
						aria-label={$_('chat.message_button_aria', {
							values: { peer: order.account }
						}) as string}
					>
						<span aria-hidden="true">💬</span>
						{$_('chat.message_button_label')}
					</a>
				{/if}
			</div>
		</section>

		<!-- ─── Details ──────────────────────────────────────────── -->
		<section class="card mb-6" aria-labelledby="details-heading">
			<h2
				id="details-heading"
				class="mb-4 text-sm font-semibold uppercase tracking-wide text-ink-500"
			>
				{$_('order_detail.details_heading')}
			</h2>
			<dl class="space-y-3">
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

				{#if order.terms}
					<div>
						<dt class="text-xs text-ink-500">{$_('order_detail.terms')}</dt>
						<dd class="mt-1 whitespace-pre-wrap text-sm text-ink-700 dark:text-ink-200">
							<TermsText text={order.terms} />
						</dd>
					</div>
				{/if}

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
								<span class="text-amber-700 dark:text-amber-300">
									⏳ {$_('order_detail.fee_pending_external')}
								</span>
							{:else if order.fee_status === 'underpaid'}
								<span class="text-amber-700 dark:text-amber-300">
									⚠ {$_('order_detail.fee_underpaid')}
								</span>
							{:else if order.fee_status === 'missing'}
								<span class="text-amber-700 dark:text-amber-300">
									⚠ {$_('order_detail.fee_missing')}
								</span>
							{:else if order.fee_status === 'reused'}
								<span class="text-amber-700 dark:text-amber-300">
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
			</dl>
		</section>

		<!-- ─── Owner-only actions ────────────────────────────── -->
		{#if isOwner && order.status === 'live'}
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
				{:else if pendingCancel}
					<!-- Inline confirm for cancel — same pattern as /my/orders -->
					<div
						class="rounded-xl border-2 border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950"
					>
						<p class="mb-1 text-sm font-semibold text-amber-900 dark:text-amber-100">
							{$_('my_orders.cancel.confirm_title')}
						</p>
						<p class="mb-3 text-xs text-amber-800 dark:text-amber-200">
							{$_('my_orders.cancel.confirm_body')}
						</p>
						<div class="flex flex-col gap-2 sm:flex-row">
							<BusyButton
								variant="primary"
								busy={cancelling}
								busyLabel={$_('my_orders.cancel.cancelling') as string}
								onclick={confirmCancel}
							>
								{$_('my_orders.cancel.confirm_button')}
							</BusyButton>
							<BusyButton variant="ghost" onclick={abortCancel}>
								{$_('my_orders.cancel.cancel_button')}
							</BusyButton>
						</div>
					</div>
				{:else}
					<div class="flex flex-col gap-2 sm:flex-row">
						{#if withinEditWindow(order)}
							<BusyButton
								variant="secondary"
								onclick={() => gotoLocale(`/post/edit/${order!.permlink}`)}
							>
								{$_('my_orders.order.action_edit')}
							</BusyButton>
						{:else}
							<span class="text-xs text-ink-500">
								{$_('my_orders.order.action_edit_expired')}
							</span>
						{/if}
						<BusyButton variant="ghost" onclick={requestCancel}>
							{$_('my_orders.order.action_cancel')}
						</BusyButton>
					</div>
				{/if}

				{#if cancelError}
					<StatusLine kind="warn">{cancelError}</StatusLine>
				{/if}
			</section>
		{/if}

		<!-- ─── CTA hint (non-owners only) ───────────────────── -->
		{#if order.status === 'live' && !isOwner}
			<section class="card border-morphit-teal/30 bg-morphit-teal/5">
				<p class="text-sm text-ink-700 dark:text-ink-200">
					{$_('order_detail.cta_hint')}
				</p>
			</section>
		{/if}
	{/if}
</div>
