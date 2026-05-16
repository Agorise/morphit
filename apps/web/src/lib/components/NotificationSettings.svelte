<script lang="ts">
	/**
	 * NotificationSettings — the Settings > Notifications section.
	 *
	 * Renders all toggles across phases 1–4. Phase 1 (ambient),
	 * Phase 2 (Notification API), and Phase 4 (audio + vibrate)
	 * are shipped. Phase 3 (Web Push) renders with a "Coming soon"
	 * badge and a disabled toggle — the preference IS persisted,
	 * so when push ships, the user's intent is already recorded.
	 *
	 * This is deliberately ONE component owning the whole section
	 * so /settings/+page.svelte stays readable. i18n keys live
	 * under `settings.notifications.*` (already shipped).
	 */
	import { _ } from 'svelte-i18n';
	import { browser } from '$app/environment';
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
		subscribe as subscribeToPush,
		unsubscribe as unsubscribeFromPush,
		type SubscribeError,
		type PushPrivacyMode
	} from '$lib/notifications/push';
	import { getUserBlurtAccount } from '$lib/blurt/ops/profile';
	import StatusLine from './StatusLine.svelte';

	// Feature detection — render "unsupported" hints in-place for
	// channels the current platform can't deliver.
	const supportsNotifications = $derived(browser && typeof Notification !== 'undefined');
	const supportsBadging = $derived(
		browser && typeof navigator !== 'undefined' && 'setAppBadge' in navigator
	);
	const supportsVibrate = $derived(
		browser && typeof navigator !== 'undefined' && 'vibrate' in navigator
	);

	// ─── Push subscription state (Part 122 cp13) ────────────────
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
			} catch {
				// no-op — push not available yet
			}
		})();
	});

	async function handlePushSubscribe(): Promise<void> {
		if (pushBusy) return;
		const account = getUserBlurtAccount();
		if (!account) {
			pushError = 'subscribe_failed';
			return;
		}
		const mode: PushPrivacyMode =
			$notificationPrefs.pushPrivacy === 'self_hosted' ? 'self_hosted' : 'standard';
		pushBusy = true;
		pushError = null;
		try {
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
		// Format as locale-aware short time.
		try {
			return new Intl.DateTimeFormat(undefined, {
				hour: 'numeric',
				minute: '2-digit'
			}).format(new Date(until));
		} catch {
			return new Date(until).toISOString();
		}
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
						onchange={(e) => setCategory('order', (e.currentTarget as HTMLInputElement).checked)}
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
						onchange={(e) => setCategory('chat', (e.currentTarget as HTMLInputElement).checked)}
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
						onchange={(e) => setCategory('feedback', (e.currentTarget as HTMLInputElement).checked)}
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
						<p class="mt-2 text-xs text-amber-600 dark:text-amber-400">
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
							<p class="mt-2 text-xs text-amber-600 dark:text-amber-400">
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

			<!-- Push: phase 3 (Part 122 cp13 — shipped). Subscribe
			     button asks browser permission at the point of
			     relevance, then registers with the relay. Privacy
			     selector remains so users see their choice; the
			     mode is sent to the relay at subscribe time and
			     surfaced on each device's row in the operator
			     summary. -->
			<li>
				<label
					class="flex items-start justify-between gap-4 rounded-xl border border-ink-200 p-4 dark:border-ink-700"
				>
					<div class="min-w-0">
						<p class="font-semibold">{$_('settings.notifications.channel_push_label')}</p>
						<p class="mt-1 text-sm text-ink-500 dark:text-ink-400">
							{$_('settings.notifications.channel_push_help')}
						</p>
						{#if pushError}
							<p
								class="mt-2 text-sm text-rose-700 dark:text-rose-300"
								role="alert"
							>
								{$_(`settings.notifications.push_error_${pushError}`)}
							</p>
						{/if}
					</div>
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
								class="rounded-md bg-morphit-emerald px-3 py-1 text-sm font-semibold text-white hover:bg-morphit-emerald/90 disabled:opacity-50"
							>
								{pushBusy
									? $_('settings.notifications.push_subscribing')
									: $_('settings.notifications.push_subscribe')}
							</button>
						{/if}
					</div>
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
						{#each [['self_hosted', 'channel_push_privacy_self'], ['standard', 'channel_push_privacy_standard'], ['off', 'channel_push_privacy_off']] as const as [value, key] (value)}
							<label class="flex items-center gap-3">
								<input
									type="radio"
									name="push-privacy"
									{value}
									checked={$notificationPrefs.pushPrivacy === value}
									onchange={() => setPushPrivacy(value as PushPrivacy)}
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
							<p class="mt-2 text-xs text-amber-600 dark:text-amber-400">
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
						class="rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
					/>
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-sm">{$_('settings.notifications.quiet_to_label')}</span>
					<input
						type="time"
						value={$notificationPrefs.quietHours.to}
						onchange={(e) => setQuietHours({ to: (e.currentTarget as HTMLInputElement).value })}
						class="rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
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
				class="mt-3 rounded-xl border border-ink-300 bg-white px-4 py-2 font-semibold text-ink-700 transition hover:border-morphit-emerald hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:border-ink-600 dark:bg-ink-900 dark:text-ink-200"
			>
				{$_('settings.notifications.mute_unmute')}
			</button>
		{:else}
			<div class="mt-3 flex flex-wrap gap-2">
				<button
					type="button"
					onclick={() => muteFor(HOUR_MS)}
					class="rounded-xl border border-ink-300 bg-white px-4 py-2 text-sm font-semibold text-ink-700 transition hover:border-morphit-emerald hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:border-ink-600 dark:bg-ink-900 dark:text-ink-200"
				>
					{$_('settings.notifications.mute_1h')}
				</button>
				<button
					type="button"
					onclick={() => muteFor(4 * HOUR_MS)}
					class="rounded-xl border border-ink-300 bg-white px-4 py-2 text-sm font-semibold text-ink-700 transition hover:border-morphit-emerald hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:border-ink-600 dark:bg-ink-900 dark:text-ink-200"
				>
					{$_('settings.notifications.mute_4h')}
				</button>
				<button
					type="button"
					onclick={() => muteFor(NINETY_NINE_YEARS)}
					class="rounded-xl border border-ink-300 bg-white px-4 py-2 text-sm font-semibold text-ink-700 transition hover:border-morphit-emerald hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:border-ink-600 dark:bg-ink-900 dark:text-ink-200"
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
</section>
