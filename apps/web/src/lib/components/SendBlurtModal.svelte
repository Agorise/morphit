<script lang="ts">
	/**
	 * SendBlurtModal — confirm + broadcast a BLURT transfer to any Blurt
	 * account from the user's own Morphit-bound wallet.
	 *
	 * cp424 wallet security pass. Unlike the chat Pay-now flow
	 * (PayBlurtModal), the recipient here is USER-ENTERED, so it is
	 * validated in two stages before a signature is ever produced:
	 *
	 *   1. FORMAT — instant, offline: the name must match Blurt's account
	 *      grammar (isValidBlurtAccount) and must not be the sender.
	 *   2. EXISTENCE — debounced, on-chain: the indexer's balance endpoint
	 *      returns 404 for an account that doesn't exist ON CHAIN (it
	 *      checks the canonical RPC pool, not just Morphit users), so a
	 *      typo can't silently send BLURT into a void. Send stays disabled
	 *      until the recipient resolves to a real account.
	 *
	 * Signing reuses the exact hardened path (F-18): prepare unsigned →
	 * runWithActiveKey(signTransferWithKey) → broadcast, with the active
	 * key alive only for the synchronous sign and the password wiped after.
	 *
	 * Memo policy: the memo is OPTIONAL, plaintext, and PUBLIC — it lands
	 * on the public chain verbatim (this is NOT the encrypted chat). A
	 * standing warning says so; the user must not put anything private in
	 * it. Empty memo → the chain memo field is left empty.
	 */

	import { onDestroy } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { runWithActiveKey } from '$crypto/runWithActiveKey';
	import {
		prepareUnsignedTransfer,
		signTransferWithKey,
		broadcastSignedTransaction
	} from '$blurt/sign';
	import { formatBlurtAmount } from '$blurt/balanceMath';
	import { fetchAccountBalance } from '$blurt/accountBalance';
	import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';
	import { isValidBlurtAccount } from '$lib/chat/payload';
	import LazyLoadError from '$components/LazyLoadError.svelte';

	interface Props {
		/** The sending account (the wallet owner — always self). */
		account: string;
		/** Available liquid BLURT (the amount ceiling + clickable). */
		blurtBalance: number;
		/** Broadcast succeeded → parent refreshes the balance + closes. */
		onDone: () => void;
		/** Cancel / dismiss. */
		onCancel: () => void;
	}

	let { account, blurtBalance, onDone, onCancel }: Props = $props();

	type Phase = { kind: 'ready' } | { kind: 'sending' } | { kind: 'error'; messageKey: string };
	/** Recipient validation state. 'invalid' = bad name grammar; 'self' =
	 *  the sender; 'checking' = on-chain lookup in flight; 'not_found' =
	 *  no such account on chain; 'error' = the lookup itself failed. */
	type RecipientState =
		| 'idle'
		| 'invalid'
		| 'self'
		| 'checking'
		| 'valid'
		| 'not_found'
		| 'error';

	let phase = $state<Phase>({ kind: 'ready' });
	let recipient = $state('');
	let recipientState = $state<RecipientState>('idle');
	let amountInput = $state('');
	let memo = $state('');
	let passwordInput = $state('');
	let passwordError = $state('');

	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	/** cp424 — the recipient QR scanner is lazy-loaded (camera + qr-scanner)
	 *  and shown only when the user taps the scan icon. */
	const loadScanner = () =>
		import('$components/RecipientQrScanner.svelte').then((m) => m.default);
	let scanning = $state(false);

	function openScanner(): void {
		scanning = true;
	}
	function closeScanner(): void {
		scanning = false;
	}
	function onScannedRecipient(candidate: string): void {
		// The scanned value is UNTRUSTED — treat it exactly like a typed
		// name: drop it into the field and run the same two-stage validation.
		scanning = false;
		recipient = candidate;
		onRecipientInput();
	}

	/** Strip a leading @, lowercase, trim — Blurt account names are
	 *  lowercase, and users habitually type the @ handle form. */
	function normalizeAccount(s: string): string {
		return s.trim().replace(/^@+/, '').toLowerCase();
	}

	const normalizedRecipient = $derived(normalizeAccount(recipient));
	const amountNum = $derived(Number(amountInput.trim()));
	const amountValid = $derived(
		Number.isFinite(amountNum) && amountNum > 0 && amountNum <= blurtBalance + 1e-6
	);
	const canSend = $derived(
		account.length > 0 &&
			recipientState === 'valid' &&
			amountValid &&
			phase.kind !== 'sending'
	);

	function onRecipientInput(): void {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		const norm = normalizeAccount(recipient);
		if (norm.length === 0) {
			recipientState = 'idle';
			return;
		}
		if (!isValidBlurtAccount(norm)) {
			recipientState = 'invalid';
			return;
		}
		if (norm === account) {
			recipientState = 'self';
			return;
		}
		// Looks well-formed + isn't us — confirm it exists on chain, but
		// debounce so we don't fire a lookup on every keystroke.
		recipientState = 'checking';
		debounceTimer = setTimeout(() => {
			void validateRecipient(norm);
		}, 450);
	}

	async function validateRecipient(norm: string): Promise<void> {
		// The field may have changed since the timer was queued.
		if (normalizeAccount(recipient) !== norm) return;
		let result;
		try {
			result = await fetchAccountBalance(resolveOrigin(MORPHIT_INDEXER_ORIGIN), norm);
		} catch {
			if (normalizeAccount(recipient) === norm) recipientState = 'error';
			return;
		}
		// And may have changed during the round-trip.
		if (normalizeAccount(recipient) !== norm) return;
		if (result.kind === 'ok') recipientState = 'valid';
		else if (result.kind === 'not_found') recipientState = 'not_found';
		else recipientState = 'error';
	}

	function useFullBalance(): void {
		if (!Number.isFinite(blurtBalance) || blurtBalance <= 0) return;
		amountInput = blurtBalance.toFixed(3);
	}

	async function confirm(): Promise<void> {
		if (!canSend) return;
		if (passwordInput.length === 0) {
			passwordError = $_('profile.wallet.error_password_required') as string;
			return;
		}
		passwordError = '';
		phase = { kind: 'sending' };

		const to = normalizeAccount(recipient);
		let unsignedTx;
		try {
			unsignedTx = await prepareUnsignedTransfer(
				account,
				to,
				formatBlurtAmount(amountNum),
				memo.trim()
			);
		} catch {
			passwordInput = '';
			phase = { kind: 'error', messageKey: 'profile.wallet.error_broadcast' };
			return;
		}

		const r = await runWithActiveKey(passwordInput, async (activePriv) => {
			return signTransferWithKey(unsignedTx, activePriv);
		});
		passwordInput = '';

		if (r.ok) {
			try {
				await broadcastSignedTransaction(r.value);
				onDone();
				return;
			} catch {
				phase = { kind: 'error', messageKey: 'profile.wallet.error_broadcast' };
				return;
			}
		}
		if (r.kind === 'bad_password') {
			phase = { kind: 'ready' };
			passwordError = $_('profile.wallet.error_bad_password') as string;
		} else if (r.kind === 'identity_mismatch') {
			phase = { kind: 'error', messageKey: 'crypto.error.identity_mismatch' };
		} else if (r.kind === 'locked') {
			phase = { kind: 'error', messageKey: 'profile.send.error_no_active_key' };
		} else if (r.kind === 'password_empty') {
			phase = { kind: 'ready' };
		} else {
			phase = { kind: 'error', messageKey: 'profile.wallet.error_broadcast' };
		}
	}

	function onBackdropClick(e: MouseEvent): void {
		if (phase.kind === 'sending') return;
		if (e.target === e.currentTarget) onCancel();
	}

	onDestroy(() => {
		if (debounceTimer) clearTimeout(debounceTimer);
	});
</script>

<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 p-4 backdrop-blur-sm"
	role="dialog"
	aria-modal="true"
	aria-labelledby="send-blurt-heading"
	onclick={onBackdropClick}
	onkeydown={(e) => {
		if (e.key === 'Escape' && phase.kind !== 'sending') onCancel();
	}}
	tabindex="-1"
>
	<div class="card w-full max-w-md">
		<h2 id="send-blurt-heading" class="font-display text-xl font-bold">
			{$_('profile.send.title')}
		</h2>
		<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
			{$_('profile.send.subtitle')}
		</p>

		{#if phase.kind === 'error'}
			<div
				class="mt-5 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
			>
				{$_(phase.messageKey)}
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
			<!-- Recipient (validated on-chain) -->
			<label class="mt-5 block">
				<span class="text-sm font-semibold">{$_('profile.send.recipient_label')}</span>
				<div class="mt-1 flex gap-2">
					<input
						type="text"
						bind:value={recipient}
						oninput={onRecipientInput}
						maxlength="18"
						autocapitalize="none"
						autocomplete="off"
						spellcheck="false"
						disabled={phase.kind === 'sending'}
						placeholder={$_('profile.send.recipient_placeholder') as string}
						class="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 font-mono text-sm dark:border-ink-700 dark:bg-ink-900"
					/>
					<button
						type="button"
						onclick={openScanner}
						disabled={phase.kind === 'sending'}
						aria-label={$_('profile.send.qr_heading')}
						title={$_('profile.send.qr_heading')}
						class="flex-none rounded-lg border border-ink-300 px-3 text-ink-600 transition hover:border-morphit-emerald hover:text-morphit-emerald disabled:opacity-50 sm:hidden dark:border-ink-700 dark:text-ink-300"
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="20"
							height="20"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
							class="h-5 w-5"
						>
							<rect width="5" height="5" x="3" y="3" rx="1" />
							<rect width="5" height="5" x="16" y="3" rx="1" />
							<rect width="5" height="5" x="3" y="16" rx="1" />
							<path d="M21 16h-3a2 2 0 0 0-2 2v3" />
							<path d="M21 21v.01" />
							<path d="M12 7v3a2 2 0 0 1-2 2H7" />
							<path d="M3 12h.01" />
							<path d="M12 3h.01" />
							<path d="M12 16v.01" />
							<path d="M16 12h1" />
							<path d="M21 12v.01" />
							<path d="M12 21v-1" />
						</svg>
					</button>
				</div>
			</label>
			<div class="mt-1 min-h-[1.25rem] text-xs">
				{#if recipientState === 'checking'}
					<span class="text-ink-500 dark:text-ink-400">{$_('profile.send.recipient_checking')}</span>
				{:else if recipientState === 'valid'}
					<span class="font-semibold text-morphit-emerald"
						>✓ {$_('profile.send.recipient_valid')}</span
					>
				{:else if recipientState === 'not_found'}
					<span class="text-red-600 dark:text-red-400">{$_('profile.send.recipient_not_found')}</span
					>
				{:else if recipientState === 'invalid'}
					<span class="text-red-600 dark:text-red-400">{$_('profile.send.recipient_invalid')}</span>
				{:else if recipientState === 'self'}
					<span class="text-red-600 dark:text-red-400">{$_('profile.send.recipient_self')}</span>
				{:else if recipientState === 'error'}
					<span class="text-red-600 dark:text-red-400">{$_('profile.send.recipient_error')}</span>
				{/if}
			</div>

			<!-- Amount + clickable available balance -->
			<label class="mt-4 block">
				<span class="text-sm font-semibold">{$_('profile.wallet.amount_label')}</span>
				<input
					type="text"
					bind:value={amountInput}
					maxlength="20"
					inputmode="decimal"
					autocomplete="off"
					disabled={phase.kind === 'sending'}
					placeholder={$_('profile.send.amount_placeholder') as string}
					class="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 font-mono text-sm dark:border-ink-700 dark:bg-ink-900"
				/>
			</label>
			<div class="mt-1.5 flex items-center justify-between gap-2 text-xs">
				<span class="text-ink-500 dark:text-ink-400">
					{$_('profile.wallet.available_blurt', { values: { amount: blurtBalance.toFixed(3) } })}
				</span>
				<button
					type="button"
					onclick={useFullBalance}
					disabled={phase.kind === 'sending' || !(blurtBalance > 0)}
					class="cursor-pointer font-semibold text-morphit-teal underline decoration-dotted underline-offset-2 hover:text-morphit-emerald disabled:cursor-not-allowed disabled:opacity-50 dark:text-morphit-emerald"
				>
					{$_('profile.wallet.use_full')}
				</button>
			</div>
			{#if amountInput.trim().length > 0 && !amountValid}
				<p class="mt-1 text-xs text-red-600 dark:text-red-400">{$_('profile.wallet.error_amount')}</p>
			{/if}

			<!-- Memo (optional, PUBLIC + plaintext) -->
			<label class="mt-4 block">
				<span class="text-sm font-semibold">{$_('profile.send.memo_label')}</span>
				<input
					type="text"
					bind:value={memo}
					maxlength="256"
					autocomplete="off"
					disabled={phase.kind === 'sending'}
					placeholder={$_('profile.send.memo_placeholder') as string}
					class="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm dark:border-ink-700 dark:bg-ink-900"
				/>
			</label>
			<p
				class="mt-1.5 flex items-start gap-1.5 rounded-lg border border-amber-300/60 bg-amber-50 p-2.5 text-xs text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-200"
			>
				<span aria-hidden="true" class="flex-none">⚠</span>
				<span>{$_('profile.send.memo_privacy_warning')}</span>
			</p>

			<!-- Password (active key) -->
			<label class="mt-4 block">
				<span class="text-sm font-semibold">
					{$_('profile.wallet.password_label', { values: { account } })}
				</span>
				<input
					type="password"
					maxlength="64"
					bind:value={passwordInput}
					autocomplete="current-password"
					disabled={phase.kind === 'sending'}
					class="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm dark:border-ink-700 dark:bg-ink-900"
				/>
				{#if passwordError}
					<p class="mt-1 text-xs text-red-600 dark:text-red-400">{passwordError}</p>
				{/if}
			</label>

			<div class="mt-5 flex justify-end gap-2">
				<button
					type="button"
					class="rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold hover:border-ink-400 disabled:opacity-50 dark:border-ink-700"
					onclick={onCancel}
					disabled={phase.kind === 'sending'}
				>
					{$_('common.cancel')}
				</button>
				<button
					type="button"
					class="rounded-lg bg-morphit-btn px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50"
					onclick={confirm}
					disabled={!canSend}
				>
					{phase.kind === 'sending' ? $_('common.broadcasting') : $_('profile.send.confirm')}
				</button>
			</div>
		{/if}
	</div>
</div>

{#if scanning}
	{#await loadScanner() then RecipientQrScanner}
		<RecipientQrScanner onScanned={onScannedRecipient} onClose={closeScanner} />
	{:catch}
		<LazyLoadError />
	{/await}
{/if}
