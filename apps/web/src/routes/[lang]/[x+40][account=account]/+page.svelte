<script lang="ts">
	import { capDisplayName } from '$lib/crypto/profile';
	import LazyLoadError from '$components/LazyLoadError.svelte';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	/**
	 * Profile page — /@{account}
	 *
	 * Renders a user's public identity + reputation:
	 *   - hero avatar (96px identicon) + display name + @account
	 *   - Nostr / Blurt.media glyphs if the user set them in their
	 *     profile json_metadata
	 *   - weighted rating summary (avg + count)
	 *   - 1-5 rating histogram
	 *   - paginated feedback list with reviewer identicons, ratings,
	 *     comments, and linked order references
	 *   - subject responses to reviews, when present
	 *
	 * Anonymous browsing is intentional — reputation is public, and
	 * someone considering trading with @alice needs to see her
	 * ratings without having to sign in first.
	 *
	 * Data is fetched client-side in parallel:
	 *   - getProfile(account)    -> display_name, json_metadata
	 *   - getFeedback(account)   -> summary + first page
	 * Subsequent pages via cursor append to the list on scroll or
	 * a "Load more" button.
	 */

	import { untrack } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { page } from '$app/stores';

	import Head from '$components/Head.svelte';
	import MessageIcon from '$components/MessageIcon.svelte';
	import RssFeedPicker from '$components/RssFeedPicker.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import BusyButton from '$components/BusyButton.svelte';
	import IdentityLabel from '$components/IdentityLabel.svelte';
	import RatingChip from '$components/RatingChip.svelte';
	import AltNetworkIcon from '$components/AltNetworkIcon.svelte';
	import { validateNostrUrlForRender } from '$utils/nostrUrl';
	import { validateWebUrlForRender } from '$utils/webUrl';
	// cp165 byte-budget: MyBalanceCard renders only on a viewer's
	// OWN profile (rare path — most profile-page traffic is people
	// looking at counterparties).  RespondToFeedbackForm renders
	// only when actively replying to a piece of feedback (rare
	// action).  Lazy-import both.
	// import RespondToFeedbackForm from '$components/RespondToFeedbackForm.svelte';
	// import MyBalanceCard from '$components/MyBalanceCard.svelte';
	import { get } from 'svelte/store';
	import RelativeTime from '$components/RelativeTime.svelte';
	import { pendingFeedbackReplies, addPendingReply, mergePendingReplies } from '$lib/stores/pendingFeedbackReplies';
	import WriteBlockedReadOnly from '$components/WriteBlockedReadOnly.svelte';
	import { identiconDataUri } from '$crypto/identicon';
	import {
		getProfile,
		getFeedback,
		getFeedbackGiven,
		getOrdersByAccount,
		getReputationReceipt
	} from '$lib/indexer/client';
	import { getProfilesBatch } from '$lib/indexer/profileCache';
	import { extractLabelPropsFromProfile } from '$lib/indexer/profileProps';
	import { displayNamesForMethods } from '$lib/payments/display';
	import OrderCard from '$lib/components/OrderCard.svelte';
	import { formatOrderPriceModel } from '$lib/orders/priceModelDisplay';
	import { isOrderLive } from '$lib/orders/orderExpiry';
	import { isUsdtNetwork, isUsdcNetwork, isDaiNetwork } from '$lib/assets/networks';
	import { recordOrderView } from '$lib/orders/views';
	import { orderTitleParts } from '$lib/utils/orderTitle';
	import { instanceAdditions, instanceNameLookup } from '$lib/stores/instanceAdditions';
	import { isUnlocked, isPairedReadOnly } from '$stores/identity';
	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import type {
		ProfileResponse,
		AccountFeedbackResponse,
		FeedbackRecord,
		OrderRecord
	} from '@morphit/indexer-client';

	// account is a route parameter; always defined when this page
	// renders.  The non-null assertion is safe because SvelteKit
	// would not have routed here without it.
	const account = $derived($page.params.account!);
	/** The signed-in viewer's account, but ONLY when there's an active
	 *  session. The `morphit.blurtAccount` cache (getUserBlurtAccount)
	 *  persists across a hard browser reload — it's cleared only on an
	 *  explicit sign-out — so reading it unconditionally made a locked /
	 *  logged-out visitor still match isOwnProfile and see the PRIVATE
	 *  balance card ("Only you see this") after a refresh. Gating on the
	 *  live session keeps the page consistent with the nav: no session ⇒
	 *  public view. (cp323) */
	const viewerAccount = $derived.by((): string | null => {
		if (!$isUnlocked && !$isPairedReadOnly) return null;
		return getUserBlurtAccount();
	});
	/** True when the signed-in user is viewing their own profile.
	 *  Enables subject-only affordances (reply to reviews) AND the
	 *  private balance card. The indexer re-checks authorization on
	 *  broadcast — this derivation only controls UI visibility. */
	const isOwnProfile = $derived(viewerAccount !== null && viewerAccount === account);

	// ─── State ─────────────────────────────────────────────────────
	type LoadState = 'loading' | 'ready' | 'error';
	let feedbackState = $state<LoadState>('loading');
	/** Batch L: payment-method display lookup with instance
	 *  additions (subscription side-effect populates the cache). */
	const instLookup = $derived.by(() => {
		// Read $instanceAdditions to register a reactive
		// dependency — the lookup helper is a stable function,
		// but it reads the store-backed cache, so we want this
		// derived to re-evaluate when additions change.
		void $instanceAdditions;
		return instanceNameLookup;
	});
	let ordersState = $state<LoadState>('loading');
	let profile = $state<ProfileResponse | null>(null);
	let feedback = $state<AccountFeedbackResponse | null>(null);
	/** The composite reputation score (cp404 Bayesian-shrunk, experience- and
	 *  recency-adjusted) — the SAME number every order card and chat header
	 *  shows. Distinct from `feedback.summary.weighted_rating`, which is the raw
	 *  time-decayed mean. Ken hit the mismatch: the profile trumpeted the raw
	 *  4.75 while the trade-decision surfaces showed the composite 3.97 for the
	 *  same trader. The headline now shows THIS, so the number a viewer sees on
	 *  the profile matches the one they saw before clicking through. */
	let reputationScore = $state<number | null>(null);
	/** The number shown large at the top of the reputation card. Prefers the
	 *  composite score (what order cards and chat show) and falls back to the raw
	 *  weighted average when no score is available — so the card never renders
	 *  blank on an account with ratings but no computable score. */
	const headlineRating = $derived(
		reputationScore ?? (feedback === null ? 0 : feedback.summary.weighted_rating)
	);
	let feedbackItems = $state<FeedbackRecord[]>([]);
	let feedbackNextCursor: string | null = $state(null);
	let feedbackError = $state('');

	// cp165 lazy-loaders for /[account] conditional components
	const loadMyBalanceCard = () => import('$components/MyBalanceCard.svelte').then((m) => m.default);
	const loadRespondToFeedbackForm = () =>
		import('$components/RespondToFeedbackForm.svelte').then((m) => m.default);
	let loadingMore = $state(false);
	/** Raw orders from the indexer — all statuses. We filter to
	 *  live + sort by expires_at ASC client-side (see liveOrders
	 *  derived below). The indexer's own sort is updated_at DESC
	 *  which is wrong for "about to expire first." Client-side
	 *  sort is fine: a user with more than 100 live orders at
	 *  once is out of scope for Phase 5. */
	let allOrders = $state<OrderRecord[]>([]);
	let ordersError = $state('');

	// ─── Feedback-given state ──────────────────────────────────────
	// Feedback this account has LEFT for other accounts. Separate
	// pagination + error state from the "received" feedback above
	// so each list loads and paginates independently.
	let feedbackGivenState = $state<LoadState>('loading');
	let feedbackGivenItems = $state<FeedbackRecord[]>([]);
	let feedbackGivenNextCursor: string | null = $state(null);
	let feedbackGivenError = $state('');
	let loadingMoreGiven = $state(false);

	/** Feedback id of the currently-open reply form. Only one form
	 *  open at a time — a second Reply click auto-closes the first. */
	let replyingTo: number | null = $state(null);
	/** Set of feedback ids that just received a successful reply.
	 *  Used to show a "replied" confirmation line until the refetch
	 *  delivers the actual response record. */
	let recentlyRepliedIds = $state<Set<number>>(new Set());

	/** Profile data for accounts referenced in the feedback lists —
	 *  reviewers, subjects of feedback-given, and responders. Distinct
	 *  from the page's `profile` variable which holds the profile
	 *  SUBJECT (the @account this page is for).
	 *
	 *  Populated asynchronously after each feedback page loads;
	 *  IdentityLabel falls back to identicons for accounts not yet
	 *  in the map. A given account may appear in both feedback lists
	 *  and multiple response rows; the shared profile cache
	 *  deduplicates across all calls. */
	let reviewerProfileMap = $state<Record<string, ProfileResponse | null>>({});

	/** Collect every account referenced in a feedback list — reviewers
	 *  (for 'received') or subjects (for 'given'), plus all response
	 *  responders. Batched into the shared profile cache. */
	async function hydrateReviewerProfiles(
		items: readonly FeedbackRecord[],
		kind: 'received' | 'given'
	): Promise<void> {
		const accounts = new Set<string>();
		for (const fb of items) {
			// For received feedback, reviewer is what we want to show.
			// For given feedback, subject is what we want (since the
			// profile-page subject IS the reviewer and we already
			// have their profile).
			accounts.add(kind === 'received' ? fb.reviewer : fb.subject);
			for (const resp of fb.responses) {
				accounts.add(resp.responder);
			}
		}
		if (accounts.size === 0) return;
		const fetched = await getProfilesBatch(Array.from(accounts));
		const next = { ...reviewerProfileMap };
		for (const [a, p] of fetched) {
			next[a] = p;
		}
		reviewerProfileMap = next;
	}

	async function loadProfile(): Promise<void> {
		// Capture the account this call is FOR. If the user navigates away before
		// the fetch resolves, `account` will have changed and we must NOT write a
		// stale response into the new profile's view (the cross-account race).
		const forAccount = account;
		const r = await getProfile(forAccount);
		if (forAccount !== account) return;
		if (r.ok) {
			profile = r.data;
		} else {
			// A 404 from the indexer is an expected shape — it means
			// the user has never broadcast a morphit_profile_v1 op.
			// We don't treat that as an error; the account just has
			// no custom display name and we show `@account` instead.
			if (r.code === 'not_found') {
				profile = null;
			} else {
				console.warn('[profile] load failed:', r.message);
			}
		}
	}

	async function loadFeedbackPage(cursor?: string): Promise<void> {
		const forAccount = account;
		const r = await getFeedback(forAccount, { cursor });
		// Discard a response that arrived after the user navigated to a different
		// profile — otherwise the previous account's reviews land in this view.
		if (forAccount !== account) return;
		if (r.ok) {
			feedback = r.data;
			// v1.7.0 "fastrepliestofeedbacks" (ADR-0051) — slot in any reply this
			// browser just broadcast. The indexer can't see it for ~45-63s, so
			// without this the page said "Reply posted ✓" and then showed no reply:
			// the user's own words missing from their own profile for a minute, which
			// reads as "it didn't work". The indexer's copy wins the moment it lands —
			// the merge drops the echo once ANY durable response exists for that row.
			const merged = mergePendingReplies(r.data.items, get(pendingFeedbackReplies), Date.now());
			if (cursor) {
				feedbackItems = [...feedbackItems, ...merged];
			} else {
				feedbackItems = [...merged];
			}
			feedbackNextCursor = r.data.next_cursor;
			feedbackState = 'ready';
			// Hydrate profile data for reviewers + responders in this
			// page of results. Fire-and-forget; IdentityLabel falls
			// back to identicons until this resolves.
			// `merged`, not `r.data.items`: hydration walks each row's responses to
			// resolve responder avatars, and a staged reply's responder isn't in the
			// indexer's copy. Without this the user's own just-posted reply renders
			// with an identicon instead of their avatar until the durable row lands.
			void hydrateReviewerProfiles(merged, 'received');
		} else {
			console.warn('[profile] feedback load failed:', r.message);
			feedbackError = $_('profile.error.feedback_load_failed');
			feedbackState = 'error';
		}
	}

	async function loadMore(): Promise<void> {
		if (!feedbackNextCursor || loadingMore) return;
		loadingMore = true;
		try {
			await loadFeedbackPage(feedbackNextCursor);
		} finally {
			loadingMore = false;
		}
	}

	async function loadFeedbackGivenPage(cursor?: string): Promise<void> {
		const forAccount = account;
		const r = await getFeedbackGiven(forAccount, { cursor });
		if (forAccount !== account) return;
		if (r.ok) {
			if (cursor) {
				feedbackGivenItems = [...feedbackGivenItems, ...r.data.items];
			} else {
				feedbackGivenItems = [...r.data.items];
			}
			feedbackGivenNextCursor = r.data.next_cursor;
			feedbackGivenState = 'ready';
			void hydrateReviewerProfiles(r.data.items, 'given');
		} else {
			console.warn('[profile] feedback-given load failed:', r.message);
			feedbackGivenError = $_('profile.error.feedback_given_load_failed');
			feedbackGivenState = 'error';
		}
	}

	async function loadMoreGiven(): Promise<void> {
		if (!feedbackGivenNextCursor || loadingMoreGiven) return;
		loadingMoreGiven = true;
		try {
			await loadFeedbackGivenPage(feedbackGivenNextCursor);
		} finally {
			loadingMoreGiven = false;
		}
	}

	async function loadOrders(): Promise<void> {
		const forAccount = account;
		ordersState = 'loading';
		ordersError = '';
		// Max limit so we capture all live orders for almost every
		// realistic user. Power users with >100 live orders would
		// need pagination here; not implemented as it's not a
		// Phase 5 problem.
		const r = await getOrdersByAccount(forAccount, { limit: 100 });
		if (forAccount !== account) return;
		if (r.ok) {
			allOrders = [...r.data.items];
			ordersState = 'ready';
		} else {
			console.warn('[profile] orders load failed:', r.message);
			ordersError = $_('profile.error.orders_load_failed');
			ordersState = 'error';
		}
	}

	/** Fetch the composite reputation score from the same receipt endpoint the
	 *  order cards and chat header use, so the profile headline agrees with them.
	 *  Stale-guarded like the others. A missing score (no included feedback, or
	 *  an older indexer that doesn't compute it) leaves the headline to fall back
	 *  to the raw weighted average — never worse than before this change. */
	async function loadReputationScore(): Promise<void> {
		const forAccount = account;
		const r = await getReputationReceipt(forAccount);
		if (forAccount !== account) return;
		if (r.ok) {
			reputationScore = r.data.summary.reputation_score ?? null;
		} else {
			// Non-fatal: the hero falls back to the raw weighted average.
			console.warn('[profile] reputation receipt load failed:', r.message);
			reputationScore = null;
		}
	}

	// Reload whenever the account changes — NOT just onMount. SvelteKit reuses
	// this component instance when navigating /@a → /@b (same route, new param),
	// so onMount fires only for the first profile viewed. Without this effect,
	// every subsequent profile rendered the PREVIOUS user's data — reputation,
	// reviews and orders all stale — until a hard refresh forced a fresh mount.
	// Ken hit exactly this: /@kentest3 showed kentest2's 5-star card.
	//
	// Reading `account` registers the dependency. On each change we first RESET
	// every per-account slice back to its loading baseline (so the old user's
	// data can never flash on the new user's page, even for the moment before
	// the fetch resolves), then re-fire the four independent loads. The reset is
	// the load-bearing half: the reputation card derives from `feedback`, and a
	// stale `feedback` is precisely what rendered the wrong score.
	$effect(() => {
		const forAccount = account; // the ONE dependency: re-run only on account change
		if (!forAccount) return;

		// Everything below is untracked so the effect can never re-fire on an
		// incidental reactive read inside a load function (now or as this file
		// grows) — the account is the only thing that should retrigger a reload.
		untrack(() => {
			// Reset to first-load state. Keep this in sync with the $state
			// declarations above — anything account-scoped must be cleared here.
			profile = null;
			feedback = null;
			reputationScore = null;
			feedbackItems = [];
			feedbackNextCursor = null;
			feedbackError = '';
			feedbackState = 'loading';
			feedbackGivenItems = [];
			feedbackGivenNextCursor = null;
			feedbackGivenError = '';
			feedbackGivenState = 'loading';
			allOrders = [];
			ordersError = '';
			ordersState = 'loading';
			reviewerProfileMap = {};

			// Parallel fetch — profile, feedback (received + given) and orders are
			// all independent. Each updates its own loading state and self-guards
			// against a stale cross-account response (see the load fns above).
			void loadProfile();
			void loadFeedbackPage();
			void loadFeedbackGivenPage();
			void loadOrders();
			void loadReputationScore();
		});
	});

	// ─── Derived view state ────────────────────────────────────────

	/** Effective display name with sensible fallback to @account
	 *  when no profile has been set. */
	const effectiveDisplayName = $derived(
		profile?.display_name && profile.display_name.length > 0
			? capDisplayName(profile.display_name)
			: `@${account}`
	);

	/** Centralized profile-derived identity props.  This is the
	 *  single source of truth for displayName/avatarSvg/avatarDataUri/
	 *  nostrUrl/streamingUrl extraction.  Per Finding G2.2 the
	 *  helper re-sanitizes avatar_svg from indexer data, so the hero
	 *  on this page (which inlines avatarSvg via {@html}) is
	 *  defense-in-depth-protected against malicious indexer content
	 *  or non-Morphit-client profile ops. */
	const labelProps = $derived(extractLabelPropsFromProfile(profile));
	const nostrUrl = $derived(labelProps.nostrUrl);
	const streamingUrl = $derived(labelProps.streamingUrl);
	const websiteUrl = $derived(labelProps.websiteUrl);

	// cp377 — render-safe validation for the hero's avatar-corner glyphs.
	// Mirrors IdentityLabel's own render guard so an unsafe or malformed
	// URL can never reach an <a href> on this page either.
	const validatedNostrUrl = $derived(validateNostrUrlForRender(nostrUrl));
	const validatedStreamingUrl = $derived(validateWebUrlForRender(streamingUrl));
	const validatedWebsiteUrl = $derived(validateWebUrlForRender(websiteUrl));
	/** Optional short bio from the profile's json_metadata blob. */
	const shortBio = $derived.by(() => {
		const md = profile?.json_metadata;
		if (md && typeof md === 'object' && !Array.isArray(md)) {
			const v = (md as Record<string, unknown>).short_bio;
			if (typeof v === 'string' && v.trim().length > 0) return v.trim();
		}
		return null;
	});
	const avatarSvg = $derived(labelProps.avatarSvg);
	const avatarDataUri = $derived(labelProps.avatarDataUri);

	/** Hero avatar data URI, seeded from the account name bytes.
	 *  Same identicon IdentityLabel would render at smaller size —
	 *  visually consistent across the app. */
	const heroAvatar = $derived.by(() => {
		if (!account) return '';
		// Seed from UTF-8 bytes of the account name. Same seeding
		// strategy as IdentityLabel when it only has an account
		// (no pubkey).
		const seed = new TextEncoder().encode(account);
		return identiconDataUri(seed, 96);
	});

	/** Rating histogram: max count across 1-5 so bars scale relative
	 *  to the highest bucket (not the total). Gives a more readable
	 *  shape when one rating dominates. */
	const histMax = $derived.by(() => {
		const s = feedback?.summary;
		if (!s) return 0;
		return Math.max(
			s.by_rating['1'],
			s.by_rating['2'],
			s.by_rating['3'],
			s.by_rating['4'],
			s.by_rating['5']
		);
	});

	function barWidthPct(count: number): string {
		if (histMax === 0) return '0%';
		return `${(count / histMax) * 100}%`;
	}

	/** Live orders sorted with the soonest-to-expire first.
	 *
	 *  Sort rules:
	 *    - not-live orders are excluded — this uses isOrderLive() (status
	 *      'live' AND expires_at in the future), NOT a bare status === 'live'
	 *      check. The indexer keeps a stored status of 'live' until a cancel
	 *      op or a periodic sweep and enforces expiry at QUERY TIME, so an
	 *      order whose expires_at has passed still reads status 'live'. Using
	 *      the shared expiry helper (same as the orderbook, /my/orders, and
	 *      the order-detail page) keeps an EXPIRED order out of "Active
	 *      orders" instead of showing it with an "Expired" badge (cp429).
	 *    - expires_at ASC (earliest first)
	 *    - expires_at === null ranks after all dated expiries
	 *      (a non-expiring order is less time-pressured than
	 *      any expiring one)
	 *    - ties broken by created_at ASC (older first)
	 *
	 *  This surfaces orders that matter NOW to a browsing trader
	 *  — a counterparty checking Sally's profile sees the orders
	 *  she most needs help moving first.
	 */
	const liveOrders = $derived.by(() => {
		const nowMs = Date.now();
		const live = allOrders.filter((o) => isOrderLive(o, nowMs));
		return [...live].sort((a, b) => {
			const aExp = a.expires_at;
			const bExp = b.expires_at;
			if (aExp === null && bExp === null) {
				// Tiebreak: older created_at first.
				return a.created_at.localeCompare(b.created_at);
			}
			if (aExp === null) return 1; // nulls last
			if (bExp === null) return -1;
			const cmp = aExp.localeCompare(bExp);
			if (cmp !== 0) return cmp;
			return a.created_at.localeCompare(b.created_at);
		});
	});

	/** Number formatter for order trade-size bounds (fiat values). */
	function formatAmount(n: number | null): string {
		if (n === null) return '';
		return n % 1 === 0 ? String(n) : n.toFixed(2);
	}

	// ─── cp511 [B]: tabbed detail section ───────────────────────────
	// Groups the four profile detail views under the Reputation card so
	// the page reads as a compact card stack instead of a long scroll.
	// Tab order follows Ken's list: reviews received / reviews given /
	// active orders / trade history. Default = reviews-received (the
	// reputation drill-down that pairs with the summary card above).
	type ProfileTab = 'reviews' | 'given' | 'orders' | 'history';
	let activeTab = $state<ProfileTab>('reviews');
	// cp511 [B] (Ken): Trade history is OWNER-ONLY — it surfaces completed
	// orders, so the tab appears only when you're viewing your own profile.
	const tabDefs = $derived(
		[
			{ id: 'reviews' as const, label: $_('profile.tab_reviews_received') },
			{ id: 'given' as const, label: $_('profile.tab_reviews_given') },
			{ id: 'orders' as const, label: $_('profile.tab_active_orders') },
			{ id: 'history' as const, label: $_('profile.tab_trade_history') }
		].filter((t) => t.id !== 'history' || isOwnProfile)
	);
	// Visible-tab order for roving-tabindex keyboard nav — derived from
	// tabDefs so a hidden tab (trade history on someone else's profile) is
	// never a keyboard-nav target.
	const tabOrder = $derived(tabDefs.map((t) => t.id));
	// Roving-tabindex keyboard nav (WAI-ARIA tabs pattern): arrows wrap,
	// Home/End jump to ends, and focus follows selection.
	function onTabKeydown(e: KeyboardEvent, id: ProfileTab): void {
		const order = tabOrder;
		const idx = order.indexOf(id);
		let next = -1;
		if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % order.length;
		else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
			next = (idx - 1 + order.length) % order.length;
		else if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = order.length - 1;
		if (next < 0) return;
		e.preventDefault();
		const nextId = order[next]!;
		activeTab = nextId;
		requestAnimationFrame(() => document.getElementById(`tab-${nextId}`)?.focus());
	}
	// Completed trades for the Trade history tab. Same source as
	// liveOrders — allOrders is already fetched via getOrdersByAccount and
	// carries every status — filtered to completed, newest-first. No new
	// endpoint or public exposure; counterparty shows only when the owner
	// named it in morphit_order_complete_v1.
	const completedOrders = $derived.by(() =>
		[...allOrders]
			.filter((o) => o.status === 'completed')
			.sort((a, b) => b.created_at.localeCompare(a.created_at))
	);

	/** Canonical order title — the same unified sentence used on the
	 *  orderbook, /my/orders, and the order-detail page. Replaces the
	 *  old per-card formatting that mislabelled the fiat trade-size
	 *  band with the asset ticker. */
	function cardTitle(o: OrderRecord): string {
		const tp = orderTitleParts(o, formatAmount);
		return $_(tp.key, { values: tp.values }) as string;
	}

	function starString(n: 1 | 2 | 3 | 4 | 5): string {
		return '★'.repeat(n) + '☆'.repeat(5 - n);
	}

	// Part 121 cp7 — per-locale internal-link wrapper.  See
	// $i18n/path.localePath() + the analogous helper in
	// [lang]/+layout.svelte for design rationale.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<Head routeKey="profile" />

<div class="mx-auto max-w-3xl px-4 py-10 md:py-14">
	<!-- ─── Hero: avatar + display name + account + links ────── -->
	<section class="mb-8 flex flex-col items-center text-center">
		<!-- Avatar with the user's social-link glyphs (Nostr / Website / Blurt.media)
		     to its RIGHT. `items-center` vertically centres the glyph column
		     against the avatar (cp511 [D] — Ken: "perfectly to the right of the
		     avatar … perfectly spaced"), so 1, 2, or all 3 icons sit level with
		     the avatar's middle rather than clinging to its bottom corner. The
		     avatar + glyph column are centred together as one unit (justify-center)
		     so the pair stays centred on the page; `gap-2` is the even spacing
		     between avatar and column, and `gap-2` inside the column spaces the
		     icons from one another. These glyphs appear ONLY here — nowhere else
		     on the profile page renders THIS user's link icons. -->
		<div class="mb-3 flex items-center justify-center gap-2">
			{#if avatarSvg}
				<span
					class="flex h-24 w-24 items-center justify-center overflow-hidden rounded-2xl bg-ink-800/50 ring-1 ring-ink-700 dark:bg-ink-800"
					aria-hidden="true"
				>
					<!-- The avatar_svg value was produced by sanitizeSvg
					     on the uploader's device, then broadcast to chain,
					     then indexed. It reaches this render path having
					     already passed allowlist sanitization; we trust
					     that chokepoint and inline it. -->
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					{@html avatarSvg}
				</span>
			{:else if avatarDataUri}
				<img
					src={avatarDataUri}
					alt=""
					width="96"
					height="96"
					class="rounded-2xl object-cover"
					loading="lazy"
					decoding="async"
				/>
			{:else}
				<img
					src={heroAvatar}
					alt=""
					width="96"
					height="96"
					class="rounded-2xl"
					loading="lazy"
					decoding="async"
				/>
			{/if}
			{#if validatedNostrUrl || validatedWebsiteUrl || validatedStreamingUrl}
				<!-- v1.8.9 — `self-end` bottom-aligns the stack with the 96px avatar
				     (the row is items-center, which floated it mid-height); `gap-1`
				     tightens the glyphs so they read as one cluster. Order is
				     play → globe → nostr top-to-bottom, so nostr always anchors the
				     bottom regardless of which links a profile actually has. -->
				<div class="flex flex-col gap-1 self-end">
					{#if validatedStreamingUrl}
						<a
							href={validatedStreamingUrl}
							target="_blank"
							rel="noopener noreferrer external"
							aria-label={$_('identity.streaming_link_aria')}
							title={$_('identity.streaming_link_tooltip')}
							class="inline-flex h-7 w-7 flex-none items-center justify-center rounded-lg text-ink-500 transition hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:text-ink-400"
						>
							<AltNetworkIcon network="play" size={18} class="h-[18px] w-[18px]" />
						</a>
					{/if}
					{#if validatedWebsiteUrl}
						<a
							href={validatedWebsiteUrl}
							target="_blank"
							rel="noopener noreferrer external"
							aria-label={$_('identity.website_link_aria')}
							title={$_('identity.website_link_tooltip')}
							class="inline-flex h-7 w-7 flex-none items-center justify-center rounded-lg text-ink-500 transition hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:text-ink-400"
						>
							<AltNetworkIcon network="globe" size={18} class="h-[18px] w-[18px]" />
						</a>
					{/if}
					{#if validatedNostrUrl}
						<a
							href={validatedNostrUrl}
							target="_blank"
							rel="noopener noreferrer external"
							aria-label={$_('identity.nostr_link_aria')}
							title={$_('identity.nostr_link_tooltip')}
							class="inline-flex h-7 w-7 flex-none items-center justify-center rounded-lg text-ink-500 transition hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:text-ink-400"
						>
							<AltNetworkIcon network="nostr" size={18} class="h-[18px] w-[18px]" />
						</a>
					{/if}
				</div>
			{/if}
		</div>
		<h1 class="font-display text-3xl font-extrabold">
			{effectiveDisplayName}
		</h1>
		{#if shortBio}
			<p class="mt-3 max-w-prose text-pretty text-ink-600 dark:text-ink-300">
				{shortBio}
			</p>
		{/if}
		<!-- Message button: visible to any signed-in viewer who is
		     NOT this profile's subject. Anonymous viewers see the
		     button too — but tapping it routes through the peer
		     conversation page, which checks for a local account and
		     redirects to onboarding if missing. That's the right
		     funnel: "you need an account to chat, here's how to
		     get one." -->
		{#if !isOwnProfile}
			<div class="mt-4">
				<a
					href={lp(`/chat/${account}`)}
					class="inline-flex items-center gap-1.5 rounded-xl border-2 border-morphit-emerald bg-morphit-emerald/10 px-4 py-2 text-sm font-semibold text-morphit-emerald transition hover:bg-morphit-emerald hover:text-ink-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald"
					aria-label={$_('chat.message_button_aria', { values: { peer: account } }) as string}
				>
					<MessageIcon />
					{$_('chat.message_button_label_named', { values: { account } })}
				</a>
			</div>
		{/if}
	</section>

	<!-- ─── Private balance card (own profile only) ──────────── -->
	{#if isOwnProfile}
		<div class="mb-6">
			{#await loadMyBalanceCard() then MyBalanceCard}
				<MyBalanceCard {account} />
			{/await}
		</div>
	{/if}

	<!-- ─── Feedback summary card ────────────────────────────── -->
	<section class="card mb-6" aria-labelledby="reputation-heading">
		<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
			<h2 id="reputation-heading" class="font-display text-lg font-bold">
				{$_('profile.reputation_heading')}
			</h2>
			{#if feedback && feedback.summary.last_traded_at !== null}
				<!-- cp512 [PR2] — "Last trade: N ago" moved to the top-right corner. -->
				<div class="flex-none text-xs text-ink-500">
					<span>{$_('profile.last_traded_label')}</span>
					<RelativeTime iso={feedback.summary.last_traded_at} format="descriptive" />
				</div>
			{/if}
		</div>

		{#if feedbackState === 'loading'}
			<StatusLine kind="loading">{$_('profile.loading_feedback')}</StatusLine>
		{:else if feedbackState === 'error'}
			<StatusLine kind="warn">{$_('profile.feedback_error')}</StatusLine>
			<p class="mt-1 text-xs text-ink-500">{feedbackError}</p>
		{:else if feedback && feedback.summary.count > 0}
			<div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
				<!-- Big number + stars.
				     v1.8.10 (Ken): this headline used to be the RAW time-decayed
				     average (`weighted_rating`), while every order card and chat
				     header showed the COMPOSITE `reputation_score`. Same trader,
				     two different headline numbers depending on the page — and the
				     profile always flattered, because the composite shrinks a thin
				     sample toward neutral. Ken spotted 4.75 here vs 3.97 there.
				     The headline is now the composite, so the number you see after
				     clicking a trader's name matches the one that made you click.
				     The raw average stays visible directly below, labelled, since
				     it is what the histogram beneath actually plots.
				     Falls back to the raw average when the score is unavailable
				     (no included feedback, or an older indexer). -->
				<div class="flex flex-none flex-col items-center sm:items-start">
					<span class="font-display text-4xl font-extrabold">
						{headlineRating.toFixed(2)}
					</span>
					<span aria-hidden="true" class="text-morphit-emerald">
						{starString(Math.round(headlineRating) as 1 | 2 | 3 | 4 | 5)}
					</span>
					<span class="mt-1 text-xs text-ink-500">
						{$_('profile.rating_count', {
							values: { n: feedback.summary.count }
						})}
					</span>
					{#if reputationScore !== null}
						<span class="mt-1 text-xs text-ink-500">
							{$_('profile.average_rating_detail', {
								values: { avg: feedback.summary.weighted_rating.toFixed(2) }
							})}
						</span>
					{/if}
				</div>

				<!-- Histogram -->
				<div class="flex-1">
					{#each [5, 4, 3, 2, 1] as n}
						{@const count = feedback.summary.by_rating[String(n) as '1' | '2' | '3' | '4' | '5']}
						<div class="mb-1 flex items-center gap-2 text-xs">
							<span class="w-8 text-right text-ink-500">{n}★</span>
							<div
								class="relative h-2 flex-1 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800"
							>
								<div
									class="absolute left-0 top-0 h-full bg-morphit-emerald"
									style:width={barWidthPct(count)}
								></div>
							</div>
							<span class="w-10 text-right tabular-nums text-ink-500">
								{count}
							</span>
						</div>
					{/each}
				</div>
			</div>

			<!-- cp124 H5: by-side breakdown.  Surfaces buy/sell asymmetry when
			     either side has trade history.  Hidden when one side has zero
			     count (avoids visual clutter on new accounts). -->
			{#if feedback.summary.by_side.buy.count > 0 || feedback.summary.by_side.sell.count > 0}
				<div class="mt-4 flex flex-wrap gap-3 text-xs">
					{#if feedback.summary.by_side.buy.count > 0 && feedback.summary.by_side.buy.weighted_rating !== null}
						<div
							class="rounded-md border border-ink-200 bg-ink-50 px-3 py-2 dark:border-ink-700 dark:bg-ink-900"
						>
							<span class="text-ink-500">{$_('profile.as_buyer')}</span>
							<span class="ml-2 font-semibold tabular-nums">
								{feedback.summary.by_side.buy.weighted_rating.toFixed(2)}★
							</span>
							<span class="ml-1 text-ink-500">
								({feedback.summary.by_side.buy.count})
							</span>
						</div>
					{/if}
					{#if feedback.summary.by_side.sell.count > 0 && feedback.summary.by_side.sell.weighted_rating !== null}
						<div
							class="rounded-md border border-ink-200 bg-ink-50 px-3 py-2 dark:border-ink-700 dark:bg-ink-900"
						>
							<span class="text-ink-500">{$_('profile.as_seller')}</span>
							<span class="ml-2 font-semibold tabular-nums">
								{feedback.summary.by_side.sell.weighted_rating.toFixed(2)}★
							</span>
							<span class="ml-1 text-ink-500">
								({feedback.summary.by_side.sell.count})
							</span>
						</div>
					{/if}
				</div>
			{/if}

			<!-- cp124 H6: dormancy signal.  Surface "last traded N ago" so
			     readers see freshness without changing the score.  Hidden
			     when null (brand-new account, never traded). -->
		{:else}
			<p class="text-sm text-ink-600 dark:text-ink-300">
				{$_('profile.no_feedback_yet')}
			</p>
		{/if}

		<!-- cp512 [PR1] — reciprocity pill pinned to the bottom-right corner. -->
		{#if feedback}
			<div class="mt-4 flex justify-end">
				{#if feedback.summary.reciprocity_flagged}
					<span
						class="inline-flex flex-none items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200"
					>
						<svg
							aria-hidden="true"
							width="13"
							height="13"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.5"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
							<path d="M12 9v4" />
							<path d="M12 17h.01" />
						</svg>
						{$_('profile.reciprocity_flagged_pill')}
					</span>
				{:else}
					<span
						class="inline-flex flex-none items-center gap-1 rounded-full border border-morphit-emerald/40 bg-morphit-emerald/10 px-2.5 py-0.5 text-xs font-semibold text-morphit-emerald"
					>
						<svg
							aria-hidden="true"
							width="13"
							height="13"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.5"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path d="M20 6 9 17l-5-5" />
						</svg>
						{$_('profile.reciprocity_clean_pill')}
					</span>
				{/if}
			</div>
		{/if}
	</section>

	<!-- ─── cp511 [B]: tabbed detail navigation (WAI-ARIA tabs) ─── -->
	<div
		role="tablist"
		aria-label={$_('profile.tabs_aria')}
		class="no-scrollbar mb-4 flex gap-1 overflow-x-auto border-b border-ink-200 dark:border-ink-800"
	>
		{#each tabDefs as tab (tab.id)}
			<button
				role="tab"
				id="tab-{tab.id}"
				type="button"
				aria-selected={activeTab === tab.id}
				aria-controls="panel-{tab.id}"
				tabindex={activeTab === tab.id ? 0 : -1}
				onclick={() => (activeTab = tab.id)}
				onkeydown={(e) => onTabKeydown(e, tab.id)}
				class="-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald {activeTab ===
				tab.id
					? 'border-morphit-emerald text-morphit-emerald'
					: 'border-transparent text-ink-500 hover:text-ink-800 dark:text-ink-400 dark:hover:text-ink-100'}"
			>
				{tab.label}
			</button>
		{/each}
	</div>

	<!-- ─── Active orders ────────────────────────────────────── -->
	<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
	<section
		role="tabpanel"
		id="panel-orders"
		aria-labelledby="tab-orders"
		tabindex="0"
		class="mb-6"
		hidden={activeTab !== 'orders'}
	>
		<h2 id="active-orders-heading" class="sr-only">
			{$_('profile.active_orders_heading')}
		</h2>

		{#if ordersState === 'loading'}
			<StatusLine kind="loading">{$_('profile.loading_orders')}</StatusLine>
		{:else if ordersState === 'error'}
			<StatusLine kind="warn">{$_('profile.orders_error')}</StatusLine>
			<p class="mt-1 text-xs text-ink-500">{ordersError}</p>
		{:else if liveOrders.length === 0}
			<p class="text-sm text-ink-600 dark:text-ink-300">
				{$_('profile.no_active_orders')}
			</p>
		{:else}
			<p class="mb-3 text-xs text-ink-500">
				{$_('profile.active_orders_sort_hint')}
			</p>
			<ul class="space-y-3">
				{#each liveOrders as o (o.permlink)}
					{@const usdtRowNetwork =
						o.asset === 'USDT' && o.asset_network && isUsdtNetwork(o.asset_network)
							? o.asset_network
							: null}
					{@const usdcRowNetwork =
						o.asset === 'USDC' && o.asset_network && isUsdcNetwork(o.asset_network)
							? o.asset_network
							: null}
					{@const daiRowNetwork =
						o.asset === 'DAI' && o.asset_network && isDaiNetwork(o.asset_network)
							? o.asset_network
							: null}
					{@const networkChip = usdtRowNetwork
						? { label: $_(`assets.usdt.network.${usdtRowNetwork}.displayName`) as string, tone: 'usdt' as const }
						: usdcRowNetwork
							? { label: $_(`assets.usdc.network.${usdcRowNetwork}.displayName`) as string, tone: 'usdc' as const }
							: daiRowNetwork
								? { label: $_(`assets.dai.network.${daiRowNetwork}.displayName`) as string, tone: 'dai' as const }
								: null}
					<OrderCard
						order={o}
						title={cardTitle(o)}
						displayName={labelProps.displayName}
						{avatarSvg}
						{avatarDataUri}
						detailHref={lp(`/@${account}/${o.permlink}`)}
						profileHref={lp(`/@${account}`)}
						messageHref={viewerAccount !== null && viewerAccount !== account
							? lp(`/chat/${account}?order=${encodeURIComponent(o.permlink)}`)
							: null}
						paymentLabels={displayNamesForMethods(o.payment_methods, instLookup)}
						{networkChip}
						priceModelLabel={formatOrderPriceModel(
							o,
							$_ as unknown as Parameters<typeof formatOrderPriceModel>[1]
						)}
						onMessageClick={() => void recordOrderView(account, o.permlink)}
					/>
				{/each}
			</ul>
		{/if}

		<!-- Per-trader RSS subscription link.
			Lets a follower receive notifications whenever this trader
			posts a new order, without needing a Morphit account or
			keeping a tab open. Renders even when the trader has no
			current orders — the subscription is forward-looking.
			Privacy tradeoff (per-trader URL is slightly more
			revealing than the global feed) documented in the
			rss_feeds FAQ entry; tooltip surfaces the hint inline. -->
		{#if ordersState !== 'loading' && ordersState !== 'error'}
			<div class="mt-4 flex justify-end">
				<RssFeedPicker
					base={`/rss/orderbook/by-account/@${account}`}
					label={$_('profile.rss_subscribe_title') as string}
					text={$_('profile.rss_subscribe_label') as string}
					triggerClass="chip text-xs"
					iconClass="h-3.5 w-3.5"
					align="right"
				/>
			</div>
		{/if}
	</section>

	<!-- ─── Feedback items list ──────────────────────────────── -->
	<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
	<section
		role="tabpanel"
		id="panel-reviews"
		aria-labelledby="tab-reviews"
		tabindex="0"
		hidden={activeTab !== 'reviews'}
	>
		<h2 id="reviews-heading" class="sr-only">
			{$_('profile.reviews_heading', { values: { account } })}
		</h2>
		{#if feedbackState === 'loading'}
			<StatusLine kind="loading">{$_('profile.loading_feedback')}</StatusLine>
		{:else if feedbackState === 'error'}
			<StatusLine kind="warn">{$_('profile.feedback_error')}</StatusLine>
			<p class="mt-1 text-xs text-ink-500">{feedbackError}</p>
		{:else if feedbackItems.length === 0}
			<p class="text-sm text-ink-600 dark:text-ink-300">{$_('profile.no_feedback_yet')}</p>
		{:else}
			<ul class="space-y-3">
				{#each feedbackItems as fb (fb.id)}
					{@const reviewerProps = extractLabelPropsFromProfile(reviewerProfileMap[fb.reviewer])}
					<li class="card {fb.suppressed ? 'opacity-60' : ''}">
						{#if fb.suppressed}
							<!-- Per Finding R15: when the (reviewer, subject)
							     pair is flagged in suspicious_reciprocity or
							     related_accounts, the summary excludes this
							     review.  Surface that fact inline so the
							     displayed list reconciles with the headline
							     rating + count. -->
							<a
								href={lp('/faq#feedback_suppressed')}
								class="mb-2 inline-block rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-xs text-red-900 hover:bg-red-100 dark:border-red-700 dark:bg-red-950 dark:text-red-100 dark:hover:bg-red-900"
							>
								{$_('profile.feedback_suppressed_chip')}
							</a>
						{/if}
						<div class="mb-2 flex items-start justify-between gap-2">
							<!-- v1.8.0 (t.txt): received card now mirrors the given
							     card — avatar + display name (truncated posting key
							     stacked under it by IdentityLabel) + the REVIEWER's
							     current reputation. flex-wrap so the chip drops to its
							     own line on a narrow phone instead of squashing the
							     name. -->
							<div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
								<IdentityLabel
									account={fb.reviewer}
									displayName={reviewerProps.displayName}
									avatarSvg={reviewerProps.avatarSvg}
									avatarDataUri={reviewerProps.avatarDataUri}
									publicKeyString={reviewerProfileMap[fb.reviewer]?.posting_pubkey ?? undefined}
									href={lp(`/@${fb.reviewer}`)}
									weight="semibold"
									avatarSize={36}
								/>
								{#if fb.reviewer_reputation && fb.reviewer_reputation.count > 0}
									<RatingChip
										count={fb.reviewer_reputation.count}
										rating={fb.reviewer_reputation.weighted_rating}
									/>
								{/if}
							</div>
							<span class="flex-none text-xs text-ink-500">
								<RelativeTime iso={fb.created_at} format="terse" ago />
							</span>
						</div>
						<!-- v1.8.0 (t.txt): "@X rated me: ★★★★☆" with the Verified-chat
						     pill on the SAME line as the stars; wraps cleanly on narrow
						     screens via flex-wrap. -->
						<div
							class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
							aria-label={$_('feedback.form.rating_n_stars', {
								values: { n: fb.rating }
							}) as string}
						>
							<span class="text-ink-600 dark:text-ink-300">
								{$_('profile.received_rated')}
							</span>
							<span class="text-morphit-emerald" aria-hidden="true">
								{starString(fb.rating)}
							</span>
							{#if fb.has_verified_chat}
								<!-- ADR-0014 verified-chat badge. A bidirectional
								     conversation preceded this review (≥2 messages each
								     side, ≥15min span, no recip flag). Does NOT prove
								     distinct identity — see the linked FAQ. -->
								<a
									href={lp('/faq#verified_chat_badge')}
									class="inline-flex items-center gap-1 rounded-full border border-morphit-emerald/40 bg-morphit-emerald/5 px-2 py-0.5 text-xs text-morphit-emerald hover:bg-morphit-emerald/10 dark:border-morphit-emerald/50 dark:bg-morphit-emerald/10 dark:hover:bg-morphit-emerald/20"
									title={$_('feedback.verified_chat_badge.tooltip') as string}
								>
									<svg viewBox="0 0 16 16" class="h-3 w-3" fill="currentColor" aria-hidden="true">
										<path
											d="M3 8l3 3 7-7"
											stroke="currentColor"
											stroke-width="2"
											fill="none"
											stroke-linecap="round"
											stroke-linejoin="round"
										/>
									</svg>
									{$_('feedback.verified_chat_badge.label')}
								</a>
							{/if}
						</div>
						{#if fb.comment}
							<!-- cp512 [PR6] — the "@X said:" prefix was removed; the reviewer
							     is already named by the IdentityLabel above the rating. -->
							<p class="whitespace-pre-wrap text-sm text-ink-700 dark:text-ink-200">
								{fb.comment}
							</p>
						{/if}
						{#if fb.order_permlink}
							<p class="mt-2 text-xs text-ink-500">
								<a
									href={lp(`/@${fb.order_account ?? account}/${fb.order_permlink}`)}
									class="hover:text-morphit-emerald hover:underline"
								>
									{$_('profile.review_order_link')}
								</a>
							</p>
						{/if}
						{#if fb.responses.length > 0}
							<!-- Per Finding R5: only render the latest response.
							     The indexer accepts multiple responses (per the
							     handler's edit-in-place comment); the API returns
							     them ordered created_at DESC.  We display only the
							     first (= latest) so older edits don't stack
							     visibly with the current one. -->
							{@const resp = fb.responses[0]!}
							{@const responderProps = extractLabelPropsFromProfile(
								reviewerProfileMap[resp.responder]
							)}
							<div class="ml-6 mt-3 border-l-2 border-ink-200 pl-3 dark:border-ink-700">
								<div class="mb-1 flex flex-wrap items-baseline justify-between gap-2">
									<IdentityLabel
										account={resp.responder}
										displayName={responderProps.displayName}
										avatarSvg={responderProps.avatarSvg}
										avatarDataUri={responderProps.avatarDataUri}
										href={lp(`/@${resp.responder}`)}
										weight="semibold"
										avatarSize={20}
									/>
									<span class="text-xs text-ink-500">
										<RelativeTime iso={resp.created_at} format="terse" ago />
									</span>
								</div>
								{#if resp.comment}
									<p class="whitespace-pre-wrap text-sm text-ink-600 dark:text-ink-300">
										{resp.comment}
									</p>
								{/if}
							</div>
						{/if}

						<!-- Reply affordance: only shown on own profile, when
						     unlocked, and only for feedback that has not yet
						     been responded to (one response per feedback by
						     convention; the indexer accepts multiple as an
						     edit-in-place, but the UI limits to one to avoid
						     confusing the reader).  Part 116: paired-readonly
						     users see an inline affordance pointing at their
						     phone instead of the reply button being silently
						     hidden. -->
						{#if isOwnProfile && fb.responses.length === 0}
							{#if $isPairedReadOnly}
								<div class="mt-3">
									<WriteBlockedReadOnly
										variant="feedback_response"
										peer={account}
										density="inline"
									/>
								</div>
							{:else if $isUnlocked}
								{#if recentlyRepliedIds.has(fb.id)}
									<StatusLine kind="ok">
										{$_('feedback_response.posted')}
									</StatusLine>
								{:else if replyingTo === fb.id}
									{#await loadRespondToFeedbackForm() then RespondToFeedbackForm}
										<RespondToFeedbackForm
											feedbackTrxId={fb.source_trx_id}
											onSuccess={(res) => {
												replyingTo = null;
												// v1.7.0 — stage the reply so it renders where it will
												// permanently live, instead of a "posted" line above a
												// visibly empty reply slot for ~45-63s. Staged only
												// after the broadcast resolved ok, so it means "on
												// chain, not yet irreversible" — never "we hope".
												addPendingReply(fb.source_trx_id, account, res.comment);
												// Snapshot-set update — Svelte 5 tracks
												// by reference, so we replace the whole
												// Set to trigger reactivity.
												recentlyRepliedIds = new Set([...recentlyRepliedIds, fb.id]);
												// Refetch so the durable copy takes over as soon as the
												// indexer has it; the merge drops the echo at that point.
												void loadFeedbackPage();
											}}
											onCancel={() => (replyingTo = null)}
										/>
									{:catch}
										<LazyLoadError />
									{/await}
								{:else}
									<div class="mt-3">
										<BusyButton variant="secondary" onclick={() => (replyingTo = fb.id)}>
											{$_('feedback_response.reply_button')}
										</BusyButton>
									</div>
								{/if}
							{/if}
						{/if}
					</li>
				{/each}
			</ul>

			{#if feedbackNextCursor}
				<div class="mt-4 flex justify-center">
					<BusyButton variant="secondary" busy={loadingMore} onclick={loadMore}>
						{$_('profile.load_more')}
					</BusyButton>
				</div>
			{/if}
		{/if}
	</section>

	<!-- ─── Feedback given (reviews this account has left) ──── -->
	<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
	<section
		role="tabpanel"
		id="panel-given"
		aria-labelledby="tab-given"
		tabindex="0"
		hidden={activeTab !== 'given'}
	>
		<h2 id="given-heading" class="sr-only">
			{$_('profile.given_heading', { values: { account } })}
		</h2>

		{#if feedbackGivenState === 'loading'}
			<StatusLine kind="loading">{$_('profile.loading_given')}</StatusLine>
		{:else if feedbackGivenState === 'error'}
			<StatusLine kind="warn">{$_('profile.given_error')}</StatusLine>
			<p class="mt-1 text-xs text-ink-500">{feedbackGivenError}</p>
		{:else if feedbackGivenItems.length === 0}
			<p class="text-sm text-ink-600 dark:text-ink-300">
				{$_('profile.no_given_yet')}
			</p>
		{:else}
			<ul class="space-y-3">
				{#each feedbackGivenItems as fb (fb.id)}
					{@const subjectProps = extractLabelPropsFromProfile(reviewerProfileMap[fb.subject])}
					<li class="card {fb.suppressed ? 'opacity-60' : ''}">
						{#if fb.suppressed}
							<a
								href={lp('/faq#feedback_suppressed')}
								class="mb-2 inline-block rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-xs text-red-900 hover:bg-red-100 dark:border-red-700 dark:bg-red-950 dark:text-red-100 dark:hover:bg-red-900"
							>
								{$_('profile.feedback_suppressed_chip')}
							</a>
						{/if}
						<div class="mb-2 flex items-start justify-between gap-2">
							<!-- v1.5.0 (t.txt E): avatar + display name (truncated posting
							     key stacked under it by IdentityLabel) + the reviewed
							     account's CURRENT reputation. flex-wrap so the chip drops
							     to its own line on a narrow phone instead of squashing
							     the name. -->
							<div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
								<IdentityLabel
									account={fb.subject}
									displayName={subjectProps.displayName}
									avatarSvg={subjectProps.avatarSvg}
									avatarDataUri={subjectProps.avatarDataUri}
									publicKeyString={reviewerProfileMap[fb.subject]?.posting_pubkey ?? undefined}
									href={lp(`/@${fb.subject}`)}
									weight="semibold"
									avatarSize={36}
								/>
								{#if fb.subject_reputation && fb.subject_reputation.count > 0}
									<RatingChip
										count={fb.subject_reputation.count}
										rating={fb.subject_reputation.weighted_rating}
									/>
								{/if}
							</div>
							<span class="flex-none text-xs text-ink-500">
								<RelativeTime iso={fb.created_at} format="terse" ago />
							</span>
						</div>
						<!-- v1.5.0 (t.txt E): "I rated @X: ★★★★★" with the Verified-chat
						     pill on the SAME line as the stars; wraps cleanly on narrow
						     screens via flex-wrap. -->
						<div
							class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
							aria-label={$_('feedback.form.rating_n_stars', {
								values: { n: fb.rating }
							}) as string}
						>
							<span class="text-ink-600 dark:text-ink-300">
								{$_('profile.given_rated', { values: { account: fb.subject } })}
							</span>
							<span class="text-morphit-emerald" aria-hidden="true">
								{starString(fb.rating)}
							</span>
							{#if fb.has_verified_chat}
								<a
									href={lp('/faq#verified_chat_badge')}
									class="inline-flex items-center gap-1 rounded-full border border-morphit-emerald/40 bg-morphit-emerald/5 px-2 py-0.5 text-xs text-morphit-emerald hover:bg-morphit-emerald/10 dark:border-morphit-emerald/50 dark:bg-morphit-emerald/10 dark:hover:bg-morphit-emerald/20"
									title={$_('feedback.verified_chat_badge.tooltip') as string}
								>
									<svg viewBox="0 0 16 16" class="h-3 w-3" fill="currentColor" aria-hidden="true">
										<path
											d="M3 8l3 3 7-7"
											stroke="currentColor"
											stroke-width="2"
											fill="none"
											stroke-linecap="round"
											stroke-linejoin="round"
										/>
									</svg>
									{$_('feedback.verified_chat_badge.label')}
								</a>
							{/if}
						</div>
						{#if fb.comment}
							<!-- t155: "add 'I said:' so that the feedback line reads as:
							     'I said: Thx for the Blurt dude :)'". This is the GIVEN
							     list — the profile owner is the reviewer, so the comment
							     is their own words. The received list keeps no prefix:
							     there the comment is what someone else said about you. -->
							<p class="whitespace-pre-wrap text-sm text-ink-700 dark:text-ink-200">
								<span class="text-ink-500 dark:text-ink-400">{$_('profile.given_said')}</span>
								{fb.comment}
							</p>
						{/if}
						{#if fb.order_permlink}
							<p class="mt-2 text-xs text-ink-500">
								<a
									href={lp(`/@${fb.order_account ?? fb.subject}/${fb.order_permlink}`)}
									class="hover:text-morphit-emerald hover:underline"
								>
									{$_('profile.review_order_link')}
								</a>
							</p>
						{/if}
						{#if fb.responses.length > 0}
							<!-- Per Finding R5: only render the latest response.
							     The indexer accepts multiple responses (per the
							     handler's edit-in-place comment); the API returns
							     them ordered created_at DESC.  We display only the
							     first (= latest) so older edits don't stack
							     visibly with the current one. -->
							{@const resp = fb.responses[0]!}
							{@const responderProps = extractLabelPropsFromProfile(
								reviewerProfileMap[resp.responder]
							)}
							<div class="ml-6 mt-3 border-l-2 border-ink-200 pl-3 dark:border-ink-700">
								<div class="mb-1 flex flex-wrap items-baseline justify-between gap-2">
									<IdentityLabel
										account={resp.responder}
										displayName={responderProps.displayName}
										avatarSvg={responderProps.avatarSvg}
										avatarDataUri={responderProps.avatarDataUri}
										href={lp(`/@${resp.responder}`)}
										weight="semibold"
										avatarSize={20}
									/>
									<span class="text-xs text-ink-500">
										<RelativeTime iso={resp.created_at} format="terse" ago />
									</span>
								</div>
								{#if resp.comment}
									<p class="whitespace-pre-wrap text-sm text-ink-600 dark:text-ink-300">
										{resp.comment}
									</p>
								{/if}
							</div>
						{/if}
					</li>
				{/each}
			</ul>

			{#if feedbackGivenNextCursor}
				<div class="mt-4 flex justify-center">
					<BusyButton variant="secondary" busy={loadingMoreGiven} onclick={loadMoreGiven}>
						{$_('profile.load_more')}
					</BusyButton>
				</div>
			{/if}
		{/if}
	</section>
	{#if isOwnProfile}
	<!-- ─── cp511 [B]: Trade history (completed trades) ─────── -->
	<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
	<section
		role="tabpanel"
		id="panel-history"
		aria-labelledby="tab-history"
		tabindex="0"
		hidden={activeTab !== 'history'}
	>
		<h2 id="history-heading" class="sr-only">
			{$_('profile.tab_trade_history')}
		</h2>
		{#if ordersState === 'loading'}
			<StatusLine kind="loading">{$_('profile.loading_orders')}</StatusLine>
		{:else if ordersState === 'error'}
			<StatusLine kind="warn">{$_('profile.orders_error')}</StatusLine>
			<p class="mt-1 text-xs text-ink-500">{ordersError}</p>
		{:else if completedOrders.length === 0}
			<p class="text-sm text-ink-600 dark:text-ink-300">
				{$_('profile.no_trade_history')}
			</p>
		{:else}
			<ul class="space-y-3">
				{#each completedOrders as o (o.permlink)}
					<li class="card">
						<div class="font-medium">{cardTitle(o)}</div>
						<div class="mt-1 text-xs text-ink-500 dark:text-ink-400">
							{#if o.completed_counterparty}
								{$_('profile.trade_history_with', {
									values: { account: o.completed_counterparty }
								})}
								<span aria-hidden="true">·</span>
							{/if}
							<RelativeTime iso={o.created_at} format="descriptive" />
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
	{/if}
</div>
