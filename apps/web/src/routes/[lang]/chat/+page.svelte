<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	/**
	 * /chat — inbox (Phase A).
	 *
	 * Lists the conversations the signed-in user is party to, sorted
	 * unread-first then most recent. Data comes from the indexer's
	 * /v1/conversations/:account endpoint which reads directly from
	 * the on-chain chat_messages table.
	 *
	 * Unread state (Phase A) is client-side only. The local device
	 * records the timestamp of each conversation visit in the
	 * `readState` module (localStorage). Any message with
	 * `created_at` newer than the user's last visit to that peer is
	 * considered unread.
	 *
	 * Phase B (planned) will shadow-write an on-chain
	 * `morphit_chat_read_v1` op so read state is durable and syncs
	 * across devices.
	 *
	 * This surface is DELIBERATELY LOW-COST — it doesn't derive
	 * chat keys, doesn't publish a chat identity, doesn't run
	 * libsodium-backed crypto. It just reads the conversations
	 * list + peer profiles. A user who opens /chat "just to look"
	 * pays nothing for the chat feature.
	 *
	 * The heavier crypto work (key derivation, identity publish,
	 * encrypt/decrypt) is triggered only when the user opens a
	 * specific conversation at /chat/[peer].
	 */

	import { onMount, onDestroy } from 'svelte';
	import { flip } from 'svelte/animate';
	import { _ } from 'svelte-i18n';

	import Head from '$components/Head.svelte';
	import IdentityLabel from '$components/IdentityLabel.svelte';
	import RelativeTime from '$components/RelativeTime.svelte';
	import { orderTitleParts } from '$lib/utils/orderTitle';
	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import { loadRecentPeers } from '$lib/chat/recentPeers';
	import {
		readState,
		markConversationRead,
		mergeRemoteReadState,
		isUnread
	} from '$lib/chat/readState';
	import { getConversations, getChatReadState } from '$lib/indexer/client';
	import { getProfilesBatch } from '$lib/indexer/profileCache';
	import { peersNeedingProfile, mergeProfileMap } from '$lib/indexer/profileMerge';
	import { extractLabelPropsFromProfile } from '$lib/indexer/profileProps';
	import { hiddenAccounts } from '$lib/utils/hiddenAccounts';
	import {
		chatFolders,
		folderOf,
		isStarred,
		toggleStar,
		archiveThread,
		restoreThread,
		syncChatFoldersFromChain,
		resurrectArchivedOnNewActivity
	} from '$lib/chat/chatFolders';
	import { isUnlocked } from '$stores/identity';
	import { blockedAccounts, loadBlocks } from '$lib/chat/blocks';
	import { subscribeChatActivity } from '$lib/chat/globalChatActivityStream';
	import { showToast } from '$lib/stores/toast';
	import RequireLiveSession from '$components/RequireLiveSession.svelte';
	import type { ConversationSummary, ProfileResponse } from '@morphit/indexer-client';

	let me: string | null = $state(null);
	let conversations: readonly ConversationSummary[] = $state([]);
	let profileMap = $state<Record<string, ProfileResponse | null>>({});
	let fallbackPeers: readonly string[] = $state([]);
	let loadError: boolean = $state(false);

	// ─── Folder partitioning ──────────────────────────────────────
	// The inbox is an email inbox (Ken, t.txt). Every discussion lives in
	// exactly one of three folders — Inbox (default), ★ Starred, Archived —
	// tracked per-discussion in the `chatFolders` store. Reading the store
	// inside the $derived below makes the lists (and the star/archive controls)
	// re-render the instant a folder changes.

	/** Active inbox tab. Inbox is the default and holds every discussion until
	 *  the user stars or archives it. */
	type InboxTab = 'inbox' | 'starred' | 'archived';
	let activeTab = $state<InboxTab>('inbox');

	/** All visible conversations, each tagged with its folder + unread flag,
	 *  sorted by date newest-first (t.txt item 6 — the star/archive folders all
	 *  sort by date, not unread-first). Filters out peers the user has hidden
	 *  (orderbook "hide") or blocked — those never appear in any folder. */
	const sortedConversations = $derived.by(() => {
		// Explicit store reads so the derived re-runs on read/folder changes.
		void $readState;
		void $chatFolders;
		const hidden = $hiddenAccounts;
		const blocked = $blockedAccounts;
		const visible = conversations.filter(
			(c) => !hidden.has(c.peer.toLowerCase()) && !blocked.has(c.peer.toLowerCase())
		);
		const withFlags = visible.map((c) => ({
			...c,
			unread: isUnread(c.peer, c.order?.permlink ?? '', c.last_message_at),
			folder: folderOf(c.peer, c.order?.permlink ?? '')
		}));
		withFlags.sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
		return withFlags;
	});

	type InboxRow = (typeof sortedConversations)[number];

	/** The three folder lists. A discussion is in exactly one. */
	const inboxList = $derived(sortedConversations.filter((c) => c.folder === 'inbox'));
	const starredList = $derived(sortedConversations.filter((c) => c.folder === 'starred'));
	const archivedList = $derived(sortedConversations.filter((c) => c.folder === 'archived'));

	/** Total unread across the folders that still nag you — Inbox + Starred.
	 *  Archived is triaged, so it doesn't feed the header pill (nor, in
	 *  chatUnread.ts, the favicon / avatar-menu badge). */
	const unreadTotal = $derived(
		sortedConversations.filter((c) => c.folder !== 'archived' && c.unread).length
	);
	/** Per-tab unread counts for the tab pill badges. */
	const inboxUnread = $derived(inboxList.filter((c) => c.unread).length);
	const starredUnread = $derived(starredList.filter((c) => c.unread).length);

	/** Which list to render based on the active tab. */
	/** Reuses `order_detail.status_*` — already translated in all ten locales, and
	 *  identical to what the chat thread and the order page show. */
	function orderStatusLabel(status: string): string {
		switch (status) {
			case 'live':
				return $_('order_detail.status_live') as string;
			case 'cancelled':
				return $_('order_detail.status_cancelled') as string;
			case 'expired':
				return $_('order_detail.status_expired') as string;
			default:
				return '';
		}
	}

	/** A discussion is identified by (peer, order) — never by peer alone. NUL is
	 *  used as the separator because it cannot occur in an account name or a
	 *  permlink, so no pair of distinct threads can produce the same key. */
	function threadKey(c: ConversationSummary): string {
		return `${c.peer}\u0000${c.order?.permlink ?? ''}`;
	}

	/** Open the thread the card is about, scoped to its order. The conversation
	 *  route reads `?order=` and filters the transcript to it.
	 *
	 *  `peer` and `permlink` arrive from the indexer, i.e. from the operator. The
	 *  result is nevertheless always a ROOT-RELATIVE path — `localePath` prefixes
	 *  `/<lang>` — so no `javascript:` or `//evil.example` scheme is reachable
	 *  through it, and the permlink is percent-encoded before it enters the query
	 *  string. The assertion below makes that structural rather than a comment:
	 *  if `localePath` ever stops prefixing, this fails loudly in dev instead of
	 *  quietly emitting an operator-controlled href. (`href-xss-smoke` allowlists
	 *  this expression on exactly that basis.) */
	function threadHref(c: ConversationSummary): string {
		const base = lp(`/chat/${c.peer}`);
		if (!base.startsWith('/') || base.startsWith('//')) return lp('/chat');
		return c.order ? `${base}?order=${encodeURIComponent(c.order.permlink)}` : base;
	}

	const activeList = $derived(
		activeTab === 'starred' ? starredList : activeTab === 'archived' ? archivedList : inboxList
	);

	/** t.txt (v1.4.8) — "Mark all as read" belongs only where there's a MARKABLE
	 *  unread: the Inbox or Starred tab with unread cards. Archived items don't
	 *  count toward unread (and the action skips them), so the button never shows
	 *  on Archived — nor on any tab with nothing unread to clear. */
	const activeTabHasUnread = $derived(
		activeTab === 'archived' ? false : activeList.some((c) => c.unread)
	);

	/** Fetch profiles for peers we don't have one for — so the 5 s poll doesn't
	 *  re-request the whole batch every tick, but a peer whose profile we DON'T
	 *  have is retried.
	 *
	 *  This used to ask `!(p in profileMap)`: a failed batch wrote `null`, the
	 *  key then existed, and that peer was never requested again for the life of
	 *  the page — the display name and avatar stayed stuck on `@username`.
	 *  `profileCache` already caches a fetch FAILURE as a soft null that expires
	 *  in seconds (vs an authoritative "no profile", cached for the full TTL),
	 *  but it only gets to act on that if we ask again. Asking again is cheap:
	 *  a fresh cache entry answers from memory without an HTTP request. */
	async function fetchProfilesForNewPeers(peers: readonly string[]): Promise<void> {
		const missing = peersNeedingProfile(peers, profileMap);
		if (missing.length === 0) return;
		const fetched = await getProfilesBatch(missing).catch(
			() => new Map<string, ProfileResponse | null>()
		);
		// Keep-prior on null: a transient failure must never blank a name we
		// already rendered successfully.
		profileMap = mergeProfileMap(profileMap, fetched);
	}

	/** Local recent-peers fallback so the inbox shows SOMETHING when the
	 *  indexer is unreachable. Only used on the initial load — a transient
	 *  poll failure must not blank an already-populated list. */
	async function fallbackToRecentPeers(): Promise<void> {
		if (me === null) return;
		loadError = true;
		const local = loadRecentPeers().filter((p) => p !== me);
		fallbackPeers = local;
		if (local.length > 0) await fetchProfilesForNewPeers(local);
	}

	/** Duration for the inbox card slide (t.txt item G — a newly-arrived
	 *  message re-sorts to the top and slides into place instead of jumping).
	 *  Returns 0 under prefers-reduced-motion so the card snaps without motion.
	 *  Evaluated per-animation, so it tracks the OS setting live. Mirrors the
	 *  AnimatedNumber.svelte reduced-motion check. */
	function cardFlipDuration(): number {
		if (typeof window === 'undefined') return 0;
		return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220;
	}

	/** Fetch the conversation list + server read-state and refresh the
	 *  inbox. Called once on mount and then every POLL_MS so new messages,
	 *  new requests (including from spammers/strangers), and read-state
	 *  changes surface within the fastchat window WITHOUT a manual refresh
	 *  (#18). Unread flags derive reactively from the read-state store, so
	 *  a conversation read elsewhere clears its dot immediately; re-fetching
	 *  here also freshens each `last_message_at` so a just-active
	 *  conversation stops showing a stale "N min ago" (#15).
	 *
	 *  `initial` controls the error path: first load falls back to the local
	 *  recent-peers list; a background poll keeps the last-known data on a
	 *  transient failure. */
	async function refresh(initial: boolean): Promise<void> {
		if (me === null) return;
		let convoR: Awaited<ReturnType<typeof getConversations>>;
		let readR: Awaited<ReturnType<typeof getChatReadState>>;
		try {
			[convoR, readR] = await Promise.all([getConversations(me), getChatReadState(me)]);
		} catch (err) {
			console.warn('[chat-inbox] indexer fetch threw:', err);
			if (initial) await fallbackToRecentPeers();
			return;
		}

		if (readR.ok) mergeRemoteReadState(readR.data.items);

		if (convoR.ok) {
			conversations = convoR.data.items;
			loadError = false;
			await fetchProfilesForNewPeers(conversations.map((c) => c.peer));
		} else if (initial) {
			await fallbackToRecentPeers();
		}
	}

	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let onVisible: (() => void) | null = null;
	let unsubActivity: (() => void) | null = null;

	// t.txt (v1.4.9 #5) — pull the on-chain chat folder organization once the
	// identity is unlocked (it's encrypted with the posting key, so it can only
	// be decrypted while unlocked). No-op when locked: the local mirror renders
	// meanwhile. Also performs the one-time migration (local stars → chain) the
	// first time an account with no on-chain state syncs.
	$effect(() => {
		if ($isUnlocked) void syncChatFoldersFromChain();
	});

	// v1.4.10 — Gmail-style un-archive: whenever the conversation list changes
	// (initial load, 5s poll, or the sub-second activity ping), pull any archived
	// thread that got a message AFTER it was archived back into the Inbox, so a
	// new reply surfaces + feeds the unread badge instead of hiding in Archived.
	$effect(() => {
		resurrectArchivedOnNewActivity(
			conversations.map((c) => ({
				peer: c.peer,
				orderPermlink: c.order?.permlink ?? '',
				lastMessageAt: c.last_message_at
			}))
		);
	});

	onMount(() => {
		try {
			me = getUserBlurtAccount();
		} catch (err) {
			console.warn('[chat-inbox] getUserBlurtAccount threw:', err);
			loadError = true;
			return;
		}
		if (!me) return;

		// Intentionally NOT calling ensureChatIdentityPublished() here — the
		// inbox is a read-only glance surface; publishing intent lives in
		// /chat/[peer] (opening a specific conversation). Unchanged by the
		// real-time refactor.
		void loadBlocks(me);
		void refresh(true);

		// Real-time inbox: re-poll on the fastchat cadence (≤6 s target).
		// Paused while the tab is hidden; an immediate poll on refocus so a
		// returning user sees a current list.
		const POLL_MS = 5_000;
		pollTimer = setInterval(() => {
			if (!document.hidden) void refresh(false);
		}, POLL_MS);
		onVisible = () => {
			if (!document.hidden) void refresh(false);
		};
		document.addEventListener('visibilitychange', onVisible);

		// SUB-SECOND path: the ambient global chat-activity SSE pings the
		// instant a new message lands for this account (from ANY peer —
		// existing conversation, stranger, or spammer); refresh immediately
		// so the list, dots, and ordering update in real time rather than on
		// the ≤5s backstop. Reuses the already-running ambient stream (no
		// extra connection); the debounce there coalesces bursts.
		unsubActivity = subscribeChatActivity(() => {
			if (!document.hidden) void refresh(false);
		});
	});

	onDestroy(() => {
		if (pollTimer !== null) clearInterval(pollTimer);
		if (onVisible !== null) document.removeEventListener('visibilitychange', onVisible);
		if (unsubActivity !== null) unsubActivity();
	});

	/** Navigation-time mark-read: we mark the conversation as
	 *  visited the moment the user commits to opening it, rather
	 *  than waiting for /chat/[peer] to load. That way if the
	 *  user navigates back before [peer] fully loads, the unread
	 *  badge is still correct. */
	function handleOpen(peer: string, orderPermlink: string): void {
		// cp446 — mark THIS discussion read, not everything from this person.
		markConversationRead(peer, orderPermlink);
	}

	/** Mark every discussion that still nags (Inbox + Starred) as read, so the
	 *  header pill and the favicon / avatar-menu badge all drop to zero at once
	 *  (t.txt item 10 — "once all messages are read … the green dots disappear").
	 *  Archived threads are already triaged and don't feed the badge. */
	function handleMarkAllRead(): void {
		const now = new Date();
		for (const c of sortedConversations) {
			if (c.folder !== 'archived' && c.unread) {
				markConversationRead(c.peer, c.order?.permlink ?? '', now);
			}
		}
	}

	/** Archive THIS discussion (per-discussion, not the whole person — the old
	 *  "Dismiss" hid every thread with a peer at once). It moves to the Archived
	 *  tab; its card's action box becomes "Restore". Also marks it read so the
	 *  badge decrements alongside the move. */
	function handleArchive(row: InboxRow): void {
		const order = row.order?.permlink ?? '';
		markConversationRead(row.peer, order, new Date());
		archiveThread(row.peer, order);
		showToast($_('chat.inbox.archive_toast') as string, 'info');
	}

	/** Restore an archived discussion back to the Inbox. */
	function handleRestore(row: InboxRow): void {
		restoreThread(row.peer, row.order?.permlink ?? '');
		showToast($_('chat.inbox.restore_toast') as string, 'info');
	}

	/** Toggle the gold star. Starring MOVES the card to ★ Starred (from wherever
	 *  it was); un-starring MOVES it to the Inbox. */
	function handleToggleStar(row: InboxRow): void {
		toggleStar(row.peer, row.order?.permlink ?? '');
	}

	// Last-message timestamps render via the unified <RelativeTime>
	// component (Part 89) — descriptive format for the chat inbox
	// since the timestamp is the primary recency indicator. NaN
	// safety, locale routing, and 60s ticking are all handled by
	// the component.

	// Part 121 cp7 — per-locale internal-link wrapper.  See
	// $i18n/path.localePath() + the analogous helper in
	// [lang]/+layout.svelte for design rationale.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<Head routeKey="chat_inbox" noindex />

<section class="mx-auto max-w-2xl px-4 py-8">
	<RequireLiveSession />
	<header class="mb-6">
		<div class="flex items-baseline justify-between gap-4">
			<h1 class="font-display text-3xl font-extrabold">
				<span class="brand-gradient-text">{$_('chat.inbox.heading')}</span>
			</h1>
			{#if unreadTotal > 0}
				<span
					class="rounded-full bg-morphit-emerald/10 px-3 py-1 text-sm font-semibold text-morphit-emerald dark:bg-morphit-emerald/20"
					aria-label={$_('chat.inbox.unread_aria', {
						values: { n: unreadTotal }
					}) as string}
				>
					{$_('chat.inbox.unread_count', { values: { n: unreadTotal } })}
				</span>
			{/if}
		</div>
		<p class="mt-2 text-ink-600 dark:text-ink-300">
			{$_('chat.inbox.subtitle')}
		</p>
	</header>

	{#if !me}
		<!-- Signed-out. Direct the user to onboarding. -->
		<div
			class="rounded-2xl border-2 border-dashed border-ink-300 p-8 text-center dark:border-ink-700"
		>
			<p class="mb-4 text-ink-600 dark:text-ink-300">
				{$_('chat.inbox.need_account')}
			</p>
			<a href={lp('/onboarding')} class="btn-primary btn-shine">
				{$_('chat.inbox.get_started')}
			</a>
		</div>
	{:else if conversations.length === 0 && fallbackPeers.length === 0}
		<!-- No conversations yet. Guide them to discovery surfaces. -->
		<div
			class="rounded-2xl border-2 border-dashed border-ink-300 p-8 text-center dark:border-ink-700"
		>
			<p class="mb-4 text-lg font-semibold">
				{$_('chat.inbox.empty_heading')}
			</p>
			<p class="mb-4 text-ink-600 dark:text-ink-300">
				{$_('chat.inbox.empty_body')}
			</p>
			<div class="flex flex-col gap-2 sm:flex-row sm:justify-center">
				<a href={lp('/orderbook')} class="btn-primary btn-shine">
					{$_('chat.inbox.empty_cta_orderbook')}
				</a>
			</div>
		</div>
	{:else}
		{#if loadError}
			<p class="mb-4 text-sm text-red-700 dark:text-red-300">
				{$_('chat.inbox.load_error_fallback')}
			</p>
		{/if}

		<!-- Tabs: Inbox (everything, until you star or archive it), ★ Starred
		     (gold-starred discussions), and Archived. All three always show —
		     an email inbox doesn't hide its folders. -->
		{#if !loadError && conversations.length > 0}
			<div
				role="tablist"
				aria-label={$_('chat.inbox.tabs_aria') as string}
				class="mb-3 flex gap-1 border-b border-ink-200 dark:border-ink-800"
			>
				<button
					type="button"
					role="tab"
					aria-selected={activeTab === 'inbox'}
					onclick={() => (activeTab = 'inbox')}
					class="flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-semibold transition-colors {activeTab ===
					'inbox'
						? 'border-morphit-emerald text-morphit-emerald'
						: 'border-transparent text-ink-600 hover:text-ink-900 dark:text-ink-400 dark:hover:text-ink-100'}"
				>
					{$_('chat.inbox.tab_inbox')}
					{#if inboxUnread > 0}
						<span
							class="rounded-full bg-morphit-emerald/15 px-2 py-0.5 text-xs font-bold text-morphit-emerald"
							aria-label={$_('chat.inbox.unread_aria', { values: { n: inboxUnread } }) as string}
						>
							{inboxUnread}
						</span>
					{/if}
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={activeTab === 'starred'}
					onclick={() => (activeTab = 'starred')}
					class="flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-semibold transition-colors {activeTab ===
					'starred'
						? 'border-morphit-emerald text-morphit-emerald'
						: 'border-transparent text-ink-600 hover:text-ink-900 dark:text-ink-400 dark:hover:text-ink-100'}"
				>
					<!-- Literal gold star in the tab label (Ken: "★ Starred"). -->
					<span class="text-amber-400" aria-hidden="true">★</span>
					{$_('chat.inbox.tab_starred')}
					{#if starredUnread > 0}
						<span
							class="rounded-full bg-morphit-emerald/15 px-2 py-0.5 text-xs font-bold text-morphit-emerald"
							aria-label={$_('chat.inbox.unread_aria', { values: { n: starredUnread } }) as string}
						>
							{starredUnread}
						</span>
					{/if}
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={activeTab === 'archived'}
					onclick={() => (activeTab = 'archived')}
					class="flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-semibold transition-colors {activeTab ===
					'archived'
						? 'border-morphit-emerald text-morphit-emerald'
						: 'border-transparent text-ink-600 hover:text-ink-900 dark:text-ink-400 dark:hover:text-ink-100'}"
				>
					{$_('chat.inbox.tab_archived')}
				</button>
			</div>
		{/if}

		{#if activeTabHasUnread && conversations.length > 0}
			<div class="mb-3 flex justify-end">
				<button
					type="button"
					class="text-sm font-medium text-ink-600 hover:text-morphit-emerald dark:text-ink-400 dark:hover:text-morphit-emerald"
					onclick={handleMarkAllRead}
				>
					{$_('chat.inbox.mark_all_read')}
				</button>
			</div>
		{/if}

		<ul class="space-y-2" aria-label={$_('chat.inbox.list_aria') as string}>
			{#if activeList.length > 0}
				<!-- cp446 (Ken) — an inbox of DISCUSSIONS, not people. The same peer
				     appears once per order they have talked to you about, plus once
				     more for any order-less thread, exactly like email. `peer` alone
				     is therefore not a unique key: two cards would collide and Svelte
				     would reuse one DOM node for both. -->
				{#each activeList as convo (threadKey(convo))}
					{@const labelProps = extractLabelPropsFromProfile(profileMap[convo.peer])}
					{@const starred = convo.folder === 'starred'}
					{@const archived = convo.folder === 'archived'}
					<!-- One card per DISCUSSION (peer + order), like an email inbox.
					     The whole card is one click target → the conversation; only the
					     star and the action box on the right are their own controls
					     (t.txt item 16). `relative` anchors the stretched hit-area and
					     the z-10 controls; `items-stretch` lets the action box run the
					     full card height. -->
					<li
						animate:flip={{ duration: cardFlipDuration() }}
						class="relative flex items-stretch overflow-hidden rounded-xl border bg-white transition hover:border-morphit-emerald hover:shadow-sm dark:bg-ink-950 dark:hover:border-morphit-emerald {convo.unread
							? 'border-morphit-emerald/60 dark:border-morphit-emerald/50'
							: 'border-ink-200 dark:border-ink-800'}"
					>
						<!-- Card content: the avatar is a SIBLING of the two-line text block
						     (name + RE:), so items-center vertically centres the 40px avatar
						     against BOTH lines instead of just the name (t.txt alignment pass).
						     The anchor's ::after stretches over the WHOLE card so a click
						     anywhere opens the chat; the timestamp shows through the transparent
						     overlay and the star sits above it (relative z-10) as its own
						     control. -->
						<div class="flex min-w-0 flex-1 items-center gap-3 p-3">
							<a
								href={threadHref(convo)}
								onclick={() => handleOpen(convo.peer, convo.order?.permlink ?? '')}
								class="flex min-w-0 flex-1 items-center gap-3 after:absolute after:inset-0 after:content-['']"
								aria-label={convo.unread
									? ($_('chat.inbox.conversation_aria_unread', {
										values: { peer: convo.peer }
									}) as string)
									: ($_('chat.inbox.conversation_aria_read', {
										values: { peer: convo.peer }
									}) as string)}
							>
								<!-- Avatar only (hideHandle) — same IdentityLabel component, so the
								     identity-label policy holds; 40px on every card so the shape never
								     varies (t.txt item 8). -->
								<IdentityLabel
									account={convo.peer}
									displayName={labelProps.displayName}
									avatarSvg={labelProps.avatarSvg}
									avatarDataUri={labelProps.avatarDataUri}
									avatarSize={40}
									hideHandle
									showCopy={false}
									class="flex-none"
								/>
								<div class="flex min-w-0 flex-1 flex-col gap-0.5">
									<!-- @name / display name (avatar-less IdentityLabel). -->
									<IdentityLabel
										account={convo.peer}
										displayName={labelProps.displayName}
										avatarSvg={labelProps.avatarSvg}
										avatarDataUri={labelProps.avatarDataUri}
										hideAvatar
										weight={convo.unread ? 'bold' : 'semibold'}
										showCopy={false}
									/>
									<!-- "RE:" line (t.txt item 12) — ALWAYS present. Bound to the order
									     ("RE: <title> (Live|Cancelled|Expired)") or "RE: -". Inside the
									     text block, so it lines up under the name with no manual indent. -->
									<div class="flex min-w-0 items-baseline gap-1 text-xs text-ink-500 dark:text-ink-400">
										<span class="flex-none font-medium">{$_('chat.inbox.re_prefix')}</span>
										{#if convo.order}
											{@const parts = orderTitleParts(
												convo.order,
												undefined,
												$_('order_title.goods_services')
											)}
											{@const orderTitle = $_(parts.key, { values: parts.values }) as string}
											<span class="min-w-0 truncate">{orderTitle}</span>
											{#if orderStatusLabel(convo.order.status)}
												<span class="flex-none">({orderStatusLabel(convo.order.status)})</span>
											{/if}
										{:else}
											<span class="min-w-0 truncate">-</span>
										{/if}
									</div>
								</div>
							</a>
							<!-- Timestamp — sibling of the anchor, vertically centred by the row's
							     items-center; shows through the transparent ::after. -->
							<span
								class="flex-none text-xs {convo.unread
									? 'font-semibold text-morphit-emerald'
									: 'text-ink-500 dark:text-ink-400'}"
							>
								<RelativeTime iso={convo.last_message_at} format="descriptive" />
							</span>
							<!-- Star (t.txt item 11) — empty by default; clicking fills it gold and
							     MOVES the discussion to Starred; clicking a gold star moves it back
							     to Inbox. z-10 so it sits above the card-wide link. -->
							<button
								type="button"
								onclick={() => handleToggleStar(convo)}
								aria-pressed={starred}
								aria-label={starred
									? ($_('chat.inbox.unstar_aria') as string)
									: ($_('chat.inbox.star_aria') as string)}
								class="relative z-10 flex-none rounded p-0.5 text-base leading-none transition-colors {starred
									? 'text-amber-400 hover:text-amber-500'
									: 'text-ink-300 hover:text-amber-400 dark:text-ink-600 dark:hover:text-amber-400'}"
							>
								{starred ? '★' : '☆'}
							</button>
						</div>
						<!-- Action box (t.txt item 7) — EVERY card has one, on the far
						     right, full height. "Archive" moves the discussion to the
						     Archived tab; on an already-archived card it reads "Restore"
						     and moves it back to the Inbox. z-10 to sit above the
						     card-wide link. -->
						{#if archived}
							<button
								type="button"
								onclick={() => handleRestore(convo)}
								class="relative z-10 flex-none border-l border-ink-200 px-3 text-xs font-semibold text-ink-500 transition-colors hover:bg-morphit-emerald/10 hover:text-morphit-emerald dark:border-ink-800 dark:text-ink-400 dark:hover:bg-morphit-emerald/20 dark:hover:text-morphit-emerald"
								aria-label={$_('chat.inbox.restore_aria', { values: { peer: convo.peer } }) as string}
							>
								{$_('chat.inbox.action_restore')}
							</button>
						{:else}
							<button
								type="button"
								onclick={() => handleArchive(convo)}
								class="relative z-10 flex-none border-l border-ink-200 px-3 text-xs font-semibold text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-900 dark:border-ink-800 dark:text-ink-400 dark:hover:bg-ink-800 dark:hover:text-ink-100"
								aria-label={$_('chat.inbox.archive_aria', { values: { peer: convo.peer } }) as string}
							>
								{$_('chat.inbox.action_archive')}
							</button>
						{/if}
					</li>
				{/each}
			{:else}
				<!-- Fallback path — indexer was unavailable, list is from localStorage.
				     We don't have timestamps for fallback peers, so no unread flag. -->
				{#each fallbackPeers as peer (peer)}
					{@const labelProps = extractLabelPropsFromProfile(profileMap[peer])}
					<li>
						<a
							href={lp(`/chat/${peer}`)}
							onclick={() => handleOpen(peer, '')}
							class="flex items-center gap-3 rounded-xl border border-ink-200 bg-white p-3 transition hover:border-morphit-emerald hover:shadow-sm dark:border-ink-800 dark:bg-ink-950 dark:hover:border-morphit-emerald"
						>
							<IdentityLabel
								account={peer}
								displayName={labelProps.displayName}
								avatarSvg={labelProps.avatarSvg}
								avatarDataUri={labelProps.avatarDataUri}
								weight="semibold"
								showCopy={false}
							/>
							<span
								class="nav-arrow nav-arrow-right ml-auto text-xs text-ink-500 dark:text-ink-400"
								aria-hidden="true">⇨</span
							>
						</a>
					</li>
				{/each}
			{/if}
		</ul>
	{/if}
</section>
