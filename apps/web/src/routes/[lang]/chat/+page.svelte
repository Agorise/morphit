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
	import { tick } from 'svelte';
	import { flip } from 'svelte/animate';
	import { slide } from 'svelte/transition';
	import { _ } from 'svelte-i18n';

	import Head from '$components/Head.svelte';
	import IdentityLabel from '$components/IdentityLabel.svelte';
	import { formatDayMonthTime } from '$i18n/formatters';
	import { orderTitleParts } from '$lib/utils/orderTitle';
	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import { loadRecentPeers } from '$lib/chat/recentPeers';
	import {
		readState,
		markConversationRead,
		mergeRemoteReadState,
		readAckTimestamp
	} from '$lib/chat/readState';
	import { threadIsUnread, fastPendingTick } from '$lib/notifications/chatUnread';
	import { getConversations, getChatReadState, getFeedbackGiven } from '$lib/indexer/client';
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
	import { isUnlocked, isPairedReadOnly } from '$stores/identity';
	import { tradeStates } from '$lib/trades/tradeStatus';
	import { blockedAccounts, loadBlocks } from '$lib/chat/blocks';
	import { subscribeChatActivity } from '$lib/chat/globalChatActivityStream';
	import { showToast } from '$lib/stores/toast';
	import RequireLiveSession from '$components/RequireLiveSession.svelte';
	import type { ConversationSummary, ProfileResponse, FeedbackRecord } from '@morphit/indexer-client';

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
	/** True for the single update in which the user switched tabs.
	 *
	 *  t.txt #4 asks for a slide when a card "appears or disappears ... from
	 *  Inbox, Starred, or Archived" — i.e. when the user FILES something and the
	 *  card leaves the list it is in. Switching tabs replaces the entire list, so
	 *  a naive `transition:slide` also fires there: twenty cards collapsing while
	 *  twenty more expand into the same <ul>, all at once. That is not what he
	 *  asked for, it is not information — it is noise, and on a phone it is noise
	 *  that costs a frame budget.
	 *
	 *  Set immediately, cleared after the DOM settles. The ordering is what makes
	 *  it work: Svelte reads a transition's parameters when the transition STARTS,
	 *  which is inside the same update, so the flag is still true then and zero
	 *  wins; `tick()` resolves afterwards, so the next real filing animates
	 *  normally. */
	let switchingTab = $state(false);
	/** False until the inbox has been populated once.
	 *
	 *  The list arrives from a fetch, not from the server-rendered page, so every
	 *  card is CREATED after mount — and a Svelte intro transition plays on
	 *  creation. Without this, Ken's first visit to /chat shows twenty cards
	 *  sliding in at once, every single load. That is a page-load flash, not the
	 *  thing he asked for: t.txt #4 wants the eye to follow a card when it is
	 *  FILED, and an animation that fires on arrival trains the eye to ignore the
	 *  one that matters.
	 *
	 *  Same shape as `switchingTab`, and it works for the same reason: Svelte
	 *  reads a transition's parameters when the transition STARTS, inside the
	 *  update that created the element, so the flag is still false then. */
	let listReady = $state(false);
	function setTab(t: InboxTab): void {
		if (t === activeTab) return;
		switchingTab = true;
		activeTab = t;
		void tick().then(() => {
			switchingTab = false;
		});
	}

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
		// v1.7.7 — read the tick so this block re-runs when a push lands. Without
		// it, `threadIsUnread` would be consulted only when `conversations`
		// changed — i.e. on the ~60s durable poll — which is the very lag the fast
		// path exists to avoid.
		void $fastPendingTick;
		const withFlags = visible.map((c) => ({
			...c,
			// v1.7.5 (t.txt #2) — identical rule to the badge channel's, so the cards
			// and the count stay in lockstep (the cp452 property).
			//
			// v1.7.7 — and now literally the same FUNCTION, not the same rule
			// re-typed. This called `isUnread` against the durable
			// `last_message_at`, which is stale for ~60s after a push (the fast
			// path never writes chat_messages), so Ken's message landed, the
			// thread resurrected into his Inbox, and the card still showed it
			// READ — no green border. `threadIsUnread` folds in the pending push.
			unread: threadIsUnread(
				c.peer,
				c.order?.permlink ?? '',
				c.last_message_at,
				c.last_message_is_mine === true
			),
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
			case 'completed':
				// t155: "it says (Live) on the title of that completed order, it
				// should say (Paid)". This case was simply missing, so a settled
				// trade's card fell through to '' and kept whatever the title
				// said — reading "(Live)" long after the trade was done.
				//
				// Deliberately `my_orders.filter.paid` ("Paid") rather than
				// order_detail.status_completed ("Completed & paid"): this is a
				// terse parenthetical beside the order title, and it should match
				// the word on the my/orders Paid pill the user just came from.
				return $_('my_orders.filter.paid') as string;
			default:
				return '';
		}
	}

	/** Hover tooltip for a card's last-message time (t.txt #10). The visible
	 *  "2h ago" is gone from the card body — it was eating ~40px of a ~360px
	 *  phone card, squeezing the name/subject/feedback — so the timing now lives
	 *  in the card's `title`: the project's canonical "14 July, 2026 @ 14:03:21
	 *  UTC" plus the same "· 2h ago" the card used to show. Mirrors
	 *  RelativeTime's descriptive ladder so the two never disagree. Computed at
	 *  render (Date.now()); a native title is hover-only and the absolute UTC
	 *  part is always exact, so a between-render "· 2h ago" drift is immaterial. */
	function whenTooltip(iso: string): string {
		const abs = formatDayMonthTime(iso);
		const then = new Date(iso).getTime();
		if (!Number.isFinite(then)) return abs;
		const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
		const t = $_ as (k: string, o?: { values: Record<string, unknown> }) => string;
		let rel: string;
		if (s < 60) rel = t('relative_time.descriptive.just_now');
		else if (s < 3600) rel = t('relative_time.descriptive.minutes', { values: { n: Math.floor(s / 60) } });
		else if (s < 86400) rel = t('relative_time.descriptive.hours', { values: { n: Math.floor(s / 3600) } });
		else if (s < 2592000) rel = t('relative_time.descriptive.days', { values: { n: Math.floor(s / 86400) } });
		else if (s < 31104000)
			rel = t('relative_time.descriptive.months', { values: { n: Math.floor(s / 2592000) } });
		else rel = t('relative_time.descriptive.years', { values: { n: Math.floor(s / 31104000) } });
		return `${abs} · ${rel}`;
	}


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
	/** Duration for a card sliding IN or OUT of the visible tab (t.txt #4).
	 *
	 *  [KEN]: "whenever a message appears or disappears (manually or dynamically/
	 *  automatically) from Inbox, Starred, or Archived, please use a smooth
	 *  slide-in or slide-out effect so the eye can see easier what is happening."
	 *
	 *  `animate:flip` above handles a card MOVING within a list. It cannot help
	 *  when a card leaves the list entirely — archiving one made it vanish between
	 *  frames, which is precisely the moment the eye most needs to follow it.
	 *
	 *  REDUCED MOTION IS NOT FREE HERE, despite appearances. app.css carries the
	 *  usual global `@media (prefers-reduced-motion: reduce)` rule forcing
	 *  `animation-duration: 0ms !important` — but **Svelte 5 transitions are not
	 *  CSS**: they run through `element.animate()` (WAAPI), which that rule cannot
	 *  touch, and Svelte does not check the preference itself. Trusting app.css
	 *  would ship a full-length animation to every user who asked for less motion,
	 *  with nothing failing and nothing visible in review. Hence the same explicit
	 *  check `cardFlipDuration` makes, for the same reason.
	 *
	 *  Evaluated per-transition, so it tracks the OS setting live — which matters:
	 *  someone toggling that preference mid-session is usually doing it BECAUSE
	 *  something moved.
	 *
	 *  250ms matches the orderbook filter panel, the app's only other slide. Long
	 *  enough for the eye to follow a card leaving, short enough that filing twenty
	 *  threads in a row never feels like waiting on an animation. */
	function cardSlideDuration(): number {
		if (typeof window === 'undefined') return 0;
		// A tab switch is navigation, not filing. See `switchingTab`.
		if (switchingTab) return 0;
		// The first paint is arrival, not filing. See `listReady`.
		if (!listReady) return 0;
		return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 250;
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
			const firstFill = !listReady;
			conversations = convoR.data.items;
			loadError = false;
			// Let the first paint land without motion, then arm the slide for real
			// filing. tick() resolves after the DOM update that created the cards,
			// so their intros have already read `listReady === false`.
			if (firstFill) void tick().then(() => (listReady = true));
			await fetchProfilesForNewPeers(conversations.map((c) => c.peer));
		} else if (initial) {
			await fallbackToRecentPeers();
		}
	}

	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let onVisible: (() => void) | null = null;
	let unsubActivity: (() => void) | null = null;

	/** v1.7.7 (t.txt #5) — how often to re-read the on-chain folder state.
	 *
	 *  15s is chosen against what it is FIXING, not against a round number: Ken
	 *  archived on his PC and his phone still showed the thread "even after a few
	 *  minutes". Anything under ~20s reads as "it just moved" to someone holding
	 *  both devices, which is the bar he set — "i would like for messages to
	 *  automatically move themselves dynamically".
	 *
	 *  It is not faster because folder moves are a HUMAN action, not a message
	 *  feed: nobody archives twice a second, and every poll that finds no change
	 *  is a request every federated instance's indexer serves for nothing.
	 *  Un-archive still feels instant regardless — it is re-derived locally on the
	 *  5s conversation poll and never waits on this at all. */
	const FOLDER_SYNC_MS = 15_000;

	// t.txt (v1.4.9 #5) — pull the on-chain chat folder organization once the
	// identity is unlocked (it's encrypted with the posting key, so it can only
	// be decrypted while unlocked). No-op when locked: the local mirror renders
	// meanwhile. Also performs the one-time migration (local stars → chain) the
	// first time an account with no on-chain state syncs.
	//
	// v1.7.7 (t.txt #5) — RE-SYNC, don't sync once.
	//
	// This effect fires when `$isUnlocked` flips true, i.e. once per page load.
	// So a device read the chain on mount and never again: Ken archived a thread
	// on his PC and his PHONE kept it in the Inbox until he manually refreshed.
	//
	// Ken also spotted the asymmetry that explains it — un-archiving DID move
	// across devices without a refresh. That was never syncing. Un-archive is
	// RE-DERIVED locally by resurrectArchivedOnNewActivity on every conversation
	// poll, from data each device already has. Archiving cannot be re-derived: it
	// is a decision, and it only exists on chain. Nothing was re-reading it.
	//
	// The interval is safe because syncChatFoldersFromChain compares the fetched
	// `enc` blob against the last one it adopted and returns before decrypting
	// when nothing changed — so the steady-state cost is one small GET, and the
	// posting key is only used when there is genuinely a new decision to adopt.
	// Adoption is already last-write-wins (cp474), so a device with a pending
	// local change is not stomped by an older chain state.
	$effect(() => {
		if (!$isUnlocked) return;
		void syncChatFoldersFromChain();
		const t = setInterval(() => void syncChatFoldersFromChain(), FOLDER_SYNC_MS);
		return () => clearInterval(t);
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

	// ─── v1.5.0 bidirectional feedback (inbox) ──────────────────
	//  Each settled-trade card gets a 3rd line: "Leave feedback" (a prompt
	//  that opens the thread, where the form lives) or "Feedback left: ★★★★★".
	//  Uses ONE /feedback-given fetch for the whole list (keyed by
	//  subject+order), same directional-safe check as the chat thread.
	let feedbackGivenMap = $state<Map<string, FeedbackRecord>>(new Map());
	let feedbackGivenChecked = $state(false);
	async function loadFeedbackGiven(): Promise<void> {
		if (!me) return;
		try {
			const r = await getFeedbackGiven(me, { limit: 100 });
			if (r.ok) {
				const m = new Map<string, FeedbackRecord>();
				for (const f of r.data.items) {
					m.set(`${f.subject}\u0000${f.order_permlink ?? ''}`, f);
				}
				feedbackGivenMap = m;
			}
		} catch {
			/* best-effort — no feedback prompt is a safe default */
		}
		feedbackGivenChecked = true;
	}
	/** Per-card feedback state: can the current user review this peer for this
	 *  order (settled trade, not yet reviewed, unlocked), and/or have they
	 *  already (→ show the rating). */
	function feedbackStateFor(convo: ConversationSummary): {
		canLeave: boolean;
		record: FeedbackRecord | null;
	} {
		const permlink = convo.order?.permlink;
		if (!permlink) return { canLeave: false, record: null };
		const record = feedbackGivenMap.get(`${convo.peer}\u0000${permlink}`) ?? null;
		const settled = ($tradeStates.get(permlink)?.phase ?? 'address_shared') !== 'address_shared';
		const canLeave =
			settled && record === null && feedbackGivenChecked && $isUnlocked && !$isPairedReadOnly;
		return { canLeave, record };
	}

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
		void loadFeedbackGiven();

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
	function handleOpen(peer: string, orderPermlink: string, lastMessageAt?: string): void {
		// cp446 — mark THIS discussion read, not everything from this person.
		//
		// v1.7.7 — CLAMP the cursor, don't stamp the local clock.
		//
		// `isUnread()` compares the cursor against `last_message_at`, which is a
		// BLOCK time. Writing `new Date()` here compared a user's wall clock to
		// the chain's — the same mistake that made Ken's archive bounce back out
		// of the Archived folder. On a slow clock the cursor lands BEHIND the
		// message just read, `lastMsg > cursor` stays true, and the thread you
		// literally just opened stays green.
		//
		// `readAckTimestamp` is max(latestSeen, now) — the same watermark idea,
		// and it already existed; these call sites just weren't using it. With no
		// message time (fallback-peer list) it degrades to `now`, which is the
		// best available answer and no worse than before.
		markConversationRead(
			peer,
			orderPermlink,
			readAckTimestamp(lastMessageAt !== undefined ? new Date(lastMessageAt) : null)
		);
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
		// v1.7.7 — hand over the thread's newest BLOCK time; see chatFolders.watermark().
		archiveThread(row.peer, order, row.last_message_at);
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
		// v1.7.7 — same watermark basis as archiveThread; see chatFolders.toggleStar().
		toggleStar(row.peer, row.order?.permlink ?? '', row.last_message_at);
	}

	// Last-message timing lives in each card's hover `title` (t.txt #10) via
	// whenTooltip() above — the canonical "14 July, 2026 @ 14:03:21 UTC · 2h
	// ago". The visible inline timestamp was removed to give the name/subject/
	// feedback lines the full card width on a phone.

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
					onclick={() => setTab('inbox')}
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
					onclick={() => setTab('starred')}
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
					onclick={() => setTab('archived')}
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
					{@const fb = feedbackStateFor(convo)}
					<!-- One card per DISCUSSION (peer + order), like an email inbox.
					     The whole card is one click target → the conversation; only the
					     star and the action box on the right are their own controls
					     (t.txt item 16). `relative` anchors the stretched hit-area and
					     the z-10 controls; `items-stretch` lets the action box run the
					     full card height. -->
					<li
						animate:flip={{ duration: cardFlipDuration() }}
						transition:slide={{ duration: cardSlideDuration() }}
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
						<!-- v1.7.5 (t.txt #3) — tighter on mobile, unchanged from `sm` up.
						     On a ~360px phone the card's fixed furniture (40px avatar,
						     timestamp, star, the full-height Archive box, padding, gaps) left
						     the text block ~100px, which is what squeezed the name into four
						     lines and dragged the avatar out of line with it. -->
						<div class="flex min-w-0 flex-1 items-center gap-2 p-2 sm:gap-3 sm:p-3">
							<a
								href={threadHref(convo)}
								onclick={() => handleOpen(convo.peer, convo.order?.permlink ?? '', convo.last_message_at)}
								title={whenTooltip(convo.last_message_at)}
								class="flex min-w-0 flex-1 items-center gap-2 after:absolute after:inset-0 after:content-[''] sm:gap-3"
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
									{#if fb.canLeave}
										<div class="flex items-baseline gap-1 text-xs font-semibold text-morphit-emerald">
											<span>{$_('chat.feedback.leave_prompt')}</span>
											<span aria-hidden="true">→</span>
										</div>
									{:else if fb.record !== null}
										<!-- v1.7.7 (t.txt #9) — "I rated @kentest2:" REMOVED, and that one
									     deletion fixes three things Ken flagged as separate bugs.
									     On a phone the label wrapped to a second line ("I rated" /
									     "@kentest3:"), which pushed the stars down onto their own
									     row and left the comment a sliver of width — so it truncated
									     at "You showed up …" with the card half empty. It also said
									     nothing: this row is inside a conversation with that exact
									     person, under their name and avatar. The stars ARE the
									     sentence.
									     `flex-wrap` goes with it: wrapping is what let the row grow
									     instead of the comment truncating honestly at the edge.
									     Stars are flex-none so the comment gets every remaining
									     pixel; `items-center` (not baseline) so the stars sit level
									     with the "37m ago" text to their right, as Ken asked. -->
									<div class="flex items-center gap-2 text-xs text-ink-500 dark:text-ink-400">
											<!-- t155: stars are EMERALD, not amber. Ken: "i love the
											     green stars that i see for a user review/feedback.
											     lets standardize on that." This row was the last
											     amber ★★★★★ outside the emerald convention. -->
											<span class="flex-none text-morphit-emerald" aria-hidden="true"
												>{'★'.repeat(fb.record.rating)}{'☆'.repeat(5 - fb.record.rating)}</span
											>
											<!-- The stars are decorative above; this carries the meaning
											     for a screen reader, which lost its sentence when the
											     visible label went. -->
											<span class="sr-only"
												>{$_('profile.given_rated', { values: { account: convo.peer } })}
												{fb.record.rating}/5</span
											>
											{#if fb.record.comment}
												<span class="min-w-0 truncate text-ink-500 dark:text-ink-400"
													>{fb.record.comment}</span
												>
											{/if}
										</div>
									{/if}
								</div>
							</a>
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
								class="relative z-10 flex-none border-l border-ink-200 px-2 text-xs font-semibold text-ink-500 transition-colors hover:bg-morphit-emerald/10 sm:px-3 hover:text-morphit-emerald dark:border-ink-800 dark:text-ink-400 dark:hover:bg-morphit-emerald/20 dark:hover:text-morphit-emerald"
								aria-label={$_('chat.inbox.restore_aria', { values: { peer: convo.peer } }) as string}
							>
								{$_('chat.inbox.action_restore')}
							</button>
						{:else}
							<button
								type="button"
								onclick={() => handleArchive(convo)}
								class="relative z-10 flex-none border-l border-ink-200 px-2 text-xs font-semibold text-ink-500 transition-colors hover:bg-ink-100 sm:px-3 hover:text-ink-900 dark:border-ink-800 dark:text-ink-400 dark:hover:bg-ink-800 dark:hover:text-ink-100"
								aria-label={$_('chat.inbox.archive_aria', { values: { peer: convo.peer } }) as string}
							>
								{$_('chat.inbox.action_archive')}
							</button>
						{/if}
						<!-- Star badge (t.txt #10) — the discussion's star lives here now: a round
						     badge tucked into the top-right corner, merged with the card, instead
						     of a column in the row, so the name/subject/feedback get the full card
						     width. Gold when starred, faint outline when not; clicking toggles
						     Starred. Positioned inside the corner (not spilling out) because the
						     <li> is overflow-hidden for the slide-collapse. z-20 sits above the
						     card link and the Archive box (z-10). -->
						<button
							type="button"
							onclick={() => handleToggleStar(convo)}
							aria-pressed={starred}
							aria-label={starred
								? ($_('chat.inbox.unstar_aria') as string)
								: ($_('chat.inbox.star_aria') as string)}
							class="absolute right-1 top-1 z-20 flex h-6 w-6 items-center justify-center rounded-full border bg-white text-base leading-none shadow-sm transition-colors {starred
								? 'border-amber-300 text-amber-400 hover:text-amber-500 dark:border-amber-400/50 dark:bg-ink-900'
								: 'border-ink-200 text-ink-300 hover:text-amber-400 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-400 dark:hover:text-amber-400'}"
						>
							{starred ? '★' : '☆'}
						</button>
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
