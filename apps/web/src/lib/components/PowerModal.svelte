<script lang="ts">
	/**
	 * PowerModal — confirm + broadcast a Power up (stake) or Power down
	 * (unstake) operation from the user's own Morphit-bound account.
	 *
	 * cp424 wallet security pass. Both actions sign with the ACTIVE key
	 * and move value on-chain, so this reuses the exact hardened path the
	 * Pay-now flow uses:
	 *
	 *   prepare unsigned op  →  runWithActiveKey(sign…)  →  broadcast
	 *
	 * The active key only exists inside the synchronous sign closure and
	 * is wiped immediately after (runWithActiveKey), and the password
	 * string is cleared the moment the call returns.
	 *
	 *   • mode='up'   → transfer_to_vesting (from === to === self). BLURT
	 *                   in, staked as BP. Effect is immediate.
	 *   • mode='down' → withdraw_vesting. BP unstaked back to liquid
	 *                   BLURT GRADUALLY over ~4 weeks (a Blurt protocol
	 *                   rule — surfaced honestly, never implied instant).
	 *
	 * Amount safety:
	 *   • The entered amount is bounded to the available balance, must be
	 *     > 0, and is formatted to the EXACT chain precision (3-dec BLURT
	 *     for up, 6-dec VESTS for down) before it ever reaches the signer;
	 *     the formatters throw on a bad number, so a malformed amount can
	 *     never be signed.
	 *   • Power-down enters an amount in BP but the op takes VESTS, so BP
	 *     is converted via the live global pool ratio. For "use full
	 *     balance" we send the EXACT on-chain `vesting_shares` string
	 *     instead of a BP→VESTS round-trip, so powering down everything
	 *     leaves no dust.
	 */

	import { _, locale } from 'svelte-i18n';
	import { runWithActiveKey } from '$crypto/runWithActiveKey';
	import {
		prepareUnsignedTransferToVesting,
		prepareUnsignedWithdrawVesting,
		signTransferWithKey,
		broadcastSignedTransaction
	} from '$blurt/sign';
	import { signWithdrawVestingWithKey } from '$blurt/withdrawVestingSign';
	import { ChainRejectedError, BroadcastUnavailableError } from '$blurt/broadcastTransport';
	import { floorToBlurtPrecision } from '$blurt/sendValidation';
	import {
		blurtPowerToVests,
		formatBlurtAmount,
		formatVestsAmount
	} from '$blurt/balanceMath';
	import type { PowerDownProgress } from '$blurt/powerDownProgress';
	import { formatDayMonth } from '$lib/i18n/formatters';

	interface Props {
		/** 'up' = stake liquid BLURT as BP; 'down' = unstake BP → BLURT. */
		mode: 'up' | 'down';
		/** The signing account (the profile owner — always self). */
		account: string;
		/** Available liquid BLURT (for mode='up': the ceiling + clickable). */
		blurtBalance: number;
		/** Available Blurt Power in BP (for mode='down': ceiling + clickable). */
		bpBalance: number;
		/** DGP total_vesting_fund_blurt (raw "N.NNN BLURT" string) — for
		 *  the BP→VESTS conversion (blurtPowerToVests parses it). */
		vestingFund: string;
		/** DGP total_vesting_shares (raw "N.NNNNNN VESTS" string) — for
		 *  the BP→VESTS conversion. */
		totalVests: string;
		/** The account's EXACT on-chain vesting_shares string (e.g.
		 *  "12345.678901 VESTS"), used verbatim for "power down everything"
		 *  so no dust is left behind. */
		vestingSharesRaw: string;
		/** cp439 — an already-running power-down (amount left + finish date),
		 *  or null. Shown as a 💡 note in the mode='down' modal so the user
		 *  sees an unstake is already underway before starting another. */
		powerDown?: PowerDownProgress | null;
		/** Broadcast succeeded → parent refreshes the balance + closes. */
		onDone: () => void;
		/** Cancel / dismiss. */
		onCancel: () => void;
	}

	let {
		mode,
		account,
		blurtBalance,
		bpBalance,
		vestingFund,
		totalVests,
		vestingSharesRaw,
		powerDown = null,
		onDone,
		onCancel
	}: Props = $props();

	type Phase =
		| { kind: 'ready' }
		| { kind: 'working' }
		| { kind: 'error'; messageKey: string; reason?: string };

	let phase = $state<Phase>({ kind: 'ready' });
	let enteredAmount = $state('');
	let passwordInput = $state('');
	let passwordError = $state('');
	/** Set when the user clicks "Use full balance" and left the amount
	 *  untouched — power-down then sends the exact on-chain vesting_shares
	 *  instead of a lossy BP→VESTS round-trip. Any manual edit clears it. */
	let usingFullBalance = $state(false);

	const available = $derived(mode === 'up' ? blurtBalance : bpBalance);

	/** The available balance FLOORED to chain display precision (3 dp). cp453 —
	 *  `toFixed(3)` ROUNDS, so a raw balance like 74.8176 became "74.818", a hair
	 *  ABOVE the real ceiling; "Use full balance" then failed the `<= available`
	 *  check ("Enter an amount up to your available balance") even though the
	 *  displayed Available read the same. Flooring can never exceed the real
	 *  balance, so both the full-balance fill and the displayed ceiling always
	 *  validate. Power-down still unstakes the EXACT vesting_shares (everything)
	 *  via usingFullBalance, so the ≤0.001 the floor drops from the DISPLAY is
	 *  never actually left behind on-chain. */
	const availableFloor = $derived(floorToBlurtPrecision(available));

	/** cp439 — remaining-BP figure for the 💡 in-progress note, formatted the
	 *  same way the balance card shows BP (locale grouping, 3 decimals). The
	 *  i18n string supplies the "BP" unit, so this is number-only. */
	const powerDownAmountText = $derived(
		powerDown
			? powerDown.remainingBp.toLocaleString($locale ?? undefined, {
					minimumFractionDigits: 3,
					maximumFractionDigits: 3
				})
			: ''
	);

	/** The entered amount as a number, for validation + conversion. */
	const amountNum = $derived(Number(enteredAmount.trim()));

	/** Valid iff a finite positive number that does not exceed the
	 *  available balance (a hair of float tolerance on the ceiling). */
	const amountValid = $derived(
		Number.isFinite(amountNum) && amountNum > 0 && amountNum <= available + 1e-6
	);

	const canConfirm = $derived(
		account.length > 0 && amountValid && phase.kind !== 'working'
	);

	function useFullBalance(): void {
		if (!Number.isFinite(available) || available <= 0) return;
		// FLOOR (not toFixed's round) so the fill never exceeds the real
		// ceiling. On confirm, power-down uses the exact vesting_shares string
		// (usingFullBalance), so this never reaches the chain for "everything".
		enteredAmount = availableFloor;
		usingFullBalance = mode === 'down';
	}

	function onAmountInput(): void {
		// A manual edit means we can no longer treat this as "everything".
		usingFullBalance = false;
	}

	async function confirm(): Promise<void> {
		if (!canConfirm) return;
		if (passwordInput.length === 0) {
			passwordError = $_('profile.wallet.error_password_required') as string;
			return;
		}
		passwordError = '';
		phase = { kind: 'working' };

		// Build the unsigned op (network fetch for ref_block; no key in
		// scope). The amount is formatted to exact chain precision here —
		// the formatters throw on a bad number, so nothing malformed can be
		// signed.
		let unsignedTx;
		try {
			if (mode === 'up') {
				unsignedTx = await prepareUnsignedTransferToVesting(
					account,
					account,
					formatBlurtAmount(amountNum)
				);
			} else {
				const vestsStr = usingFullBalance
					? vestingSharesRaw
					: formatVestsAmount(blurtPowerToVests(amountNum, vestingFund, totalVests));
				unsignedTx = await prepareUnsignedWithdrawVesting(account, vestsStr);
			}
		} catch (err) {
			passwordInput = '';
			console.warn('[power] prepare failed:', err);
			phase =
				err instanceof BroadcastUnavailableError
					? { kind: 'error', messageKey: 'profile.wallet.error_unreachable' }
					: { kind: 'error', messageKey: 'profile.wallet.error_broadcast' };
			return;
		}

		// Sign inside runWithActiveKey — activePriv lives only for the
		// synchronous sign call, then is wiped.
		const r = await runWithActiveKey(passwordInput, async (activePriv) => {
			return mode === 'up'
				? signTransferWithKey(unsignedTx, activePriv)
				: signWithdrawVestingWithKey(unsignedTx, activePriv);
		});
		passwordInput = '';

		if (r.ok) {
			try {
				await broadcastSignedTransaction(r.value);
				onDone();
				return;
			} catch (err) {
				// Surface the chain's actual reason. NOTE: powering up does NOT
				// require mana/RC — that's the Hive/Steem model. On Blurt an op
				// costs a small fee paid from LIQUID BLURT (operation flat fee +
				// bandwidth fee, set by witnesses); mana on Blurt is only voting
				// power. With ample liquid BLURT the fee is trivially covered, so
				// whatever the chain reports here is shown verbatim rather than
				// guessed at.
				console.warn('[power] broadcast rejected:', err);
				if (err instanceof ChainRejectedError) {
					phase = {
						kind: 'error',
						messageKey: 'profile.wallet.error_chain_rejected',
						reason: err.message
					};
				} else if (err instanceof BroadcastUnavailableError) {
					phase = { kind: 'error', messageKey: 'profile.wallet.error_unreachable' };
				} else {
					phase = { kind: 'error', messageKey: 'profile.wallet.error_broadcast' };
				}
				return;
			}
		}
		if (r.kind === 'bad_password') {
			phase = { kind: 'ready' };
			passwordError = $_('profile.wallet.error_bad_password') as string;
		} else if (r.kind === 'identity_mismatch') {
			phase = { kind: 'error', messageKey: 'crypto.error.identity_mismatch' };
		} else if (r.kind === 'locked') {
			phase = { kind: 'error', messageKey: 'profile.wallet.error_no_active_key' };
		} else if (r.kind === 'password_empty') {
			phase = { kind: 'ready' };
		} else {
			phase = { kind: 'error', messageKey: 'profile.wallet.error_broadcast' };
		}
	}

	function onBackdropClick(e: MouseEvent): void {
		if (phase.kind === 'working') return;
		if (e.target === e.currentTarget) onCancel();
	}
</script>

<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 p-4 backdrop-blur-sm"
	role="dialog"
	aria-modal="true"
	aria-labelledby="power-modal-heading"
	onclick={onBackdropClick}
	onkeydown={(e) => {
		if (e.key === 'Escape' && phase.kind !== 'working') onCancel();
	}}
	tabindex="-1"
>
	<div class="card max-h-[95dvh] overflow-y-auto overscroll-contain w-full max-w-md">
		<h2 id="power-modal-heading" class="font-display text-xl font-bold">
			{mode === 'up' ? $_('profile.wallet.power_up_title') : $_('profile.wallet.power_down_title')}
		</h2>
		<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
			{mode === 'up'
				? $_('profile.wallet.power_up_subtitle')
				: $_('profile.wallet.power_down_subtitle')}
		</p>

		{#if mode === 'down' && powerDown}
			<!-- cp439 — a power-down is already running. Show how much is left
			     and when the final weekly payout lands, so the user knows an
			     unstake is underway before they start another. -->
			<p
				class="mt-3 flex items-start gap-1.5 rounded-lg border border-morphit-teal/40 bg-morphit-teal/5 p-2.5 text-xs text-ink-600 dark:border-morphit-emerald/40 dark:text-ink-300"
			>
				<span aria-hidden="true" class="flex-none">💡</span>
				<span>
					{$_('profile.wallet.power_down_in_progress', {
						values: {
							amount: powerDownAmountText,
							date: formatDayMonth(powerDown.finishIso)
						}
					})}
				</span>
			</p>
		{/if}

		{#if phase.kind === 'error'}
			<div
				class="mt-5 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
			>
				{phase.reason
					? $_(phase.messageKey, { values: { reason: phase.reason } })
					: $_(phase.messageKey)}
			</div>
			<div class="mt-5 flex justify-end">
				<button
					type="button"
					class="rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold transition-colors hover:border-ink-400 hover:bg-ink-50 dark:border-ink-700 dark:hover:bg-ink-800"
					onclick={onCancel}
				>
					{$_('common.close')}
				</button>
			</div>
		{:else}
			<!-- Amount + clickable available balance -->
			<label class="mt-5 block">
				<span class="text-sm font-semibold">{$_('profile.wallet.amount_label')}</span>
				<input
					type="text"
					bind:value={enteredAmount}
					oninput={onAmountInput}
					maxlength="20"
					inputmode="decimal"
					autocomplete="off"
					disabled={phase.kind === 'working'}
					placeholder={mode === 'up'
						? ($_('profile.wallet.power_up_placeholder') as string)
						: ($_('profile.wallet.power_down_placeholder') as string)}
					class="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 font-mono text-sm dark:border-ink-700 dark:bg-ink-900"
				/>
			</label>
			<div class="mt-1.5 flex items-center justify-between gap-2 text-xs">
				<span class="text-ink-500 dark:text-ink-400">
					{mode === 'up'
						? $_('profile.wallet.available_blurt', {
								values: { amount: availableFloor }
							})
						: $_('profile.wallet.available_bp', {
								values: { amount: availableFloor }
							})}
				</span>
				<button
					type="button"
					onclick={useFullBalance}
					disabled={phase.kind === 'working' || !(available > 0)}
					class="cursor-pointer font-semibold text-morphit-teal underline decoration-dotted underline-offset-2 hover:text-morphit-emerald disabled:cursor-not-allowed disabled:opacity-50 dark:text-morphit-emerald"
				>
					{$_('profile.wallet.use_full')}
				</button>
			</div>
			{#if enteredAmount.trim().length > 0 && !amountValid}
				<p class="mt-1 text-xs text-red-600 dark:text-red-400">
					{$_('profile.wallet.error_amount')}
				</p>
			{/if}

			{#if mode === 'down'}
				<!-- Honest disclosure: power-down is NOT instant. -->
				<p
					class="mt-3 flex items-start gap-1.5 rounded-lg border border-morphit-teal/40 bg-morphit-teal/5 p-2.5 text-xs text-ink-600 dark:border-morphit-emerald/40 dark:text-ink-300"
				>
					<span aria-hidden="true" class="flex-none">⏳</span>
					<span>{$_('profile.wallet.power_down_schedule')}</span>
				</p>
			{/if}

			<!-- Password (active key) -->
			<label class="mt-5 block">
				<span class="text-sm font-semibold">
					{$_('profile.wallet.password_label', { values: { account } })}
				</span>
				<input
					type="password"
					maxlength="64"
					bind:value={passwordInput}
					autocomplete="current-password"
					disabled={phase.kind === 'working'}
					class="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm dark:border-ink-700 dark:bg-ink-900"
				/>
				{#if passwordError}
					<p class="mt-1 text-xs text-red-600 dark:text-red-400">{passwordError}</p>
				{/if}
			</label>

			<div class="mt-5 flex justify-end gap-2">
				<button
					type="button"
					class="rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold transition-colors hover:border-ink-400 hover:bg-ink-50 disabled:opacity-50 dark:border-ink-700 dark:hover:bg-ink-800"
					onclick={onCancel}
					disabled={phase.kind === 'working'}
				>
					{$_('common.cancel')}
				</button>
				<button
					type="button"
					class="rounded-lg bg-morphit-btn px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50"
					onclick={confirm}
					disabled={!canConfirm}
				>
					{#if phase.kind === 'working'}
						{$_('common.broadcasting')}
					{:else if mode === 'up'}
						{$_('profile.wallet.power_up_action')}
					{:else}
						{$_('profile.wallet.power_down_action')}
					{/if}
				</button>
			</div>
		{/if}
	</div>
</div>
