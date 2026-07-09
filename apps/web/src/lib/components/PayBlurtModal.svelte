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
	import { liveIdentity } from '$stores/identity';
	import UnlockActiveKeyModal from '$components/UnlockActiveKeyModal.svelte';
	import sodium from 'libsodium-wrappers-sumo';
	import {
		validateBlurtAmount,
		hasBlurtPrecision,
		MIN_BLURT
	} from '$lib/blurt/sendValidation';
	import {
		prepareUnsignedTransfer,
		signTransferWithKey,
		broadcastSignedTransaction
	} from '$blurt/sign';
	import { ChainRejectedError, BroadcastUnavailableError } from '$blurt/broadcastTransport';
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

	type Phase =
		| { kind: 'ready' }
		| { kind: 'paying' }
		| { kind: 'error'; messageKey: string; detail?: string };

	/** Classify a broadcast/prepare failure into a specific, honest message +
	 *  the chain/transport's own words. The generic "check your balance" was
	 *  actively misleading (a transfer can fail with a full balance — e.g. the
	 *  signature doesn't match the account's on-chain active authority, or the
	 *  instance is unreachable). Blurt meters ops with a tiny BLURT fee (not
	 *  RC/mana), so balance is rarely the real cause. */
	function classifyBroadcastError(e: unknown): { messageKey: string; detail?: string } {
		if (e instanceof ChainRejectedError) {
			return { messageKey: 'chat.pay_blurt.error.chain_rejected', detail: e.message };
		}
		if (e instanceof BroadcastUnavailableError) {
			return { messageKey: 'chat.pay_blurt.error.instance_unreachable', detail: e.message };
		}
		return {
			messageKey: 'chat.pay_blurt.error.broadcast_failed',
			detail: e instanceof Error ? e.message : undefined
		};
	}

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

	/** #25 (Ken) — a BLURT transfer is signed with the ACTIVE key. An account
	 *  imported posting-only has no active key on this device, so the transfer
	 *  can never be signed. We used to let the user pick an amount, type their
	 *  password, and only then fail with "Could not send the transfer." The
	 *  wallet's Send button has always been gated on exactly this
	 *  (`MyBalanceCard`); the chat's Pay now was not. Same guard, same rule.
	 *
	 *  Deliberately NOT hiding the Pay-now button: a user whose account can't
	 *  pay deserves to learn WHY and what to do about it, not to watch a control
	 *  quietly vanish. */
	/** CAPABILITY, not provenance (tt.txt #11). A 'posting-active' session — a
	 *  posting-only import that chose to keep its verified Active key on this
	 *  device — CAN sign a transfer. Asking `origin === 'morphit-seed'` would
	 *  wrongly deny it. Ask whether the key is actually there. */
	const hasActiveKey = $derived(($liveIdentity?.activePublicKey ?? null) !== null);

	/** #24 — the password is REQUIRED. It was absent from `canPay`, so the Pay
	 *  button sat enabled over an empty field. Non-empty is the gate; the real
	 *  check is the Argon2id unlock at submit (too slow to run per keystroke). */
	const passwordFilled = $derived(passwordInput.length > 0);

	/** #24 — real amount validation. `formatBlurtAmount` serialises with
	 *  `toFixed(3)`, which ROUNDS: an entered `1.0006` would broadcast `1.001`
	 *  (more BLURT than the user chose) and `0.0004` would build `0.000 BLURT`.
	 *  No balance is available in this modal, so the ceiling is left to the
	 *  chain — but precision and the floor are enforced here.
	 *
	 *  A pill-provided amount is a number, not typed text; it gets the same
	 *  grid check, because rounding an amount the user didn't type is the same
	 *  bug with no field to complain in. */
	const amountCheck = $derived(validateBlurtAmount(enteredAmount, Number.POSITIVE_INFINITY));
	const amountPrecisionOk = $derived(amountEditable ? amountCheck.precisionOk : true);
	const amountValid = $derived(
		amountEditable
			? amountCheck.valid
			: Number.isFinite(amount) && amount >= MIN_BLURT && hasBlurtPrecision(amount)
	);

	/** Sanity guards.  These should never trip via real UI — the
	 *  pay-now button is disabled when the conditions aren't met
	 *  — but defense in depth. */
	const canPay = $derived(
		myAccount !== null &&
			myAccount !== recipient &&
			hasActiveKey &&
			amountValid &&
			passwordFilled
	);

	/** tt.txt #11 — a posting-only session unlocked its Active key just for this
	 *  payment. The scalar exists in memory for the ~10ms signing window and is
	 *  then wiped with `sodium.memzero`; it is NEVER written to the keystore.
	 *
	 *  Ken: "let the user SEAMLESSLY continue doing what they were doing without
	 *  losing their place" — so this resumes the payment with the amount already
	 *  typed, rather than closing the modal and making them start over. */
	async function payWithEphemeralActiveKey(activeScalar: Uint8Array): Promise<void> {
		if (!amountValid || myAccount === null || myAccount === recipient) return;
		phase = { kind: 'paying' };
		try {
			const unsignedTx = await prepareUnsignedTransfer(
				myAccount,
				recipient,
				formattedAmount,
				memo
			);
			// Sign, then wipe. The key must not outlive the signature.
			let signed;
			try {
				signed = signTransferWithKey(unsignedTx, activeScalar);
			} finally {
				sodium.memzero(activeScalar);
			}
			const result = await broadcastSignedTransaction(signed);
			onPaid({ trxId: result.trx_id, blockNum: result.block_num, amount: effectiveAmount });
		} catch (e) {
			// Wipe on every path out, including a failed prepare.
			try {
				sodium.memzero(activeScalar);
			} catch {
				/* already zeroed */
			}
			phase = { kind: 'error', ...classifyBroadcastError(e) };
		}
	}

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
		} catch (e) {
			// Hygiene: clear password if we're bailing before the
			// active-key path even runs.
			passwordInput = '';
			phase = { kind: 'error', ...classifyBroadcastError(e) };
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
			} catch (e) {
				// Surface the CHAIN's real reason (e.g. "missing required active
				// authority") or "instance unreachable" — not a misleading
				// balance hint.
				phase = { kind: 'error', ...classifyBroadcastError(e) };
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
			// Sign-time failure — the signing callback threw (malformed key or
			// crypto error). Surface it distinctly from a chain rejection, with
			// the underlying reason when the keystore exposed one.
			phase = {
				kind: 'error',
				messageKey: 'chat.pay_blurt.error.sign_failed',
				detail: r.cause instanceof Error ? r.cause.message : undefined
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
				<!-- The amount error must key off the AMOUNT, not `canPay`. `canPay` now
				     also requires the password and an active key, so keying off it
				     would shout "invalid amount" at someone whose amount is fine and
				     whose password is merely still empty. -->
				{#if enteredAmount.trim().length > 0 && !amountPrecisionOk}
					<p class="mt-1 text-xs text-red-600 dark:text-red-400">
						{$_('chat.pay_blurt.error_amount_precision')}
					</p>
				{:else if enteredAmount.trim().length > 0 && !amountValid && myAccount !== null && myAccount !== recipient}
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
				<div class="mt-5 flex justify-center">
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
				<div class="mt-5 flex justify-center">
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
					<p>{$_(phase.messageKey)}</p>
					{#if phase.detail}
						<p class="mt-1 break-words font-mono text-xs opacity-80">{phase.detail}</p>
					{/if}
				</div>
				<div class="mt-5 flex justify-center gap-2">
					<button
						type="button"
						class="rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold hover:border-ink-400 dark:border-ink-700"
						onclick={onCancel}
					>
						{$_('common.close')}
					</button>
				</div>
			{:else if !hasActiveKey}
				<!-- #25 / tt.txt #11 — this account was imported posting-only, so there
				     is no active key on this device and a transfer can never be signed
				     with what we hold. Rather than a dead end (or, worse, collecting a
				     password that cannot work), unlock IN PLACE and resume: the amount
				     above stays exactly where the user typed it.
				     The CTA stays disabled while the amount is invalid — we never
				     enable a button first and explain afterwards. -->
				<UnlockActiveKeyModal
					account={myAccount ?? ''}
					canProceed={amountValid}
					onUnlocked={payWithEphemeralActiveKey}
					onCancel={onCancel}
				/>
			{:else}
				<!-- Password input -->
				<label class="mt-5 block">
					<span class="text-sm font-semibold">
						<!-- #24 (Ken) — "Active key password" / "Your password" told the user
						     nothing. Morphit stores the ACTIVE KEY encrypted; this field is
						     the password that unlocks it. One field, not two. -->
						{$_('chat.pay_blurt.password_label', { values: { account: myAccount ?? '' } })}
					</span>
					<input
						type="password"
						maxlength="64"
						bind:value={passwordInput}
						autocomplete="current-password"
						disabled={phase.kind === 'paying'}
						class="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm dark:border-ink-700 dark:bg-ink-900"
					/>
					<p class="mt-1 text-xs text-ink-500 dark:text-ink-400">
						{$_('chat.pay_blurt.password_hint')}
					</p>
					{#if passwordError}
						<p class="mt-1 text-xs text-red-600 dark:text-red-400">
							{passwordError}
						</p>
					{/if}
				</label>



				<div class="mt-5 flex justify-center gap-2">
					<button
						type="button"
						class="rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold hover:border-ink-400 dark:border-ink-700"
						onclick={onCancel}
						disabled={phase.kind === 'paying'}
					>
						{$_('common.cancel')}
					</button>
					<!-- #24 — the Pay button was gated ONLY on "not currently paying": it
					     sat enabled over an empty password and an unvalidated amount. -->
					<button
						type="button"
						class="rounded-lg bg-morphit-btn px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50"
						onclick={confirm}
						disabled={!canPay || phase.kind === 'paying'}
					>
						{phase.kind === 'paying' ? $_('chat.pay_blurt.paying') : $_('chat.pay_blurt.confirm')}
					</button>
				</div>
			{/if}
		{/if}
	</div>
</div>
