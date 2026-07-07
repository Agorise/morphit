<script lang="ts">
	/**
	 * PayBlurtModal — confirm + broadcast a BLURT transfer.
	 *
	 * Phase F.3.  Pay-now flow when the buyer wants to send the
	 * BLURT directly from their Morphit-bound account, without
	 * leaving the chat or opening another wallet.
	 *
	 * Flow:
	 *   1. Render summary: amount, recipient, and (if non-empty)
	 *      the opaque memo the seller pinned. See "Memo policy"
	 *      below.
	 *   2. Active-key password prompt.
	 *   3. On confirm → prepareUnsignedTransfer → runWithActiveKey
	 *      (signTransferWithKey) → broadcastSignedTransaction.
	 *      Phase F.5 audit fix (F-18): split sign+broadcast so
	 *      the active key only lives during the synchronous sign.
	 *   4. On success → onPaid(txid) so the parent can
	 *      auto-broadcast a morphit_funds_sent chat payload.
	 *   5. On failure → surface specific error (bad_password,
	 *      locked, broadcast_failed).
	 *
	 * Memo policy: opaque tokens only. The `memo` prop carries a
	 * random alphanumeric token (lowercase, 6..32 chars per
	 * `payload.ts`'s MEMO_RE) that the seller pinned to the
	 * address pill. Goes into the on-chain transfer memo so the
	 * seller can match the payment to this trade. The token is
	 * opaque — random alphanumerics, no trade-specific
	 * identifiers — so anyone scraping the public chain learns
	 * nothing about what the trade was. Both parties already
	 * saw the memo in the encrypted chat where it was generated,
	 * so its meaning is shared between them only. (Pre-Phase-F.4
	 * doc comment said "no memo" — that policy was superseded by
	 * the opaque-token design at Phase F.4 ratification; comment
	 * corrected Part 73.)
	 *
	 * Empty memo means "seller didn't request a memo" — chain
	 * memo field is left empty in that case.
	 *
	 * Active-key requirement: BLURT transfers need active auth.
	 * `runWithActiveKey()` JIT-derives the scalar from the
	 * encrypted active envelope (set up at registration),
	 * passes it to the broadcast, then wipes from memory.  The
	 * password input is also wiped after the call.
	 */

	import { _ } from 'svelte-i18n';
	import { runWithActiveKey } from '$crypto/runWithActiveKey';
	import {
		prepareUnsignedTransfer,
		signTransferWithKey,
		broadcastSignedTransaction
	} from '$blurt/sign';
	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import { formatBlurtAmount } from '$lib/orders/fee';

	interface Props {
		/** Recipient's Blurt account name (validated upstream by
		 *  the address-payload regex). */
		recipient: string;
		/** BLURT amount as a positive number, parsed from the
		 *  address payload's amount field upstream. Optional: in the
		 *  composer "Pay now" flow (cp402 [7b]) there is no pill, so the
		 *  amount is entered in-modal instead (see `amountEditable`). */
		amount?: number;
		/** cp402 [7b] — when true, the modal was opened from the composer
		 *  "Pay now" (no pill), so it shows a validated amount INPUT and
		 *  uses that instead of the `amount` prop. The recipient is still
		 *  fixed to `@peer` (never user-editable), so only the amount is
		 *  entered; the same `canPay` guard + broadcast path apply. */
		amountEditable?: boolean;
		/** Phase F.4 — payment memo the seller pinned to the
		 *  address pill.  Goes into the on-chain transfer's memo
		 *  field so the seller can match this payment to this
		 *  trade.  Empty string means "no memo requested" — chain
		 *  memo is left empty.  Buyer cannot edit; we display
		 *  the memo prominently in the confirm summary so they
		 *  know what's about to land on chain. */
		memo: string;
		/** Called when the broadcast succeeds.  Receives the
		 *  on-chain trx_id + the amount actually broadcast so the
		 *  parent can auto-broadcast a morphit_funds_sent payload
		 *  with the correct amount (cp402 [7b] — the composer flow's
		 *  amount is entered in-modal, not known to the parent). */
		onPaid: (result: { trxId: string; blockNum: number; amount: number }) => void;
		/** Called on cancel / dismiss. */
		onCancel: () => void;
		/** cp406 — optional one-line caption under the amount field explaining a
		 *  pre-filled amount (e.g. "The order's minimum is 500 MXN (≈ 588 BLURT)").
		 *  Empty string renders nothing. */
		payHint?: string;
	}

	let {
		recipient,
		amount = 0,
		amountEditable = false,
		memo,
		onPaid,
		onCancel,
		payHint = ''
	}: Props = $props();

	type Phase = { kind: 'ready' } | { kind: 'paying' } | { kind: 'error'; messageKey: string };

	let phase = $state<Phase>({ kind: 'ready' });
	let passwordInput = $state('');
	let passwordError = $state('');
	/** cp402 [7b] — the in-modal amount for the composer flow. Ignored
	 *  when `amountEditable` is false (the pill-provided `amount` is used
	 *  verbatim, exactly as before). */
	let enteredAmount = $state('');

	const myAccount = getUserBlurtAccount();

	/** cp402 [7b] — the amount that will actually be sent: the entered
	 *  value in composer mode, otherwise the pill-provided prop. Parsed
	 *  to a number so the SAME validation + formatting applies to both. */
	const effectiveAmount = $derived(amountEditable ? Number(enteredAmount.trim()) : amount);
	const formattedAmount = $derived(
		formatBlurtAmount(Number.isFinite(effectiveAmount) && effectiveAmount > 0 ? effectiveAmount : 0)
	);

	/** Sanity guards.  These should never trip via real UI — the
	 *  pay-now button is disabled when the conditions aren't met
	 *  — but defense in depth. */
	const canPay = $derived(
		myAccount !== null &&
			myAccount !== recipient &&
			effectiveAmount > 0 &&
			Number.isFinite(effectiveAmount)
	);

	async function confirm(): Promise<void> {
		if (!canPay) return;
		if (passwordInput.length === 0) {
			passwordError = $_('chat.pay_blurt.error.password_required') as string;
			return;
		}
		passwordError = '';
		phase = { kind: 'paying' };

		// Phase F.5 audit fix (F-18) — split sign + broadcast so
		// the active key only lives for the ~10ms signing window,
		// not the 200-2000ms network roundtrip.
		//
		// 1. Prepare the unsigned transaction (network call for
		//    ref_block info, no key in scope).
		// 2. Sign inside runWithActiveKey — closure scope holds
		//    activePriv only for the duration of the synchronous
		//    signTransferWithKey call.
		// 3. Broadcast outside — no keys in scope.
		let unsignedTx;
		try {
			unsignedTx = await prepareUnsignedTransfer(
				myAccount as string,
				recipient,
				formattedAmount,
				memo // Phase F.4 — empty when seller didn't request one
			);
		} catch {
			// Hygiene: clear password if we're bailing before the
			// active-key path even runs. User would have to re-type
			// to retry, but the security benefit of not leaving the
			// password sitting in component state on an error path
			// is worth it.
			passwordInput = '';
			phase = {
				kind: 'error',
				messageKey: 'chat.pay_blurt.error.broadcast_failed'
			};
			return;
		}

		const r = await runWithActiveKey(passwordInput, async (activePriv) => {
			return signTransferWithKey(unsignedTx, activePriv);
		});
		passwordInput = '';

		if (r.ok) {
			// Active key wiped already; signedTx holds only signatures.
			try {
				const result = await broadcastSignedTransaction(r.value);
				onPaid({ trxId: result.trx_id, blockNum: result.block_num, amount: effectiveAmount });
				return;
			} catch {
				phase = {
					kind: 'error',
					messageKey: 'chat.pay_blurt.error.broadcast_failed'
				};
				return;
			}
		}
		if (r.kind === 'bad_password') {
			phase = { kind: 'ready' };
			passwordError = $_('chat.pay_blurt.error.bad_password') as string;
		} else if (r.kind === 'identity_mismatch') {
			phase = {
				kind: 'error',
				messageKey: 'crypto.error.identity_mismatch'
			};
		} else if (r.kind === 'locked') {
			phase = {
				kind: 'error',
				messageKey: 'chat.pay_blurt.error.no_active_envelope'
			};
		} else if (r.kind === 'password_empty') {
			phase = { kind: 'ready' };
		} else {
			// Sign-time failure — could be a malformed key or
			// crypto error.  Same generic message.
			phase = {
				kind: 'error',
				messageKey: 'chat.pay_blurt.error.broadcast_failed'
			};
		}
	}

	function onBackdropClick(e: MouseEvent): void {
		// Don't dismiss during paying — broadcast is in flight.
		if (phase.kind === 'paying') return;
		if (e.target === e.currentTarget) onCancel();
	}
</script>

<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 p-4 backdrop-blur-sm"
	role="dialog"
	aria-modal="true"
	aria-labelledby="pay-blurt-heading"
	onclick={onBackdropClick}
	onkeydown={(e) => {
		if (e.key === 'Escape' && phase.kind !== 'paying') onCancel();
	}}
	tabindex="-1"
>
	<div class="card w-full max-w-md">
		<h2 id="pay-blurt-heading" class="font-display text-xl font-bold">
			{$_('chat.pay_blurt.title', { values: { recipient } })}
		</h2>
		<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
			{$_('chat.pay_blurt.subtitle')}
		</p>

		{#if amountEditable}
			<!-- cp402 [7b] — composer "Pay now": the amount is entered here
			     (there is no address pill to carry it). Validated to a
			     positive BLURT number; the confirmation summary + Send
			     button below appear only once it is valid. The recipient
			     stays fixed to @peer — only the amount is user-entered. -->
			<label class="mt-5 block">
				<span class="text-sm font-semibold">{$_('chat.pay_blurt.amount_label')}</span>
				<input
					type="text"
					bind:value={enteredAmount}
					maxlength="20"
					inputmode="decimal"
					autocomplete="off"
					disabled={phase.kind === 'paying'}
					placeholder={$_('chat.pay_blurt.amount_placeholder') as string}
					class="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 font-mono text-sm dark:border-ink-700 dark:bg-ink-900"
				/>
				{#if payHint}
					<p class="mt-1 text-xs text-morphit-teal dark:text-morphit-emerald">{payHint}</p>
				{/if}
				{#if enteredAmount.trim().length > 0 && !canPay && myAccount !== null && myAccount !== recipient}
					<p class="mt-1 text-xs text-red-600 dark:text-red-400">
						{$_('chat.pay_blurt.error.invalid_amount')}
					</p>
				{:else}
					<p class="mt-1 text-xs text-ink-500 dark:text-ink-400">
						{$_('chat.pay_blurt.amount_help')}
					</p>
				{/if}
			</label>
		{/if}

		{#if !canPay}
			{#if myAccount === null || myAccount === recipient || !amountEditable}
				<div
					class="mt-5 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
				>
					{#if myAccount === null}
						{$_('chat.pay_blurt.error.no_account')}
					{:else if myAccount === recipient}
						{$_('chat.pay_blurt.error.self_pay')}
					{:else}
						{$_('chat.pay_blurt.error.invalid_amount')}
					{/if}
				</div>
				<div class="mt-5 flex justify-end">
					<button
						type="button"
						class="rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold hover:border-ink-400 dark:border-ink-700"
						onclick={onCancel}
					>
						{$_('common.close')}
					</button>
				</div>
			{:else}
				<!-- cp402 [7b] — editable + amount not entered yet: no scary
				     error (the input above guides the user); offer Cancel. -->
				<div class="mt-5 flex justify-end">
					<button
						type="button"
						class="rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold hover:border-ink-400 dark:border-ink-700"
						onclick={onCancel}
					>
						{$_('common.cancel')}
					</button>
				</div>
			{/if}
		{:else}
			<!-- Summary card -->
			<div class="mt-5 rounded-lg border-2 border-morphit-emerald/40 bg-morphit-emerald/5 p-4">
				<dl class="space-y-2 text-sm">
					<div class="flex justify-between gap-4">
						<dt class="font-semibold text-ink-600 dark:text-ink-300">
							{$_('chat.pay_blurt.amount_label')}
						</dt>
						<dd class="font-mono font-bold text-morphit-emerald">
							{formattedAmount}
						</dd>
					</div>
					<div class="flex justify-between gap-4">
						<dt class="font-semibold text-ink-600 dark:text-ink-300">
							{$_('chat.pay_blurt.recipient_label')}
						</dt>
						<dd class="break-all font-mono">{recipient}</dd>
					</div>
					<div class="flex justify-between gap-4">
						<dt class="font-semibold text-ink-600 dark:text-ink-300">
							{$_('chat.pay_blurt.from_label')}
						</dt>
						<dd class="break-all font-mono text-ink-500 dark:text-ink-500">{myAccount}</dd>
					</div>
					{#if memo !== ''}
						<div class="flex justify-between gap-4">
							<dt class="font-semibold text-ink-600 dark:text-ink-300">
								{$_('chat.pay_blurt.memo_label')}
							</dt>
							<dd class="break-all font-mono font-bold text-red-700 dark:text-red-300">
								{memo}
							</dd>
						</div>
					{/if}
				</dl>
			</div>

			<p class="mt-3 text-xs text-ink-500 dark:text-ink-400">
				{memo !== '' ? $_('chat.pay_blurt.with_memo_notice') : $_('chat.pay_blurt.no_memo_notice')}
			</p>

			{#if phase.kind === 'error'}
				<div
					class="mt-5 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
				>
					{$_(phase.messageKey)}
				</div>
				<div class="mt-5 flex justify-end gap-2">
					<button
						type="button"
						class="rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold hover:border-ink-400 dark:border-ink-700"
						onclick={onCancel}
					>
						{$_('common.close')}
					</button>
				</div>
			{:else}
				<!-- Password input -->
				<label class="mt-5 block">
					<span class="text-sm font-semibold">
						{$_('chat.pay_blurt.password_label')}
					</span>
					<input
						type="password"
						maxlength="64"
						bind:value={passwordInput}
						autocomplete="current-password"
						disabled={phase.kind === 'paying'}
						class="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm dark:border-ink-700 dark:bg-ink-900"
					/>
					{#if passwordError}
						<p class="mt-1 text-xs text-red-600 dark:text-red-400">
							{passwordError}
						</p>
					{/if}
				</label>

				<div class="mt-5 flex justify-end gap-2">
					<button
						type="button"
						class="rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold hover:border-ink-400 dark:border-ink-700"
						onclick={onCancel}
						disabled={phase.kind === 'paying'}
					>
						{$_('common.cancel')}
					</button>
					<button
						type="button"
						class="rounded-lg bg-morphit-btn px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50"
						onclick={confirm}
						disabled={phase.kind === 'paying'}
					>
						{phase.kind === 'paying' ? $_('chat.pay_blurt.paying') : $_('chat.pay_blurt.confirm')}
					</button>
				</div>
			{/if}
		{/if}
	</div>
</div>
