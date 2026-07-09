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
	import { hiddenAccounts, hideAccount } from '$lib/utils/hiddenAccounts';
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

	// ─── Unread derivation + tab partitioning ─────────────────────
	// The $readState store read inside the $derived body makes this
	// reactive: every time a conversation is marked read, the sort
	// below re-runs, unread flags update, and the badge decrements
	// automatically.

	/** Active inbox tab. 'messages' shows conversations the user
	 *  has engaged with (sent at least one message). 'requests'
	 *  shows inbound-only conversations — strangers who've reached
	 *  us via the Finding H layer-2 fee path (or any other legit
	 *  first-contact). Default to 'messages' since it's the
	 *  higher-frequency surface for an engaged user. */
	type InboxTab = 'messages' | 'requests';
	let activeTab = $state<InboxTab>('messages');

	/** Flag tracking whether we've applied the smart-default
	 *  (open on Requests when Messages is empty but Requests
	 *  has content). Only fires once so subsequent tab changes
	 *  from the user aren't overwritten by late-arriving data. */
	let smartDefaultApplied = $state(false);

	/** All conversations with unread flags, sorted. Filters out
	 *  peers the user has hidden (via orderbook "hide" or inbox
	 *  "dismiss") or blocked. Shared source for both tab lists. */
	const sortedConversations = $derived.by(() => {
		// Explicit store read to register reactivity on the derived.
		void $readState;
		const hidden = $hiddenAccounts;
		const blocked = $blockedAccounts;
		const visible = conversations.filter(
			(c) => !hidden.has(c.peer.toLowerCase()) && !blocked.has(c.peer.toLowerCase())
		);
		const withFlags = visible.map((c) => ({
			...c,
			unread: isUnread(c.peer, c.last_message_at)
		}));
		withFlags.sort((a, b) => {
			if (a.unread && !b.unread) return -1;
			if (!a.unread && b.unread) return 1;
			return b.last_message_at.localeCompare(a.last_message_at);
		});
		return withFlags;
	});

	/** Conversations where the user has replied at least once. */
	const messagesList = $derived(sortedConversations.filter((c) => c.has_user_sent));
	/** Inbound-only conversations — strangers awaiting reply. */
	const requestsList = $derived(sortedConversations.filter((c) => !c.has_user_sent));

	/** Total unread across both tabs. Used for the top badge so
	 *  the "there's something for you" signal doesn't depend on
	 *  which tab you're currently on. */
	const unreadTotal = $derived(sortedConversations.filter((c) => c.unread).length);
	/** Per-tab unread counts, driving the pill badges on each tab
	 *  button — the signal that nudges users toward the tab
	 *  containing new activity. */
	const messagesUnread = $derived(messagesList.filter((c) => c.unread).length);
	const requestsUnread = $derived(requestsList.filter((c) => c.unread).length);

	/** Which list to render based on the active tab. */
	const activeList = $derived(activeTab === 'messages' ? messagesList : requestsList);

	// Smart-default: if the first load reveals an empty Messages
	// tab but a non-empty Requests tab, switch to Requests so the
	// user lands on their actual inbox content. Fires once; user
	// clicks after this are respected without override.
	$effect(() => {
		if (smartDefaultApplied) return;
		// Wait until we actually have data loaded (conversations
		// populated or a confirmed empty-inbox from indexer).
		if (conversations.length === 0) return;
		smartDefaultApplied = true;
		if (messagesList.length === 0 && requestsList.length > 0) {
			activeTab = 'requests';
		}
	});

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
	function handleOpen(peer: string): void {
		markConversationRead(peer);
	}

	/** Mark every visible conversation as read at once. */
	function handleMarkAllRead(): void {
		const now = new Date();
		for (const c of activeList) {
			if (c.unread) markConversationRead(c.peer, now);
		}
	}

	/** Dismiss a request — client-side hide via the shared
	 *  hiddenAccounts primitive. The conversation disappears from
	 *  inbox AND orderbook until the user unhides from Settings.
	 *  Intentionally softer than a block: no on-chain op, no
	 *  signal to the other party, and fully reversible.
	 *
	 *  Also marks the conversation read so the top-level unread
	 *  count decrements alongside the list change. */
	function handleDismiss(peer: string): void {
		markConversationRead(peer, new Date());
		hideAccount(peer);
		// Closes the UX loop: the user knows the action landed
		// AND knows how to reverse it. Without this the row just
		// vanishes — mystifying the first time it happens.
		showToast($_('chat.inbox.dismiss_toast', { values: { peer } }) as string, 'info');
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

		<!-- Tabs: Messages (engaged conversations) and Requests
		     (strangers awaiting reply, typically admitted via
		     Finding H layer-2 stranger-fee). The requests tab is
		     hidden when there are no requests AND the user isn't
		     already on it — avoids teaching a UX element for a
		     case most users never encounter. -->
		{#if !loadError && conversations.length > 0 && (requestsList.length > 0 || activeTab === 'requests')}
			<div
				role="tablist"
				aria-label={$_('chat.inbox.tabs_aria') as string}
				class="mb-3 flex gap-1 border-b border-ink-200 dark:border-ink-800"
			>
				<button
					type="button"
					role="tab"
					aria-selected={activeTab === 'messages'}
					onclick={() => (activeTab = 'messages')}
					class="flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-semibold transition-colors {activeTab ===
					'messages'
						? 'border-morphit-emerald text-morphit-emerald'
						: 'border-transparent text-ink-600 hover:text-ink-900 dark:text-ink-400 dark:hover:text-ink-100'}"
				>
					{$_('chat.inbox.tab_messages')}
					{#if messagesUnread > 0}
						<span
							class="rounded-full bg-morphit-emerald/15 px-2 py-0.5 text-xs font-bold text-morphit-emerald"
							aria-label={$_('chat.inbox.unread_aria', {
								values: { n: messagesUnread }
							}) as string}
						>
							{messagesUnread}
						</span>
					{/if}
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={activeTab === 'requests'}
					onclick={() => (activeTab = 'requests')}
					class="flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-semibold transition-colors {activeTab ===
					'requests'
						? 'border-morphit-emerald text-morphit-emerald'
						: 'border-transparent text-ink-600 hover:text-ink-900 dark:text-ink-400 dark:hover:text-ink-100'}"
				>
					{$_('chat.inbox.tab_requests')}
					{#if requestsUnread > 0}
						<span
							class="rounded-full bg-morphit-emerald/15 px-2 py-0.5 text-xs font-bold text-morphit-emerald"
							aria-label={$_('chat.inbox.unread_aria', {
								values: { n: requestsUnread }
							}) as string}
						>
							{requestsUnread}
						</span>
					{/if}
				</button>
			</div>
		{/if}

		{#if activeTab === 'requests' && requestsList.length === 0}
			<!-- Requests tab specifically empty. Different from the
			     whole-inbox empty state — we tell the user what this
			     tab is for so they know when it'll light up. -->
			<div
				class="rounded-2xl border-2 border-dashed border-ink-300 p-8 text-center dark:border-ink-700"
			>
				<p class="mb-2 font-semibold">
					{$_('chat.inbox.requests_empty_heading')}
				</p>
				<p class="text-sm text-ink-600 dark:text-ink-300">
					{$_('chat.inbox.requests_empty_body')}
				</p>
			</div>
		{:else if unreadTotal > 0 && conversations.length > 0}
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
				{#each activeList as convo (convo.peer)}
					{@const labelProps = extractLabelPropsFromProfile(profileMap[convo.peer])}
					<!-- tt.txt #6 — `relative` so the chat anchor below can stretch its
					     hit area over the WHOLE card (::after inset-0). Clicking
					     anywhere on the card opens the conversation; only the "RE:"
					     text itself goes to the order. -->
					<li
						class="relative flex items-stretch gap-0 overflow-hidden rounded-xl border bg-white transition hover:border-morphit-emerald hover:shadow-sm dark:bg-ink-950 dark:hover:border-morphit-emerald {convo.unread
							? 'border-morphit-emerald/60 dark:border-morphit-emerald/50'
							: 'border-ink-200 dark:border-ink-800'}"
					>
						<!-- Chat link + optional "RE: <order>" subline share a
						     column so the order line can be its OWN anchor (to the
						     order detail page) as a SIBLING of the chat anchor — a
						     nested <a> would be invalid HTML. The p-3 moves to the
						     column so both rows sit inside the same padding. -->
						<div class="flex min-w-0 flex-1 flex-col gap-0.5 p-3">
							<a
								href={lp(`/chat/${convo.peer}`)}
								onclick={() => handleOpen(convo.peer)}
								class="flex items-center gap-3 after:absolute after:inset-0 after:content-['']"
								aria-label={convo.unread
									? ($_('chat.inbox.conversation_aria_unread', {
											values: { peer: convo.peer }
										}) as string)
									: ($_('chat.inbox.conversation_aria_read', {
											values: { peer: convo.peer }
										}) as string)}
							>
								<!-- Unread indicator dot. aria-hidden because the
								     unread status is already conveyed via the
								     aria-label on the anchor. The hidden sibling
								     span when read preserves alignment between
								     read/unread rows so identity labels align in
								     a column. -->
								{#if convo.unread}
									<span class="h-2 w-2 flex-none rounded-full bg-morphit-emerald" aria-hidden="true"
									></span>
								{:else}
									<span class="h-2 w-2 flex-none" aria-hidden="true"></span>
								{/if}
								<!-- tt.txt #9 — 28px read as a smudge next to a 14px name. 36px
								     matches the order cards and lets the identicon actually be
								     recognised at a glance. -->
								<IdentityLabel
									account={convo.peer}
									displayName={labelProps.displayName}
									avatarSvg={labelProps.avatarSvg}
									avatarDataUri={labelProps.avatarDataUri}
									avatarSize={36}
									weight={convo.unread ? 'bold' : 'semibold'}
									showCopy={false}
								/>
								<span
									class="ml-auto text-xs {convo.unread
										? 'font-semibold text-morphit-emerald'
										: 'text-ink-500 dark:text-ink-400'}"
								>
									<RelativeTime iso={convo.last_message_at} format="descriptive" />
								</span>
							</a>
							<!-- "RE: <order title>" — shown when this conversation is
							     about a specific order. Its own link to the order
							     detail page, indented to align under the username
							     (dot 8 + gap-3 12 + avatar 36 + IdentityLabel
							     gap-1.5 6 = 62px). The title uses the same shared
							     orderTitleParts helper (and 10-locale wording) as
							     the orderbook / order-detail / chat-thread. -->
							{#if convo.order}
								{@const parts = orderTitleParts(convo.order, undefined, $_('order_title.goods_services'))}
								{@const orderTitle = $_(parts.key, { values: parts.values }) as string}
								<!-- tt.txt #6 — was `flex`, i.e. a BLOCK-level box: its hit area
								     silently spanned the whole card width, so Ken kept landing on
								     the order page when he meant to open the chat. `inline-flex` +
								     `self-start` shrink it to its own text. `relative z-10` keeps
								     it above the stretched chat link. `max-w-full` preserves the
								     truncation of long titles. -->
								<a
									href={lp(`/@${convo.order.account}/${convo.order.permlink}`)}
									class="relative z-10 inline-flex max-w-full items-baseline gap-1 self-start pl-[62px] text-xs text-ink-500 transition-colors hover:text-morphit-emerald dark:text-ink-400 dark:hover:text-morphit-emerald"
									title={`${$_('chat.inbox.re_prefix')} ${orderTitle}`}
								>
									<span class="flex-none font-medium">{$_('chat.inbox.re_prefix')}</span>
									<span class="min-w-0 truncate">{orderTitle}</span>
								</a>
							{/if}
						</div>
						{#if activeTab === 'requests'}
							<!-- Dismiss button. Client-side hide via the
							     shared hiddenAccounts primitive — the peer
							     disappears from inbox (and orderbook) until
							     the user unhides from Settings. This is
							     intentionally softer than a block: the peer
							     isn't told anything, and unhiding is a
							     one-click revert. -->
							<!-- `relative z-10`: the chat anchor stretches its hit area over the
							     whole card, so any control that must remain clickable has to
							     sit above it. Without this, Dismiss would silently open the
							     conversation instead. -->
							<button
								type="button"
								onclick={() => handleDismiss(convo.peer)}
								class="relative z-10 flex-none border-l border-ink-200 px-3 text-xs font-semibold text-ink-500 transition-colors hover:bg-ink-100 hover:text-red-600 dark:border-ink-800 dark:text-ink-400 dark:hover:bg-ink-800 dark:hover:text-red-400"
								aria-label={$_('chat.inbox.dismiss_aria', {
									values: { peer: convo.peer }
								}) as string}
							>
								{$_('common.dismiss')}
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
							onclick={() => handleOpen(peer)}
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
