<script lang="ts">
	/**
	 * PendingFeedbackReminderBanner — surfaces the "you have
	 * pending feedback to leave" reminder.
	 *
	 * Item 3.  Anchor: counterparty reviewed you > 48h ago and
	 * you haven't reciprocated.  See
	 * `$lib/feedback/pendingReminders.ts` for the pure compute.
	 *
	 * Privacy posture: this is a CLIENT-SIDE computation against
	 * the user's OWN data.  No server tracks "you forgot."  The
	 * banner is shown to the logged-in user only, and inline-
	 * embeds the same `LeaveFeedbackForm` they'd see if they had
	 * navigated to /my/orders themselves — so reciprocating is
	 * a single click away.
	 *
	 * OS-level notification: gated on
	 * `notificationPrefs.categories.feedback`.  When enabled,
	 * fires `notify({ category: 'feedback', ... })` once per
	 * pending-feedback trx_id per session.  Tracked in
	 * sessionStorage so re-loads don't spam.
	 */

	import { _ } from 'svelte-i18n';
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { gotoLocale } from '$i18n/navigate';
	import LeaveFeedbackForm from './LeaveFeedbackForm.svelte';
	import IdentityLabel from './IdentityLabel.svelte';
	import { identity } from '$stores/identity';
	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import { getFeedback, getFeedbackGiven } from '$indexer/client';
	import {
		computePendingFeedbackReminders,
		elapsedHours,
		type PendingFeedbackReminder
	} from '$lib/feedback/pendingReminders';
	import { notify } from '$lib/notifications';
	import { isUnlocked } from '$stores/identity';

	/** sessionStorage key tracking which reminder trx_ids have
	 *  already fired an OS notification this session.  Plain
	 *  Set serialized as JSON.  Cleared on tab close — that's
	 *  fine, the next session re-fires for whatever's still
	 *  pending. */
	const FIRED_KEY = 'morphit.feedbackReminders.firedThisSession';

	function readFiredSet(): Set<string> {
		if (!browser) return new Set();
		try {
			const raw = window.sessionStorage.getItem(FIRED_KEY);
			if (!raw) return new Set();
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) return new Set(parsed.filter((x) => typeof x === 'string'));
			return new Set();
		} catch {
			return new Set();
		}
	}

	function writeFiredSet(s: Set<string>): void {
		if (!browser) return;
		try {
			window.sessionStorage.setItem(FIRED_KEY, JSON.stringify(Array.from(s)));
		} catch {
			// Quota exhausted or storage disabled — ignore; we just
			// fire next session, no real harm.
		}
	}

	let reminders: readonly PendingFeedbackReminder[] = $state([]);
	let inlineFormFor: string | null = $state(null);
	/** True after the first fetch completes — controls whether
	 *  we render anything at all (no flash on a clean account). */
	let loaded = $state(false);

	/** Latest-call-wins guard.  identity.subscribe can fire several
	 *  times during sign-in, and a sign-out → in switch can race the
	 *  in-flight fetch.  Without this, alice's pending-feedback
	 *  reminders could be written to bob's session — and worse, OS
	 *  notifications would fire for the WRONG account.  See
	 *  OperatorBlockBanner for the same pattern. */
	let fetchGen = 0;

	async function refresh(): Promise<void> {
		if (!browser) return;
		const myGen = ++fetchGen;
		const acct = getUserBlurtAccount();
		if (!acct) return;

		// Fetch both directions in parallel.  Limit 100 each is
		// a sensible default — most users have far fewer pending
		// reminders, and the helper returns sorted/filtered.
		const [received, given] = await Promise.all([
			getFeedback(acct, { limit: 100 }),
			getFeedbackGiven(acct, { limit: 100 })
		]);
		// Drop if a newer refresh started while we were awaiting,
		// OR if the user signed out / switched account.  Critical
		// here because the next block fires OS notifications.
		if (myGen !== fetchGen) return;
		if (getUserBlurtAccount() !== acct) return;
		if (!received.ok || !given.ok) return;

		const list = computePendingFeedbackReminders({
			myAccount: acct,
			feedbackReceived: received.data.items,
			feedbackGiven: given.data.items
		});
		reminders = list;
		loaded = true;

		// Fire OS notifications for any reminder we haven't yet
		// notified about this session.  notify() respects user's
		// per-category opt-in via notificationPrefs.feedback, so
		// no need to pre-check here.
		const fired = readFiredSet();
		for (const r of list) {
			if (fired.has(r.counterpartyFeedbackTrxId)) continue;
			notify({
				category: 'feedback',
				title: $_('feedback_reminder.notif_title'),
				body: $_('feedback_reminder.notif_body', {
					values: {
						counterparty: r.counterpartyAccount,
						hours: elapsedHours(r)
					}
				}),
				href: `/my/orders#feedback=${r.orderPermlink}`,
				id: `feedback-reminder-${r.counterpartyFeedbackTrxId}`
			});
			fired.add(r.counterpartyFeedbackTrxId);
		}
		writeFiredSet(fired);
	}

	onMount(() => {
		// Only fetch once identity is ready — getUserBlurtAccount
		// returns null before the keystore is loaded.
		const unsub = identity.subscribe(async () => {
			if (getUserBlurtAccount()) {
				await refresh();
			}
		});
		// Re-check periodically — once per hour is plenty for a
		// reminder cadence, doesn't burn API calls.
		const interval = browser ? window.setInterval(() => void refresh(), 60 * 60 * 1000) : null;
		return () => {
			unsub();
			if (interval !== null) window.clearInterval(interval);
		};
	});

	function openInline(permlink: string): void {
		inlineFormFor = permlink;
	}

	function closeInline(): void {
		inlineFormFor = null;
	}

	function onFeedbackSuccess(permlink: string): void {
		// Remove this reminder from the list immediately —
		// optimistic update.  The next refresh() cycle will
		// confirm by virtue of the now-existing
		// feedbackGiven entry.
		reminders = reminders.filter((r) => r.orderPermlink !== permlink);
		inlineFormFor = null;
	}
</script>

{#if loaded && reminders.length > 0}
	<aside
		class="my-6 rounded-xl border-2 border-red-300 bg-red-50/70 p-4 dark:border-red-700/60 dark:bg-red-950/20"
		aria-label={$_('feedback_reminder.aria_label')}
	>
		<header class="mb-3 flex items-start gap-3">
			<svg
				class="mt-0.5 h-5 w-5 flex-none text-red-600 dark:text-red-400"
				viewBox="0 0 20 20"
				fill="currentColor"
				aria-hidden="true"
			>
				<path
					fill-rule="evenodd"
					d="M10 1a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm.75 6a.75.75 0 0 0-1.5 0v3.69l1.97 1.97a.75.75 0 1 0 1.06-1.06L10.75 10.19V7Z"
					clip-rule="evenodd"
				/>
			</svg>
			<div class="min-w-0 flex-1">
				<h2 class="font-semibold text-red-900 dark:text-red-100">
					{$_('feedback_reminder.heading', {
						values: { count: reminders.length }
					})}
				</h2>
				<p class="mt-1 text-sm text-red-800 dark:text-red-200">
					{$_('feedback_reminder.subheading')}
				</p>
			</div>
		</header>

		<ul class="space-y-3">
			{#each reminders as reminder (reminder.counterpartyFeedbackTrxId)}
				<li
					class="rounded-lg border border-red-200 bg-white p-3 dark:border-red-800/60 dark:bg-ink-900"
				>
					<div class="flex flex-wrap items-center justify-between gap-3">
						<div class="min-w-0 flex-1">
							<p class="text-sm text-ink-700 dark:text-ink-200">
								{$_('feedback_reminder.row_intro')}
								<IdentityLabel account={reminder.counterpartyAccount} />
								{$_('feedback_reminder.row_after_name', {
									values: { hours: elapsedHours(reminder) }
								})}
							</p>
							<p class="mt-1 text-xs text-ink-500 dark:text-ink-400">
								{$_('feedback_reminder.row_order_label')}: {reminder.orderPermlink}
							</p>
						</div>
						{#if inlineFormFor !== reminder.orderPermlink}
							{#if $isUnlocked}
								<button
									type="button"
									class="btn-secondary text-sm"
									onclick={() => openInline(reminder.orderPermlink)}
								>
									{$_('feedback_reminder.cta_inline')}
								</button>
							{:else}
								<button
									type="button"
									class="btn-secondary text-sm"
									onclick={() => gotoLocale(`/my/orders#feedback=${reminder.orderPermlink}`)}
								>
									{$_('feedback_reminder.cta_navigate')}
								</button>
							{/if}
						{/if}
					</div>

					{#if inlineFormFor === reminder.orderPermlink && $isUnlocked}
						<div class="mt-3">
							<LeaveFeedbackForm
								orderPermlink={reminder.orderPermlink}
								prefillSubject={reminder.counterpartyAccount}
								onSuccess={() => onFeedbackSuccess(reminder.orderPermlink)}
								onCancel={closeInline}
							/>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	</aside>
{/if}
