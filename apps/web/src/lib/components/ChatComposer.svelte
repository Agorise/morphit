<script lang="ts">
	/**
	 * ChatComposer — compose + send a single chat message.
	 *
	 * Keyboard contract:
	 *   - Enter → send
	 *   - Shift+Enter → newline (default textarea behavior)
	 *   - Tab → default focus-out
	 *
	 * Private-key defense: uses ProtectedTextarea + PrivateKeyWarningModal
	 * exactly like the feedback-response form. redactPrivateKeys() runs
	 * on the outgoing text regardless of whether the warning was
	 * acknowledged — defense in depth.
	 *
	 * Draft persistence: keyed by peer account so parallel conversations
	 * don't collide. Saved with 500ms debounce; wiped on successful send.
	 * Per docs/CHAT-UI-DESIGN.md, draft persistence survives auto-lock
	 * (idle timeout) because the user's intent to send is still there;
	 * it's only wiped on explicit Lock-now. That wiping is handled by
	 * the Lock-now flow elsewhere, not here.
	 *
	 * State ownership: the composer holds ONLY its own input text +
	 * key-detection state. Everything else (broadcast, message list,
	 * identity check) lives in the parent ConversationView.
	 */

	import { onMount, tick } from 'svelte';
	import { _ } from 'svelte-i18n';

	import ProtectedTextarea from '$components/ProtectedTextarea.svelte';
	import PrivateKeyWarningModal from '$components/PrivateKeyWarningModal.svelte';
	import BusyButton from '$components/BusyButton.svelte';
	import { redactPrivateKeys, type PrivateKeyMatch } from '$lib/security/privateKeyDetector';
	import { hasAccountNumberShape } from '$lib/security/accountNumberDetector';
	import { saveDraft, loadDraft, clearDraft } from '$lib/drafts';
	import { browser } from '$app/environment';

	interface Props {
		/** Peer account name — used for the draft key and the
		 *  placeholder text. */
		peer: string;
		/** Called when the user confirms a send. The composer has
		 *  already redacted private-key material from the argument
		 *  string. Parent handles the actual broadcast + state
		 *  update. */
		onSend: (text: string) => Promise<void> | void;
		/** True when the signed-in user's session is locked. The
		 *  composer disables input and surfaces a hint directing
		 *  the user to unlock. */
		isLocked?: boolean;
		/** Optional keydown handler.  Forwarded straight through to
		 *  the underlying ProtectedTextarea so the parent can
		 *  intercept keys (Ctrl+Enter to send is the primary
		 *  use case).  Without an explicit prop the bare
		 *  `{onkeydown}` shorthand below would shadow with the
		 *  window's built-in onkeydown handler. */
		onkeydown?: (event: KeyboardEvent) => void;
	}

	let { peer, onSend, isLocked = false, onkeydown }: Props = $props();

	/** Maximum plaintext codepoints per message. Matches the
	 *  design-doc budget; the indexer enforces a ciphertext-level
	 *  cap of 1536 chars PER ciphertext — applied to both the
	 *  recipient copy and the self-copy — which comfortably absorbs
	 *  this 256-codepoint plaintext + DR overhead + base64. (An
	 *  earlier comment here said 1024; that was the indexer's old,
	 *  bad-math cap, since corrected to 1536.) The precise per-
	 *  message limit is the codepoint counter (`overCap`) below;
	 *  the textarea's `maxlength` is only a hard paste backstop and
	 *  is sized to 2× MAX_CODEPOINTS UTF-16 units (the worst case
	 *  for 256 codepoints is 512 units — all surrogate-pair emoji),
	 *  so it never truncates a valid 256-codepoint message. */
	const MAX_CODEPOINTS = 256;

	/** Draft key in the shared drafts module. The full localStorage
	 *  key becomes `morphit.draft.chat.<peer>`. */
	const draftKey = $derived(`chat.${peer}`);

	let text = $state('');
	let sending = $state(false);
	/** v1.5.0 — bound to the composer input so we can re-focus it after a
	 *  send (keeps the cursor in the field unless the user clicks away). */
	let inputRef: { focus: () => void } | undefined = $state();

	// ─── Private-key protection ────────────────────────────────────
	let keyMatches: readonly PrivateKeyMatch[] = $state([]);
	let showKeyWarning = $state(false);
	let userAckedKeyWarning = $state(false);

	function handleKeyDetect(matches: readonly PrivateKeyMatch[]): void {
		keyMatches = matches;
		// If the user edited away all matches, reset the ack so a
		// subsequent re-paste re-triggers the warning.
		if (matches.length === 0) userAckedKeyWarning = false;
	}

	// ─── Account-number proofread reminder (Tier 2.1) ──────────────
	// Soft, one-time-per-session reminder when the user is about
	// to send a message that contains an IBAN, BIC, or 9+-digit
	// run.  Account numbers are LEGITIMATE in chat (it's how
	// trade partners share where to send fiat), so we never
	// block, redact, or confirm-modal — just an inline red
	// banner that says "this is permanent, double-check the
	// number before sending."  Once dismissed for the session,
	// stays dismissed; the next session re-evaluates.
	const ACCT_REMINDER_KEY = 'morphit.chatComposer.acctReminderSeen';

	function readAcctReminderSeen(): boolean {
		if (!browser) return false;
		try {
			return window.sessionStorage.getItem(ACCT_REMINDER_KEY) === '1';
		} catch {
			return false;
		}
	}
	function markAcctReminderSeen(): void {
		if (!browser) return;
		try {
			window.sessionStorage.setItem(ACCT_REMINDER_KEY, '1');
		} catch {
			// ignore storage failures (incognito quota, etc.)
		}
	}

	let acctReminderDismissed = $state(false);
	const showAcctReminder = $derived(
		!acctReminderDismissed && !readAcctReminderSeen() && hasAccountNumberShape(text)
	);

	function dismissAcctReminder(): void {
		markAcctReminderSeen();
		acctReminderDismissed = true;
	}

	// ─── Draft persistence ─────────────────────────────────────────
	let draftSaveTimeout: ReturnType<typeof setTimeout> | null = null;

	onMount(() => {
		const saved = loadDraft<{ text: string }>(draftKey);
		if (saved && typeof saved.text === 'string' && saved.text.length > 0) {
			text = saved.text;
		}
		return () => {
			if (draftSaveTimeout) clearTimeout(draftSaveTimeout);
		};
	});

	// Re-load the draft when the peer changes — e.g. user navigates
	// from /chat/alice to /chat/bob without unmounting the component.
	$effect(() => {
		void peer;
		const saved = loadDraft<{ text: string }>(draftKey);
		text = saved && typeof saved.text === 'string' ? saved.text : '';
	});

	// Debounced save on every change.
	$effect(() => {
		void text;
		if (sending) return;
		if (draftSaveTimeout) clearTimeout(draftSaveTimeout);
		draftSaveTimeout = setTimeout(() => {
			if (text.length > 0) {
				// Per Finding R7 (extended from feedback audit):
				// redact private keys before persisting.  Chat
				// drafts go to localStorage in cleartext (the e2e
				// encryption only applies to the broadcast op),
				// so a key typed and abandoned would otherwise
				// remain on disk indefinitely.
				saveDraft(draftKey, { text: redactPrivateKeys(text) });
			} else {
				// Empty text — clear the draft slot so an old draft
				// doesn't resurrect when the user navigates away.
				clearDraft(draftKey);
			}
		}, 500);
	});

	// ─── Derived UI state ──────────────────────────────────────────
	const trimmed = $derived(text.trim());
	const codepointCount = $derived([...text].length);
	const overCap = $derived(codepointCount > MAX_CODEPOINTS);
	const canSend = $derived(!sending && !isLocked && trimmed.length > 0 && !overCap);

	// ─── Send path ─────────────────────────────────────────────────

	async function send(): Promise<void> {
		if (!canSend) return;
		if (keyMatches.length > 0 && !userAckedKeyWarning) {
			showKeyWarning = true;
			return;
		}
		sending = true;
		try {
			// Final redaction pass — even if the modal was dismissed,
			// nothing sensitive leaves the client.
			const outgoing = redactPrivateKeys(trimmed);
			await onSend(outgoing);
			// Success: clear text + draft. Intentionally blank the
			// text BEFORE yielding — a user hitting Enter twice
			// quickly shouldn't resubmit the same content.
			text = '';
			clearDraft(draftKey);
			userAckedKeyWarning = false;
		} finally {
			sending = false;
			// v1.5.0 — keep the cursor in the composer after a send (success OR
			// failure) unless the user clicks elsewhere. tick() first so the
			// textarea is re-enabled (disabled while `sending`) before focus.
			await tick();
			inputRef?.focus();
		}
	}

	function onKeydown(event: KeyboardEvent): void {
		// Enter (plain) → send. Shift+Enter falls through to default
		// behavior (newline).
		// Part 73 fix: this function existed pre-Part-73 but was
		// never wired into the textarea; the documented "Enter
		// sends" keyboard contract from CHAT-UI-DESIGN.md was not
		// enforced.  The textarea was getting native newline
		// behavior on Enter.  Now wired below in the template.
		if (
			event.key === 'Enter' &&
			!event.shiftKey &&
			!event.ctrlKey &&
			!event.metaKey &&
			!event.altKey
		) {
			event.preventDefault();
			void send();
			return;
		}
		// If parent supplied a keydown handler, forward — Ctrl+Enter
		// (the secondary "send" combo) is handled there.
		onkeydown?.(event);
	}
</script>

<form
	class="chat-composer border-t border-ink-200 bg-white p-3 dark:border-ink-800 dark:bg-ink-950"
	onsubmit={(e) => {
		e.preventDefault();
		void send();
	}}
	aria-label={$_('chat.composer.aria_label') as string}
>
	{#if isLocked}
		<p
			class="mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-200"
			role="status"
		>
			{$_('chat.composer.locked_hint')}
		</p>
	{/if}

	{#if showAcctReminder}
		<div
			class="mb-2 flex items-start justify-between gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
			role="status"
			aria-live="polite"
		>
			<span class="flex-1">
				<strong>{$_('chat.composer.acct_reminder.heading')}</strong>
				{$_('chat.composer.acct_reminder.body')}
			</span>
			<button
				type="button"
				onclick={dismissAcctReminder}
				class="-mr-1 -mt-0.5 rounded-md px-2 py-0.5 text-red-700 hover:bg-red-100 hover:text-red-900 dark:text-red-300 dark:hover:bg-red-900 dark:hover:text-red-100"
				aria-label={$_('chat.composer.acct_reminder.dismiss_aria') as string}
			>
				✕
			</button>
		</div>
	{/if}

	<!-- cp407 — textarea + Send on ONE row, Send vertically CENTRED against the
	     2-row textarea (was items-end, which sank the 1-row button to the bottom
	     and read as misaligned/too low). Still one row, so the compact composer
	     stays visible on mobile without a textarea+button stack pushing it below
	     the fold. The account-number reminder + locked hint stay full-width
	     above this row. -->
	<div class="flex items-center gap-2">
		<ProtectedTextarea
			bind:this={inputRef}
			class="flex-1"
			bind:value={text}
			name="chat-message"
			onDetect={handleKeyDetect}
			onkeydown={onKeydown}
			rows={2}
			maxlength={MAX_CODEPOINTS * 2}
			showCounter
			counterMode="codepoint"
			counterLimit={MAX_CODEPOINTS}
			placeholder={$_('chat.composer.placeholder', { values: { peer } }) as string}
			disabled={sending || isLocked}
			ariaLabel={$_('chat.composer.input_aria') as string}
		/>

		<!-- cp508 (tt.txt #9) — Ken: the chat Send button should look like the
		     "Submit feedback" button, which is variant="secondary". -->
		<BusyButton
			variant="secondary"
			busy={sending}
			busyLabel={$_('common.sending') as string}
			disabled={!canSend}
			onclick={send}
		>
			{$_('chat.composer.send')}
		</BusyButton>
	</div>
</form>

{#if showKeyWarning}
	<PrivateKeyWarningModal
		matches={keyMatches}
		onEdit={() => {
			showKeyWarning = false;
		}}
		onSendAnyway={() => {
			showKeyWarning = false;
			userAckedKeyWarning = true;
			void send();
		}}
	/>
{/if}

<style>
	.chat-composer {
		/* Keep the composer anchored at the bottom of the flex parent
		   (ConversationView). Parent uses height: 100svh and the
		   composer is the non-flex-grow tail. */
		flex: 0 0 auto;
	}
</style>
