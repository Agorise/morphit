<script lang="ts">
	/**
	 * StrangerFeeModal — first-contact modal for Finding H layer 2.
	 *
	 * Shown when a user tries to open a conversation with someone
	 * they've never exchanged messages with and have not yet paid
	 * the stranger-fee for. Walks the user through:
	 *
	 *   1. Fetches the current escalating price from the indexer
	 *      (/v1/stranger-fee-quote/:sender). The price doubles
	 *      for each first-contact fee paid in the last 5 minutes,
	 *      capped at 128× base ($1.28).
	 *   2. Displays the USD amount, multiplier warning if the
	 *      escalation has engaged, and the exact BLURT amount
	 *      computed from the live price feed.
	 *   3. Why Morphit charges it (anti-spam) + slow-down warning
	 *      when multiplier > 1.
	 *   4. Confirm + password prompt to unlock the active key.
	 *
	 * On success, broadcasts both the custom_json fee op and a
	 * sibling BLURT transfer in one transaction, then emits
	 * onPaid() so the caller can refresh the admission state and
	 * show the composer.
	 *
	 * The active key is JIT-unlocked via `runWithActiveKey()` —
	 * standard Morphit pattern for active-auth ops — so the
	 * scalar is wiped from memory after the broadcast completes
	 * (or throws).
	 */

	import { _ } from 'svelte-i18n';
	import { runWithActiveKey } from '$crypto/runWithActiveKey';
	import { broadcastStrangerFee } from '$blurt/ops/strangerFee';
	import { getInstanceSnapshot } from '$stores/instance';
	import { resolveFeeRecipient } from '$lib/orders/fee';
	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import { getStrangerFeeQuote } from '$lib/indexer/client';
	import { fetchListingFee } from '$lib/orders/listingFee';
	import { formatFiat } from '$lib/i18n/formatters';
	import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';
	import type { StrangerFeeQuoteResponse } from '@morphit/indexer-client';
	import type { LiveIdentity } from '$crypto/keygen';

	interface Props {
		live: LiveIdentity;
		peer: string;
		onPaid: () => void;
		onCancel: () => void;
	}

	let { live, peer, onPaid, onCancel }: Props = $props();

	/** UI phase. Drives which subtree renders in the card body.
	 *  Carries the indexer's BLURT-denominated quote — no client-
	 *  side conversion needed. */
	type Phase =
		| { kind: 'loading' }
		| { kind: 'ready'; priceQuote: StrangerFeeQuoteResponse }
		| { kind: 'paying'; priceQuote: StrangerFeeQuoteResponse }
		| { kind: 'error'; messageKey: string };

	let phase = $state<Phase>({ kind: 'loading' });
	let passwordInput = $state('');
	let passwordError = $state('');
	/** Optional fiat-per-BLURT for ambient subtext. Populated from
	 *  /v1/listing-fee when the operator has the price feed
	 *  enabled.  Null = no fiat echo shown.
	 *
	 *  cp128: previously `usdPerBlurt`; renamed because the operator
	 *  can configure the denomination to EUR / XDR / XAU / etc. */
	let fiatPerBlurt: number | null = $state(null);
	let denominationFiat: string = $state('USD');

	async function loadQuote(): Promise<void> {
		phase = { kind: 'loading' };
		try {
			const me = getUserBlurtAccount();
			if (!me) {
				phase = {
					kind: 'error',
					messageKey: 'chat.stranger_fee.error.quote_failed'
				};
				return;
			}
			// Step 1 — ask the indexer what the user owes right
			// now.  This is the source of truth, and is BLURT-
			// denominated; the client doesn't get to invent a
			// number or convert it via a separate price feed.
			const priceResult = await getStrangerFeeQuote(me);
			if (!priceResult.ok) {
				console.error('stranger-fee quote failed', priceResult.message);
				phase = {
					kind: 'error',
					messageKey: 'chat.stranger_fee.error.quote_failed'
				};
				return;
			}
			phase = {
				kind: 'ready',
				priceQuote: priceResult.data
			};

			// Step 2 — best-effort optional fiat echo.  Falls back
			// to "no fiat shown" silently if the operator hasn't
			// enabled the price feed.  Doesn't block the modal
			// becoming usable.
			//
			// cp128: reads renamed fields `blurt_price_fiat` and
			// `denomination_fiat`; pre-cp128 was `blurt_price_usd`.
			void (async () => {
				const lf = await fetchListingFee(resolveOrigin(MORPHIT_INDEXER_ORIGIN));
				if (lf.kind === 'ok' && typeof lf.quote.blurt_price_fiat === 'number') {
					fiatPerBlurt = lf.quote.blurt_price_fiat;
					if (typeof lf.quote.denomination_fiat === 'string') {
						denominationFiat = lf.quote.denomination_fiat;
					}
				}
			})();
		} catch (err) {
			console.error('stranger-fee quote failed', err);
			phase = {
				kind: 'error',
				messageKey: 'chat.stranger_fee.error.quote_failed'
			};
		}
	}

	// Load the quote as soon as the modal mounts.
	$effect(() => {
		void loadQuote();
	});

	async function onConfirm(): Promise<void> {
		if (phase.kind !== 'ready') return;
		if (passwordInput.length === 0) {
			passwordError = $_('chat.stranger_fee.error.password_required') as string;
			return;
		}
		passwordError = '';
		const { priceQuote } = phase;
		phase = { kind: 'paying', priceQuote };

		// Phase F.5 audit fix (F-18) — sign-callback pattern.
		// The active key only lives inside the synchronous
		// signOrderWithFeeWithKey call.
		try {
			const signCallback = async (
				unsigned: import('@beblurt/dblurt').Transaction
			): Promise<import('@beblurt/dblurt').SignedTransaction> => {
				const r = await runWithActiveKey(passwordInput, async (activePriv) => {
					const { signOrderWithFeeWithKey } = await import('$blurt/sign');
					return signOrderWithFeeWithKey(unsigned, activePriv);
				});
				if (!r.ok) {
					// Surface as throw so the outer catch classifies.
					const err = new Error(`runWithActiveKey:${r.kind}`);
					(err as Error & { kind?: string }).kind = r.kind;
					throw err;
				}
				return r.value;
			};
			await broadcastStrangerFee(
				live,
				signCallback,
				peer,
				priceQuote.price_blurt,
				resolveFeeRecipient(getInstanceSnapshot().fee_recipient)
			);
			passwordInput = '';
			onPaid();
			return;
		} catch (err) {
			passwordInput = '';
			const kind = (err as Error & { kind?: string }).kind;
			if (kind === 'bad_password') {
				phase = { kind: 'ready', priceQuote };
				passwordError = $_('chat.stranger_fee.error.bad_password') as string;
				return;
			}
			if (kind === 'identity_mismatch') {
				phase = {
					kind: 'error',
					messageKey: 'crypto.error.identity_mismatch'
				};
				return;
			}
			if (kind === 'locked') {
				phase = {
					kind: 'error',
					messageKey: 'chat.stranger_fee.error.no_active_envelope'
				};
				return;
			}
			if (kind === 'password_empty') {
				phase = { kind: 'ready', priceQuote };
				return;
			}
			// Sign-time crypto failure or broadcast network error.
			phase = {
				kind: 'error',
				messageKey: 'chat.stranger_fee.error.broadcast_failed'
			};
		}
	}

	function onBackdropClick(e: MouseEvent): void {
		// Only dismiss when clicking the backdrop itself, not
		// descendant content. Prevents accidental dismiss from
		// mis-clicks inside the card.  Per Finding A14: also
		// blocked during the paying phase — the broadcast is
		// in flight and dismissing the modal abandons the UI
		// while the transaction still proceeds.
		if (phase.kind === 'paying') return;
		if (e.target === e.currentTarget) {
			onCancel();
		}
	}

	function onKeydown(e: KeyboardEvent): void {
		// Per Finding A14: Escape gated during paying phase too.
		if (phase.kind === 'paying') return;
		if (e.key === 'Escape') onCancel();
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 p-4 backdrop-blur-sm"
	onclick={onBackdropClick}
	role="presentation"
>
	<div
		class="card w-full max-w-md"
		role="dialog"
		aria-modal="true"
		aria-labelledby="stranger-fee-heading"
	>
		<h2 id="stranger-fee-heading" class="font-display text-xl font-bold">
			{$_('chat.stranger_fee.heading', { values: { peer } })}
		</h2>
		<p class="mt-3 text-sm text-ink-600 dark:text-ink-300">
			{$_('chat.stranger_fee.explain')}
		</p>

		{#if phase.kind === 'loading'}
			<div
				class="mt-6 rounded-xl border border-ink-200 bg-ink-50 p-4 text-center text-sm text-ink-500 dark:border-ink-700 dark:bg-ink-900"
			>
				{$_('chat.stranger_fee.quoting')}
			</div>
		{:else if phase.kind === 'error'}
			<div
				class="mt-6 rounded-xl border-2 border-red-300 bg-red-50 p-4 dark:border-red-700 dark:bg-red-950"
				role="alert"
			>
				<p class="text-sm text-red-900 dark:text-red-100">
					{$_(phase.messageKey)}
				</p>
				<div class="mt-3 flex gap-2">
					<button
						type="button"
						onclick={loadQuote}
						class="rounded-lg border border-ink-300 px-3 py-1 text-sm font-semibold hover:border-morphit-emerald hover:text-morphit-emerald dark:border-ink-700"
					>
						{$_('chat.stranger_fee.retry')}
					</button>
					<button
						type="button"
						onclick={onCancel}
						class="rounded-lg border border-ink-300 px-3 py-1 text-sm font-semibold hover:border-ink-400 dark:border-ink-700"
					>
						{$_('common.cancel')}
					</button>
				</div>
			</div>
		{:else}
			<!-- ready or paying — both show the quote card. paying
			     disables the buttons and shows a busy label. -->

			<!-- Escalation warning. Only renders when the indexer
			     reports multiplier > 1 — i.e. the user has paid for
			     other strangers in the last 5 minutes. The warning
			     is informative, not punitive — it tells the user
			     why the price went up and what to do about it. -->
			{#if phase.priceQuote.multiplier > 1}
				<div
					class="mt-4 rounded-xl border-2 border-red-400 bg-red-50 p-3 dark:border-red-600 dark:bg-red-950"
					role="alert"
				>
					<p class="text-sm font-semibold text-red-900 dark:text-red-100">
						{$_('chat.stranger_fee.escalation.heading', {
							values: {
								multiplier: phase.priceQuote.multiplier,
								count: phase.priceQuote.recent_count,
								window: phase.priceQuote.window_minutes
							}
						})}
					</p>
					<p class="mt-1 text-xs text-red-800 dark:text-red-200">
						{$_('chat.stranger_fee.escalation.body')}
					</p>
				</div>
			{/if}

			<div
				class="mt-6 rounded-xl border border-ink-200 bg-ink-50 p-4 dark:border-ink-700 dark:bg-ink-900"
			>
				<div class="flex items-baseline justify-between gap-4">
					<span class="text-sm text-ink-500 dark:text-ink-500"
						>{$_('chat.stranger_fee.amount_label')}</span
					>
					<span class="font-mono text-lg font-bold">
						{phase.priceQuote.price_blurt.toFixed(3)} BLURT
					</span>
				</div>
				{#if fiatPerBlurt !== null}
					<div class="mt-1 flex items-baseline justify-end text-xs text-ink-500 dark:text-ink-500">
						<span>~{formatFiat(phase.priceQuote.price_blurt * fiatPerBlurt, denominationFiat)}</span
						>
					</div>
				{/if}
			</div>

			<p class="mt-4 text-xs text-ink-500 dark:text-ink-500">
				{$_('chat.stranger_fee.one_time_note', { values: { peer } })}
			</p>

			<!-- Password prompt for active-key unlock. -->
			<label class="mt-4 block">
				<span class="mb-1 block text-sm font-semibold">
					{$_('chat.stranger_fee.password_label')}
				</span>
				<input
					type="password"
					maxlength="64"
					bind:value={passwordInput}
					disabled={phase.kind === 'paying'}
					autocomplete="current-password"
					onkeydown={(e) => {
						if (e.key === 'Enter' && phase.kind === 'ready') {
							e.preventDefault();
							void onConfirm();
						}
					}}
					class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-morphit-emerald disabled:opacity-50 dark:border-ink-700 dark:bg-ink-900"
					placeholder={$_('chat.stranger_fee.password_placeholder') as string}
				/>
				{#if passwordError}
					<p class="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">
						{passwordError}
					</p>
				{/if}
			</label>

			<div class="mt-6 flex flex-col gap-3 sm:flex-row-reverse sm:justify-between">
				<button
					type="button"
					onclick={onConfirm}
					disabled={phase.kind === 'paying'}
					class="rounded-xl border-2 border-morphit-btn bg-morphit-btn px-4 py-2 font-semibold text-white hover:brightness-110 disabled:cursor-wait disabled:opacity-60"
				>
					{#if phase.kind === 'paying'}
						{$_('chat.stranger_fee.paying')}
					{:else}
						{$_('chat.stranger_fee.confirm')}
					{/if}
				</button>
				<button
					type="button"
					onclick={onCancel}
					disabled={phase.kind === 'paying'}
					class="rounded-xl border-2 border-ink-300 bg-white px-4 py-2 font-semibold hover:bg-ink-100 disabled:opacity-50 dark:border-ink-600 dark:bg-ink-900 dark:hover:bg-ink-800"
				>
					{$_('common.cancel')}
				</button>
			</div>
		{/if}
	</div>
</div>
