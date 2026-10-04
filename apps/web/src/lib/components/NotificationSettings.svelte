<script lang="ts">
	/**
	 * NotificationSettings — the Settings > Notifications section.
	 *
	 * Renders all toggles across phases 1–4 — all shipped. Phase 1
	 * (ambient), Phase 2 (Notification API), Phase 3 (Web Push —
	 * subscribe/unsubscribe through the relay with
	 * capability detection + error surfacing), and Phase 4 (audio +
	 * vibrate). The push privacy preference is persisted so the
	 * user's choice is recorded across (re)subscribes.
	 *
	 * This is deliberately ONE component owning the whole section
	 * so /settings/+page.svelte stays readable. i18n keys live
	 * under `settings.notifications.*` (already shipped).
	 */
	import { _ } from 'svelte-i18n';
	import { browser } from '$app/environment';
	import { formatDayMonthTime } from '$lib/i18n/formatters';
	import {
		notificationPrefs,
		setCategory,
		setChannel,
		setPushPrivacy,
		setQuietHours,
		muteFor,
		unmute,
		type PushPrivacy
	} from '$lib/notifications/preferences';
	import {
		crossPageTradeEventsEnabled,
		enableCrossPageTradeEvents,
		disableCrossPageTradeEvents
	} from '$lib/notifications/crossPageTradeEvents';
	import {
		isPushSupported,
		currentSubscription,
		pushDeliveryUnavailable,
		subscribe as subscribeToPush,
		unsubscribe as unsubscribeFromPush,
		resyncPushCategories,
		setPushPrivacyLevel,
		type SubscribeError,
		type PushPrivacyMode
	} from '$lib/notifications/push';
	import { pushBlockedHelpKey } from '$lib/notifications/pushBlockedHelp';
	import { getUserBlurtAccount } from '$lib/blurt/ops/profile';
	import StatusLine from './StatusLine.svelte';
	import { onMount } from 'svelte';
	import {
		addressHistoryCount as countAddressHistory,
		clearAddressHistory,
		migrateLegacyAddressHistory
	} from '$lib/privacy/addressHistory';

	// Feature detection — render "unsupported" hints in-place for
	// channels the current platform can't deliver.
	const supportsNotifications = $derived(browser && typeof Notification !== 'undefined');
	const supportsBadging = $derived(
		browser && typeof navigator !== 'undefined' && 'setAppBadge' in navigator
	);
	const supportsVibrate = $derived(
		browser && typeof navigator !== 'undefined' && 'vibrate' in navigator
	);

	// ─── Push subscription state ────────────────
	// `supportsPush` is the structural feature-detect (SW + push +
	// Notification APIs all present).  `pushAvailable` additionally
	// requires that the operator's relay has VAPID configured — we
	// learn this when our first subscribe call returns push_disabled
	// or by an empty /vapid-public-key response.  Until we know,
	// the UI shows the subscribe button optimistically.
	let supportsPush = $state(false);
	let pushSubscribed = $state(false);
	let pushBusy = $state(false);
	let pushError = $state<SubscribeError | null>(null);

	// Shared-address-history "forget" control (wired into the Privacy
	// section below). The data lives device-local, hashed, in localStorage
	// ($lib/privacy/addressHistory.ts); the count loads on mount (after an
	// older build's plaintext record is converted) and clearing is purely
	// client-side.
	let addressHistoryCount = $state(0);
	let confirmingForgetAddresses = $state(false);
	onMount(() => {
		addressHistoryCount = countAddressHistory();
		void migrateLegacyAddressHistory().then(() => {
			addressHistoryCount = countAddressHistory();
		});
	});
	function forgetAddressHistory(): void {
		clearAddressHistory();
		addressHistoryCount = 0;
		confirmingForgetAddresses = false;
	}

	// Bootstrap: on first mount, detect support and read current
	// subscription so the toggle reflects reality.
	$effect(() => {
		if (!browser) return;
		supportsPush = isPushSupported();
		if (!supportsPush) return;
		(async () => {
			try {
				const existing = await currentSubscription();
				pushSubscribed = existing !== null;
				// v1.18.0 — a subscription can outlive the instance's ability to
				// deliver to it: every existing tor-only node turns push off on
				// upgrade. Ask, and say so, rather than show "subscribed" for
				// something that will never arrive. Only when there IS a
				// subscription: a browser without one learns this on its first
				// Subscribe, as before.
				const unavailable = existing === null ? null : await pushDeliveryUnavailable();
				if (unavailable !== null) {
					pushSubscribed = false;
					pushError = unavailable;
					// A hidden-only instance will never deliver to this
					// subscription, by design (v1.18.0 review, W4): remove it
					// — from the browser and from the relay — rather than leave
					// a stored link between this account and this device that
					// nothing will ever use or prune. Best-effort; the next
					// visit tries again if it did not go through.
					const account = getUserBlurtAccount();
					if (unavailable === 'push_disabled_hidden_only' && account) {
						void unsubscribeFromPush(account).catch(() => undefined);
					}
				}
			} catch {
				// no-op — push not available yet
			}
		})();
	});

	// toggling a category updates the client prefs AND,
	// if this device already has a Web Push subscription, re-syncs the
	// muted list to the relay so tab-closed pushes obey the toggle too.
	// Best-effort (a locked session just defers the sync to the next
	// subscribe) — the visual toggle state never depends on the relay.
	function handleCategoryToggle(category: 'order' | 'chat' | 'feedback', value: boolean): void {
		setCategory(category, value);
		if (!pushSubscribed) return;
		const account = getUserBlurtAccount();
		if (!account) return;
		// v1.7.7 — always 'standard'. The wire/relay still ACCEPT
		// 'self_hosted' so a browser running pre-1.7.7 cached JS keeps working,
		// but this client no longer produces it: it selected a mode nothing
		// downstream ever read.
		const mode: PushPrivacyMode = 'standard';
		void resyncPushCategories(account, mode);
	}

	async function handlePushSubscribe(): Promise<void> {
		if (pushBusy) return;
		const account = getUserBlurtAccount();
		if (!account) {
			pushError = 'subscribe_failed';
			return;
		}
		// v1.7.7 — always 'standard'; see the note at the other call site.
		const mode: PushPrivacyMode = 'standard';
		pushBusy = true;
		pushError = null;
		try {
			// Subscribing is choosing push: leave "Off".
			if ($notificationPrefs.pushPrivacy === 'off') setPushPrivacy('standard');
			await subscribeToPush(account, mode);
			pushSubscribed = true;
			setChannel('push', true);
		} catch (err: unknown) {
			pushError = (err as SubscribeError) ?? 'subscribe_failed';
			pushSubscribed = false;
		} finally {
			pushBusy = false;
		}
	}

	/** The privacy radio. 'Off' cancels this browser's push subscription
	 *  (browser and relay), so the toggle above must say so too. */
	async function applyPushPrivacy(level: PushPrivacy): Promise<void> {
		await setPushPrivacyLevel(level, getUserBlurtAccount());
		if (level === 'off') pushSubscribed = false;
	}

	async function handlePushUnsubscribe(): Promise<void> {
		if (pushBusy) return;
		const account = getUserBlurtAccount();
		if (!account) {
			pushError = 'subscribe_failed';
			return;
		}
		pushBusy = true;
		pushError = null;
		try {
			await unsubscribeFromPush(account);
			pushSubscribed = false;
			setChannel('push', false);
		} catch (err: unknown) {
			pushError = (err as SubscribeError) ?? 'subscribe_failed';
		} finally {
			pushBusy = false;
		}
	}

	// Mute-until display: if currently muted, show "muted until
	// {time}" and offer an Unmute button.
	const muteActiveUntil = $derived.by(() => {
		const until = $notificationPrefs.mutedUntil;
		if (until <= Date.now()) return null;
		// Sitewide standard: 24-hour UTC timestamp (unambiguous timezone).
		return formatDayMonthTime(new Date(until));
	});

	const HOUR_MS = 60 * 60 * 1000;
	const NINETY_NINE_YEARS = 99 * 365 * 24 * HOUR_MS;
</script>

<section class="card mt-6" aria-labelledby="notifications-heading" id="notifications">
	<h2 id="notifications-heading" class="font-display text-xl font-bold">
		{$_('settings.notifications.heading')}
	</h2>
	<p class="mt-2 text-ink-600 dark:text-ink-300">
		{$_('settings.notifications.explain')}
	</p>

	<!-- ── Group 1: Categories (what to be notified about) ── -->
	<div class="mt-8">
		<h3 class="font-display text-base font-bold">
			{$_('settings.notifications.category_heading')}
		</h3>

		<ul class="mt-4 space-y-3">
			<li>
				<label
					class="flex items-start justify-between gap-4 rounded-xl border border-ink-200 p-4 dark:border-ink-700"
				>
					<div class="min-w-0">
						<p class="font-semibold">{$_('settings.notifications.category_order_label')}</p>
						<p class="mt-1 text-sm text-ink-500 dark:text-ink-400">
							{$_('settings.notifications.category_order_help')}
						</p>
					</div>
					<input
						type="checkbox"
						checked={$notificationPrefs.categories.order}
						onchange={(e) =>
							handleCategoryToggle('order', (e.currentTarget as HTMLInputElement).checked)}
						class="mt-1 h-5 w-5 flex-none accent-morphit-emerald"
					/>
				</label>
			</li>
			<li>
				<label
					class="flex items-start justify-between gap-4 rounded-xl border border-ink-200 p-4 dark:border-ink-700"
				>
					<div class="min-w-0">
						<p class="font-semibold">{$_('settings.notifications.category_chat_label')}</p>
						<p class="mt-1 text-sm text-ink-500 dark:text-ink-400">
							{$_('settings.notifications.category_chat_help')}
						</p>
					</div>
					<input
						type="checkbox"
						checked={$notificationPrefs.categories.chat}
						onchange={(e) =>
							handleCategoryToggle('chat', (e.currentTarget as HTMLInputElement).checked)}
						class="mt-1 h-5 w-5 flex-none accent-morphit-emerald"
					/>
				</label>
			</li>
			<li>
				<label
					class="flex items-start justify-between gap-4 rounded-xl border border-ink-200 p-4 dark:border-ink-700"
				>
					<div class="min-w-0">
						<p class="font-semibold">{$_('settings.notifications.category_feedback_label')}</p>
						<p class="mt-1 text-sm text-ink-500 dark:text-ink-400">
							{$_('settings.notifications.category_feedback_help')}
						</p>
					</div>
					<input
						type="checkbox"
						checked={$notificationPrefs.categories.feedback}
						onchange={(e) =>
							handleCategoryToggle('feedback', (e.currentTarget as HTMLInputElement).checked)}
						class="mt-1 h-5 w-5 flex-none accent-morphit-emerald"
					/>
				</label>
			</li>
		</ul>
	</div>

	<!-- ── Group 2: Channels (how to be notified) ── -->
	<div class="mt-8">
		<h3 class="font-display text-base font-bold">
			{$_('settings.notifications.channel_heading')}
		</h3>

		<ul class="mt-4 space-y-3">
			<!-- Ambient: always on, no toggle. Title + favicon + App
			     Badge. Here purely for user transparency. -->
			<li
				class="flex items-start justify-between gap-4 rounded-xl border border-ink-200 bg-ink-50/50 p-4 dark:border-ink-700 dark:bg-ink-800/30"
			>
				<div class="min-w-0">
					<p class="font-semibold">{$_('settings.notifications.channel_ambient_label')}</p>
					<p class="mt-1 text-sm text-ink-500 dark:text-ink-400">
						{$_('settings.notifications.channel_ambient_help')}
					</p>
					{#if !supportsBadging}
						<p class="mt-2 text-xs text-ink-600 dark:text-ink-400">
							{$_('settings.notifications.hint_badging_unsupported')}
						</p>
					{/if}
				</div>
				<span
					class="mt-1 flex-none rounded-full bg-morphit-emerald px-2 py-0.5 text-[11px] font-black text-ink-950"
				>
					{$_('settings.notifications.always_on')}
				</span>
			</li>

			<!-- Native: phase 2. Shipped. Requires permission grant —
			     the PermissionBanner component requests permission
			     at point-of-relevance the first time an event would
			     fire a native notification. -->
			<li>
				<label
					class="flex items-start justify-between gap-4 rounded-xl border border-ink-200 p-4 dark:border-ink-700"
				>
					<div class="min-w-0">
						<p class="font-semibold">{$_('settings.notifications.channel_native_label')}</p>
						<p class="mt-1 text-sm text-ink-500 dark:text-ink-400">
							{$_('settings.notifications.channel_native_help')}
						</p>
						{#if !supportsNotifications}
							<p class="mt-2 text-xs text-ink-600 dark:text-ink-400">
								{$_('settings.notifications.hint_notifications_unsupported')}
							</p>
						{/if}
					</div>
					<input
						type="checkbox"
						checked={$notificationPrefs.channels.native}
						onchange={(e) => setChannel('native', (e.currentTarget as HTMLInputElement).checked)}
						class="mt-1 h-5 w-5 flex-none accent-morphit-emerald"
					/>
				</label>
			</li>

			<!-- Push: phase 3 (shipped). Subscribe
			     button asks browser permission at the point of
			     relevance, then registers with the relay. Privacy
			     selector remains so users see their choice; the
			     mode is sent to the relay at subscribe time and
			     surfaced on each device's row in the operator
			     summary. -->
			<li>
				<label class="block rounded-xl border border-ink-200 p-4 dark:border-ink-700">
					<div class="flex items-start justify-between gap-4">
						<p class="min-w-0 font-semibold">{$_('settings.notifications.channel_push_label')}</p>
						<div class="flex flex-none flex-col items-end gap-2">
							{#if !supportsPush}
								<span
									class="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-bold text-ink-600 dark:bg-ink-800 dark:text-ink-300"
								>
									{$_('settings.notifications.push_unsupported')}
								</span>
							{:else if pushSubscribed}
								<span
									class="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
								>
									{$_('settings.notifications.push_subscribed')}
								</span>
								<button
									type="button"
									onclick={handlePushUnsubscribe}
									disabled={pushBusy}
									class="rounded-md border border-ink-300 bg-white px-3 py-1 text-sm font-semibold text-ink-800 hover:bg-ink-50 disabled:opacity-50 dark:border-ink-600 dark:bg-ink-800 dark:text-ink-100 dark:hover:bg-ink-700"
								>
									{pushBusy
										? $_('settings.notifications.push_unsubscribing')
										: $_('settings.notifications.push_unsubscribe')}
								</button>
							{:else}
								<button
									type="button"
									onclick={handlePushSubscribe}
									disabled={pushBusy}
									class="rounded-md bg-morphit-btn px-3 py-1 text-sm font-semibold text-morphit-btn-text transition hover:brightness-110 disabled:opacity-50"
								>
									{pushBusy
										? $_('settings.notifications.push_subscribing')
										: $_('settings.notifications.push_subscribe')}
								</button>
							{/if}
						</div>
					</div>
					<p class="mt-2 text-sm text-ink-500 dark:text-ink-400">
						{$_('settings.notifications.channel_push_help')}
					</p>
					{#if pushError}
						{@const pushErrKey =
							pushError === 'push_service_unavailable'
								? pushBlockedHelpKey()
								: `push_error_${pushError}`}
						<p class="mt-2 text-sm text-rose-700 dark:text-rose-300" role="alert">
							{$_(`settings.notifications.${pushErrKey}`)}
						</p>
					{/if}
				</label>

				<!-- Privacy-level radios — stays visible so the user
				     can pick their mode before clicking Subscribe. -->
				<fieldset
					class="mt-3 rounded-xl border border-ink-200 bg-ink-50/50 p-4 dark:border-ink-700 dark:bg-ink-800/30"
				>
					<legend class="px-1 text-sm font-semibold">
						{$_('settings.notifications.channel_push_privacy_label')}
					</legend>
					<div class="mt-2 space-y-2">
						<!-- v1.7.7 — "Self-hosted only" REMOVED.
						     It never did anything. `privacy_mode` was validated by the
						     relay (api/push.ts), written to the DB (pushSubscriptions.ts)
						     — and read by nothing. `pushSender.ts` never looked at it. So
						     a user picked the private option, the FAQ told them "no
						     Google, no Mozilla, no third parties ever see that you
						     received a ping", and Chrome kept delivering via FCM exactly
						     as before.
						     A privacy control that does nothing is worse than no control:
						     it converts a user's caution into false confidence, and this
						     is the panel where that costs the most. It cannot be made to
						     work under Web Push either — pushManager.subscribe() returns
						     an endpoint minted by the BROWSER's push service; there is no
						     API to point it at your own server. The real answer is
						     UnifiedPush (user-chosen distributor), which is a feature, not
						     a radio button. Until that ships, the option is gone and the
						     FAQ says what actually happens. -->
						{#each [['standard', 'channel_push_privacy_standard'], ['off', 'channel_push_privacy_off']] as const as [value, key] (value)}
							<label class="flex items-center gap-3">
								<input
									type="radio"
									name="push-privacy"
									{value}
									checked={$notificationPrefs.pushPrivacy === value}
									onchange={() => void applyPushPrivacy(value as PushPrivacy)}
									class="h-4 w-4 accent-morphit-emerald"
								/>
								<span class="text-sm">{$_(`settings.notifications.${key}`)}</span>
							</label>
						{/each}
					</div>
				</fieldset>
			</li>

			<!-- Audio: phase 4. Off by default; synthesized two-tone
			     chime via Web Audio API. Requires a prior user
			     gesture before first play due to browser autoplay
			     policy — no extra handling needed because Morphit
			     always has an interaction before any event fires. -->
			<li>
				<label
					class="flex items-start justify-between gap-4 rounded-xl border border-ink-200 p-4 dark:border-ink-700"
				>
					<div class="min-w-0">
						<p class="font-semibold">{$_('settings.notifications.channel_audio_label')}</p>
						<p class="mt-1 text-sm text-ink-500 dark:text-ink-400">
							{$_('settings.notifications.channel_audio_help')}
						</p>
					</div>
					<input
						type="checkbox"
						checked={$notificationPrefs.channels.audio}
						onchange={(e) => setChannel('audio', (e.currentTarget as HTMLInputElement).checked)}
						class="mt-1 h-5 w-5 flex-none accent-morphit-emerald"
					/>
				</label>
			</li>

			<!-- Vibrate: phase 4, mobile only. Feature-detected; a
			     user who turns it on but has no vibration hardware
			     just gets a silent no-op (the hint under the help
			     text tells them up-front it won't work here). -->
			<li>
				<label
					class="flex items-start justify-between gap-4 rounded-xl border border-ink-200 p-4 dark:border-ink-700"
				>
					<div class="min-w-0">
						<p class="font-semibold">{$_('settings.notifications.channel_vibrate_label')}</p>
						<p class="mt-1 text-sm text-ink-500 dark:text-ink-400">
							{$_('settings.notifications.channel_vibrate_help')}
						</p>
						{#if !supportsVibrate}
							<p class="mt-2 text-xs text-ink-600 dark:text-ink-400">
								{$_('settings.notifications.hint_vibrate_unsupported')}
							</p>
						{/if}
					</div>
					<input
						type="checkbox"
						checked={$notificationPrefs.channels.vibrate}
						onchange={(e) => setChannel('vibrate', (e.currentTarget as HTMLInputElement).checked)}
						class="mt-1 h-5 w-5 flex-none accent-morphit-emerald"
					/>
				</label>
			</li>
		</ul>
	</div>

	<!-- ── Group 3: Quiet hours ── -->
	<div class="mt-8">
		<h3 class="font-display text-base font-bold">
			{$_('settings.notifications.quiet_heading')}
		</h3>
		<p class="mt-1 text-sm text-ink-500 dark:text-ink-400">
			{$_('settings.notifications.quiet_explain')}
		</p>

		<label class="mt-4 flex items-center gap-3">
			<input
				type="checkbox"
				checked={$notificationPrefs.quietHours.enabled}
				onchange={(e) => setQuietHours({ enabled: (e.currentTarget as HTMLInputElement).checked })}
				class="h-5 w-5 accent-morphit-emerald"
			/>
			<span class="font-semibold">{$_('settings.notifications.quiet_enable_label')}</span>
		</label>

		{#if $notificationPrefs.quietHours.enabled}
			<div class="mt-4 flex flex-wrap items-end gap-4">
				<label class="flex flex-col gap-1">
					<span class="text-sm">{$_('settings.notifications.quiet_from_label')}</span>
					<input
						type="time"
						value={$notificationPrefs.quietHours.from}
						onchange={(e) => setQuietHours({ from: (e.currentTarget as HTMLInputElement).value })}
						class="rounded-xl border border-ink-200 bg-white px-3 py-2 focus:outline-none dark:border-ink-700 dark:bg-ink-900"
					/>
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-sm">{$_('settings.notifications.quiet_to_label')}</span>
					<input
						type="time"
						value={$notificationPrefs.quietHours.to}
						onchange={(e) => setQuietHours({ to: (e.currentTarget as HTMLInputElement).value })}
						class="rounded-xl border border-ink-200 bg-white px-3 py-2 focus:outline-none dark:border-ink-700 dark:bg-ink-900"
					/>
				</label>
			</div>
		{/if}
	</div>

	<!-- ── Group 4: Mute-all kill switch ── -->
	<div class="mt-8">
		<h3 class="font-display text-base font-bold">
			{$_('settings.notifications.mute_heading')}
		</h3>

		{#if muteActiveUntil}
			<div class="mt-3">
				<StatusLine kind="idle">
					{$_('settings.notifications.mute_active', { values: { until: muteActiveUntil } })}
				</StatusLine>
			</div>
			<button
				type="button"
				onclick={unmute}
				class="mt-3 rounded-xl border border-ink-300 bg-white px-4 py-2 font-semibold text-ink-700 transition-colors hover:border-morphit-emerald hover:bg-morphit-emerald/5 hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:border-ink-600 dark:bg-ink-900 dark:text-ink-200 dark:hover:bg-morphit-emerald/10"
			>
				{$_('settings.notifications.mute_unmute')}
			</button>
		{:else}
			<div class="mt-3 flex flex-wrap gap-2">
				<button
					type="button"
					onclick={() => muteFor(HOUR_MS)}
					class="rounded-xl border border-ink-300 bg-white px-4 py-2 text-sm font-semibold text-ink-700 transition-colors hover:border-morphit-emerald hover:bg-morphit-emerald/5 hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:border-ink-600 dark:bg-ink-900 dark:text-ink-200 dark:hover:bg-morphit-emerald/10"
				>
					{$_('settings.notifications.mute_1h')}
				</button>
				<button
					type="button"
					onclick={() => muteFor(4 * HOUR_MS)}
					class="rounded-xl border border-ink-300 bg-white px-4 py-2 text-sm font-semibold text-ink-700 transition-colors hover:border-morphit-emerald hover:bg-morphit-emerald/5 hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:border-ink-600 dark:bg-ink-900 dark:text-ink-200 dark:hover:bg-morphit-emerald/10"
				>
					{$_('settings.notifications.mute_4h')}
				</button>
				<button
					type="button"
					onclick={() => muteFor(NINETY_NINE_YEARS)}
					class="rounded-xl border border-ink-300 bg-white px-4 py-2 text-sm font-semibold text-ink-700 transition-colors hover:border-morphit-emerald hover:bg-morphit-emerald/5 hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:border-ink-600 dark:bg-ink-900 dark:text-ink-200 dark:hover:bg-morphit-emerald/10"
				>
					{$_('settings.notifications.mute_until_unmute')}
				</button>
			</div>
		{/if}
	</div>
</section>

<!-- Phase F.5 audit fix (F-23) — cross-page trade events toggle.
     Separate section because it's a privacy choice, not a
     notifications choice: governs whether the global SSE
     listener runs at all (and thus whether Morphit decrypts
     incoming chat messages ambiently across recent peers).
     Default ON; users who care about ambient-decryption privacy
     can opt out at the cost of losing cross-page badge updates. -->
<section class="card mt-6" aria-labelledby="privacy-heading" id="privacy">
	<h3 id="privacy-heading" class="text-lg font-semibold">
		{$_('settings.privacy.heading')}
	</h3>
	<div class="mt-3 flex items-start justify-between gap-4">
		<div class="min-w-0 flex-1">
			<p class="text-sm font-medium">
				{$_('settings.privacy.cross_page_trade_events_label')}
			</p>
			<p class="mt-1 text-xs text-ink-600 dark:text-ink-400">
				{$_('settings.privacy.cross_page_trade_events_help')}
			</p>
		</div>
		<button
			type="button"
			role="switch"
			aria-checked={$crossPageTradeEventsEnabled}
			aria-label={$_('settings.privacy.cross_page_trade_events_aria')}
			onclick={() =>
				$crossPageTradeEventsEnabled ? disableCrossPageTradeEvents() : enableCrossPageTradeEvents()}
			class="relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald focus-visible:ring-offset-2 {$crossPageTradeEventsEnabled
				? 'bg-morphit-emerald'
				: 'bg-ink-300 dark:bg-ink-700'}"
		>
			<span
				class="inline-block h-4 w-4 rounded-full bg-white transition-transform {$crossPageTradeEventsEnabled
					? 'translate-x-6'
					: 'translate-x-1'}"
			></span>
		</button>
	</div>

	<!-- Shared-address history ($lib/privacy/addressHistory.ts).
	     Wires the "forget my history" control the module was written for.
	     The data is device-local localStorage; clearing is client-side only. -->
	<div class="mt-4 border-t border-ink-200 pt-4 dark:border-ink-700">
		<p class="text-sm font-medium">{$_('settings.privacy.address_history_label')}</p>
		<p class="mt-1 text-xs text-ink-600 dark:text-ink-400">
			{$_('settings.privacy.address_history_help')}
		</p>
		{#if addressHistoryCount === 0}
			<p class="mt-2 text-xs text-ink-500">
				{$_('settings.privacy.address_history_empty')}
			</p>
		{:else}
			<p class="mt-2 text-xs text-ink-700 dark:text-ink-300">
				{$_('settings.privacy.address_history_count', { values: { count: addressHistoryCount } })}
			</p>
			<div class="mt-2">
				{#if !confirmingForgetAddresses}
					<button
						type="button"
						onclick={() => (confirmingForgetAddresses = true)}
						class="text-sm font-semibold text-red-600 hover:underline dark:text-red-400"
					>
						{$_('settings.privacy.address_history_forget')}
					</button>
				{:else}
					<div
						class="rounded-xl border-2 border-red-300 bg-red-50 p-3 dark:border-red-700 dark:bg-red-950"
						role="alertdialog"
						aria-live="polite"
					>
						<p class="text-sm text-red-900 dark:text-red-100">
							{$_('settings.privacy.address_history_forget_confirm', {
								values: { count: addressHistoryCount }
							})}
						</p>
						<div class="mt-3 flex flex-wrap gap-2">
							<button
								type="button"
								onclick={forgetAddressHistory}
								class="rounded-md bg-red-600 px-3 py-1 text-sm font-semibold text-white hover:bg-red-700"
							>
								{$_('settings.privacy.address_history_forget_confirm_yes')}
							</button>
							<button
								type="button"
								onclick={() => (confirmingForgetAddresses = false)}
								class="rounded-md border border-ink-300 px-3 py-1 text-sm font-semibold text-ink-800 hover:bg-ink-50 dark:border-ink-600 dark:text-ink-100 dark:hover:bg-ink-800"
							>
								{$_('settings.privacy.address_history_forget_confirm_cancel')}
							</button>
						</div>
					</div>
				{/if}
			</div>
		{/if}
	</div>
</section>
