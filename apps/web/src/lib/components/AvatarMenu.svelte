<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	/**
	 * AvatarMenu — the top-right avatar-with-badge + dropdown.
	 *
	 * When the user is signed in (unlocked OR paired-readonly):
	 *   - Renders their identicon avatar, seeded from the account
	 *     NAME whenever one is known (the stable, app-wide-available
	 *     anchor — it survives a posting-key rotation and matches the
	 *     profile page, explorer, the /settings account-name card, and
	 *     IdentityLabel everywhere). This holds for both unlocked and
	 *     paired-readonly sessions. Only before a name exists (mid-
	 *     onboarding, unlocked) does it fall back to the posting pubkey.
	 *   - Overlays an emerald badge with unread count when
	 *     totalUnread > 0.
	 *   - Click opens a dropdown menu with two panes:
	 *       1. Notifications fly-out (inline, current page stays)
	 *       2. Menu items: /my/orders, /settings, Sign out (+ Lock for
	 *          keystore sessions; Lock is HIDDEN for paired-readonly
	 *          because there's no password to gate a subsequent unlock
	 *          against — the keys live on the user's phone).
	 *
	 * When the user is NOT signed in:
	 *   - Renders the "Sign in / Register" button as before.
	 *
	 * Keyboard / a11y:
	 *   - Click or Enter/Space on the button toggles the menu
	 *   - Escape closes
	 *   - Click outside closes
	 *   - Focus trapped inside menu while open (tab cycles)
	 */
	import { _ } from 'svelte-i18n';
	import { gotoLocale } from '$i18n/navigate';
	import { identiconDataUri, identiconDataUriFromString } from '$crypto/identicon';
	import {
		liveIdentity,
		isPairedReadOnly,
		pairedReadOnly,
		hasAnySession,
		reset as resetIdentity,
		lockSession
	} from '$stores/identity';
	import { hasPersistedKeystore } from '$crypto/persistentKeystore';
	import { unreadCount, totalUnread, markRead } from '$lib/notifications';
	import { backupVisited } from '$utils/backupVisited';
	// runExplicitLockExtras is dynamically imported in confirmLock() (cp271 byte
	// budget): it pulls sign-out-only chat/trade cleanup (pubPin/tradeStatus/
	// blurtVerify), and importing it statically dragged a chat-verify chunk
	// (condenser_api.get_transaction) onto every page's baseline. It only runs
	// on an explicit lock action, never at first paint.
	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import ConfirmModal from './ConfirmModal.svelte';

	let open = $state(false);
	let showNotifications = $state(false);
	/** True when the sign-out confirmation modal is open. Separate
	 *  state from `open` (the menu) so the menu can close while the
	 *  modal is up — user sees one thing at a time. */
	let showSignOutConfirm = $state(false);
	/** True when the lock-session confirmation modal is open. Same
	 *  pattern as showSignOutConfirm, different action. */
	let showLockConfirm = $state(false);
	let menuEl = $state<HTMLDivElement | undefined>(undefined);
	let triggerEl = $state<HTMLButtonElement | undefined>(undefined);

	/** Whether to show the Lock Session menu item.  Only shown when
	 *  the user actually chose password-mode at onboarding — for
	 *  seed-only users, Lock and Sign Out do the same thing and
	 *  offering both would be confusing.  Paired-readonly sessions
	 *  also hide Lock (no password to gate a subsequent unlock; the
	 *  keys live on the phone), which `hasPersistedKeystore()`
	 *  correctly returns false for since no envelope is persisted. */
	const canLock = $derived(hasPersistedKeystore() && !$isPairedReadOnly);

	/** Whether to show the View profile menu item.  Sally finding
	 *  H8 (Part 68).  Hidden when the user hasn't completed
	 *  account-name registration yet, since /@<null> would 404.
	 *  Reads $liveIdentity AND $pairedReadOnly so it re-evaluates
	 *  on any session change without needing a page reload. */
	const canViewProfile = $derived.by((): boolean => {
		void $liveIdentity;
		void $pairedReadOnly;
		return getUserBlurtAccount() !== null;
	});

	// Avatar src — identicon seeded from the account NAME so it matches
	// the avatar shown on the profile page, the explorer, the account-name
	// card on /settings, and IdentityLabel everywhere. The account name is
	// the stable visual anchor (it survives a future posting-key rotation,
	// and it's the only seed available for accounts whose pubkey we haven't
	// fetched). Falls back to the posting pubkey only before a name exists
	// (mid-onboarding). Empty string when no session — the surrounding
	// {#if $hasAnySession} gate hides the avatar then.
	const avatarSrc = $derived.by(() => {
		void $liveIdentity; // re-evaluate on any session change
		void $pairedReadOnly;
		const name = getUserBlurtAccount();
		if (name) return identiconDataUriFromString(name, 40);
		const paired = $pairedReadOnly;
		if (paired) return identiconDataUriFromString(paired.account, 40);
		const live = $liveIdentity;
		if (live) return identiconDataUri(live.posting.publicKey, 40);
		return '';
	});

	const total = $derived(totalUnread($unreadCount));
	const badgeText = $derived(total > 9 ? '9+' : String(total));

	function toggle(): void {
		open = !open;
		if (!open) showNotifications = false;
	}

	function close(): void {
		open = false;
		showNotifications = false;
		triggerEl?.focus();
	}

	function openNotifications(): void {
		showNotifications = true;
	}

	function goToPostOrder(): void {
		close();
		void gotoLocale('/post');
	}

	function goToOrders(): void {
		close();
		void gotoLocale('/my/orders');
	}

	function goToMyProfile(): void {
		// Sally finding H8 (Part 68): without this entry the user
		// has no in-UI route from the avatar menu to her own
		// profile page (the public /@account view).  We resolve
		// the account name lazily inside the click handler so
		// users who haven't completed registration silently no-op
		// (the menu item is hidden via canViewProfile below).
		close();
		const me = getUserBlurtAccount();
		if (me) void gotoLocale(`/@${me}`);
	}

	function goToEditProfile(): void {
		close();
		// Land at the TOP of /settings (the profile/identity editor). No
		// anchor — deep-linking to #display-name-heading auto-scrolled the
		// user past the account-name card, which was disorienting.
		void gotoLocale('/settings');
	}

	function goToBackupKeys(): void {
		close();
		void gotoLocale('/backup-keys');
	}

	function goToSettings(): void {
		close();
		void gotoLocale('/settings');
	}

	function goToSupport(): void {
		close();
		void gotoLocale('/support');
	}

	/** User clicked Sign Out — close the menu and raise the
	 *  confirmation modal. The actual sign-out happens only if
	 *  they confirm. */
	function promptSignOut(): void {
		close();
		showSignOutConfirm = true;
	}

	/** User confirmed sign-out in the modal. Close the modal first
	 *  (smooth visual), then wipe the in-memory identity (which
	 *  unmounts this whole branch), then navigate home.
	 *
	 *  Order matters: closing the modal before resetIdentity() means
	 *  the modal goes through its normal close animation instead of
	 *  vanishing mid-unmount. */
	async function confirmSignOut(): Promise<void> {
		showSignOutConfirm = false;
		resetIdentity();
		await gotoLocale('/');
	}

	function cancelSignOut(): void {
		showSignOutConfirm = false;
	}

	/** User clicked Lock Session — close menu, raise modal. */
	function promptLock(): void {
		close();
		showLockConfirm = true;
	}

	/** User confirmed lock. Close modal first (smooth visual), then
	 *  clear in-memory identity. Unlike sign-out, the persisted
	 *  envelope STAYS on disk — that's what lets the next session
	 *  unlock with just the password. Navigate to /login so the
	 *  "unlock with password" form renders.
	 *
	 *  Explicit-lock extras (chat drafts + recent-peers list) run
	 *  in addition to the identity wipe — these are per the privacy
	 *  posture described in docs/CHAT-UI-DESIGN.md. Auto-lock (idle
	 *  timeout in +layout.svelte) does NOT call them; that keeps
	 *  drafts around for the user who just walked away briefly. */
	async function confirmLock(): Promise<void> {
		showLockConfirm = false;
		const { runExplicitLockExtras } = await import('$lib/chat/explicitLock');
		runExplicitLockExtras();
		lockSession();
		await gotoLocale('/login');
	}

	function cancelLock(): void {
		showLockConfirm = false;
	}

	function markAllRead(): void {
		markRead();
	}

	// Outside-click + escape handlers. Attached only while open, so
	// the listener doesn't run on every render.
	$effect(() => {
		if (!open) return;
		const onClick = (e: MouseEvent): void => {
			const t = e.target as Node | null;
			if (menuEl && t && !menuEl.contains(t) && !triggerEl?.contains(t)) {
				close();
			}
		};
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === 'Escape') close();
		};
		document.addEventListener('mousedown', onClick);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onClick);
			document.removeEventListener('keydown', onKey);
		};
	});

	// Part 121 cp7 — per-locale internal-link wrapper.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

{#if $hasAnySession}
	<div class="relative">
		<!-- Avatar trigger. The badge sits in the top-right corner of
		     the avatar, absolute-positioned so it overlaps the identicon
		     slightly for visual prominence without pushing layout. -->
		<button
			bind:this={triggerEl}
			type="button"
			onclick={toggle}
			aria-haspopup="menu"
			aria-expanded={open}
			aria-label={total > 0
				? $_('avatar_menu.open_with_count', { values: { count: total } })
				: $_('avatar_menu.open')}
			class="relative flex h-10 w-10 items-center justify-center rounded-full ring-1 ring-ink-300 transition hover:ring-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:ring-ink-700"
		>
			<img
				src={avatarSrc}
				alt=""
				width="40"
				height="40"
				class="rounded-full bg-ink-200/50 dark:bg-ink-800/50"
				aria-hidden="true"
				decoding="async"
			/>

			{#if $isPairedReadOnly}
				<!-- Paired-readonly indicator pill (ADR-0022 QR-pair).  A
				     small emerald dot in the bottom-right tells the user
				     "this session is paired from your phone" without
				     fighting the unread-count badge for the top-right
				     slot.  Decorative only — the readonly state is also
				     spelled out in the menu pill below. -->
				<span
					class="absolute -bottom-0.5 -end-0.5 flex h-3 w-3 items-center justify-center rounded-full border-2 border-white bg-morphit-emerald dark:border-ink-950"
					aria-hidden="true"
				></span>
			{/if}

			{#if total > 0}
				<!-- Badge pill. Absolute top-right, offset so it
				     overlaps the avatar edge — looks more integrated
				     than sitting strictly outside. The aria-live
				     region lets screen readers hear count updates. -->
				<span
					class="absolute -end-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-morphit-emerald px-1 text-[11px] font-black text-ink-950 shadow-morphit-card"
					aria-live="polite"
				>
					{badgeText}
				</span>
			{:else if !$backupVisited}
				<!-- Backup-unvisited nudge: amber dot, no count. The
				     distinct color communicates "this is a one-time
				     reminder, not an activity counter." Hidden once
				     notifications are active (unread count takes
				     priority visually). -->
				<span
					class="absolute -end-0.5 -top-0.5 h-3 w-3 rounded-full bg-amber-400 shadow-morphit-card ring-2 ring-white dark:ring-ink-950"
					aria-label={$_('avatar_menu.backup_nudge_aria')}
				></span>
			{/if}
		</button>

		{#if open}
			<!-- Dropdown menu. Absolutely-positioned, inline on the
			     page so the user never navigates away. Width is fixed
			     at sm:w-80 so content doesn't reflow; on very narrow
			     viewports it caps at 90vw. -->
			<div
				bind:this={menuEl}
				role="menu"
				class="absolute end-0 z-50 mt-2 w-[min(90vw,20rem)] animate-fade-up rounded-2xl border border-ink-200 bg-white shadow-morphit-card-hover dark:border-ink-700 dark:bg-ink-900"
			>
				{#if showNotifications}
					<!-- Notifications fly-out pane. Back button to
					     return to the main menu without closing. -->
					<div
						class="flex items-center gap-2 border-b border-ink-100 px-4 py-3 dark:border-ink-800"
					>
						<button
							type="button"
							onclick={() => (showNotifications = false)}
							class="rounded-lg p-1 text-ink-500 hover:bg-ink-100 hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:hover:bg-ink-800"
							aria-label={$_('avatar_menu.back')}
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="18"
								height="18"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2.5"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
								class="rtl:scale-x-[-1]"
							>
								<path d="m15 18-6-6 6-6" />
							</svg>
						</button>
						<h2 class="flex-1 font-display text-base font-bold">
							{$_('avatar_menu.notifications_heading')}
						</h2>
						{#if total > 0}
							<button
								type="button"
								onclick={markAllRead}
								class="rounded-lg px-2 py-1 text-xs font-semibold text-morphit-emerald hover:bg-ink-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:hover:bg-ink-800"
							>
								{$_('avatar_menu.mark_all_read')}
							</button>
						{/if}
					</div>

					<!-- Per-category summary. Shows counts even when 0
					     so the user has visual confirmation that the
					     notification system is working. -->
					<ul class="max-h-96 overflow-y-auto p-2">
						<li>
							<div class="flex items-center justify-between gap-3 rounded-xl px-3 py-3">
								<div class="min-w-0">
									<p class="text-sm font-semibold">
										{$_('avatar_menu.category.order')}
									</p>
									<p class="text-xs text-ink-500 dark:text-ink-400">
										{$_('avatar_menu.category.order_help')}
									</p>
								</div>
								<span
									class="flex-none rounded-full bg-ink-100 px-2 py-0.5 text-xs font-bold dark:bg-ink-800"
								>
									{$unreadCount.order}
								</span>
							</div>
						</li>
						<li>
							<div class="flex items-center justify-between gap-3 rounded-xl px-3 py-3">
								<div class="min-w-0">
									<p class="text-sm font-semibold">
										{$_('avatar_menu.category.chat')}
									</p>
									<p class="text-xs text-ink-500 dark:text-ink-400">
										{$_('avatar_menu.category.chat_help')}
									</p>
								</div>
								<span
									class="flex-none rounded-full bg-ink-100 px-2 py-0.5 text-xs font-bold dark:bg-ink-800"
								>
									{$unreadCount.chat}
								</span>
							</div>
						</li>
						<li>
							<div class="flex items-center justify-between gap-3 rounded-xl px-3 py-3">
								<div class="min-w-0">
									<p class="text-sm font-semibold">
										{$_('avatar_menu.category.feedback')}
									</p>
									<p class="text-xs text-ink-500 dark:text-ink-400">
										{$_('avatar_menu.category.feedback_help')}
									</p>
								</div>
								<span
									class="flex-none rounded-full bg-ink-100 px-2 py-0.5 text-xs font-bold dark:bg-ink-800"
								>
									{$unreadCount.feedback}
								</span>
							</div>
						</li>
					</ul>

					<div class="border-t border-ink-100 p-3 text-center dark:border-ink-800">
						<a
							href={lp('/settings#notifications')}
							onclick={close}
							class="text-xs font-semibold text-morphit-emerald hover:underline"
						>
							{$_('avatar_menu.notification_settings')}
						</a>
					</div>
				{:else}
					<!-- Main menu pane. -->
					{#if $isPairedReadOnly && $pairedReadOnly !== null}
						<!-- Paired-readonly pill — sits above the menu items as
						     a constant reminder of the session shape, so a
						     user who lost track of the global banner still
						     sees the truth when they pull down the menu. -->
						<div class="border-b border-ink-100 px-4 py-3 dark:border-ink-800">
							<p class="text-xs text-ink-500 dark:text-ink-400">
								@{$pairedReadOnly.account}
							</p>
							<p class="mt-0.5 text-xs font-semibold text-morphit-emerald">
								{$_('paired_readonly.avatar_menu_pill')}
							</p>
						</div>
					{/if}
					<ul class="p-2">
						<li>
							<button
								type="button"
								onclick={openNotifications}
								role="menuitem"
								class="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-3 text-left hover:bg-ink-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:hover:bg-ink-800"
							>
								<span class="flex items-center gap-3">
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="18"
										height="18"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"
									>
										<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
										<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
									</svg>
									<span class="text-sm font-semibold">
										{$_('avatar_menu.notifications')}
									</span>
								</span>
								<span class="flex items-center gap-1">
									{#if total > 0}
										<span
											class="rounded-full bg-morphit-emerald px-2 py-0.5 text-[11px] font-black text-ink-950"
										>
											{badgeText}
										</span>
									{/if}
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="14"
										height="14"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2.5"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"
										class="text-ink-500 dark:text-ink-400 rtl:scale-x-[-1]"
									>
										<path d="m9 18 6-6-6-6" />
									</svg>
								</span>
							</button>
						</li>
						<li class="my-1 border-t border-ink-100 dark:border-ink-800"></li>

						<!-- Primary trade CTA — placed at the top of
						     the non-notification items because trade
						     velocity is the whole point. Emerald
						     text tint distinguishes it from neutral
						     navigation items. -->
						<li>
							<button
								type="button"
								onclick={goToPostOrder}
								role="menuitem"
								class="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-morphit-emerald hover:bg-morphit-emerald/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald"
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="18"
									height="18"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2.5"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<path d="M12 5v14M5 12h14" />
								</svg>
								<span class="text-sm font-bold">{$_('avatar_menu.post_order')}</span>
							</button>
						</li>

						<li>
							<button
								type="button"
								onclick={goToOrders}
								role="menuitem"
								class="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-ink-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:hover:bg-ink-800"
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="18"
									height="18"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<rect x="3" y="4" width="18" height="16" rx="2" />
									<path d="M8 2v4M16 2v4M3 10h18" />
								</svg>
								<span class="text-sm font-semibold">{$_('avatar_menu.my_orders')}</span>
							</button>
						</li>

						<!-- Sally finding H8 (Part 68): View my profile.
						     Hidden when the user hasn't completed
						     account-name registration (registration is
						     prereq for /@<account> to resolve).  Drops
						     the user onto their own /@account view —
						     same surface other users see when looking
						     them up. -->
						{#if canViewProfile}
							<li>
								<button
									type="button"
									onclick={goToMyProfile}
									role="menuitem"
									class="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-ink-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:hover:bg-ink-800"
								>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="18"
										height="18"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"
									>
										<circle cx="12" cy="8" r="4" />
										<path d="M4 21a8 8 0 0 1 16 0" />
									</svg>
									<span class="text-sm font-semibold">{$_('avatar_menu.view_my_profile')}</span>
								</button>
							</li>
						{/if}

						<!-- Edit profile — deep-links into the
						     display-name section of /settings where
						     display_name, Blurt.media URL, and Nostr
						     URL are edited. -->
						<li>
							<button
								type="button"
								onclick={goToEditProfile}
								role="menuitem"
								class="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-ink-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:hover:bg-ink-800"
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="18"
									height="18"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
								</svg>
								<span class="text-sm font-semibold">{$_('avatar_menu.edit_profile')}</span>
							</button>
						</li>

						<!-- Backup my keys — critical one-time nudge.
						     Amber pill on the right disappears on
						     first visit. Copy is intentionally direct
						     so new users understand this isn't
						     optional. -->
						<li>
							<button
								type="button"
								onclick={goToBackupKeys}
								role="menuitem"
								class="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-3 text-left hover:bg-ink-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:hover:bg-ink-800"
							>
								<span class="flex items-center gap-3">
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="18"
										height="18"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"
									>
										<rect x="3" y="11" width="18" height="11" rx="2" />
										<path d="M7 11V7a5 5 0 0 1 10 0v4" />
									</svg>
									<span class="text-sm font-semibold">{$_('avatar_menu.backup_keys')}</span>
								</span>
								{#if !$backupVisited}
									<span
										class="rounded-full bg-amber-400 px-2 py-0.5 text-[11px] font-black text-ink-950"
									>
										{$_('avatar_menu.backup_nudge_pill')}
									</span>
								{/if}
							</button>
						</li>

						<li>
							<button
								type="button"
								onclick={goToSettings}
								role="menuitem"
								class="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-ink-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:hover:bg-ink-800"
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="18"
									height="18"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<circle cx="12" cy="12" r="3" />
									<path
										d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
									/>
								</svg>
								<span class="text-sm font-semibold">{$_('avatar_menu.settings')}</span>
							</button>
						</li>

						<li class="my-1 border-t border-ink-100 dark:border-ink-800"></li>

						<!-- Help & support — direct route to the
						     support page. Kept separate from the
						     primary action cluster so users know
						     where to look when they need help. -->
						<li>
							<button
								type="button"
								onclick={goToSupport}
								role="menuitem"
								class="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-ink-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:hover:bg-ink-800"
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="18"
									height="18"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<circle cx="12" cy="12" r="10" />
									<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
									<path d="M12 17h.01" />
								</svg>
								<span class="text-sm font-semibold">{$_('avatar_menu.help_support')}</span>
							</button>
						</li>

						<li class="my-1 border-t border-ink-100 dark:border-ink-800"></li>

						{#if canLock}
							<!-- Lock Session — only visible for users
							     who chose password-mode at onboarding.
							     Keeps the encrypted keystore on disk;
							     wipes in-memory keys. Next session
							     unlocks with just the password. -->
							<li>
								<button
									type="button"
									onclick={promptLock}
									role="menuitem"
									class="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-ink-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:hover:bg-ink-800"
								>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="18"
										height="18"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"
									>
										<rect x="3" y="11" width="18" height="11" rx="2" />
										<path d="M7 11V7a5 5 0 0 1 10 0v4" />
										<circle cx="12" cy="16" r="1" />
									</svg>
									<span class="text-sm font-semibold">{$_('avatar_menu.lock_session')}</span>
								</button>
							</li>
						{/if}

						<li>
							<button
								type="button"
								onclick={promptSignOut}
								role="menuitem"
								class="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-red-600 hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:text-red-400 dark:hover:bg-red-950/30"
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="18"
									height="18"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
									<polyline points="16 17 21 12 16 7" />
									<line x1="21" y1="12" x2="9" y2="12" />
								</svg>
								<span class="text-sm font-semibold">{$_('avatar_menu.sign_out')}</span>
							</button>
						</li>
					</ul>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Sign-out confirmation modal. Rendered inside the signed-in
	     branch because there's nothing to sign out of otherwise.
	     bind:open lets us flip it from promptSignOut/cancelSignOut/
	     confirmSignOut without the modal owning its own visibility
	     logic. -->
	<ConfirmModal
		bind:open={showSignOutConfirm}
		variant="destructive"
		title={$_('avatar_menu.sign_out_modal.title')}
		body={$_('avatar_menu.sign_out_modal.body')}
		confirmLabel={$_('avatar_menu.sign_out_modal.confirm')}
		cancelLabel={$_('avatar_menu.sign_out_modal.cancel')}
		busyLabel={$_('avatar_menu.sign_out_modal.confirm_pending')}
		onConfirm={confirmSignOut}
		onCancel={cancelSignOut}
	/>

	<!-- Lock-session confirmation modal. Neutral variant (not
	     destructive) because nothing is deleted — keys go from
	     memory to disk-only. -->
	<ConfirmModal
		bind:open={showLockConfirm}
		variant="neutral"
		title={$_('avatar_menu.lock_modal.title')}
		body={$_('avatar_menu.lock_modal.body')}
		confirmLabel={$_('avatar_menu.lock_modal.confirm')}
		cancelLabel={$_('avatar_menu.lock_modal.cancel')}
		busyLabel={$_('avatar_menu.lock_modal.confirm_pending')}
		onConfirm={confirmLock}
		onCancel={cancelLock}
	/>
{:else}
	<!-- Signed out: a small "Sign in" CTA in the header.  Visible
	     at all viewport sizes — the mobile primary nav has its own
	     larger CTA below as the canonical mobile entry point, but
	     having the header CTA visible too means users tapping the
	     avatar slot get a deterministic "do this to sign in" target. -->
	<a href={lp('/login')} class="btn-primary-sm">
		{$_('nav.start')}
	</a>
{/if}
