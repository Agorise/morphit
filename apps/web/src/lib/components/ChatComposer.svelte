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

	import { onMount } from 'svelte';
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
	 *  cap at 1024 chars which accommodates this plaintext + DR
	 *  overhead + base64. */
	const MAX_CODEPOINTS = 256;

	/** Draft key in the shared drafts module. The full localStorage
	 *  key becomes `morphit.draft.chat.<peer>`. */
	const draftKey = $derived(`chat.${peer}`);

	let text = $state('');
	let sending = $state(false);

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
	// block, redact, or confirm-modal — just an inline amber
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
		!acctReminderDismissed &&
			!readAcctReminderSeen() &&
			hasAccountNumberShape(text)
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
			class="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200"
			role="status"
		>
			{$_('chat.composer.locked_hint')}
		</p>
	{/if}

	{#if showAcctReminder}
		<div
			class="mb-2 flex items-start justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
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
				class="-mr-1 -mt-0.5 rounded-md px-2 py-0.5 text-amber-700 hover:bg-amber-100 hover:text-amber-900 dark:text-amber-300 dark:hover:bg-amber-900 dark:hover:text-amber-100"
				aria-label={$_('chat.composer.acct_reminder.dismiss_aria') as string}
			>
				✕
			</button>
		</div>
	{/if}

	<ProtectedTextarea
		bind:value={text}
		onDetect={handleKeyDetect}
		onkeydown={onKeydown}
		rows={2}
		maxlength={1024}
		showCounter
		counterMode="codepoint"
		counterLimit={MAX_CODEPOINTS}
		placeholder={$_('chat.composer.placeholder', { values: { peer } }) as string}
		disabled={sending || isLocked}
		ariaLabel={$_('chat.composer.input_aria') as string}
	/>

	<div class="mt-2 flex items-center justify-end gap-2">
		<BusyButton
			variant="primary"
			busy={sending}
			busyLabel={$_('chat.composer.sending') as string}
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
