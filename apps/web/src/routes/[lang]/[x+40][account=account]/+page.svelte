<script lang="ts">
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { formatDayMonthTime } from '$i18n/formatters';
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

	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { page } from '$app/stores';

	import Head from '$components/Head.svelte';
	import TermsText from '$components/TermsText.svelte';
	import RssFeedPicker from '$components/RssFeedPicker.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import BusyButton from '$components/BusyButton.svelte';
	import IdentityLabel from '$components/IdentityLabel.svelte';
	import AltNetworkIcon from '$components/AltNetworkIcon.svelte';
	import { validateNostrUrlForRender } from '$utils/nostrUrl';
	import { validateBlurtMediaUrlForRender } from '$utils/blurtMediaUrl';
	// cp165 byte-budget: MyBalanceCard renders only on a viewer's
	// OWN profile (rare path — most profile-page traffic is people
	// looking at counterparties).  RespondToFeedbackForm renders
	// only when actively replying to a piece of feedback (rare
	// action).  Lazy-import both.
	// import RespondToFeedbackForm from '$components/RespondToFeedbackForm.svelte';
	// import MyBalanceCard from '$components/MyBalanceCard.svelte';
	import RelativeTime from '$components/RelativeTime.svelte';
	import WriteBlockedReadOnly from '$components/WriteBlockedReadOnly.svelte';
	import { identiconDataUri } from '$crypto/identicon';
	import {
		getProfile,
		getFeedback,
		getFeedbackGiven,
		getOrdersByAccount
	} from '$lib/indexer/client';
	import { getProfilesBatch } from '$lib/indexer/profileCache';
	import { extractLabelPropsFromProfile } from '$lib/indexer/profileProps';
	import { displayNamesForMethods } from '$lib/payments/display';
	import { formatOrderPriceModel } from '$lib/orders/priceModelDisplay';
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
		const r = await getProfile(account);
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
		const r = await getFeedback(account, { cursor });
		if (r.ok) {
			feedback = r.data;
			if (cursor) {
				feedbackItems = [...feedbackItems, ...r.data.items];
			} else {
				feedbackItems = [...r.data.items];
			}
			feedbackNextCursor = r.data.next_cursor;
			feedbackState = 'ready';
			// Hydrate profile data for reviewers + responders in this
			// page of results. Fire-and-forget; IdentityLabel falls
			// back to identicons until this resolves.
			void hydrateReviewerProfiles(r.data.items, 'received');
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
		const r = await getFeedbackGiven(account, { cursor });
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
		ordersState = 'loading';
		ordersError = '';
		// Max limit so we capture all live orders for almost every
		// realistic user. Power users with >100 live orders would
		// need pagination here; not implemented as it's not a
		// Phase 5 problem.
		const r = await getOrdersByAccount(account, { limit: 100 });
		if (r.ok) {
			allOrders = [...r.data.items];
			ordersState = 'ready';
		} else {
			console.warn('[profile] orders load failed:', r.message);
			ordersError = $_('profile.error.orders_load_failed');
			ordersState = 'error';
		}
	}

	onMount(() => {
		// Parallel fetch — profile, feedback (received), feedback
		// (given), and orders are all independent. Each updates
		// its own loading state.
		void loadProfile();
		void loadFeedbackPage();
		void loadFeedbackGivenPage();
		void loadOrders();
	});

	// ─── Derived view state ────────────────────────────────────────

	/** Effective display name with sensible fallback to @account
	 *  when no profile has been set. */
	const effectiveDisplayName = $derived(
		profile?.display_name && profile.display_name.length > 0 ? profile.display_name : `@${account}`
	);

	/** Centralized profile-derived identity props.  This is the
	 *  single source of truth for displayName/avatarSvg/avatarDataUri/
	 *  nostrUrl/blurtMediaUrl extraction.  Per Finding G2.2 the
	 *  helper re-sanitizes avatar_svg from indexer data, so the hero
	 *  on this page (which inlines avatarSvg via {@html}) is
	 *  defense-in-depth-protected against malicious indexer content
	 *  or non-Morphit-client profile ops. */
	const labelProps = $derived(extractLabelPropsFromProfile(profile));
	const nostrUrl = $derived(labelProps.nostrUrl);
	const blurtMediaUrl = $derived(labelProps.blurtMediaUrl);

	// cp377 — render-safe validation for the hero's avatar-corner glyphs.
	// Mirrors IdentityLabel's own render guard so an unsafe or malformed
	// URL can never reach an <a href> on this page either.
	const validatedNostrUrl = $derived(validateNostrUrlForRender(nostrUrl));
	const validatedBlurtMediaUrl = $derived(validateBlurtMediaUrlForRender(blurtMediaUrl));
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
	 *    - status !== 'live' is excluded
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
		const live = allOrders.filter((o) => o.status === 'live');
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

	/** Compact "time until expiry" for live orders.
	 *  Format mirrors the terse RelativeTime component: 1m / 1h / 1d.
	 *  A negative duration (already past expiry but still marked
	 *  live — e.g. the orderbook hasn't flipped the status yet)
	 *  renders as "now" rather than a negative number. */
	function formatTimeUntil(iso: string): string {
		const diff = new Date(iso).getTime() - Date.now();
		if (diff <= 0) return $_('profile.expires_now') as string;
		const minutes = Math.floor(diff / 60_000);
		if (minutes < 1) return '<1m';
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h`;
		const days = Math.floor(hours / 24);
		return `${days}d`;
	}

	/** Format amount range for an order. Same pattern used on
	 *  my/orders and the orderbook: show both bounds when present,
	 *  single bound when only one side is set, "any" when neither. */
	function formatRange(o: OrderRecord): string {
		const min = o.amount_min;
		const max = o.amount_max;
		if (min !== null && max !== null) {
			return `${min}–${max} ${o.asset}`;
		}
		if (min !== null) return `≥${min} ${o.asset}`;
		if (max !== null) return `≤${max} ${o.asset}`;
		return `— ${o.asset}`;
	}

	/** Sally finding L10 (Part 68): absolute expiry date formatter
	 *  for the order chip's `title` tooltip.  Uses the project's
	 *  canonical translated day-month-year-time format. */
	function formatAbsoluteDate(iso: string): string {
		return formatDayMonthTime(iso);
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
		<!-- Avatar with the user's social-link glyphs (Nostr / Blurt.media)
		     stacked at its bottom-right corner.  The avatar and the glyph
		     column are centered together as one unit (items-end aligns the
		     column's bottom to the avatar's bottom), so when glyphs are
		     present the avatar sits slightly left of centre and the pair
		     stays centred on the page.  Nostr renders first (top); Blurt.media
		     second (bottom).  With a single glyph the column collapses to one
		     icon which bottom-aligns into that same corner spot. -->
		<div class="mb-3 flex items-end justify-center gap-2">
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
			{#if validatedNostrUrl || validatedBlurtMediaUrl}
				<div class="flex flex-col gap-2 pb-1">
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
					{#if validatedBlurtMediaUrl}
						<a
							href={validatedBlurtMediaUrl}
							target="_blank"
							rel="noopener noreferrer external"
							aria-label={$_('identity.blurt_media_link_aria')}
							title={$_('identity.blurt_media_link_tooltip')}
							class="inline-flex h-7 w-7 flex-none items-center justify-center rounded-lg text-ink-500 transition hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:text-ink-400"
						>
							<AltNetworkIcon network="blurt" size={18} class="h-[18px] w-[18px]" />
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
					<span aria-hidden="true">💬</span>
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
		<h2 id="reputation-heading" class="mb-3 font-display text-lg font-bold">
			{$_('profile.reputation_heading')}
		</h2>

		{#if feedbackState === 'loading'}
			<StatusLine kind="loading">{$_('profile.loading_feedback')}</StatusLine>
		{:else if feedbackState === 'error'}
			<StatusLine kind="warn">{$_('profile.feedback_error')}</StatusLine>
			<p class="mt-1 text-xs text-ink-500">{feedbackError}</p>
		{:else if feedback && feedback.summary.count > 0}
			<div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
				<!-- Big number + stars -->
				<div class="flex flex-none flex-col items-center sm:items-start">
					<span class="font-display text-4xl font-extrabold">
						{feedback.summary.weighted_rating.toFixed(2)}
					</span>
					<span aria-hidden="true" class="text-morphit-emerald">
						{starString(Math.round(feedback.summary.weighted_rating) as 1 | 2 | 3 | 4 | 5)}
					</span>
					<span class="mt-1 text-xs text-ink-500">
						{$_('profile.rating_count', {
							values: { n: feedback.summary.count }
						})}
					</span>
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
			{#if feedback.summary.last_traded_at !== null}
				<div class="mt-3 text-xs text-ink-500">
					<span>{$_('profile.last_traded_label')}</span>
					<RelativeTime iso={feedback.summary.last_traded_at} format="descriptive" />
				</div>
			{/if}
		{:else}
			<p class="text-sm text-ink-600 dark:text-ink-300">
				{$_('profile.no_feedback_yet')}
			</p>
		{/if}
	</section>

	<!-- ─── Active orders ────────────────────────────────────── -->
	<section class="mb-6" aria-labelledby="active-orders-heading">
		<h2 id="active-orders-heading" class="mb-3 font-display text-lg font-bold">
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
					{@const priceModelLabel = formatOrderPriceModel(
						o,
						$_ as unknown as Parameters<typeof formatOrderPriceModel>[1]
					)}
					<li>
						<a
							href={lp(`/@${account}/${o.permlink}`)}
							class="card block transition hover:border-morphit-emerald/60"
						>
							<div class="flex flex-col gap-1">
								<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
									<span class="font-display text-base font-bold">
										{o.side === 'buy'
											? ($_('profile.order_buying', { values: { asset: o.asset } }) as string)
											: ($_('profile.order_selling', { values: { asset: o.asset } }) as string)}
									</span>
									<span class="text-sm text-ink-600 dark:text-ink-300">
										{formatRange(o)}
									</span>
									<span class="text-sm text-ink-600 dark:text-ink-300">
										· {o.fiat_currency}
									</span>
									{#if priceModelLabel !== null}
										<span
											class="text-sm text-ink-500 dark:text-ink-400"
											title={$_('orderbook.price_model.tooltip') as string}
										>
											· {priceModelLabel}
										</span>
									{/if}
								</div>
								<div class="mt-1 flex flex-wrap items-center gap-2 text-xs">
									{#if o.expires_at}
										<!-- Sally finding L10 (Part 68): show the
										     absolute date in a `title` tooltip so a
										     viewer trying to plan a trade ("can I
										     reach this seller on Tuesday?") can
										     answer without doing relative-time
										     arithmetic.  Visible chip text stays
										     relative for compactness. -->
										<span
											class="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
											title={formatAbsoluteDate(o.expires_at)}
										>
											{$_('profile.expires_in', {
												values: { t: formatTimeUntil(o.expires_at) }
											})}
										</span>
									{/if}
									{#if o.location_region}
										<span class="text-ink-500">{o.location_region}</span>
									{/if}
									{#if o.payment_methods.length > 0}
										<span class="text-ink-500">
											{displayNamesForMethods(o.payment_methods, instLookup).join(', ')}
										</span>
									{/if}
								</div>
								{#if o.terms}
									<p class="mt-2 text-sm text-ink-700 dark:text-ink-200">
										<TermsText text={o.terms} />
									</p>
								{/if}
							</div>
						</a>
					</li>
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
	{#if feedbackState === 'ready' && feedbackItems.length > 0}
		<section aria-labelledby="reviews-heading">
			<h2 id="reviews-heading" class="mb-3 font-display text-lg font-bold">
				{$_('profile.reviews_heading')}
			</h2>
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
								class="mb-2 inline-block rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100 dark:hover:bg-amber-900"
							>
								{$_('profile.feedback_suppressed_chip')}
							</a>
						{/if}
						<div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
							<IdentityLabel
								account={fb.reviewer}
								displayName={reviewerProps.displayName}
								avatarSvg={reviewerProps.avatarSvg}
								avatarDataUri={reviewerProps.avatarDataUri}
								nostrUrl={reviewerProps.nostrUrl}
								blurtMediaUrl={reviewerProps.blurtMediaUrl}
								href={lp(`/@${fb.reviewer}`)}
								weight="semibold"
								avatarSize={24}
							/>
							<span class="text-xs text-ink-500">
								<RelativeTime iso={fb.created_at} format="terse" />
							</span>
						</div>
						<div
							class="mb-2"
							aria-label={$_('feedback.form.rating_n_stars', {
								values: { n: fb.rating }
							}) as string}
						>
							<span class="text-morphit-emerald" aria-hidden="true">
								{starString(fb.rating)}
							</span>
						</div>
						{#if fb.has_verified_chat}
							<!-- ADR-0014 verified-chat badge.  Indicates that a
							     bidirectional conversation preceded this review
							     (≥2 messages each side, ≥15min span, no recip
							     flag).  Does NOT prove distinct identity — see
							     the linked FAQ. -->
							<a
								href={lp('/faq#verified_chat_badge')}
								class="mb-2 inline-flex items-center gap-1 rounded-full border border-morphit-emerald/40 bg-morphit-emerald/5 px-2 py-0.5 text-xs text-morphit-emerald hover:bg-morphit-emerald/10 dark:border-morphit-emerald/50 dark:bg-morphit-emerald/10 dark:hover:bg-morphit-emerald/20"
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
						{#if fb.comment}
							<p class="whitespace-pre-wrap text-sm text-ink-700 dark:text-ink-200">
								{fb.comment}
							</p>
						{/if}
						{#if fb.order_permlink}
							<p class="mt-2 text-xs text-ink-500">
								<a
									href={lp(`/@${account}/${fb.order_permlink}`)}
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
							<div class="mt-3 border-l-2 border-ink-200 pl-3 dark:border-ink-700">
								<div class="mb-1 flex flex-wrap items-baseline justify-between gap-2">
									<IdentityLabel
										account={resp.responder}
										displayName={responderProps.displayName}
										avatarSvg={responderProps.avatarSvg}
										avatarDataUri={responderProps.avatarDataUri}
										nostrUrl={responderProps.nostrUrl}
										blurtMediaUrl={responderProps.blurtMediaUrl}
										href={lp(`/@${resp.responder}`)}
										weight="semibold"
										avatarSize={20}
									/>
									<span class="text-xs text-ink-500">
										<RelativeTime iso={resp.created_at} format="terse" />
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
											onSuccess={() => {
												replyingTo = null;
												// Snapshot-set update — Svelte 5 tracks
												// by reference, so we replace the whole
												// Set to trigger reactivity.
												recentlyRepliedIds = new Set([...recentlyRepliedIds, fb.id]);
												// Kick off a refetch so the response
												// record lands in the DOM. The success
												// line stays visible until then.
												void loadFeedbackPage();
											}}
											onCancel={() => (replyingTo = null)}
										/>
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
		</section>
	{/if}

	<!-- ─── Feedback given (reviews this account has left) ──── -->
	<section class="mt-8" aria-labelledby="given-heading">
		<h2 id="given-heading" class="mb-3 font-display text-lg font-bold">
			{$_('profile.given_heading')}
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
								class="mb-2 inline-block rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100 dark:hover:bg-amber-900"
							>
								{$_('profile.feedback_suppressed_chip')}
							</a>
						{/if}
						<div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
							<div class="flex flex-wrap items-baseline gap-2 text-sm">
								<span class="text-ink-500">
									{$_('profile.given_prefix')}
								</span>
								<IdentityLabel
									account={fb.subject}
									displayName={subjectProps.displayName}
									avatarSvg={subjectProps.avatarSvg}
									avatarDataUri={subjectProps.avatarDataUri}
									nostrUrl={subjectProps.nostrUrl}
									blurtMediaUrl={subjectProps.blurtMediaUrl}
									href={lp(`/@${fb.subject}`)}
									weight="semibold"
									avatarSize={24}
								/>
							</div>
							<span class="text-xs text-ink-500">
								<RelativeTime iso={fb.created_at} format="terse" />
							</span>
						</div>
						<div
							class="mb-2"
							aria-label={$_('feedback.form.rating_n_stars', {
								values: { n: fb.rating }
							}) as string}
						>
							<span class="text-morphit-emerald" aria-hidden="true">
								{starString(fb.rating)}
							</span>
						</div>
						{#if fb.has_verified_chat}
							<a
								href={lp('/faq#verified_chat_badge')}
								class="mb-2 inline-flex items-center gap-1 rounded-full border border-morphit-emerald/40 bg-morphit-emerald/5 px-2 py-0.5 text-xs text-morphit-emerald hover:bg-morphit-emerald/10 dark:border-morphit-emerald/50 dark:bg-morphit-emerald/10 dark:hover:bg-morphit-emerald/20"
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
						{#if fb.comment}
							<p class="whitespace-pre-wrap text-sm text-ink-700 dark:text-ink-200">
								{fb.comment}
							</p>
						{/if}
						{#if fb.order_permlink}
							<p class="mt-2 text-xs text-ink-500">
								<a
									href={lp(`/@${fb.subject}/${fb.order_permlink}`)}
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
							<div class="mt-3 border-l-2 border-ink-200 pl-3 dark:border-ink-700">
								<div class="mb-1 flex flex-wrap items-baseline justify-between gap-2">
									<IdentityLabel
										account={resp.responder}
										displayName={responderProps.displayName}
										avatarSvg={responderProps.avatarSvg}
										avatarDataUri={responderProps.avatarDataUri}
										nostrUrl={responderProps.nostrUrl}
										blurtMediaUrl={responderProps.blurtMediaUrl}
										href={lp(`/@${resp.responder}`)}
										weight="semibold"
										avatarSize={20}
									/>
									<span class="text-xs text-ink-500">
										<RelativeTime iso={resp.created_at} format="terse" />
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
</div>
