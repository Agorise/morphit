<script lang="ts">
	/**
	 * ChatNotificationNudge — a slim, self-suppressing bar shown at the
	 * top of a trade chat thread the first time a user opens one, prompting
	 * them to turn on chat notifications so they get pinged when the
	 * counterparty replies (even with the tab closed) → trades complete
	 * faster.
	 *
	 * Privacy posture: this rides the EXISTING web-push system only — an
	 * opaque browser push endpoint via the operator's relay (RFC 8291
	 * encrypted), no email/phone/Matrix address, no PII. "Turn on"
	 * subscribes to push + flips the push channel + the chat category on,
	 * exactly what Settings → Notifications would do. "Not now" dismisses
	 * permanently (localStorage) so we never nag again; the user can still
	 * enable it from Settings. Once chat pings are already active, the bar
	 * never shows.
	 *
	 * Placement mirrors FirstTradeHelper — between the chat header and the
	 * scrolling message list (a flex-none block).
	 */

	import { _ } from 'svelte-i18n';
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { browser } from '$app/environment';

	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import {
		isPushSupported,
		currentSubscription,
		subscribe as subscribeToPush,
		type PushPrivacyMode
	} from '$lib/notifications/push';
	import { notificationPrefs, setCategory, setChannel } from '$lib/notifications/preferences';
	import { shouldShowChatNudge, CHAT_NUDGE_DISMISSED_KEY } from '$lib/notifications/chatNudge';

	interface Props {
		/** Counterparty handle, for the prompt copy. */
		readonly peer: string;
	}

	let { peer }: Props = $props();

	let visible = $state(false);
	let busy = $state(false);
	let enabled = $state(false);
	let failed = $state(false);

	function readDismissed(): boolean {
		if (!browser) return true;
		try {
			return window.localStorage.getItem(CHAT_NUDGE_DISMISSED_KEY) === '1';
		} catch {
			return false;
		}
	}

	function persistDismissed(): void {
		if (!browser) return;
		try {
			window.localStorage.setItem(CHAT_NUDGE_DISMISSED_KEY, '1');
		} catch {
			// ignore — worst case the nudge re-evaluates next load
		}
	}

	function dismiss(): void {
		persistDismissed();
		visible = false;
	}

	async function enable(): Promise<void> {
		if (busy) return;
		const account = getUserBlurtAccount();
		if (!account) {
			failed = true;
			return;
		}
		busy = true;
		failed = false;
		try {
			const mode: PushPrivacyMode =
				get(notificationPrefs).pushPrivacy === 'self_hosted' ? 'self_hosted' : 'standard';
			await subscribeToPush(account, mode);
			setChannel('push', true);
			setCategory('chat', true);
			enabled = true;
			// Briefly confirm, then collapse.
			setTimeout(() => {
				visible = false;
			}, 2200);
		} catch {
			// Push can fail (operator relay has no VAPID, permission denied,
			// browser quirk). Don't crash the chat — show a quiet fallback
			// pointing at Settings.
			failed = true;
		} finally {
			busy = false;
		}
	}

	onMount(() => {
		if (!browser) return;
		void (async () => {
			const supported = isPushSupported();
			const loggedIn = getUserBlurtAccount() !== null;
			const dismissed = readDismissed();
			let chatPingsActive = false;
			try {
				const sub = await currentSubscription();
				const prefs = get(notificationPrefs);
				chatPingsActive = sub !== null && prefs.channels.push && prefs.categories.chat;
			} catch {
				chatPingsActive = false;
			}
			visible = shouldShowChatNudge({ supported, loggedIn, dismissed, chatPingsActive });
		})();
	});
</script>

{#if visible}
	<div
		class="mx-3 mb-2 mt-2 rounded-xl border-2 border-morphit-emerald/30 bg-morphit-emerald/5 p-3"
		aria-label={$_('chat_notif_nudge.aria_label') as string}
	>
		{#if enabled}
			<p class="text-sm font-medium text-morphit-emerald">
				{$_('chat_notif_nudge.enabled')}
			</p>
		{:else}
			<div class="flex items-start justify-between gap-2">
				<p class="text-sm text-ink-700 dark:text-ink-200">
					<span aria-hidden="true">🔔</span>
					{$_('chat_notif_nudge.prompt', { values: { peer } })}
				</p>
				<button
					type="button"
					onclick={dismiss}
					class="-mr-1 -mt-1 flex-none rounded-md px-2 py-1 text-xs text-ink-600 hover:bg-morphit-emerald/10 hover:text-ink-800 dark:text-ink-400 dark:hover:text-ink-200"
					aria-label={$_('chat_notif_nudge.dismiss_aria') as string}
				>
					✕
				</button>
			</div>
			<div class="mt-2 flex flex-wrap items-center gap-2">
				<button
					type="button"
					onclick={enable}
					disabled={busy}
					class="rounded-xl bg-morphit-emerald px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-morphit-emerald/90 disabled:cursor-wait disabled:opacity-60"
				>
					{busy ? $_('chat_notif_nudge.enabling') : $_('chat_notif_nudge.turn_on')}
				</button>
				<button
					type="button"
					onclick={dismiss}
					class="rounded-xl px-3 py-1.5 text-sm font-medium text-ink-600 hover:bg-morphit-emerald/10 dark:text-ink-400"
				>
					{$_('chat_notif_nudge.not_now')}
				</button>
			</div>
			{#if failed}
				<p class="mt-2 text-xs text-red-700 dark:text-red-400">
					{$_('chat_notif_nudge.error')}
				</p>
			{:else}
				<p class="mt-2 text-xs text-ink-500 dark:text-ink-500">
					{$_('chat_notif_nudge.privacy_note')}
				</p>
			{/if}
		{/if}
	</div>
{/if}
