<script lang="ts">
	/**
	 * LeaveFeedbackForm — inline UI for leaving feedback on a trade.
	 *
	 * Used on /my/orders as a disclosure under each live order, so
	 * the user can mark a trade complete and review their counterparty.
	 * Per ADR-0011 §8, feedback submission IS the trade-complete
	 * signal — there's no separate "mark complete" step.
	 *
	 * Signed with the posting key (not active), so no password
	 * prompt. Just the form → broadcast → callback pattern.
	 *
	 * Side effect: after the user's FIRST successful feedback
	 * broadcast ever on this account, we also fire Post A (the
	 * automatic "I joined Morphit" announcement to the community).
	 * A localStorage flag prevents redundant broadcasts on
	 * subsequent feedback; the chain-side permlink is
	 * account-keyed so even without the flag a retry would land
	 * as an edit, not a duplicate post.
	 */

	import { _ } from 'svelte-i18n';
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import BusyButton from '$components/BusyButton.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import ProtectedTextarea from '$components/ProtectedTextarea.svelte';
	import PrivateKeyWarningModal from '$components/PrivateKeyWarningModal.svelte';
	import WriteBlockedReadOnly from '$components/WriteBlockedReadOnly.svelte';
	import { identity, isPairedReadOnly } from '$stores/identity';
	import {
		broadcastFeedback,
		validateFeedback,
		FeedbackValidationError
	} from '$blurt/ops/feedback';
	import { BroadcastError, getUserBlurtAccount } from '$blurt/ops/profile';
	import { publishFirstTradePost } from '$lib/syndication/publish';
	import {
		isFirstTradeAnnounceEnabled,
		firstTradeAnnounce,
		setFirstTradeAnnounce
	} from '$lib/utils/syndicationPrefs';
	import { redactPrivateKeys, type PrivateKeyMatch } from '$lib/security/privateKeyDetector';
	import { saveDraft, loadDraftWithMeta, clearDraft } from '$lib/drafts';
	import { get } from 'svelte/store';

	interface Props {
		/** The user's order this feedback is linked to. Recorded
		 *  in the op's order_permlink field for the indexer. */
		orderPermlink: string;
		/** Optional: pre-populate the counterparty (subject) field.
		 *  Used by call sites that already know who the user is
		 *  reviewing — e.g. the pending-feedback reminder banner
		 *  knows the counterparty from the chain feedback record.
		 *  When provided, the field is still editable so users can
		 *  correct typos in their own minds, but starts populated. */
		prefillSubject?: string;
		/** Called on successful broadcast with the trx_id. Parent
		 *  typically refetches its list and closes the disclosure. */
		onSuccess?: (result: { trx_id: string }) => void;
		/** Called when the user dismisses the form. */
		onCancel?: () => void;
	}

	let { orderPermlink, prefillSubject, onSuccess, onCancel }: Props = $props();

	// localStorage key — once set, we skip the Post A broadcast for
	// subsequent feedback. The flag is keyed by account so switching
	// between accounts on the same device works correctly.
	const POST_A_FLAG_KEY_PREFIX = 'morphit.syndication.firstTradeFired.';

	const reviewerAccount = getUserBlurtAccount();

	// `subject` is seeded from `prefillSubject` once on mount.
	// The form is unmounted/remounted between feedback flows;
	// there is no UI path that updates `prefillSubject` while
	// the form is rendered.
	// svelte-ignore state_referenced_locally
	let subject = $state(prefillSubject ?? '');
	let rating: 1 | 2 | 3 | 4 | 5 | null = $state(null);
	let comment = $state('');
	let submitting = $state(false);
	let errorMessage = $state('');

	// ─── Private-key protection ────────────────────────────────────
	/** Current detector matches on `comment`. Kept in sync via the
	 *  ProtectedTextarea's onDetect callback. */
	let keyMatches: readonly PrivateKeyMatch[] = $state([]);
	/** True while the warning modal is visible. */
	let showKeyWarning = $state(false);
	/** Per-mount flag: once the user has chosen "send anyway" at
	 *  least once, we don't pester them with the modal again for
	 *  this form instance. They've acknowledged the risk; the
	 *  redaction at submit-time still applies. */
	let userAckedKeyWarning = $state(false);

	// Derived live errors for the fields. Silent (no kind=warn) until
	// the user has interacted — we don't want to scream at someone
	// who just opened the form.
	let subjectTouched = $state(false);

	const commentError = $derived.by(() => {
		// Validate once there's actual content to validate. The
		// ProtectedTextarea doesn't expose a blur hook, so we
		// can't use the "touched on blur" pattern — falling back
		// to "any content" is fine because an empty comment is
		// always valid anyway.
		if (comment.length === 0) return '';
		try {
			validateFeedback(reviewerAccount ?? 'unknown', {
				subject: subject || 'placeholder',
				rating: 5,
				comment
			});
			return '';
		} catch (err) {
			if (err instanceof FeedbackValidationError) {
				if (err.code === 'comment_too_long' || err.code === 'comment_forbidden_char') {
					return $_(`feedback.error.${err.code}`) as string;
				}
			}
			return '';
		}
	});

	const subjectError = $derived.by(() => {
		if (!subjectTouched) return '';
		if (subject.length === 0) return '';
		if (!reviewerAccount) return '';
		try {
			validateFeedback(reviewerAccount, {
				subject,
				rating: 5
			});
			return '';
		} catch (err) {
			if (err instanceof FeedbackValidationError) {
				if (err.code === 'subject_invalid' || err.code === 'self_review') {
					return $_(`feedback.error.${err.code}`) as string;
				}
			}
			return '';
		}
	});

	const canSubmit = $derived(
		reviewerAccount !== null &&
			subject.length > 0 &&
			subjectError === '' &&
			rating !== null &&
			commentError === '' &&
			!submitting
	);

	/** Key-specific flag lookup. Returns true if Post A has
	 *  already been fired for this account on this device. */
	function postAAlreadyFired(account: string): boolean {
		if (!browser) return true;
		try {
			return window.localStorage.getItem(POST_A_FLAG_KEY_PREFIX + account) === '1';
		} catch {
			// Privacy Mode or storage-denied. Safer to skip Post A
			// than to re-fire every submission.
			return true;
		}
	}

	function markPostAFired(account: string): void {
		if (!browser) return;
		try {
			window.localStorage.setItem(POST_A_FLAG_KEY_PREFIX + account, '1');
		} catch {
			// Best effort. The chain-side permlink dedup is the
			// real correctness guarantee.
		}
	}

	/** onDetect callback from ProtectedTextarea. Updates our local
	 *  match state; if matches are present AND the user hasn't
	 *  already acknowledged the warning, pop the modal next time
	 *  they try to submit. We don't pop here — that would be
	 *  jarring mid-type. The pop happens only on submit. */
	function handleKeyDetect(matches: readonly PrivateKeyMatch[]): void {
		keyMatches = matches;
		// If the user edits out all keys (matches empty), reset
		// the ack flag so the next newly-pasted key re-triggers
		// the warning.
		if (matches.length === 0) {
			userAckedKeyWarning = false;
		}
	}

	// ─── Draft persistence ─────────────────────────────────────────
	// Keyed by orderPermlink so feedback-in-progress for different
	// orders doesn't clobber each other. The user can have multiple
	// orders in /my/orders; each opens its own inline form.
	const DRAFT_KEY = $derived(`feedback.${orderPermlink}`);
	let draftSavedAt = $state<Date | null>(null);
	let draftSaveTimeout: ReturnType<typeof setTimeout> | null = null;

	interface FeedbackDraft {
		subject: string;
		rating: 1 | 2 | 3 | 4 | 5 | null;
		comment: string;
	}

	function draftHasContent(d: FeedbackDraft): boolean {
		return d.subject.length > 0 || d.rating !== null || d.comment.length > 0;
	}

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
		subject = '';
		rating = null;
		comment = '';
		subjectTouched = false;
	}

	onMount(() => {
		const saved = loadDraftWithMeta<FeedbackDraft>(DRAFT_KEY);
		if (saved && draftHasContent(saved.value)) {
			subject = saved.value.subject;
			rating = saved.value.rating;
			comment = saved.value.comment;
			draftSavedAt = new Date(saved.meta.savedAt);
		}

		return () => {
			if (draftSaveTimeout) clearTimeout(draftSaveTimeout);
		};
	});

	$effect(() => {
		// Subscribe to every persisted field.
		void subject;
		void rating;
		void comment;
		// Don't re-save while broadcasting — we either succeed
		// (and clear) or fail (and keep the last editing snapshot).
		if (submitting) return;

		if (draftSaveTimeout) clearTimeout(draftSaveTimeout);
		draftSaveTimeout = setTimeout(() => {
			// Per Finding R7: redact private keys from the comment
			// before persisting.  A user who types or pastes a key
			// then closes the browser without submitting would
			// otherwise leave the key in localStorage indefinitely.
			// In-memory `comment` is unchanged — only the persisted
			// copy is sanitized.
			const safeComment = comment.length > 0 ? redactPrivateKeys(comment) : comment;
			const snap: FeedbackDraft = { subject, rating, comment: safeComment };
			if (draftHasContent(snap)) {
				saveDraft(DRAFT_KEY, snap);
			}
		}, 500);
	});

	async function submit(): Promise<void> {
		if (!canSubmit || rating === null || !reviewerAccount) return;

		// Private-key gate: if the comment contains a detected key
		// AND the user hasn't already chosen "send anyway" this
		// session, show the warning modal instead of broadcasting.
		if (keyMatches.length > 0 && !userAckedKeyWarning) {
			showKeyWarning = true;
			return;
		}

		submitting = true;
		errorMessage = '';
		const state = get(identity);
		if (state.state !== 'unlocked') {
			errorMessage = $_('feedback.error.locked') as string;
			submitting = false;
			return;
		}

		// Redact any private-key material before broadcast. This is
		// the final line of defense — even if the user dismissed the
		// warning or the warning somehow didn't fire, nothing
		// sensitive leaves the client.
		const outgoingComment = comment.length > 0 ? redactPrivateKeys(comment) : '';

		try {
			const result = await broadcastFeedback(state.live, {
				subject,
				rating,
				comment: outgoingComment.length > 0 ? outgoingComment : undefined,
				order_permlink: orderPermlink
			});
			// Successful broadcast. Fire Post A if this is the first
			// feedback ever for this account on this device AND the
			// user hasn't disabled auto-announce in Settings.
			if (!postAAlreadyFired(reviewerAccount)) {
				markPostAFired(reviewerAccount);
				if (isFirstTradeAnnounceEnabled()) {
					// Fire-and-forget. The post is idempotent (account-
					// keyed permlink), so even a concurrent broadcast
					// from another device just becomes an edit.
					void publishFirstTradePost(state.live, { seller: subject });
				}
				// Note: when the user has disabled auto-announce, we
				// still markPostAFired to avoid re-checking on every
				// subsequent feedback they leave.  Re-enabling the
				// setting later won't retroactively post — that's the
				// right semantics (announcing a long-past first trade
				// would be weird).
			}
			// Broadcast succeeded — drop the draft. The form
			// typically gets closed by the parent via onSuccess
			// (it removes this component from the tree), but
			// belt-and-suspenders: clear first.
			clearDraft(DRAFT_KEY);
			draftSavedAt = null;
			onSuccess?.({ trx_id: result.trx_id });
		} catch (err) {
			console.warn('[LeaveFeedbackForm] broadcast failed:', err);
			if (err instanceof BroadcastError) {
				// Only certain BroadcastError codes have feedback-
				// specific localized messages; others fall to the
				// generic "broadcast failed" copy.  Without this
				// guard, a future BroadcastError code (or a refactor
				// that newly throws an existing one through this
				// path) would render the literal i18n key like
				// "feedback.error.missing_external_tx_id" to the user.
				const FEEDBACK_CODES = new Set(['no_account', 'locked']);
				if (FEEDBACK_CODES.has(err.code)) {
					errorMessage = $_(`feedback.error.${err.code}`) as string;
				} else {
					errorMessage = $_('feedback.error.broadcast_failed') as string;
				}
			} else if (err instanceof FeedbackValidationError) {
				// Same defensive guard as for BroadcastError above.
				// Only certain validation codes have feedback-specific
				// localized messages (the ones surfaced by user input);
				// codes that should be unreachable from the UI
				// (rating_out_of_range, order_permlink_bad_chars) fall
				// to the generic copy if they ever leak through.
				const VALIDATION_CODES = new Set([
					'subject_invalid',
					'self_review',
					'comment_too_long',
					'comment_forbidden_char'
				]);
				if (VALIDATION_CODES.has(err.code)) {
					errorMessage = $_(`feedback.error.${err.code}`) as string;
				} else {
					errorMessage = $_('feedback.error.broadcast_failed') as string;
				}
			} else {
				// Transport / chain / RPC failure. Use the generic
				// broadcast-failed copy — the user can retry.
				errorMessage = $_('feedback.error.broadcast_failed') as string;
			}
		} finally {
			submitting = false;
		}
	}
</script>

<div
	class="rounded-xl border-2 border-morphit-teal/40 bg-morphit-teal/5 p-3"
	role="group"
	aria-label={$_('feedback.form.aria_label')}
>
	{#if $isPairedReadOnly}
		<!-- Paired-readonly session (ADR-0022 QR-pair, Option A).
		     Feedback ops sign with the posting key, which lives on
		     the user's phone for QR-paired sessions.  Show the
		     WriteBlocked affordance with a phone deep-link to the
		     counterparty's profile (where they can leave feedback
		     on their phone). -->
		<WriteBlockedReadOnly variant="feedback" peer={subject || prefillSubject || null} />
	{:else}
		{#if draftSavedAt}
			<!-- Compact restore line: muted prose above the heading with
			     an inline Discard link. Intentionally less prominent
			     than the /post banner — this form is itself an inline
			     disclosure inside /my/orders, so a full banner would
			     out-weight the parent card. -->
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
	<p class="mb-2 font-semibold">{$_('feedback.form.heading')}</p>
	<p class="mb-3 text-xs text-ink-600 dark:text-ink-300">
		{$_('feedback.form.subheading')}
	</p>

	<!-- Subject: counterparty account name -->
	<label class="mb-3 block">
		<span class="mb-1 block text-sm font-semibold">
			{$_('feedback.form.subject_label')}
		</span>
		<input
			type="text"
			inputmode="text"
			autocomplete="off"
			autocorrect="off"
			autocapitalize="off"
			spellcheck="false"
			bind:value={subject}
			maxlength="16"
			onblur={() => (subjectTouched = true)}
			placeholder={$_('feedback.form.subject_placeholder') as string}
			class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
			disabled={submitting}
		/>
	</label>
	{#if subjectError}
		<StatusLine kind="warn">{subjectError}</StatusLine>
	{/if}

	<!-- Rating: 5-star buttons -->
	<fieldset class="mb-3">
		<legend class="mb-1 block text-sm font-semibold">
			{$_('feedback.form.rating_label')}
		</legend>
		<div class="flex gap-2">
			{#each [1, 2, 3, 4, 5] as n}
				<button
					type="button"
					aria-label={$_('feedback.form.rating_n_stars', { values: { n } }) as string}
					aria-pressed={rating === n}
					onclick={() => (rating = n as 1 | 2 | 3 | 4 | 5)}
					disabled={submitting}
					class="h-10 w-10 rounded-xl border-2 text-lg transition active:scale-[0.95] {rating !==
						null && rating >= n
						? 'border-morphit-emerald bg-emerald-50 dark:bg-ink-800'
						: 'border-ink-200 dark:border-ink-700'}"
				>
					{rating !== null && rating >= n ? '★' : '☆'}
				</button>
			{/each}
		</div>
	</fieldset>

	<!-- Comment: optional textarea with in-corner counter -->
	<label class="mb-3 block">
		<span class="mb-1 block text-sm font-semibold">{$_('feedback.form.comment_label')}</span>
		<ProtectedTextarea
			bind:value={comment}
			name="feedback-comment"
			onDetect={handleKeyDetect}
			rows={3}
			maxlength={1024}
			showCounter
			counterMode="codepoint"
			counterLimit={256}
			placeholder={$_('feedback.form.comment_placeholder') as string}
			disabled={submitting}
		/>
	</label>
	{#if commentError}
		<StatusLine kind="warn">{commentError}</StatusLine>
	{/if}

	{#if errorMessage}
		<StatusLine kind="warn">{errorMessage}</StatusLine>
	{/if}

	<!-- U2.2 — first-trade syndication disclosure.  Only renders
	     when this would actually be the user's first feedback
	     submission AND they're authenticated AND we're in a
	     browser context where postAAlreadyFired can be checked
	     reliably.
	     Sally finding H9 (Part 68): upgraded from a small-print
	     note + settings link to a prominent disclosure with
	     selling-point framing + an inline checkbox the user can
	     flip without leaving the form.  Default-on is kept (the
	     welcome-bonus flow promised the announcement) and the
	     copy now positively explains *why* syndication helps the
	     user (more eyes → more trades → upvote earnings going
	     straight into their Blurt wallet) so opting in feels
	     like a benefit not a tax. -->
	{#if reviewerAccount && browser && !postAAlreadyFired(reviewerAccount)}
		<div
			class="mt-3 rounded-xl border-2 border-morphit-emerald/40 bg-morphit-emerald/5 p-4 dark:border-morphit-emerald/50"
			role="note"
		>
			<p class="mb-2 flex items-center gap-2 text-sm font-semibold text-morphit-emerald">
				<span aria-hidden="true">📣</span>
				{$_('feedback.first_trade_disclosure.heading')}
			</p>
			<!-- Selling-point pitch — explains the mechanism so
			     opting in feels like a win.  Three concrete
			     benefits: (1) more eyes = more trade partners,
			     (2) upvotes = direct BLURT earnings, (3) BLURT
			     lands in the user's own wallet.  No marketing
			     fluff — every claim is a real consequence of
			     Blurt's upvote-rewards mechanic. -->
			<p class="mb-3 text-sm text-ink-700 dark:text-ink-200">
				{$_('feedback.first_trade_disclosure.pitch')}
			</p>
			<label
				class="flex cursor-pointer items-start gap-3 rounded-lg border border-morphit-emerald/20 bg-white p-3 dark:border-morphit-emerald/30 dark:bg-ink-950"
			>
				<input
					type="checkbox"
					checked={$firstTradeAnnounce}
					onchange={(e) => setFirstTradeAnnounce(e.currentTarget.checked)}
					disabled={submitting}
					class="mt-0.5 h-5 w-5 flex-none accent-morphit-emerald"
				/>
				<span class="min-w-0 text-sm text-ink-700 dark:text-ink-200">
					{#if $firstTradeAnnounce}
						<strong class="font-semibold text-morphit-emerald"
							>{$_('feedback.first_trade_disclosure.label_on')}</strong
						>
						<span class="mt-1 block text-xs text-ink-600 dark:text-ink-300">
							{$_('feedback.first_trade_disclosure.body_on')}
						</span>
					{:else}
						<strong class="font-semibold">{$_('feedback.first_trade_disclosure.label_off')}</strong>
						<span class="mt-1 block text-xs text-ink-600 dark:text-ink-300">
							{$_('feedback.first_trade_disclosure.body_off')}
						</span>
					{/if}
				</span>
			</label>
		</div>
	{/if}

	<div class="mt-3 flex flex-col gap-2">
		<BusyButton
			variant="primary"
			busy={submitting}
			busyLabel={$_('feedback.form.submitting') as string}
			disabled={!canSubmit}
			onclick={submit}
		>
			{$_('feedback.form.submit')}
		</BusyButton>
		<BusyButton variant="ghost" disabled={submitting} onclick={onCancel}>
			{$_('common.cancel')}
		</BusyButton>
	</div>
	{/if}
</div>

{#if showKeyWarning}
	<PrivateKeyWarningModal
		matches={keyMatches}
		onEdit={() => {
			showKeyWarning = false;
			// Don't set the ack — user chose to edit, not to
			// bypass. Next submit will re-check and re-pop if
			// the keys are still there.
		}}
		onSendAnyway={() => {
			showKeyWarning = false;
			userAckedKeyWarning = true;
			// Retry the submit path now that the gate is lifted.
			// The broadcast itself runs redactPrivateKeys() so
			// the outbound text is still sanitized.
			void submit();
		}}
	/>
{/if}
