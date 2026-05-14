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

	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';

	import Head from '$components/Head.svelte';
	import IdentityLabel from '$components/IdentityLabel.svelte';
	import RelativeTime from '$components/RelativeTime.svelte';
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
	import { extractLabelPropsFromProfile } from '$lib/indexer/profileProps';
	import { hiddenAccounts, hideAccount } from '$lib/utils/hiddenAccounts';
	import { blockedAccounts, loadBlocks } from '$lib/chat/blocks';
	import { showToast } from '$lib/stores/toast';
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

	onMount(async () => {
		// Wrap bootstrap in try/catch so a corrupt-localStorage
		// throw doesn't leave the inbox in an unrecoverable state.
		// (Part 73: previously this assumed getUserBlurtAccount()
		// only returns null/string; in practice a JSON parse on
		// corrupt data could throw.)
		try {
			me = getUserBlurtAccount();
		} catch (err) {
			console.warn('[chat-inbox] getUserBlurtAccount threw:', err);
			loadError = true;
			return;
		}
		if (!me) return;

		// Intentionally NOT calling ensureChatIdentityPublished() here.
		// The inbox is a read-only surface — if the user opens it just
		// to glance at what conversations exist, they haven't
		// declared intent to engage. Publishing a chat identity on
		// inbox-open would mean any user who ever visits /chat
		// becomes chat-reachable, even if they never actually use
		// the feature. That's backwards from the "don't force crypto
		// on non-users" principle.
		//
		// The publish trigger instead lives in /chat/[peer] — opening
		// a specific conversation IS the signal of intent to engage
		// (either to initiate, or to read history and potentially
		// reply).

		// Fetch conversations + server read-state in parallel. The
		// two are independent — the read-state response just refines
		// the unread flags derived from conversations. If the
		// read-state endpoint fails (older indexer, network hiccup),
		// we silently fall through to Phase A local-only behavior;
		// the inbox is still usable.
		//
		// loadBlocks runs in parallel too — fire-and-forget. The
		// $blockedAccounts derivation picks it up reactively once
		// the store settles, and the inbox's filter re-runs. Until
		// it resolves, blocked peers show briefly in the list;
		// acceptable tradeoff vs blocking first paint on the blocks
		// round-trip.
		//
		// Outer try/catch (Part 73): a thrown error from
		// getConversations / getChatReadState (e.g. CORS preflight
		// fail, DNS error) would otherwise propagate as an
		// unhandled rejection in onMount.  Catching here lets us
		// fall through to the same recent-peers fallback path the
		// "ok: false" branch uses below.
		let convoR: Awaited<ReturnType<typeof getConversations>>;
		let readR: Awaited<ReturnType<typeof getChatReadState>>;
		try {
			[convoR, readR] = await Promise.all([getConversations(me), getChatReadState(me)]);
		} catch (err) {
			console.warn('[chat-inbox] indexer fetch threw:', err);
			loadError = true;
			const local = loadRecentPeers().filter((p) => p !== me);
			fallbackPeers = local;
			if (local.length > 0) {
				const fetched = await getProfilesBatch(local).catch(() => new Map());
				const next: Record<string, ProfileResponse | null> = {};
				for (const [a, p] of fetched) next[a] = p;
				profileMap = next;
			}
			return;
		}
		void loadBlocks(me);

		if (readR.ok) {
			mergeRemoteReadState(readR.data.items);
		}

		if (convoR.ok) {
			conversations = convoR.data.items;
			const peers = conversations.map((c) => c.peer);
			if (peers.length > 0) {
				const fetched = await getProfilesBatch(peers).catch(() => new Map());
				const next: Record<string, ProfileResponse | null> = {};
				for (const [a, p] of fetched) next[a] = p;
				profileMap = next;
			}
		} else {
			// Indexer unreachable or errored. Fall back to the local
			// recent-peers list so the user still sees something.
			loadError = true;
			const local = loadRecentPeers().filter((p) => p !== me);
			fallbackPeers = local;
			if (local.length > 0) {
				const fetched = await getProfilesBatch(local).catch(() => new Map());
				const next: Record<string, ProfileResponse | null> = {};
				for (const [a, p] of fetched) next[a] = p;
				profileMap = next;
			}
		}
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
			<p class="mb-4 text-sm text-amber-700 dark:text-amber-300">
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
					<li
						class="flex items-stretch gap-0 overflow-hidden rounded-xl border bg-white transition hover:border-morphit-emerald hover:shadow-sm dark:bg-ink-950 dark:hover:border-morphit-emerald {convo.unread
							? 'border-morphit-emerald/60 dark:border-morphit-emerald/50'
							: 'border-ink-200 dark:border-ink-800'}"
					>
						<a
							href={`/chat/${convo.peer}`}
							onclick={() => handleOpen(convo.peer)}
							class="flex flex-1 items-center gap-3 p-3"
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
							<IdentityLabel
								account={convo.peer}
								displayName={labelProps.displayName}
								avatarSvg={labelProps.avatarSvg}
								avatarDataUri={labelProps.avatarDataUri}
								nostrUrl={labelProps.nostrUrl}
								blurtMediaUrl={labelProps.blurtMediaUrl}
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
						{#if activeTab === 'requests'}
							<!-- Dismiss button. Client-side hide via the
							     shared hiddenAccounts primitive — the peer
							     disappears from inbox (and orderbook) until
							     the user unhides from Settings. This is
							     intentionally softer than a block: the peer
							     isn't told anything, and unhiding is a
							     one-click revert. -->
							<button
								type="button"
								onclick={() => handleDismiss(convo.peer)}
								class="flex-none border-l border-ink-200 px-3 text-xs font-semibold text-ink-500 transition-colors hover:bg-ink-100 hover:text-red-600 dark:border-ink-800 dark:text-ink-400 dark:hover:bg-ink-800 dark:hover:text-red-400"
								aria-label={$_('chat.inbox.dismiss_aria', {
									values: { peer: convo.peer }
								}) as string}
							>
								{$_('chat.inbox.dismiss')}
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
							href={`/chat/${peer}`}
							onclick={() => handleOpen(peer)}
							class="flex items-center gap-3 rounded-xl border border-ink-200 bg-white p-3 transition hover:border-morphit-emerald hover:shadow-sm dark:border-ink-800 dark:bg-ink-950 dark:hover:border-morphit-emerald"
						>
							<IdentityLabel
								account={peer}
								displayName={labelProps.displayName}
								avatarSvg={labelProps.avatarSvg}
								avatarDataUri={labelProps.avatarDataUri}
								nostrUrl={labelProps.nostrUrl}
								blurtMediaUrl={labelProps.blurtMediaUrl}
								weight="semibold"
								showCopy={false}
							/>
							<span class="ml-auto text-xs text-ink-500 dark:text-ink-400" aria-hidden="true"
								>→</span
							>
						</a>
					</li>
				{/each}
			{/if}
		</ul>
	{/if}
</section>
