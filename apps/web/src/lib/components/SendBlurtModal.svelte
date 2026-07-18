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
	import { liveIdentity } from '$stores/identity';
	import UnlockActiveKeyModal from '$components/UnlockActiveKeyModal.svelte';
	import sodium from 'libsodium-wrappers-sumo';
	import {
		prepareUnsignedTransfer,
		signTransferWithKey,
		broadcastSignedTransaction
	} from '$blurt/sign';
	import { ChainRejectedError, BroadcastUnavailableError } from '$blurt/broadcastTransport';
	import { formatBlurtAmount } from '$blurt/balanceMath';
	import { fetchAccountBalance } from '$blurt/accountBalance';
	import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';
	import { isValidBlurtAccount } from '$lib/chat/payload';
	import LazyLoadError from '$components/LazyLoadError.svelte';
	import { validateBlurtAmount, floorToBlurtPrecision } from '$lib/blurt/sendValidation';

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

	type Phase =
		| { kind: 'ready' }
		| { kind: 'sending' }
		| { kind: 'error'; messageKey: string; reason?: string };
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

	/** Shape + range validation lives in `$lib/blurt/sendValidation` so it can be
	 *  unit-tested: BLURT has 3 decimals and `formatBlurtAmount` ROUNDS, so
	 *  `1.0006` would silently broadcast `1.001` and `0.0004` would build
	 *  `0.000 BLURT`. Money is never rounded up behind the user's back. */
	const amountCheck = $derived(validateBlurtAmount(amountInput, blurtBalance));
	const amountPrecisionOk = $derived(amountCheck.precisionOk);
	const amountValid = $derived(amountCheck.valid);

	/** The active-key password is REQUIRED — nothing can be signed without it.
	 *  It was missing from `canSend`, so "Send BLURT" sat enabled over an empty
	 *  password field and the user only learned it was needed after clicking.
	 *
	 *  Gating on "non-empty" rather than "this password actually unlocks the
	 *  key" is deliberate: verifying it means running the Argon2id KDF, which is
	 *  intentionally slow, and doing that on every keystroke would burn the
	 *  user's CPU to tell them something the submit path already tells them.
	 *  A wrong password still fails at submit with `error_bad_password`. */
	const passwordFilled = $derived(passwordInput.length > 0);

	/** tt.txt #11 — a posting-only session has no active key on this device, so a
	 *  transfer can never be signed with what we hold. Rather than hiding Send (as
	 *  the wallet card used to) we offer it and unlock in place, resuming the send
	 *  with everything the user already typed. */
	/** CAPABILITY, not provenance (tt.txt #11). A 'posting-active' session — a
	 *  posting-only import that chose to keep its verified Active key on this
	 *  device — CAN sign a transfer. Asking `origin === 'morphit-seed'` would
	 *  wrongly deny it. Ask whether the key is actually there. */
	const hasActiveKey = $derived(($liveIdentity?.activePublicKey ?? null) !== null);

	/** Everything except the password: what must be true before we let a
	 *  posting-only user even reach for their Active key. */
	const formReady = $derived(
		account.length > 0 && recipientState === 'valid' && amountValid && phase.kind !== 'sending'
	);

	const canSend = $derived(
		account.length > 0 &&
			recipientState === 'valid' &&
			amountValid &&
			passwordFilled &&
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
		// FLOOR, never round: `toFixed(3)` on a balance with more precision than
		// the asset would fill the field with more than the user actually has,
		// and the form would then refuse to send it.
		amountInput = floorToBlurtPrecision(blurtBalance);
	}

	/** Sign with a just-unlocked Active key, then wipe it. The key exists for the
	 *  signing window only and is NEVER written to the keystore. */
	async function sendWithEphemeralActiveKey(activeScalar: Uint8Array): Promise<void> {
		if (!formReady) return;
		phase = { kind: 'sending' };
		try {
			const unsignedTx = await prepareUnsignedTransfer(
				account,
				recipient.trim(),
				formatBlurtAmount(amountNum),
				memo.trim()
			);
			let signed;
			try {
				signed = signTransferWithKey(unsignedTx, activeScalar);
			} finally {
				sodium.memzero(activeScalar);
			}
			await broadcastSignedTransaction(signed);
			onDone();
		} catch {
			try {
				sodium.memzero(activeScalar);
			} catch {
				/* already zeroed */
			}
			phase = { kind: 'error', messageKey: 'profile.wallet.error_broadcast' };
		}
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
		} catch (err) {
			passwordInput = '';
			// Building the tx fetches the chain head; if the instance is
			// unreachable that surfaces as BroadcastUnavailableError. Log the
			// raw error so an unexpected build failure is diagnosable.
			console.warn('[send] prepare failed:', err);
			phase =
				err instanceof BroadcastUnavailableError
					? { kind: 'error', messageKey: 'profile.wallet.error_unreachable' }
					: { kind: 'error', messageKey: 'profile.wallet.error_broadcast' };
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
			} catch (err) {
				// Surface the chain's actual reason rather than a blank "try
				// again" that just loops. NOTE: on Blurt an op costs a small
				// fee paid from LIQUID BLURT (an operation flat fee + a
				// bandwidth fee, set by witnesses) — it is NOT gated by
				// mana/RC (that's the Hive/Steem model; Blurt's mana is only
				// voting power). So the reason here is whatever the chain
				// reports (e.g. balance/fee, authority) — we show it verbatim.
				console.warn('[send] broadcast rejected:', err);
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

<!-- v1.7.7 (t.txt #5) — the modal must FIT, and when it can't, it must SCROLL.
     [KEN]: "the send modal is too big for my mobile screen and will not let me
     scroll my screen up or down so that i can see its full height or the submit
     button at the bottom. please size it correctly on load and let me scroll to
     see the whole thing."

     What was wrong: `fixed inset-0` + `items-center` with no height cap and no
     scroller. `fixed` pins the backdrop to exactly one viewport, so there is
     nothing to scroll, and centring an over-tall flex child overflows BOTH ends
     at once — and overflow past the START edge is unreachable, no scrollbar will
     ever take you up to it. That is why Ken's screenshot loses the subtitle at
     the top AND the submit button at the bottom. Nothing errors. The button just
     cannot be reached, on the screen that moves money.

     Reproduced in Chromium at Ken's exact size (1080px @ DPR 3 = 360x800 CSS):
     card top at -22px, submit unreachable even after scrolling to the end.
     With the fix: top +20px, submit reachable.

     Not a rare case either — this modal grows. The memo warning, the "needs your
     Active key" panel, the key field and its explainer, and the "After this
     payment" summary are all conditional; the long form overflows any phone.

     WHY THIS SHAPE: it is the pattern FundsSentModal and MarkdownGuideModal
     already use — cap the card's height and let the CARD scroll. Two other
     shapes work equally well in a browser test, but a third pattern for the same
     problem is worse than a simpler one, and this needs no extra wrapper element.

     WHY dvh AND NOT vh: on a phone `vh` is the LARGE viewport — it counts the
     space behind the URL bar, so `95vh` can be taller than what is actually on
     screen, which re-creates this very bug in miniature. `dvh` tracks the
     viewport as the bar shows and hides. ConversationView reaches for `svh` for
     the same reason.

     And NO vh fallback pair here, deliberately. Tailwind emits utilities in its
     own order, not the order they appear in the class attribute, so
     `max-h-[95vh] max-h-[95dvh]` gives no control over which declaration lands
     last — and in CSS, last wins. A fallback you cannot order is not a fallback;
     it is a coin flip. `dvh` has been in every major engine since 2022, so the
     pair buys nothing and risks silently pinning the wrong one.
     (See REVISIT-LIST: `app.css` body has exactly that pair, in the losing
     order — `100dvh` then `100vh` — so its dvh line has never once applied.) -->
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
	<div class="card max-h-[95dvh] w-full min-w-0 max-w-md overflow-y-auto overscroll-contain">

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
					aria-invalid={amountInput.trim().length > 0 && !amountValid}
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
			{#if amountInput.trim().length > 0 && !amountPrecisionOk}
				<!-- Precision gets its OWN message: "up to your available balance" would
				     be baffling advice for someone who typed 0.0004. -->
				<p class="mt-1 text-xs text-red-600 dark:text-red-400">
					{$_('profile.wallet.error_amount_precision')}
				</p>
			{:else if amountInput.trim().length > 0 && !amountValid}
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

			<!-- tt.txt #11 — a posting-only session cannot sign a transfer with what we
			     hold. Offer the Active-key unlock IN PLACE rather than a password field
			     that cannot work; recipient / amount / memo above stay exactly as typed
			     and the send resumes on success. The unlock CTA stays disabled until the
			     rest of the form is valid — never enable a button first and explain after. -->
			{#if !hasActiveKey}
				<UnlockActiveKeyModal
					{account}
					canProceed={formReady}
					onUnlocked={sendWithEphemeralActiveKey}
					onCancel={onCancel}
				/>
			{:else}
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
						aria-invalid={passwordError.length > 0}
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
