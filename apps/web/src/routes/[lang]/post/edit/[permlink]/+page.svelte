<script lang="ts">
	/**
	 * Morphit — edit order page.
	 *
	 * Flow:
	 *   1. Fetch the order by (signer's blurt account, :permlink)
	 *      via GET /v1/orders/:account. Filter to that permlink.
	 *   2. If not found OR not alive OR window expired, show the
	 *      corresponding error card with a clear explanation.
	 *   3. Otherwise render the form pre-filled with the current
	 *      values. All fields visible at once (no progressive
	 *      disclosure — the user has a baseline to edit).
	 *   4. On save, call broadcastOrderReplace. Uses the signer's
	 *      posting key only — no fee, no active-key prompt. The
	 *      session is already unlocked; we just pass the live
	 *      identity to the broadcaster.
	 *   5. Show a countdown of time remaining in the 15-minute
	 *      window. When it hits zero, disable the save button and
	 *      show an expired card.
	 *
	 * Indexer propagation race: a user who posts an order and
	 * immediately clicks "Edit" may race ahead of the indexer. We
	 * handle this by offering a quiet auto-retry (every 2s for up
	 * to 15s) before showing the not-found card. Grandma clicks
	 * the button; it "just works" after a second or two.
	 */

	import { onDestroy, onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { goto } from '$app/navigation';
	import { get } from 'svelte/store';
	import { page } from '$app/stores';

	import Head from '$components/Head.svelte';
	import BusyButton from '$components/BusyButton.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import PaymentMethodsPicker from '$components/PaymentMethodsPicker.svelte';
	import { instanceAdditions } from '$lib/stores/instanceAdditions';
	import ProtectedTextarea from '$components/ProtectedTextarea.svelte';
	import PrivateKeyWarningModal from '$components/PrivateKeyWarningModal.svelte';
	import WriteBlockedReadOnly from '$components/WriteBlockedReadOnly.svelte';

	import { identity, isUnlocked, isPairedReadOnly } from '$stores/identity';
	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import { broadcastOrderReplace, BroadcastError } from '$blurt/ops/order';
	import { KeystoreError } from '$crypto/keystore';
	import { getOrdersByAccount } from '$lib/indexer/client';
	import type { OrderFormInput } from '$lib/orders/payload';
	import type { OrderRecord } from '@morphit/indexer-client';
	import type { PrivateKeyMatch } from '$lib/security/privateKeyDetector';
	import { ASSET_TICKERS, type AssetTicker } from '@morphit/asset-registry';

	type Asset = AssetTicker;
	type Side = 'buy' | 'sell';

	// ─── Routing ───────────────────────────────────────────────────
	const permlink = $derived($page.params.permlink ?? '');
	const blurtAccount = getUserBlurtAccount();

	// ─── Phase ─────────────────────────────────────────────────────
	type Phase =
		| 'loading'
		| 'retrying_indexer'
		| 'ready'
		| 'saving'
		| 'saved'
		| 'not_found'
		| 'not_yours'
		| 'not_live'
		| 'window_expired'
		| 'save_error';
	let phase = $state<Phase>('loading');
	let errorMessage = $state('');

	// ─── The order we're editing ───────────────────────────────────
	let order = $state<OrderRecord | null>(null);
	/** ms timestamp at which the replace window closes. */
	let windowExpiresAt = $state(0);
	/** Reactive "time remaining" in ms; ticks via setInterval. */
	let remainingMs = $state(0);
	let tickTimer: ReturnType<typeof setInterval> | null = null;

	// ─── Form state — populated after load ─────────────────────────
	let side = $state<Side>('buy');
	let asset = $state<Asset>('BTC');
	let fiat = $state('');
	let amountMin = $state(''); // kept as string so empty distinguishes
	let amountMax = $state('');
	let paymentMethods: string[] = $state([]);
	let region = $state('');
	let terms = $state('');
	let expiresDays = $state(14);
	// Price model — split state mirroring /post's picker.  On load
	// we derive these from the on-chain `price_model` record
	// (defensive about unknown shapes, falling back to the canonical
	// 'spread 0' default — same posture as /my/orders' `relistOrder`
	// helper).  On save we reassemble the `{kind, percent|price}`
	// record from the picker selection.  Part 117 closure of the
	// pre-Part-117 "future iteration" gap noted in the prior state
	// declaration.
	type PriceModelKind = 'spread' | 'fixed';
	let priceModelKind = $state<PriceModelKind>('spread');
	let spreadPercent = $state('0');
	let fixedPrice = $state('');

	// ─── Private-key protection for the terms field ────────────────
	// Same defense stack as the /post screen: visual highlight via
	// ProtectedTextarea + warning modal on save + silent redaction
	// in buildOrderPayload. The region field relies on the payload
	// redaction alone (too short for most keys).
	let termsKeyMatches: readonly PrivateKeyMatch[] = $state([]);
	let showTermsKeyWarning = $state(false);
	let userAckedTermsKeyWarning = $state(false);

	function handleTermsKeyDetect(matches: readonly PrivateKeyMatch[]): void {
		termsKeyMatches = matches;
		if (matches.length === 0) userAckedTermsKeyWarning = false;
	}

	// ─── Load the order ────────────────────────────────────────────
	async function loadOnce(): Promise<'found' | 'not_found' | 'err'> {
		if (!blurtAccount) return 'err';
		const result = await getOrdersByAccount(blurtAccount, { limit: 100 });
		if (!result.ok) {
			console.warn('[post/edit] load orders failed:', result.message);
			errorMessage = $_('edit_order.error_load_failed');
			return 'err';
		}
		const found = result.data.items.find((o) => o.permlink === permlink);
		if (!found) return 'not_found';

		order = found;
		return 'found';
	}

	async function load(): Promise<void> {
		// Auto-retry for up to 15s to give the indexer a chance to
		// catch up if the user hit "Edit" right after posting.
		const deadline = Date.now() + 15_000;
		let firstTry = true;
		while (Date.now() < deadline) {
			phase = firstTry ? 'loading' : 'retrying_indexer';
			const result = await loadOnce();
			if (result === 'err') {
				phase = 'save_error'; // reuse the error card for load errors
				return;
			}
			if (result === 'found') {
				hydrateFormFromOrder();
				return;
			}
			firstTry = false;
			await new Promise((r) => setTimeout(r, 2_000));
		}
		phase = 'not_found';
	}

	function hydrateFormFromOrder(): void {
		if (!order) return;

		// Check ownership — defensive, since the loaded list is
		// already filtered to the signer's account.
		if (order.account !== blurtAccount) {
			phase = 'not_yours';
			return;
		}

		// Check liveness.
		if (order.status && order.status !== 'live') {
			phase = 'not_live';
			return;
		}

		// Check the 15-minute window. created_at is ISO-8601 from the
		// indexer; we compute an absolute expiry timestamp once and
		// let the tick timer compute remaining.
		const createdMs = new Date(order.created_at).getTime();
		windowExpiresAt = createdMs + 15 * 60 * 1000;
		remainingMs = windowExpiresAt - Date.now();

		if (remainingMs <= 0) {
			phase = 'window_expired';
			return;
		}

		// Hydrate form.
		side = order.side;
		asset = order.asset;
		fiat = order.fiat_currency;
		amountMin = order.amount_min === null ? '' : String(order.amount_min);
		amountMax = order.amount_max === null ? '' : String(order.amount_max);
		paymentMethods = [...order.payment_methods];
		region = order.location_region ?? '';
		terms = order.terms ?? '';
		// Expiry: derive days from expires_at - created_at, rounded
		// to the nearest supported value. If no expires_at, keep
		// the default.
		if (order.expires_at) {
			const expiresMs = new Date(order.expires_at).getTime();
			const daysFromCreated = Math.round((expiresMs - createdMs) / 86_400_000);
			expiresDays = clampToSupportedDays(daysFromCreated);
		}
		// Derive picker state from on-chain price_model.  Defensive
		// about wire shape — same posture as /my/orders'
		// relistOrder helper.  Unknown shapes fall back to the
		// canonical 'spread 0' default; the user can then edit
		// explicitly if they want to change pricing.  We MUST NOT
		// silently drop the user's prior intent for any well-known
		// shape.  The picker (split state) is the source of truth
		// from this point onward; the on-chain record is recomposed
		// at save time.
		const pm = order.price_model;
		if (pm && typeof pm === 'object') {
			const obj = pm as Record<string, unknown>;
			if (obj.kind === 'spread' && typeof obj.percent === 'number') {
				priceModelKind = 'spread';
				spreadPercent = String(obj.percent);
			} else if (obj.kind === 'fixed' && typeof obj.price === 'number') {
				priceModelKind = 'fixed';
				fixedPrice = String(obj.price);
			} else {
				// Unknown / legacy shape — default to 'spread 0'.
				priceModelKind = 'spread';
				spreadPercent = '0';
			}
		} else {
			// Missing or null — default to 'spread 0'.
			priceModelKind = 'spread';
			spreadPercent = '0';
		}

		// Kick off the countdown.
		tickTimer = setInterval(() => {
			remainingMs = windowExpiresAt - Date.now();
			if (remainingMs <= 0 && phase === 'ready') {
				phase = 'window_expired';
				if (tickTimer) clearInterval(tickTimer);
				tickTimer = null;
			}
		}, 500);

		phase = 'ready';
	}

	function clampToSupportedDays(n: number): number {
		const supported = [1, 3, 7, 14, 30, 60, 90];
		return supported.reduce((prev, cur) => (Math.abs(cur - n) < Math.abs(prev - n) ? cur : prev));
	}

	onMount(() => {
		if (!blurtAccount) {
			phase = 'not_yours'; // user has no account at all — treat as not-yours
			return;
		}
		void load();
	});

	onDestroy(() => {
		if (tickTimer) clearInterval(tickTimer);
	});

	// ─── Validation (lightweight — handler re-validates) ───────────
	const amountMinNum = $derived(amountMin === '' ? null : Number(amountMin));
	const amountMaxNum = $derived(amountMax === '' ? null : Number(amountMax));

	/** Sanity cap.  Mirror of /post and the indexer's MAX_AMOUNT. */
	const MAX_AMOUNT = 1e12;

	const amountError = $derived.by(() => {
		if (amountMinNum !== null) {
			if (!Number.isFinite(amountMinNum) || amountMinNum < 0) {
				return $_('post_order.errors.amount_min_negative');
			}
			if (amountMinNum > MAX_AMOUNT) {
				return $_('post_order.errors.amount_min_too_large');
			}
		}
		if (amountMaxNum !== null) {
			if (!Number.isFinite(amountMaxNum) || amountMaxNum < 0) {
				return $_('post_order.errors.amount_max_negative');
			}
			if (amountMaxNum > MAX_AMOUNT) {
				return $_('post_order.errors.amount_max_too_large');
			}
		}
		if (amountMinNum !== null && amountMaxNum !== null && amountMinNum > amountMaxNum) {
			return $_('post_order.errors.amount_min_exceeds_max');
		}
		return '';
	});

	const pmError = $derived.by(() => {
		if (paymentMethods.length === 0) return $_('post_order.errors.payment_methods_empty');
		if (paymentMethods.length > 12) return $_('post_order.errors.payment_methods_too_many');
		return '';
	});

	/** Price-model validation — mirrors /post's `priceModelError`.
	 *  Spread: must be a finite number in [-50, +50].  Empty input
	 *  treated as valid (the user clears the field and we'll fall
	 *  through to 0 at submit, same posture as /post).
	 *  Fixed: must be a finite, strictly positive number not
	 *  exceeding MAX_AMOUNT (mirrors the post-form's sanity cap on
	 *  fixed prices to avoid pathological floats reaching the
	 *  indexer). */
	const priceModelError = $derived.by(() => {
		if (priceModelKind === 'spread') {
			if (spreadPercent.trim() === '') return '';
			const n = Number(spreadPercent);
			if (!Number.isFinite(n)) return $_('post_order.errors.spread_not_a_number');
			if (n < -50 || n > 50) return $_('post_order.errors.spread_out_of_range');
			return '';
		}
		// 'fixed'
		if (fixedPrice.trim() === '') {
			return $_('post_order.errors.fixed_price_required');
		}
		const n = Number(fixedPrice);
		if (!Number.isFinite(n) || n <= 0) {
			return $_('post_order.errors.fixed_price_invalid');
		}
		if (n > MAX_AMOUNT) {
			return $_('post_order.errors.fixed_price_too_large');
		}
		return '';
	});

	const fiatError = $derived.by(() => {
		const trimmed = fiat.trim().toUpperCase();
		if (trimmed.length === 0) return $_('post_order.errors.fiat_empty');
		if (trimmed.length > 8) return $_('post_order.errors.fiat_too_long');
		if (!/^[A-Z]+$/.test(trimmed)) return $_('post_order.errors.fiat_bad_chars');
		return '';
	});

	const canSave = $derived(
		phase === 'ready' && !amountError && !pmError && !fiatError && !priceModelError && remainingMs > 0
	);

	// ─── Save ──────────────────────────────────────────────────────
	async function save(): Promise<void> {
		// Private-key gate: if terms contains a detected key and the
		// user hasn't acknowledged the warning, show the modal. The
		// silent redaction in buildOrderPayload runs regardless on
		// the actual broadcast path.
		if (termsKeyMatches.length > 0 && !userAckedTermsKeyWarning) {
			showTermsKeyWarning = true;
			return;
		}

		const state = get(identity);
		if (state.state !== 'unlocked') {
			phase = 'save_error';
			errorMessage = $_('post_order.broadcast_error.body_locked');
			return;
		}
		if (!blurtAccount) {
			phase = 'save_error';
			errorMessage = $_('post_order.no_account.body');
			return;
		}

		phase = 'saving';

		// Reassemble the on-chain price_model record from the picker
		// state.  Mirrors /post's submission logic so both surfaces
		// emit the same canonical shape.  Spread defaults to 0 when
		// the field is empty (treated as 'market rate').
		const priceModel: Record<string, unknown> =
			priceModelKind === 'spread'
				? { kind: 'spread', percent: Number(spreadPercent) || 0 }
				: { kind: 'fixed', price: Number(fixedPrice) };

		const input: OrderFormInput = {
			side,
			asset,
			fiatCurrency: fiat.trim().toUpperCase(),
			amountMin: amountMinNum,
			amountMax: amountMaxNum,
			priceModel,
			locationRegion: region.trim() || null,
			paymentMethods,
			terms: terms.trim() || null,
			// Expires_at is an absolute ISO string in the payload;
			// we re-anchor it off NOW so the user's "make it last 14d
			// from now" intent is respected, not "14d from the original
			// post time."
			expiresAt: new Date(Date.now() + expiresDays * 86_400_000)
		};

		try {
			await broadcastOrderReplace(state.live, permlink, input);
			phase = 'saved';
		} catch (err) {
			console.warn('[post/edit] replace broadcast failed:', err);
			if (err instanceof BroadcastError && err.code === 'locked') {
				errorMessage = $_('post_order.broadcast_error.body_locked');
			} else if (err instanceof KeystoreError && err.kind === 'bad_password') {
				errorMessage = $_('post_order.broadcast_error.body_bad_password');
			} else if (err instanceof KeystoreError && err.kind === 'identity_mismatch') {
				errorMessage = $_('crypto.error.identity_mismatch');
			} else {
				errorMessage = $_('post_order.broadcast_error.body_generic');
			}
			phase = 'save_error';
		}
	}

	// ─── Countdown display ─────────────────────────────────────────
	const remainingLabel = $derived.by(() => {
		if (remainingMs <= 0) return $_('edit_order.time_remaining_expired');
		const totalSec = Math.ceil(remainingMs / 1000);
		const min = Math.floor(totalSec / 60);
		const sec = totalSec % 60;
		return `${min}:${sec.toString().padStart(2, '0')}`;
	});
</script>

<Head routeKey="edit_order" noindex />

<div class="mx-auto max-w-3xl px-4 py-10 md:py-14">
	<header class="mb-6">
		<h1 class="font-display text-3xl font-extrabold">
			<span class="brand-gradient-text">{$_('edit_order.heading')}</span>
		</h1>
		<p class="mt-2 text-ink-700 dark:text-ink-200">
			{$_('edit_order.subtitle')}
		</p>
	</header>

	{#if $isPairedReadOnly}
		<!-- Part 116: paired-readonly users get an explicit affordance
		     pointing them at their phone, with the order's permlink
		     preserved in the deep link so the phone opens the same
		     edit form pre-loaded.  Without this branch the user hit
		     a misleading "session locked, unlock to continue" CTA
		     they can't satisfy. -->
		<WriteBlockedReadOnly variant="post_order" orderPermlink={permlink} />
	{:else if !$isUnlocked}
		<section class="card">
			<h2 class="font-display text-xl font-bold">{$_('post_order.locked.title')}</h2>
			<p class="mt-2 text-ink-600 dark:text-ink-300">{$_('post_order.locked.body')}</p>
			<div class="mt-4">
				<BusyButton variant="primary" onclick={() => goto('/onboarding/import')}>
					{$_('post_order.locked.unlock')}
				</BusyButton>
			</div>
		</section>
	{:else if phase === 'loading' || phase === 'retrying_indexer'}
		<section class="card">
			<StatusLine kind="loading">{$_('edit_order.loading')}</StatusLine>
		</section>
	{:else if phase === 'not_found'}
		<section class="card">
			<h2 class="font-display text-lg font-bold">{$_('edit_order.not_found_title')}</h2>
			<p class="mt-2 text-ink-600 dark:text-ink-300">{$_('edit_order.not_found_body')}</p>
			<div class="mt-4">
				<BusyButton variant="secondary" onclick={() => goto('/orderbook')}>
					← {$_('post_order.back_to_orderbook')}
				</BusyButton>
			</div>
		</section>
	{:else if phase === 'not_yours'}
		<section class="card">
			<h2 class="font-display text-lg font-bold">{$_('edit_order.not_yours_title')}</h2>
			<p class="mt-2 text-ink-600 dark:text-ink-300">{$_('edit_order.not_yours_body')}</p>
			<div class="mt-4">
				<BusyButton variant="secondary" onclick={() => goto('/orderbook')}>
					← {$_('post_order.back_to_orderbook')}
				</BusyButton>
			</div>
		</section>
	{:else if phase === 'not_live'}
		<section class="card">
			<h2 class="font-display text-lg font-bold">{$_('edit_order.not_live_title')}</h2>
			<p class="mt-2 text-ink-600 dark:text-ink-300">{$_('edit_order.not_live_body')}</p>
			<div class="mt-4">
				<BusyButton variant="primary" onclick={() => goto('/post')}>
					{$_('post_order.heading')}
				</BusyButton>
			</div>
		</section>
	{:else if phase === 'window_expired'}
		<section class="card border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950">
			<h2 class="font-display text-lg font-bold text-amber-900 dark:text-amber-100">
				{$_('edit_order.expired_title')}
			</h2>
			<p class="mt-2 text-sm text-amber-800 dark:text-amber-200">
				{$_('edit_order.expired_body')}
			</p>
			<div class="mt-4 flex flex-col gap-3 sm:flex-row">
				<BusyButton variant="secondary" onclick={() => goto('/my/orders')}>
					{$_('my_orders.heading')}
				</BusyButton>
				<BusyButton variant="primary" onclick={() => goto('/post')}>
					{$_('post_order.heading')}
				</BusyButton>
			</div>
		</section>
	{:else if phase === 'saved'}
		<section class="card animate-fade-up text-center">
			<svg
				class="mx-auto mb-4 h-16 w-16 text-morphit-emerald"
				viewBox="0 0 24 24"
				fill="none"
				aria-hidden="true"
			>
				<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" />
				<path
					d="M7 12l3 3 7-7"
					stroke="currentColor"
					stroke-width="2.5"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
			<h2 class="font-display text-2xl font-extrabold">
				{$_('edit_order.save_success_title')}
			</h2>
			<p class="mt-2 text-ink-600 dark:text-ink-300">
				{$_('edit_order.save_success_body')}
			</p>
			<div class="mt-6">
				<BusyButton variant="primary" onclick={() => goto('/orderbook')}>
					{$_('post_order.success.view_cta')}
				</BusyButton>
			</div>
		</section>
	{:else if phase === 'save_error'}
		<section
			class="card border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950"
			role="alert"
		>
			<h2 class="font-display text-lg font-bold text-amber-900 dark:text-amber-100">
				{$_('edit_order.save_error_title')}
			</h2>
			<p class="mt-2 text-sm text-amber-800 dark:text-amber-200">
				{$_('edit_order.save_error_body')}
			</p>
			{#if errorMessage}
				<p class="mt-1 text-xs text-amber-700 dark:text-amber-300">{errorMessage}</p>
			{/if}
			<div class="mt-4">
				<BusyButton
					variant="primary"
					onclick={() => {
						phase = 'ready';
						void load();
					}}
				>
					{$_('post_order.broadcast_error.retry')}
				</BusyButton>
			</div>
		</section>
	{:else}
		<!-- Countdown banner — always visible while editing -->
		<section
			class="mb-4 rounded-xl border-2 border-morphit-emerald bg-emerald-50 px-4 py-3 text-sm dark:bg-ink-800"
			aria-live="polite"
		>
			<span class="font-semibold">{$_('edit_order.time_remaining_prefix')}</span>
			<span class="ml-2 font-mono font-bold">{remainingLabel}</span>
		</section>

		<section class="card mb-4">
			<div class="grid gap-3 sm:grid-cols-2">
				<button
					type="button"
					onclick={() => (side = 'buy')}
					class="rounded-xl border-2 px-4 py-3 text-left transition active:scale-[0.98] {side ===
					'buy'
						? 'border-morphit-emerald bg-emerald-50 dark:bg-ink-800'
						: 'border-ink-200 dark:border-ink-700'}"
				>
					<span class="font-semibold">{$_('post_order.form.side_buy')}</span>
				</button>
				<button
					type="button"
					onclick={() => (side = 'sell')}
					class="rounded-xl border-2 px-4 py-3 text-left transition active:scale-[0.98] {side ===
					'sell'
						? 'border-morphit-emerald bg-emerald-50 dark:bg-ink-800'
						: 'border-ink-200 dark:border-ink-700'}"
				>
					<span class="font-semibold">{$_('post_order.form.side_sell')}</span>
				</button>
			</div>
			<p class="mb-2 mt-6 text-sm font-semibold">{$_('post_order.form.asset_label')}</p>
			<div class="flex flex-wrap gap-2">
				{#each ASSET_TICKERS as a}
					<button
						type="button"
						onclick={() => (asset = a as Asset)}
						class="rounded-xl border-2 px-4 py-2 font-mono font-semibold transition active:scale-[0.98] {asset ===
						a
							? 'border-morphit-emerald bg-emerald-50 dark:bg-ink-800'
							: 'border-ink-200 dark:border-ink-700'}"
					>
						{a}
					</button>
				{/each}
			</div>
		</section>

		<section class="card mb-4">
			<label class="mb-4 block">
				<span class="mb-1 block text-sm font-semibold">{$_('post_order.form.fiat_label')}</span>
				<input
					type="text"
					bind:value={fiat}
					maxlength="8"
					aria-invalid={!!fiatError}
					aria-describedby={fiatError ? 'edit-fiat-error' : undefined}
					class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 uppercase focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
				/>
				{#if fiatError}
					<StatusLine kind="warn" id="edit-fiat-error">{fiatError}</StatusLine>
				{/if}
			</label>

			<div class="grid gap-4 sm:grid-cols-2">
				<label class="block">
					<span class="mb-1 block text-sm font-semibold"
						>{$_('post_order.form.amount_min_label')}</span
					>
					<input
						type="number"
						min="0"
						step="0.01"
						bind:value={amountMin}
						aria-invalid={!!amountError}
						aria-describedby={amountError ? 'edit-amount-error' : undefined}
						class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
					/>
				</label>
				<label class="block">
					<span class="mb-1 block text-sm font-semibold"
						>{$_('post_order.form.amount_max_label')}</span
					>
					<input
						type="number"
						min="0"
						step="0.01"
						bind:value={amountMax}
						aria-invalid={!!amountError}
						aria-describedby={amountError ? 'edit-amount-error' : undefined}
						class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
					/>
				</label>
			</div>
			{#if amountError}
				<StatusLine kind="warn" id="edit-amount-error">{amountError}</StatusLine>
			{/if}
		</section>

		<!-- Price-model picker (Part 117).  Mirrors the /post screen's
		     picker so an editor can change pricing without having to
		     cancel-and-re-list.  Picker state is initialized from the
		     loaded order in `load()`; submission reassembles the on-
		     chain {kind, percent|price} record (same canonical shape
		     as /post emits) so the two screens are wire-compatible.
		     Unknown / legacy / missing shapes load as 'spread 0'
		     (the canonical "market rate" default) — the user can
		     then explicitly switch to fixed if desired.  ARIA IDs
		     are `edit-`-prefixed to coexist with /post on a possible
		     side-by-side render in the future. -->
		<section class="card mb-4">
			<fieldset class="rounded-xl border border-ink-200 p-3 dark:border-ink-700">
				<legend class="px-2 text-sm font-semibold">
					{$_('post_order.form.price_model_legend')}
				</legend>
				<p class="mb-3 text-xs text-ink-500">
					{$_('post_order.form.price_model_hint')}
				</p>

				<div class="space-y-2">
					<label
						class="flex cursor-pointer items-start gap-3 rounded-lg p-2 hover:bg-ink-50 dark:hover:bg-ink-800"
					>
						<input
							type="radio"
							name="edit-price-model-kind"
							value="spread"
							bind:group={priceModelKind}
							class="mt-0.5 h-4 w-4 flex-none accent-morphit-emerald"
						/>
						<div class="min-w-0">
							<p class="font-semibold">
								{$_('post_order.form.price_model_spread_label')}
							</p>
							<p class="text-xs text-ink-600 dark:text-ink-300">
								{$_('post_order.form.price_model_spread_help')}
							</p>
							{#if priceModelKind === 'spread'}
								<div class="mt-2 flex items-center gap-2">
									<input
										type="number"
										step="0.1"
										min="-50"
										max="50"
										bind:value={spreadPercent}
										aria-invalid={!!priceModelError}
										aria-describedby={priceModelError ? 'edit-price-model-error' : undefined}
										class="w-24 rounded-lg border-2 border-ink-200 bg-white px-2 py-1 text-sm focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
										aria-label={$_('post_order.form.price_model_spread_aria') as string}
									/>
									<span class="text-sm text-ink-600 dark:text-ink-300">%</span>
									<span class="text-xs text-ink-500">
										{$_('post_order.form.price_model_spread_unit_hint')}
									</span>
								</div>
								{#if priceModelError}
									<StatusLine kind="warn" id="edit-price-model-error">{priceModelError}</StatusLine>
								{/if}
							{/if}
						</div>
					</label>

					<label
						class="flex cursor-pointer items-start gap-3 rounded-lg p-2 hover:bg-ink-50 dark:hover:bg-ink-800"
					>
						<input
							type="radio"
							name="edit-price-model-kind"
							value="fixed"
							bind:group={priceModelKind}
							class="mt-0.5 h-4 w-4 flex-none accent-morphit-emerald"
						/>
						<div class="min-w-0">
							<p class="font-semibold">
								{$_('post_order.form.price_model_fixed_label')}
							</p>
							<p class="text-xs text-ink-600 dark:text-ink-300">
								{$_('post_order.form.price_model_fixed_help')}
							</p>
							{#if priceModelKind === 'fixed'}
								<div class="mt-2 flex items-center gap-2">
									<input
										type="number"
										step="0.01"
										min="0"
										bind:value={fixedPrice}
										aria-invalid={!!priceModelError}
										aria-describedby={priceModelError ? 'edit-fixed-price-error' : undefined}
										class="w-32 rounded-lg border-2 border-ink-200 bg-white px-2 py-1 text-sm focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
										placeholder={$_('post_order.form.price_model_fixed_placeholder') as string}
										aria-label={$_('post_order.form.price_model_fixed_aria') as string}
									/>
									<span class="text-sm text-ink-600 dark:text-ink-300">
										{fiat || $_('post_order.form.price_model_fiat_placeholder')}
									</span>
								</div>
								{#if priceModelError}
									<StatusLine kind="warn" id="edit-fixed-price-error">{priceModelError}</StatusLine>
								{/if}
							{/if}
						</div>
					</label>
				</div>
			</fieldset>
		</section>

		<section class="card mb-4">
			<div class="mb-4">
				<p class="mb-1 text-sm font-semibold">{$_('post_order.form.payment_methods_label')}</p>
				<PaymentMethodsPicker
					bind:selected={paymentMethods}
					excludeForAsset={asset}
					instanceAdditions={$instanceAdditions}
					invalid={!!pmError}
					describedById="edit-pm-error"
				/>
				{#if pmError}
					<StatusLine kind="warn" id="edit-pm-error">{pmError}</StatusLine>
				{/if}
			</div>

			<label class="mb-4 block">
				<span class="mb-1 block text-sm font-semibold">{$_('post_order.form.region_label')}</span>
				<input
					type="text"
					bind:value={region}
					maxlength="128"
					class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
				/>
			</label>

			<label class="mb-4 block">
				<span class="mb-1 block text-sm font-semibold">{$_('post_order.form.terms_label')}</span>
				<ProtectedTextarea
					bind:value={terms}
					onDetect={handleTermsKeyDetect}
					rows={3}
					maxlength={2048}
					showCounter
				/>
			</label>

			<label class="block">
				<span class="mb-1 block text-sm font-semibold">{$_('post_order.form.expires_label')}</span>
				<select
					bind:value={expiresDays}
					class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
				>
					<option value={1}>{$_('post_order.form.expires_1d')}</option>
					<option value={3}>{$_('post_order.form.expires_3d')}</option>
					<option value={7}>{$_('post_order.form.expires_7d')}</option>
					<option value={14}>{$_('post_order.form.expires_14d')}</option>
					<option value={30}>{$_('post_order.form.expires_30d')}</option>
					<option value={60}>{$_('post_order.form.expires_60d')}</option>
					<option value={90}>{$_('post_order.form.expires_90d')}</option>
				</select>
			</label>
		</section>

		<p class="mb-4 text-sm text-ink-500">{$_('edit_order.fee_note')}</p>

		<div class="flex flex-col gap-3 sm:flex-row sm:justify-between">
			<BusyButton variant="ghost" onclick={() => goto('/orderbook')}>
				← {$_('post_order.back_to_orderbook')}
			</BusyButton>
			<BusyButton
				variant="primary"
				busy={phase === 'saving'}
				busyLabel={$_('edit_order.saving')}
				disabled={!canSave}
				onclick={save}
			>
				{$_('edit_order.save_button')}
			</BusyButton>
		</div>
	{/if}
</div>

{#if showTermsKeyWarning}
	<PrivateKeyWarningModal
		matches={termsKeyMatches}
		onEdit={() => {
			showTermsKeyWarning = false;
		}}
		onSendAnyway={() => {
			showTermsKeyWarning = false;
			userAckedTermsKeyWarning = true;
			void save();
		}}
	/>
{/if}
