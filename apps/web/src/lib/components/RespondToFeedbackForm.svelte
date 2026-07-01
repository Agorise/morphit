<script lang="ts">
	/**
	 * RespondToFeedbackForm — inline UI for a subject's reply to a
	 * review they received.
	 *
	 * Rendered on the profile page under each FeedbackRecord where:
	 *   (a) the viewer is the signed-in subject of the feedback, AND
	 *   (b) the feedback has no existing response yet
	 *
	 * The indexer does the authoritative authorization check (only
	 * the subject can respond). This component is just the UI surface
	 * — it never tries to gate on authorization itself because the
	 * UI state may be stale (e.g. someone opened the form, then their
	 * session state changed).
	 *
	 * Design: textarea + submit, no rating. A response is a pure
	 * statement — the reputation system distinguishes "review" from
	 * "reply." The indexer rejects empty responses, so the UI mirrors
	 * that check client-side.
	 *
	 * No password prompt: response is a posting-key op, same as the
	 * underlying feedback it replies to.
	 */

	import { _ } from 'svelte-i18n';
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import BusyButton from '$components/BusyButton.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import ProtectedTextarea from '$components/ProtectedTextarea.svelte';
	import PrivateKeyWarningModal from '$components/PrivateKeyWarningModal.svelte';
	import { identity } from '$stores/identity';
	import {
		broadcastFeedbackResponse,
		validateFeedbackResponse,
		FeedbackResponseValidationError
	} from '$blurt/ops/feedbackResponse';
	import { BroadcastError } from '$blurt/ops/profile';
	import { redactPrivateKeys, type PrivateKeyMatch } from '$lib/security/privateKeyDetector';
	import { saveDraft, loadDraftWithMeta, clearDraft } from '$lib/drafts';

	interface Props {
		/** The trx_id of the feedback being responded to. Comes
		 *  from FeedbackRecord.source_trx_id. */
		feedbackTrxId: string;
		/** Called on successful broadcast. Parent typically
		 *  refetches the feedback list and closes the disclosure. */
		onSuccess?: (result: { trx_id: string }) => void;
		/** Called when the user dismisses the form. */
		onCancel?: () => void;
	}

	let { feedbackTrxId, onSuccess, onCancel }: Props = $props();

	let comment = $state('');
	let submitting = $state(false);
	let errorMessage = $state('');

	// ─── Private-key protection ────────────────────────────────────
	let keyMatches: readonly PrivateKeyMatch[] = $state([]);
	let showKeyWarning = $state(false);
	let userAckedKeyWarning = $state(false);

	function handleKeyDetect(matches: readonly PrivateKeyMatch[]): void {
		keyMatches = matches;
		if (matches.length === 0) userAckedKeyWarning = false;
	}

	// ─── Draft persistence ─────────────────────────────────────────
	// Keyed by feedbackTrxId so replies to different feedbacks are
	// stored independently. A user reading their profile might
	// start a reply on one review, scroll to another, and start
	// a second — both preserved.
	const DRAFT_KEY = $derived(`feedback_response.${feedbackTrxId}`);
	let draftSavedAt = $state<Date | null>(null);
	let draftSaveTimeout: ReturnType<typeof setTimeout> | null = null;

	function formatDraftAge(since: Date): string {
		const diff = Date.now() - since.getTime();
		const minutes = Math.floor(diff / 60_000);
		if (minutes < 1) return '<1m';
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h`;
		const days = Math.floor(hours / 24);
		return `${days}d`;
	}

	function discardDraft(): void {
		clearDraft(DRAFT_KEY);
		draftSavedAt = null;
		comment = '';
	}

	onMount(() => {
		const saved = loadDraftWithMeta<{ comment: string }>(DRAFT_KEY);
		if (saved && saved.value.comment.length > 0) {
			comment = saved.value.comment;
			draftSavedAt = new Date(saved.meta.savedAt);
		}

		return () => {
			if (draftSaveTimeout) clearTimeout(draftSaveTimeout);
		};
	});

	$effect(() => {
		void comment;
		if (submitting) return;

		if (draftSaveTimeout) clearTimeout(draftSaveTimeout);
		draftSaveTimeout = setTimeout(() => {
			if (comment.length > 0) {
				// Per Finding R7: redact private keys before
				// persisting.  Same defense-in-depth as the
				// broadcast path — a user who types a key then
				// closes the browser without submitting won't
				// leave the key in localStorage.
				saveDraft(DRAFT_KEY, { comment: redactPrivateKeys(comment) });
			}
		}, 500);
	});

	/** Live validation for in-form error display. ProtectedTextarea
	 *  has no onblur hook, so we fall back to "show errors once
	 *  there's content to validate" — empty comments are always
	 *  valid anyway (canSubmit gates on length > 0). */
	const commentError = $derived.by(() => {
		if (comment.length === 0) return '';
		try {
			validateFeedbackResponse({ feedback_trx_id: feedbackTrxId, comment });
			return '';
		} catch (err) {
			if (err instanceof FeedbackResponseValidationError) {
				if (err.code === 'comment_too_long' || err.code === 'comment_forbidden_char') {
					return $_(`feedback_response.error.${err.code}`) as string;
				}
			}
			return '';
		}
	});

	const canSubmit = $derived(comment.length > 0 && commentError === '' && !submitting);

	async function submit(): Promise<void> {
		if (!canSubmit) return;

		// Private-key gate: if the comment contains a detected key
		// AND the user hasn't acked the warning, show the modal
		// instead of broadcasting.
		if (keyMatches.length > 0 && !userAckedKeyWarning) {
			showKeyWarning = true;
			return;
		}

		submitting = true;
		errorMessage = '';
		const state = get(identity);
		if (state.state !== 'unlocked') {
			errorMessage = $_('feedback_response.error.locked') as string;
			submitting = false;
			return;
		}

		// Final redaction pass — even if the modal was dismissed,
		// nothing sensitive leaves the client.
		const outgoing = redactPrivateKeys(comment);

		try {
			const result = await broadcastFeedbackResponse(state.live, {
				feedback_trx_id: feedbackTrxId,
				comment: outgoing
			});
			// Broadcast succeeded — drop the draft.
			clearDraft(DRAFT_KEY);
			draftSavedAt = null;
			onSuccess?.({ trx_id: result.trx_id });
		} catch (err) {
			console.warn('[RespondToFeedbackForm] broadcast failed:', err);
			if (err instanceof BroadcastError) {
				// Defensive guard: only the broadcast codes that have
				// corresponding feedback_response keys map directly;
				// others fall to broadcast_failed.
				const FR_CODES = new Set(['no_account', 'locked']);
				if (FR_CODES.has(err.code)) {
					errorMessage = $_(`feedback_response.error.${err.code}`) as string;
				} else {
					errorMessage = $_('feedback_response.error.broadcast_failed') as string;
				}
			} else if (err instanceof FeedbackResponseValidationError) {
				// All 4 FeedbackResponseValidationCode values have
				// corresponding i18n keys (feedback_trx_id_invalid,
				// comment_empty, comment_too_long,
				// comment_forbidden_char) — no fallback needed.
				errorMessage = $_(`feedback_response.error.${err.code}`) as string;
			} else {
				errorMessage = $_('feedback_response.error.broadcast_failed') as string;
			}
		} finally {
			submitting = false;
		}
	}
</script>

<div
	class="mt-3 rounded-xl border-2 border-morphit-teal/40 bg-morphit-teal/5 p-3"
	role="group"
	aria-label={$_('feedback_response.form.aria_label')}
>
	{#if draftSavedAt}
		<p
			class="mb-2 flex items-center justify-between gap-2 text-xs text-ink-600 dark:text-ink-300"
			role="status"
			aria-live="polite"
		>
			<span>
				{$_('post_order.draft.restored_banner', {
					values: { age: formatDraftAge(draftSavedAt) }
				})}
			</span>
			<button
				type="button"
				class="flex-none text-xs font-semibold text-ink-700 underline decoration-dotted underline-offset-2 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:text-ink-200"
				onclick={discardDraft}
			>
				{$_('post_order.draft.discard')}
			</button>
		</p>
	{/if}
	<p class="mb-2 font-semibold">{$_('feedback_response.form.heading')}</p>
	<p class="mb-3 text-xs text-ink-600 dark:text-ink-300">
		{$_('feedback_response.form.subheading')}
	</p>

	<label class="mb-2 block">
		<span class="mb-1 block text-sm font-semibold">
			{$_('feedback_response.form.comment_label')}
		</span>
		<ProtectedTextarea
			bind:value={comment}
			name="feedback-response"
			onDetect={handleKeyDetect}
			rows={3}
			maxlength={1024}
			showCounter
			counterMode="codepoint"
			counterLimit={256}
			placeholder={$_('feedback_response.form.comment_placeholder') as string}
			disabled={submitting}
		/>
	</label>
	{#if commentError}
		<StatusLine kind="warn">{commentError}</StatusLine>
	{/if}
	{#if errorMessage}
		<StatusLine kind="warn">{errorMessage}</StatusLine>
	{/if}

	<div class="mt-2 flex flex-col gap-2 sm:flex-row sm:justify-end">
		<BusyButton variant="ghost" disabled={submitting} onclick={onCancel}>
			{$_('common.cancel')}
		</BusyButton>
		<BusyButton
			variant="primary"
			busy={submitting}
			busyLabel={$_('feedback_response.form.submitting') as string}
			disabled={!canSubmit}
			onclick={submit}
		>
			{$_('feedback_response.form.submit')}
		</BusyButton>
	</div>
</div>

{#if showKeyWarning}
	<PrivateKeyWarningModal
		matches={keyMatches}
		onEdit={() => {
			showKeyWarning = false;
		}}
		onSendAnyway={() => {
			showKeyWarning = false;
			userAckedKeyWarning = true;
			void submit();
		}}
	/>
{/if}
