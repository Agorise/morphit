<script lang="ts">
	/**
	 * Settings → Offline Notifications.
	 *
	 * When someone sends her a chat message while she is away from every
	 * browser, this site can send a short note to an address of hers (email,
	 * Matrix, XMPP, Telegram, Session): "Someone just sent you a chat message on
	 * <site>", with a link that opens the conversation. Never who wrote, never
	 * what they wrote.
	 *
	 * Only the channels this site's operator set up are shown; with none, the
	 * card is not shown at all. Each address is confirmed with a code before
	 * anything is sent to it. Once saved, an address is never shown again —
	 * not even to her — so the card shows only "On" (to change it she types a
	 * new one). See apps/relay/src/notify/ for how the addresses are kept.
	 */
	import { onDestroy, onMount, untrack } from 'svelte';
	import { _, locale } from 'svelte-i18n';
	import { isUnlocked } from '$stores/identity';
	import { blurtAccountName } from '$lib/blurt/ops/profile';
	import { isRtlLocale } from '$lib/i18n/locales';
	import BusyButton from './BusyButton.svelte';
	import StatusLine from './StatusLine.svelte';
	import VisibilityBadge from './VisibilityBadge.svelte';
	import {
		OFFLINE_CHANNELS,
		cancelChange,
		offeredChannels,
		offlineStatus,
		removeChannel,
		setAddress,
		startOfflinePresence,
		startTelegram,
		stopOfflinePresence,
		verifyCode,
		type ChannelState,
		type OfferedChannel,
		type OfflineChannel,
		type OfflineError
	} from '$lib/notifications/offlineNotify';

	let site = $state('');
	let offered = $state<readonly OfferedChannel[]>([]);
	let zeroClearnet = $state(false);
	let loaded = $state(false);
	let states = $state<Partial<Record<OfflineChannel, ChannelState>>>({});
	let addresses = $state<Partial<Record<OfflineChannel, string>>>({});
	let codes = $state<Partial<Record<OfflineChannel, string>>>({});
	let editing = $state<Partial<Record<OfflineChannel, boolean>>>({});
	let busy = $state<OfflineChannel | 'all' | null>(null);
	let errors = $state<Partial<Record<OfflineChannel | 'all', OfflineError>>>({});
	let telegram = $state<{ code: string; bot: string } | null>(null);
	let telegramTimer: ReturnType<typeof setTimeout> | null = null;
	/** Ten minutes without the bot seeing her code: polling stopped, she can
	 *  ask again. */
	let telegramGaveUp = $state(false);
	let deletedAll = $state(false);
	let destroyed = false;
	/** Bumped each time what she typed is forgotten (lock, sign-out, another
	 *  account): an answer to a request made before then is not shown. */
	let epoch = 0;

	const PLACEHOLDER: Record<Exclude<OfflineChannel, 'telegram'>, string> = {
		email: 'you@example.com',
		matrix: '@you:matrix.org',
		xmpp: 'you@xmpp.example',
		session: '05…'
	};

	/** `fresh`: not an answer from a few seconds ago (offlineStatus shares one
	 *  between the card and the heartbeat as the page opens). */
	async function refresh(fresh = false): Promise<void> {
		const mine = epoch;
		try {
			const s = await offlineStatus({ fresh });
			// An answer about whoever had the card before a lock or a switch.
			if (mine !== epoch) return;
			states = s;
		} catch {
			/* locked or unavailable: the card says so below */
		}
		if (mine !== epoch) return;
		if (Object.values(states).includes('on')) startOfflinePresence();
		else stopOfflinePresence();
	}

	/** Channels she still has here that the site no longer offers: she can
	 *  turn them off (the site keeps them sealed until she or it does). */
	const leftover = $derived(
		OFFLINE_CHANNELS.filter((c) => states[c] !== undefined && !offered.some((o) => o.id === c))
	);
	/** Whether to ask the relay about her: it offers something, or keeps addresses. */
	let stored = $state(false);

	onMount(async () => {
		const o = await offeredChannels();
		site = o.site;
		stored = o.stored;
		// Always Matrix, Session, XMPP, Telegram, Email, whatever order the
		// server lists them in.
		offered = [...o.channels].sort(
			(a, b) => OFFLINE_CHANNELS.indexOf(a.id) - OFFLINE_CHANNELS.indexOf(b.id)
		);
		zeroClearnet = o.zeroClearnet;
		loaded = true;
	});

	/** Whose card this is: the account while unlocked, null while locked. */
	const holder = $derived($isUnlocked ? ($blurtAccountName ?? '') : null);
	let shownFor: string | null | undefined;

	// On a shared computer: when she locks or signs out, or another account
	// signs in on this tab, nothing she typed (addresses, codes, a change in
	// progress, a Telegram code) or was told stays for the next person.
	$effect(() => {
		const who = holder;
		untrack(() => {
			if (shownFor !== undefined && who !== shownFor) forget();
			shownFor = who;
		});
	});

	// One status request as the card opens (once the offer is known) and each
	// time she unlocks (or the account changes); nothing else here asks on its own.
	$effect(() => {
		if (holder !== null && (offered.length > 0 || stored)) untrack(() => void refresh());
	});

	function forget(): void {
		epoch++;
		stopTelegramWait();
		states = {};
		addresses = {};
		codes = {};
		editing = {};
		errors = {};
		deletedAll = false;
	}

	onDestroy(() => {
		destroyed = true;
		clearTelegramTimer();
	});

	const uiLocale = (): string => $locale ?? 'en';

	/** Answers after which the code she was asked for is gone: the card goes
	 *  back to the address step (the status says so). */
	const CODE_GONE: readonly OfflineError[] = ['expired', 'none', 'too_many_codes'];

	async function run(channel: OfflineChannel | 'all', fn: () => Promise<void>): Promise<void> {
		busy = channel;
		errors = { ...errors, [channel]: undefined };
		const mine = epoch;
		try {
			await fn();
		} catch (e) {
			if (mine !== epoch) return;
			const err = (typeof e === 'string' ? e : 'failed') as OfflineError;
			errors = { ...errors, [channel]: err };
			if (CODE_GONE.includes(err)) {
				if (channel !== 'all') codes = { ...codes, [channel]: '' };
				await refresh();
			}
		} finally {
			busy = null;
		}
	}

	function sendCode(c: Exclude<OfflineChannel, 'telegram'>): Promise<void> {
		return run(c, async () => {
			await setAddress(c, addresses[c] ?? '', uiLocale());
			codes = { ...codes, [c]: '' };
			editing = { ...editing, [c]: false };
			await refresh();
		});
	}

	/** Back to "On" after "Use a different address", nothing sent. */
	function stopEditing(c: OfflineChannel): void {
		editing = { ...editing, [c]: false };
		addresses = { ...addresses, [c]: '' };
		errors = { ...errors, [c]: undefined };
	}

	function confirm(c: OfflineChannel): Promise<void> {
		return run(c, async () => {
			await verifyCode(c, codes[c] ?? '');
			addresses = { ...addresses, [c]: '' };
			await refresh();
		});
	}

	function turnOff(c: OfflineChannel): Promise<void> {
		return run(c, async () => {
			await removeChannel(c);
			if (c === 'telegram') stopTelegramWait();
			await refresh();
		});
	}

	/** Cancel on the code step: a change of address is dropped and the address
	 *  she had keeps working (the relay puts it back); a first address goes. */
	function cancelCode(c: OfflineChannel): Promise<void> {
		return run(c, async () => {
			if (c === 'telegram') stopTelegramWait();
			await cancelChange(c);
			codes = { ...codes, [c]: '' };
			addresses = { ...addresses, [c]: '' };
			editing = { ...editing, [c]: false };
			await refresh();
		});
	}

	function deleteAll(): Promise<void> {
		return run('all', async () => {
			await removeChannel('all');
			stopTelegramWait();
			// Nothing she typed stays on screen (or in memory) either.
			addresses = {};
			codes = {};
			editing = {};
			errors = {};
			deletedAll = true;
			await refresh();
		});
	}

	function clearTelegramTimer(): void {
		if (telegramTimer !== null) clearTimeout(telegramTimer);
		telegramTimer = null;
	}

	function stopTelegramWait(): void {
		telegram = null;
		telegramGaveUp = false;
		clearTelegramTimer();
	}

	/** Her Telegram code is no longer waiting: on, or gone (the relay's
	 *  15 minutes ran out) — then she is told, as for an email code. */
	function telegramSettled(): void {
		if (states.telegram !== 'on') errors = { ...errors, telegram: 'expired' };
		stopTelegramWait();
	}

	/** The relay allows each account 30 requests in 10 minutes: look after 5
	 *  seconds, then 15, then every 30, for about ten minutes (21 looks). */
	const TELEGRAM_WAIT_MS = 10 * 60_000;
	const telegramDelay = (n: number): number => (n === 0 ? 5_000 : n === 1 ? 15_000 : 30_000);

	function waitForTelegram(): void {
		clearTelegramTimer();
		telegramGaveUp = false;
		const started = Date.now();
		let n = 0;
		const next = (): void => {
			const d = telegramDelay(n++);
			if (Date.now() - started + d > TELEGRAM_WAIT_MS) {
				telegramGaveUp = true;
				return;
			}
			telegramTimer = setTimeout(async () => {
				telegramTimer = null;
				await refresh(true);
				if (destroyed || telegram === null) return;
				if (states.telegram !== 'pending') telegramSettled();
				else next();
			}, d);
		};
		next();
	}

	function connectTelegram(): Promise<void> {
		return run('telegram', async () => {
			const mine = epoch;
			const code = await startTelegram(uiLocale());
			// Locked (or another account) meanwhile: her code is not shown to them.
			if (mine !== epoch) return;
			telegram = code;
			await refresh();
			// Watch for the bot to see her code; stop once it is on.
			waitForTelegram();
		});
	}

	function checkTelegramAgain(): Promise<void> {
		return run('telegram', async () => {
			await refresh(true);
			if (telegram === null) return;
			if (states.telegram !== 'pending') telegramSettled();
			else waitForTelegram();
		});
	}

	const label = (c: OfflineChannel): string => $_(`settings.offline_notify.channel.${c}`);
	const errorText = (e: OfflineError): string => $_(`settings.offline_notify.errors.${e}`);
	const botOf = (c: OfflineChannel): string => offered.find((o) => o.id === c)?.bot ?? '';
	/** A Session ID is 66 hex digits: show its start and end. Every other
	 *  sender (a Matrix ID, an XMPP address) is shown whole, so she can see
	 *  exactly who will write to her. */
	const shownBot = (c: OfflineChannel): string => {
		const b = botOf(c);
		return c === 'session' && b.length > 24 ? `${b.slice(0, 10)}…${b.slice(-6)}` : b;
	};
	/** In a right-to-left language a name or address put into a sentence keeps
	 *  its own direction (U+2068 … U+2069; rtl-bidi-smoke). Left-to-right text
	 *  gets nothing added here, so a copied address or Session ID stays clean.
	 *  (A text that writes `@{bot}` — telegram_steps — is the exception: the
	 *  i18n loader wraps every `@{…}` in U+2066 … U+2069 in every language,
	 *  rtlHandle.ts; so its value is given as it is, isolated once.) */
	const rtl = $derived(isRtlLocale($locale));
	// By code point: the compiler refuses the escapes written in a literal.
	const FSI = String.fromCodePoint(0x2068);
	const PDI = String.fromCodePoint(0x2069);
	const iso = (v: string): string => (rtl ? `${FSI}${v}${PDI}` : v);
</script>

{#if loaded && (offered.length > 0 || leftover.length > 0)}
	<section class="card mt-6" id="offline-notifications" aria-labelledby="offline-notify-heading">
		<h2 id="offline-notify-heading" class="font-display text-xl font-bold">
			{$_('settings.offline_notify.title')}
		</h2>
		<div class="mt-1"><VisibilityBadge scope="instance" /></div>
		<p class="mt-2 text-ink-600 [overflow-wrap:anywhere] dark:text-ink-300">
			{$_('settings.offline_notify.intro', { values: { site: iso(site) } })}
		</p>

		<div class="mt-4 rounded-xl border border-morphit-emerald/30 bg-morphit-emerald/5 p-3 text-sm">
			<p class="font-semibold">🔒 {$_('settings.offline_notify.privacy_title')}</p>
			<p class="mt-1 text-ink-600 [overflow-wrap:anywhere] dark:text-ink-300">
				{$_('settings.offline_notify.privacy', { values: { site: iso(site) } })}
			</p>
			<p class="mt-2 text-xs text-ink-500">{$_('settings.offline_notify.tip')}</p>
			<p class="mt-1 text-xs text-ink-500">{$_('settings.offline_notify.timing')}</p>
		</div>

		{#if zeroClearnet}
			<p class="mt-3 text-sm text-ink-500">{$_('settings.offline_notify.zero_clearnet')}</p>
		{/if}

		{#if !$isUnlocked}
			<p class="mt-4 text-ink-600 dark:text-ink-300">{$_('settings.offline_notify.signin')}</p>
		{:else}
			<ul class="mt-5 space-y-5">
				{#each offered as o (o.id)}
					{@const c = o.id}
					<li class="border-t border-ink-100 pt-4 first:border-t-0 first:pt-0 dark:border-ink-800">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<span class="font-semibold">{label(c)}</span>
							{#if states[c] === 'on'}
								<span class="text-sm font-semibold text-morphit-emerald"
									>✓ {$_('settings.offline_notify.on')}</span
								>
							{/if}
						</div>

						{#if states[c] === 'on' && !editing[c]}
							<div class="mt-2 flex flex-wrap gap-2">
								{#if c !== 'telegram'}
									<BusyButton
										variant="secondary-quiet"
										size="sm"
										onclick={() => (editing = { ...editing, [c]: true })}
									>
										{$_('settings.offline_notify.change')}
									</BusyButton>
								{/if}
								<BusyButton variant="ghost" size="sm" busy={busy === c} onclick={() => turnOff(c)}>
									{$_('settings.offline_notify.turn_off')}
								</BusyButton>
							</div>
						{:else if c === 'telegram'}
							{#if telegram && states.telegram === 'pending'}
								<p class="mt-2 text-sm text-ink-600 [overflow-wrap:anywhere] dark:text-ink-300">
									{$_('settings.offline_notify.telegram_steps', {
										values: { bot: telegram.bot }
									})}
								</p>
								<p class="mt-2 font-mono text-2xl tracking-widest" dir="ltr">{telegram.code}</p>
								<div class="mt-2 flex flex-wrap items-center gap-3">
									<a
										class="btn-primary-sm px-3 py-1.5"
										href={`https://t.me/${encodeURIComponent(telegram.bot)}?start=${encodeURIComponent(telegram.code)}`}
										target="_blank"
										rel="noopener noreferrer">{$_('settings.offline_notify.telegram_open')}</a
									>
									<BusyButton
										variant="ghost"
										size="sm"
										disabled={busy === 'telegram'}
										onclick={() => cancelCode('telegram')}
									>
										{$_('settings.offline_notify.cancel')}
									</BusyButton>
								</div>
								<div class="mt-2">
									{#if telegramGaveUp}
										<BusyButton
											variant="secondary-quiet"
											size="sm"
											busy={busy === 'telegram'}
											onclick={checkTelegramAgain}
										>
											{$_('settings.offline_notify.telegram_check_again')}
										</BusyButton>
									{:else}
										<StatusLine kind="loading"
											>{$_('settings.offline_notify.telegram_waiting')}</StatusLine
										>
									{/if}
								</div>
							{:else}
								<p class="mt-1 text-sm text-ink-500 [overflow-wrap:anywhere]">
									{$_('settings.offline_notify.from_bot', { values: { bot: iso(`@${botOf(c)}`) } })}
								</p>
								<div class="mt-2">
									<BusyButton
										variant="secondary-quiet"
										size="sm"
										busy={busy === c}
										onclick={connectTelegram}
									>
										{$_('settings.offline_notify.telegram_connect')}
									</BusyButton>
								</div>
							{/if}
						{:else if states[c] === 'pending'}
							<p class="mt-2 text-sm text-ink-600 [overflow-wrap:anywhere] dark:text-ink-300">
								{$_(`settings.offline_notify.code_sent.${c}`, {
									values: { site: iso(site), bot: iso(shownBot(c)) }
								})}
							</p>
							<label class="mt-2 block">
								<span class="mb-1 block text-sm font-semibold"
									>{$_('settings.offline_notify.code_label')}</span
								>
								<input
									class="w-40 rounded-xl border border-ink-200 bg-white px-3 py-2 font-mono tracking-widest focus:outline-none dark:border-ink-700 dark:bg-ink-900"
									dir="ltr"
									inputmode="numeric"
									autocomplete="one-time-code"
									maxlength="6"
									bind:value={codes[c]}
								/>
							</label>
							<div class="mt-2 flex flex-wrap gap-2">
								<BusyButton
									variant="primary"
									size="sm"
									busy={busy === c}
									disabled={!/^\d{6}$/.test((codes[c] ?? '').trim())}
									onclick={() => confirm(c)}
								>
									{$_('settings.offline_notify.confirm')}
								</BusyButton>
								<BusyButton
									variant="ghost"
									size="sm"
									disabled={busy === c}
									onclick={() => cancelCode(c)}
								>
									{$_('settings.offline_notify.cancel')}
								</BusyButton>
							</div>
						{:else}
							{#if botOf(c) !== ''}
								<p class="mt-1 text-sm text-ink-500 [overflow-wrap:anywhere]">
									{$_('settings.offline_notify.from_bot', { values: { bot: iso(shownBot(c)) } })}
								</p>
							{/if}
							<div class="mt-2 flex flex-wrap items-center gap-2">
								<!-- autocomplete off for every channel, email too: the browser
								     does not save her notification address in its autofill. -->
								<input
									class="min-w-[12rem] flex-1 rounded-xl border border-ink-200 bg-white px-3 py-2 focus:outline-none dark:border-ink-700 dark:bg-ink-900"
									type={c === 'email' ? 'email' : 'text'}
									dir="ltr"
									autocomplete="off"
									spellcheck="false"
									maxlength="254"
									placeholder={PLACEHOLDER[c]}
									aria-label={label(c)}
									bind:value={addresses[c]}
								/>
								<BusyButton
									variant="secondary-quiet"
									size="sm"
									busy={busy === c}
									busyLabel={$_('settings.offline_notify.sending')}
									disabled={(addresses[c] ?? '').trim() === ''}
									onclick={() => sendCode(c)}
								>
									{$_('settings.offline_notify.send_code')}
								</BusyButton>
								{#if states[c] === 'on'}
									<BusyButton
										variant="ghost"
										size="sm"
										disabled={busy === c}
										onclick={() => stopEditing(c)}
									>
										{$_('settings.offline_notify.cancel')}
									</BusyButton>
								{/if}
							</div>
							{#if states[c] === 'on'}
								<p class="mt-1 text-xs text-ink-500">{$_('settings.offline_notify.change_hint')}</p>
							{/if}
						{/if}

						{#if errors[c]}
							<div class="mt-2"><StatusLine kind="error">{errorText(errors[c]!)}</StatusLine></div>
						{/if}
					</li>
				{/each}
				{#each leftover as c (c)}
					<li class="border-t border-ink-100 pt-4 first:border-t-0 first:pt-0 dark:border-ink-800">
						<span class="font-semibold">{label(c)}</span>
						<p class="mt-1 text-sm text-ink-500">{$_('settings.offline_notify.not_offered')}</p>
						<div class="mt-2">
							<BusyButton
								variant="secondary-quiet"
								size="sm"
								busy={busy === c}
								onclick={() => turnOff(c)}
							>
								{$_('settings.offline_notify.turn_off')}
							</BusyButton>
						</div>
						{#if errors[c]}
							<div class="mt-2"><StatusLine kind="error">{errorText(errors[c]!)}</StatusLine></div>
						{/if}
					</li>
				{/each}
			</ul>

			{#if Object.keys(states).length > 0}
				<div class="mt-6 border-t border-ink-100 pt-4 dark:border-ink-800">
					<BusyButton variant="danger-quiet" size="sm" busy={busy === 'all'} onclick={deleteAll}>
						{$_('settings.offline_notify.delete_all')}
					</BusyButton>
				</div>
			{/if}
			{#if deletedAll && Object.keys(states).length === 0}
				<div class="mt-3">
					<StatusLine kind="ok">{$_('settings.offline_notify.deleted')}</StatusLine>
				</div>
			{/if}
			{#if errors.all}
				<div class="mt-2"><StatusLine kind="error">{errorText(errors.all)}</StatusLine></div>
			{/if}
		{/if}
	</section>
{/if}
