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
	import IdentityLabel from '$components/IdentityLabel.svelte';
	import { getProfileCached } from '$lib/indexer/profileCache';
	import type { ProfileResponse } from '@morphit/indexer-client';
	import { extractLabelPropsFromProfile } from '$lib/indexer/profileProps';
	import { getReputationReceipt } from '$lib/indexer/client';
	import NewTraderChip from '$lib/components/NewTraderChip.svelte';
	import { fetchAccountKeys } from '$blurt/accountKeys';
	import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';
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
	import { isFirstTradeAnnounceEnabled } from '$lib/utils/syndicationPrefs';
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
		 *  When provided WITHOUT lockSubject, the field is still
		 *  editable so users can correct typos; WITH lockSubject it
		 *  is shown read-only. */
		prefillSubject?: string;
		/** cp421: when true, the subject is a provably-derived trade
		 *  partner (from the order's on-chain counterparties) and is
		 *  rendered LOCKED — a prominent read-only @handle instead of a
		 *  free-text input — so there's no ambiguity about who is being
		 *  reviewed and no way to redirect the stars to another account.
		 *  Requires prefillSubject to be set. */
		lockSubject?: boolean;
		/** Called on successful broadcast with the trx_id. Parent
		 *  typically refetches its list and closes the disclosure. */
		onSuccess?: (result: { trx_id: string }) => void;
		/** Called when the user dismisses the form. */
		onCancel?: () => void;
	}

	let { orderPermlink, prefillSubject, lockSubject = false, onSuccess, onCancel }: Props = $props();

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
	// v1.5.0 — enrich the "You're reviewing" box with the counterparty's
	//  avatar, display name (@handle), and truncated posting key. Fetched from
	//  the same-origin indexer; stale results are ignored; NO reputation is
	//  shown (Ken: it mustn't bias the review).
	let subjectProfile = $state<ProfileResponse | null>(null);
	let subjectPostingKey = $state<string | null>(null);
	let subjectIsNewTrader = $state(false);
	let subjectFetchSeq = 0;
	const subjectLabelProps = $derived(extractLabelPropsFromProfile(subjectProfile));
	$effect(() => {
		const acct = subject.trim();
		if (!acct) {
			subjectProfile = null;
			subjectPostingKey = null;
			subjectIsNewTrader = false;
			return;
		}
		const seq = ++subjectFetchSeq;
		void (async () => {
			try {
				const [profile, keys, rep] = await Promise.all([
					getProfileCached(acct),
					fetchAccountKeys(resolveOrigin(MORPHIT_INDEXER_ORIGIN), acct),
					getReputationReceipt(acct)
				]);
				if (seq !== subjectFetchSeq) return;
				subjectProfile = profile;
				subjectPostingKey = keys?.posting?.key_auths?.[0]?.[0] ?? null;
				// v1.5.0 — new-trader pill (NO reputation score). Matches the
				//  orderbook's "< 4 verified-fee trades" rule, approximated by the
				//  received-feedback count from the public reputation receipt.
				subjectIsNewTrader = rep.ok ? rep.data.summary.count_total < 4 : false;
			} catch {
				if (seq !== subjectFetchSeq) return;
				subjectProfile = null;
				subjectPostingKey = null;
				subjectIsNewTrader = false;
			}
		})();
	});
	let rating: 1 | 2 | 3 | 4 | 5 | null = $state(null);
	/** Star index (1–5) currently hovered/focused, 0 when none. Drives
	 *  the emerald fill-on-hover preview; never persisted. */
	let hoverRating = $state(0);
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
		// v1.5.0 — keep the locked/prefilled counterparty so the "You're
		// reviewing" box never dead-ends after a discard (Ken: the box must
		// always hold a counterparty). Only the draft's rating + comment go.
		subject = prefillSubject ?? '';
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
	class="rounded-xl border-2 border-ink-200 bg-white p-3 dark:border-ink-700 dark:bg-ink-900"
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
					class="flex-none text-xs font-semibold text-ink-700 underline decoration-dotted underline-offset-2 hover:no-underline hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:text-ink-200"
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
	{#if lockSubject}
		<!-- cp421: provably-derived trade partner — read-only, prominent,
		     no way to redirect the review to another account. -->
		<div class="mb-3">
			<span class="mb-1 block text-sm font-semibold">
				{$_('feedback.form.subject_locked_label')}
			</span>
			<div
				class="w-full rounded-xl border-2 border-morphit-emerald bg-morphit-emerald/5 px-3 py-2 text-sm font-semibold text-ink-900 dark:text-ink-50"
			>
				<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
					<IdentityLabel
						account={subject}
						displayName={subjectLabelProps.displayName}
						avatarSvg={subjectLabelProps.avatarSvg}
						avatarDataUri={subjectLabelProps.avatarDataUri}
						publicKeyString={subjectPostingKey ?? undefined}
					/>
					{#if subjectIsNewTrader}
						<NewTraderChip />
					{/if}
				</div>
			</div>
		</div>
	{:else}
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
				class="w-full rounded-xl border border-ink-200 bg-white px-3 py-2 font-mono text-sm focus:outline-none dark:border-ink-700 dark:bg-ink-900"
				disabled={submitting}
			/>
		</label>
		{#if subjectError}
			<StatusLine kind="warn">{subjectError}</StatusLine>
		{/if}
	{/if}

	<!-- Rating: 5-star buttons -->
	<fieldset class="mb-3">
		<legend class="mb-1 block text-sm font-semibold">
			{$_('feedback.form.rating_label')}
		</legend>
		<div class="flex gap-2">
			{#each [1, 2, 3, 4, 5] as n}
				{@const active = (hoverRating || rating || 0) >= n}
				<button
					type="button"
					aria-label={$_('feedback.form.rating_n_stars', { values: { n } }) as string}
					aria-pressed={rating === n}
					onclick={() => (rating = n as 1 | 2 | 3 | 4 | 5)}
					onmouseenter={() => (hoverRating = n)}
					onmouseleave={() => (hoverRating = 0)}
					onfocus={() => (hoverRating = n)}
					onblur={() => (hoverRating = 0)}
					disabled={submitting}
					class="h-10 w-10 rounded-xl border-2 bg-transparent text-lg transition active:scale-[0.95] {active
						? 'border-morphit-emerald text-morphit-emerald'
						: 'border-ink-200 text-ink-400 hover:border-morphit-emerald hover:text-morphit-emerald dark:border-ink-700 dark:text-ink-500'}"
				>
					{active ? '★' : '☆'}
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
