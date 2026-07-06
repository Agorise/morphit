<script lang="ts">
	/**
	 * FeatureBidForm — inline UI for bidding on a featured slot.
	 *
	 * Used on /my/orders as a disclosure under each live order,
	 * and on the post-order success flow as an "also feature
	 * this?" upsell. Emits a callback on success so the parent
	 * can refetch (or push a toast, or navigate).
	 *
	 * Design choices:
	 *   - Hours picker is a 4-option chip ladder (1, 6, 24, 72)
	 *     because a free-entry input would invite 168 here and
	 *     0.5 there and we don't need either edge case in the UI.
	 *     Power users can broadcast the op directly; the UI
	 *     caters to the 95% case.
	 *   - Live BLURT cost preview updates as the user picks
	 *     hours.
	 *   - Password gathered inline with the same JIT pattern as
	 *     /post — we never persist the password, and the
	 *     plaintext active key only exists inside the
	 *     useActiveKey callback.
	 */

	import { get } from 'svelte/store';
	import { _ } from 'svelte-i18n';
	import BusyButton from '$components/BusyButton.svelte';
	import { identity } from '$stores/identity';
	import { runWithActiveKey } from '$crypto/runWithActiveKey';
	import { broadcastFeatureBid } from '$blurt/ops/featureBid';
	import { ChainRejectedError, BroadcastUnavailableError } from '$blurt/broadcastTransport';
	import { getInstanceSnapshot } from '$stores/instance';
	import { resolveFeeRecipient } from '$lib/orders/fee';
	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import FeaturedBidHistory from '$components/FeaturedBidHistory.svelte';
	import { onMount } from 'svelte';
	import { symbolAmountToUsd } from '$lib/prices';

	interface Props {
		/** Permlink of the order to promote. Must be a live order
		 *  owned by the current signer — enforced on-chain by the
		 *  indexer handler, but the parent UI should already have
		 *  filtered to live-owned. */
		orderPermlink: string;
		/** Per-hour BLURT rate from config. Default 50 matches the
		 *  indexer's `MORPHIT_INDEXER_FEATURE_FEE_BLURT_PER_HOUR`
		 *  default. Surfacing this as a prop lets the parent
		 *  override if it has fresher config data. */
		feeBlurtPerHour?: number;
		/** Called on successful broadcast so the parent can refetch
		 *  or close the disclosure. */
		onSuccess?: (result: { trx_id: string; blurtPaid: number }) => void;
		/** Called when the user dismisses the form without bidding. */
		onCancel?: () => void;
	}

	let { orderPermlink, feeBlurtPerHour = 50, onSuccess, onCancel }: Props = $props();

	// The indexer enforces MIN_HOURS=6 (featureBid handler): a bid below 6h is
	// rejected on-chain, so offering 1h here just produced a confusing
	// "couldn't place your bid". Options start at the real minimum.
	const HOURS_OPTIONS = [6, 24, 72] as const;
	let selectedHours: (typeof HOURS_OPTIONS)[number] = $state(24);
	let password = $state('');
	let submitting = $state(false);
	/** Broadcast/signing error (locked, identity mismatch, generic failure).
	 *  cp420 — shown in red directly UNDER the password field (was a warn
	 *  line at the card bottom, which read as disconnected from the action
	 *  that failed). */
	let errorMessage = $state('');
	/** Password-specific error (bad/empty password) — shown in red right
	 *  under the field, alongside {@link errorMessage}. */
	let passwordError = $state('');
	/** The signing account, so the label can read "Your @account password"
	 *  and the user knows exactly whose password unlocks the active key. */
	const signingAccount = getUserBlurtAccount();
	const passwordLabel = $derived(
		signingAccount
			? ($_('feature_bid.password_label_named', {
					values: { handle: '@' + signingAccount }
				}) as string)
			: ($_('feature_bid.password_label') as string)
	);
	/** Toggled to briefly replay a twice-flash red border on the
	 *  password field when the entered password is rejected. */
	let flashPassword = $state(false);
	/** USD value of 1 BLURT, fetched once; drives the fiat-equivalent
	 *  hint next to the BLURT total. null until loaded / on failure. */
	let perBlurtUsd = $state<number | null>(null);

	// Current account for the FeaturedBidHistory upsell.  Null
	// when no account is on file (locked or pre-registration);
	// FeaturedBidHistory simply isn't rendered in that case.
	// Resolved once at mount — account name doesn't change
	// during a session.
	const historyAccount: string | null = getUserBlurtAccount();

	const totalBlurt = $derived(feeBlurtPerHour * selectedHours);
	// Ceil at 3 decimals to match on-chain formatting and avoid
	// an under-by-epsilon rendered vs. transferred discrepancy.
	const totalBlurtDisplay = $derived((Math.ceil(totalBlurt * 1000) / 1000).toFixed(3));
	// Fiat-equivalent hint. No persisted user fiat preference exists,
	// so we show the always-available USD value (BLURT is priced in
	// USD). Reactive to the hours picker.
	const totalUsdDisplay = $derived(
		perBlurtUsd === null ? null : (totalBlurt * perBlurtUsd).toFixed(2)
	);
	onMount(async () => {
		try {
			perBlurtUsd = (await symbolAmountToUsd(1, 'BLURT')).usd;
		} catch {
			perBlurtUsd = null;
		}
	});
	function flashPasswordBorder(): void {
		flashPassword = false;
		requestAnimationFrame(() => {
			flashPassword = true;
			setTimeout(() => (flashPassword = false), 700);
		});
	}

	async function submit(): Promise<void> {
		if (submitting) return;
		const state = get(identity);
		if (state.state !== 'unlocked') {
			errorMessage = $_('feature_bid.error_locked');
			return;
		}
		if (password.length === 0) {
			passwordError = $_('feature_bid.error_password_required');
			flashPasswordBorder();
			return;
		}
		submitting = true;
		errorMessage = '';
		passwordError = '';

		// Phase F.5 audit fix (F-18) — sign-callback pattern.
		try {
			const signCallback = async (
				unsigned: import('@beblurt/dblurt').Transaction
			): Promise<import('@beblurt/dblurt').SignedTransaction> => {
				const r = await runWithActiveKey(password, async (activePriv) => {
					const { signOrderWithFeeWithKey } = await import('$blurt/sign');
					return signOrderWithFeeWithKey(unsigned, activePriv);
				});
				if (!r.ok) {
					const err = new Error(`runWithActiveKey:${r.kind}`);
					(err as Error & { kind?: string }).kind = r.kind;
					throw err;
				}
				return r.value;
			};
			const result = await broadcastFeatureBid(
				state.live,
				signCallback,
				{
					orderPermlink,
					hoursRequested: selectedHours,
					feeBlurtPerHour
				},
				resolveFeeRecipient(getInstanceSnapshot().fee_recipient)
			);
			password = '';
			onSuccess?.({
				trx_id: result.trx_id,
				blurtPaid: result.blurtPaid
			});
		} catch (err) {
			password = '';
			const kind = (err as Error & { kind?: string }).kind;
			if (kind === 'bad_password') {
				passwordError = $_('feature_bid.error_bad_password');
				flashPasswordBorder();
			} else if (kind === 'identity_mismatch') {
				errorMessage = $_('crypto.error.identity_mismatch');
			} else if (kind === 'locked') {
				errorMessage = $_('feature_bid.error_locked');
			} else if (kind === 'password_empty') {
				passwordError = $_('feature_bid.error_password_required');
				flashPasswordBorder();
			} else if (err instanceof ChainRejectedError) {
				// cp425 — the network rejected the tx. Surface the REAL reason
				// (not enough liquid BLURT for the network fee, missing
				// authority, etc. — NOT mana/RC, which is the Steem/Hive model)
				// instead of a generic message that hides what went wrong.
				errorMessage = $_('feature_bid.error_chain_rejected', {
					values: { reason: err.message }
				});
			} else if (err instanceof BroadcastUnavailableError) {
				errorMessage = $_('feature_bid.error_unreachable');
			} else {
				console.warn('[feature_bid] unrecognized error:', err);
				errorMessage = $_('feature_bid.error_generic');
			}
		}
		submitting = false;
	}
</script>

<div
	class="rounded-xl border-2 border-morphit-emerald/40 bg-gradient-to-br from-morphit-emerald/5 to-morphit-teal/5 p-4"
>
	{#if historyAccount !== null}
		<FeaturedBidHistory account={historyAccount} />
	{/if}

	<p class="mb-1 font-display text-lg font-bold">
		🚀 {$_('feature_bid.title')}
	</p>
	<p class="mb-3 text-xs text-ink-600 dark:text-ink-300">
		{$_('feature_bid.explainer')}
	</p>

	<!-- Hours picker -->
	<fieldset class="mb-3">
		<legend class="mb-2 text-xs font-semibold text-ink-700 dark:text-ink-200">
			{$_('feature_bid.hours_label')}
		</legend>
		<div class="flex flex-wrap gap-2" role="radiogroup">
			{#each HOURS_OPTIONS as h}
				<button
					type="button"
					role="radio"
					aria-checked={selectedHours === h}
					onclick={() => (selectedHours = h)}
					class="rounded-full border-2 px-3 py-1 text-sm transition active:scale-[0.98] {selectedHours ===
					h
						? 'border-morphit-emerald bg-morphit-emerald/10 font-semibold'
						: 'border-ink-300 dark:border-ink-600'}"
				>
					{$_('feature_bid.hours_option', { values: { n: h } })}
				</button>
			{/each}
		</div>
	</fieldset>

	<!-- Cost preview -->
	<div class="mb-3 rounded-lg bg-ink-50 p-3 dark:bg-ink-800">
		<p class="text-xs text-ink-500 dark:text-ink-400">
			{$_('feature_bid.cost_label')}
		</p>
		<p class="font-display text-lg font-bold">
			{totalBlurtDisplay} BLURT{#if totalUsdDisplay}<span
					class="ml-2 text-sm font-normal text-ink-500 dark:text-ink-400"
					>(~${totalUsdDisplay} USD)</span
				>{/if}
		</p>
		<p class="text-xs text-ink-500 dark:text-ink-400">
			{$_('feature_bid.cost_detail', {
				values: { per_hour: feeBlurtPerHour, hours: selectedHours }
			})}
		</p>
	</div>

	<!-- Password prompt. Required because this op uses the
	     active key (pays BLURT). Same JIT pattern as /post:
	     never persisted, cleared after submit, and the plaintext
	     active key only exists inside the useActiveKey callback. -->
	<label class="mb-3 block">
		<span class="mb-1 block text-xs font-semibold text-ink-700 dark:text-ink-200">
			{passwordLabel}
		</span>
		<input
			type="password"
			maxlength="64"
			bind:value={password}
			autocomplete="current-password"
			disabled={submitting}
			class="w-full rounded-lg border bg-white px-3 py-2 text-sm focus:border-morphit-emerald focus:outline-none focus:ring-1 focus:ring-morphit-emerald dark:bg-ink-900 {passwordError
				? 'border-red-500 dark:border-red-500'
				: 'border-ink-300 dark:border-ink-700'}"
			class:password-flash={flashPassword}
		/>
	</label>
	{#if passwordError}
		<p class="-mt-2 mb-3 text-sm font-medium text-red-600 dark:text-red-400" role="alert">
			{passwordError}
		</p>
	{/if}
	{#if errorMessage}
		<p class="-mt-2 mb-3 text-sm font-medium text-red-600 dark:text-red-400" role="alert">
			{errorMessage}
		</p>
	{/if}

	<div class="flex flex-col gap-2">
		<BusyButton
			variant="primary"
			busy={submitting}
			busyLabel={$_('common.broadcasting')}
			onclick={submit}
		>
			{$_('feature_bid.submit_button')}
		</BusyButton>
		{#if onCancel}
			<BusyButton variant="ghost" onclick={() => onCancel?.()}>
				{$_('feature_bid.cancel_button')}
			</BusyButton>
		{/if}
	</div>
</div>

<style>
	/* Twice-flash red border on the password field when a bad
	   password is rejected (see flashPasswordBorder). */
	@keyframes flashRedBorder {
		0%,
		50%,
		100% {
			border-color: rgb(239 68 68);
		}
		25%,
		75% {
			border-color: rgb(239 68 68 / 0.25);
		}
	}
	.password-flash {
		animation: flashRedBorder 0.7s ease-in-out;
	}
</style>
