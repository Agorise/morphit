<script lang="ts">
	import { formatDayMonth, formatDayMonthTime } from '$lib/i18n/formatters';
	import type { BidVerdict } from '$lib/orders/featureBidCheck';
	import LazyLoadError from '$components/LazyLoadError.svelte';
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	/**
	 * Morphit — "my orders" page.
	 *
	 * Lists the signer's own orders with actions: edit (within the
	 * 15-minute window) and cancel (while live). Cancellation uses a
	 * two-step inline confirm rather than a modal — grandma gets one
	 * explicit "are you sure" prompt before the broadcast.
	 *
	 * After a successful cancel, we refetch from the indexer rather
	 * than just flipping state locally — the indexer is the source
	 * of truth, and a refetch rules out the rare race where another
	 * device cancelled the same order concurrently.
	 */

	import { onMount } from 'svelte';
	import { scrollToLazySection } from '$lib/ui/scrollToLazySection';
	import { _ } from 'svelte-i18n';
	import { gotoLocale } from '$i18n/navigate';
	import { get } from 'svelte/store';

	import Head from '$components/Head.svelte';
	import TermsText from '$components/TermsText.svelte';
	import BusyButton from '$components/BusyButton.svelte';
	import IdentityLabel from '$components/IdentityLabel.svelte';
	import ConfirmModal from '$components/ConfirmModal.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	// byte-budget: 3 disclosure/modal components below are
	// lazy-imported.  None render on first paint; all are gated by
	// state that toggles only after a user action.  Combined the
	// three are ~37 KB of component source plus transitive helpers
	// — non-trivial for /my/orders where Sally lands after every
	// trade.
	// import FeatureBidForm from '$components/FeatureBidForm.svelte';
	// import LeaveFeedbackForm from '$components/LeaveFeedbackForm.svelte';
	// import PendingFeedbackReminderBanner from '$components/PendingFeedbackReminderBanner.svelte';
	import PaymentStatusBadge from '$components/PaymentStatusBadge.svelte';
	import RelativeTime from '$components/RelativeTime.svelte';
	import WriteBlockedReadOnly from '$components/WriteBlockedReadOnly.svelte';

	import { identity, isUnlocked, isPairedReadOnly, hasAnySession } from '$stores/identity';
	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import { broadcastOrderCancel, broadcastOrderComplete, BroadcastError } from '$blurt/ops/order';
	import { KeystoreError } from '$crypto/keystore';
	import {
		getAccountOrderPages,
		getOrdersByAccount,
		getOrderCounterpartyLists,
		COUNTERPARTY_LISTS_BATCH
	} from '$lib/indexer/client';
	import { fetchListingFee } from '$lib/orders/listingFee';
	import { fetchOrderViewCounts } from '$lib/orders/views';
	import {
		autoCompleteCounterparty,
		mergeNewestPage,
		paidPermlinksOf,
		parseMyOrdersHash
	} from '$lib/orders/myOrdersActions';
	import { formatOrderPriceModel } from '$lib/orders/priceModelDisplay';
	import { isOrderExpired, isOrderLive } from '$lib/orders/orderExpiry';
	import { buildRelistPrefill, RELIST_PREFILL_KEY } from '$lib/orders/relist';
	import { recordCancel, applyRecentCancels } from '$lib/orders/recentCancels';
	import { recordComplete, applyRecentCompletes } from '$lib/orders/recentCompletes';
	import { MORPHIT_INDEXER_ORIGIN, resolveOrigin } from '$net/config';
	import { safeSession, safeLocal } from '$lib/utils/safeStorage';
	import { orderTitleParts } from '$lib/utils/orderTitle';
	import { displayNamesForMethods } from '$lib/payments/display';
	import { instanceAdditions, instanceNameLookup } from '$lib/stores/instanceAdditions';
	import type { OrderRecord } from '@morphit/indexer-client';
	import { addPendingFeatured } from '$stores/pendingFeatured';
	import { pendingOrders, mergePendingOrders, pendingOrderKeys } from '$lib/stores/pendingOrders';
	import { orderEchoKey } from '$lib/stores/pendingEcho';
	import { tradeStates } from '$lib/trades/tradeStatus';
	import {
		editWindowRemainingSeconds as editWindowRemainingSecondsFor,
		formatRemainingMmSs
	} from '$lib/orders/editWindow';

	const blurtAccount = getUserBlurtAccount();

	/** Reactive payment-instrument name lookup (re-derives when the
	 *  user's saved instances change), so payment methods on each card
	 *  render with friendly names, not raw keys. */
	const instLookup = $derived.by(() => {
		void $instanceAdditions;
		return instanceNameLookup;
	});

	// ─── Phase + data ──────────────────────────────────────────────
	type Phase = 'loading' | 'ready' | 'error';
	let phase = $state<Phase>('loading');
	let items = $state<OrderRecord[]>([]);
	let errorMessage = $state('');

	// #9 — the top fee-status explainer can be dismissed forever (localStorage
	// so it stays hidden across sessions/devices-per-browser). Initialized from
	// storage at setup; browser-only guard for SSR.
	const FEE_BANNER_DISMISS_KEY = 'morphit.my_orders.fee_status_banner.dismissed.v1';
	let feeStatusBannerDismissed = $state(
		typeof window !== 'undefined' && safeLocal.get(FEE_BANNER_DISMISS_KEY) === '1'
	);
	function dismissFeeStatusBanner(): void {
		feeStatusBannerDismissed = true;
		safeLocal.set(FEE_BANNER_DISMISS_KEY, '1');
	}

	// lazy-loaders for below-the-fold / behind-disclosure components
	// v1.20.0 (MK-H2) — "pay your order's own BTC fee address" card.
	const loadBtcFeePayPanel = () =>
		import('$components/BtcFeePayPanel.svelte').then((m) => m.default);
	const loadFeatureBidForm = () =>
		import('$components/FeatureBidForm.svelte').then((m) => m.default);
	const loadLeaveFeedbackForm = () =>
		import('$components/LeaveFeedbackForm.svelte').then((m) => m.default);
	const loadPendingFeedbackReminderBanner = () =>
		import('$components/PendingFeedbackReminderBanner.svelte').then((m) => m.default);

	// Task #14 — per-permlink viewcount.  Fetched after the items
	// load, one batch request per 100 orders.  Display only — never
	// used for routing or gating.  See lib/orders/views.ts.
	const viewCounts: Record<string, number> = $state({});

	// ─── Filter state ──────────────────────────────────────────────
	type FilterKind = 'all' | 'live' | 'paid' | 'cancelled' | 'expired';
	// default to the Live pill/orders. Most people
	// arriving here want to see what they currently have posted; All /
	// Cancelled / Expired are a click away.
	let filter = $state<FilterKind>('live');

	// ─── Counts per state (derived) ────────────────────────────────
	// "Paid" (the Paid filter; Feature / Cancel and the "Visible in orderbook"
	//  pill hidden): released / completed, or a payment verified against the
	//  amount asked — not one merely received with no amount asked
	//  (paidPermlinksOf).
	const paidPermlinks = $derived(paidPermlinksOf($tradeStates));

	// v1.5.0 — AUTO-COMPLETE. Once the seller's client has verified that the
	//  counterparty the seller is trading with paid the amount the seller
	//  asked for (autoCompleteCounterparty: paid_verified + amountConfirmed +
	//  sender === engagedPeer), post morphit_order_complete_v1 to drop the
	//  order from the public orderbook. Anything less (a payment checked only
	//  against the buyer's own figure, a stranger's transfer, an underpayment)
	//  leaves the manual "Mark as complete" button as the path. /my/orders
	//  shows ONLY the current user's own orders, so the handler's owner-only
	//  guard is satisfied here. Fire-once per order per session, unlocked-only
	//  (needs the posting key), best-effort.
	const autoCompletedPermlinks = new Set<string>();
	$effect(() => {
		const st = $identity;
		if (st.state !== 'unlocked') return;
		for (const o of items) {
			if (autoCompletedPermlinks.has(o.permlink)) continue;
			// v1.20.0 (G7) — name the verified payer as the counterparty. Without
			// it the order completed anonymously and the later review's
			// completion (which names them) was rejected as already-completed,
			// so the buyer never got the trade credit. The indexer still
			// requires a provable conversation before it records the name.
			const peer = autoCompleteCounterparty(o, $tradeStates.get(o.permlink));
			if (peer !== null) {
				autoCompletedPermlinks.add(o.permlink); // mark BEFORE await — fire once
				void (async () => {
					try {
						await broadcastOrderComplete(st.live, o.permlink, peer);
						recordComplete(o.permlink);
						items = applyRecentCompletes(items);
					} catch (err) {
						console.warn('[my/orders] auto-complete failed:', o.permlink, err);
						autoCompletedPermlinks.delete(o.permlink); // allow retry next tick
					}
				})();
			}
		}
	});
	const counts = $derived.by(() => {
		const c = { all: mergedItems.length, live: 0, paid: 0, cancelled: 0, expired: 0 };
		for (const o of mergedItems) {
			if (o.status === 'completed' || paidPermlinks.has(o.permlink)) c.paid++;
			else if (isLive(o)) c.live++;
			else if (o.status === 'cancelled') c.cancelled++;
			else if (isExpired(o)) c.expired++;
		}
		return c;
	});

	// ─── Cancel state (per-row) ────────────────────────────────────
	/** Permlink currently in "are you sure?" state. Only one at a
	 *  time — confirming a second one is rare enough that we don't
	 *  need a Set. */
	let pendingCancelPermlink: string | null = $state(null);
	let cancelErrorPermlink: string | null = $state(null);
	let cancelErrorMessage = $state('');

	// ─── Complete state (per-row) — v1.5.0 "Mark as complete" ─────
	let pendingCompletePermlink: string | null = $state(null);
	let completeErrorPermlink: string | null = $state(null);
	let completeErrorMessage = $state('');

	// ─── Feature-bid state (per-row) ───────────────────────────────
	// Same one-at-a-time disclosure pattern as cancel. The form
	// component manages its own submit/error state; we just track
	// which row currently has the form open.
	let pendingFeaturePermlink: string | null = $state(null);
	let featureSuccessPermlink: string | null = $state(null);
	let featureSuccessBlurt: number | null = $state(null);
	/** What the indexer recorded for the bid just sent (FeatureBidForm waits
	 *  for it): shown now, starts later, waits for a free slot, or not yet
	 *  recorded. */
	let featureSuccessVerdict: BidVerdict | null = $state(null);

	// Feedback disclosure — parallels feature-bid. One row's form
	// open at a time; LeaveFeedbackForm manages its own submit state.
	let pendingFeedbackPermlink: string | null = $state(null);
	let feedbackSuccessPermlink: string | null = $state(null);
	// reviewable trade partners per order (permlink → peer names
	// the owner MAY review, i.e. the counterparties endpoint's
	// reviewable=true set). `undefined` = not loaded yet OR the lookup
	// failed → fall back to the legacy free-type form (the indexer gate
	// still enforces). `[]` = loaded, nobody reviewable → hide the button.
	let reviewableCounterparties: Record<string, string[] | undefined> = $state({});
	// When a review form opens, the counterparty it is locked to (a
	// single reviewable peer). Null → legacy free-type (fallback only).
	let feedbackPrefillSubject: string | null = $state(null);
	// When an order has >1 reviewable counterparty, the row shows a
	// small picker first; this holds which order's picker is open.
	let feedbackPickerPermlink: string | null = $state(null);

	/** Open the review form for an order, locked to a specific peer. */
	function openFeedback(permlink: string, peer: string): void {
		feedbackPrefillSubject = peer;
		feedbackPickerPermlink = null;
		pendingFeedbackPermlink = permlink;
		void scrollToFeedbackForm(permlink); // #10 — smooth-scroll to the form
	}

	/** Click handler for the "Mark complete / review" button. 1
	 *  reviewable peer → open locked to them; >1 → open the picker. */
	function startFeedback(permlink: string): void {
		const peers = reviewableCounterparties[permlink];
		if (peers && peers.length === 1) {
			openFeedback(permlink, peers[0]!);
		} else if (peers && peers.length > 1) {
			feedbackPickerPermlink = permlink;
		} else {
			// Unknown (not loaded / lookup failed) → legacy free-type form.
			feedbackPrefillSubject = null;
			feedbackPickerPermlink = null;
			pendingFeedbackPermlink = permlink;
			void scrollToFeedbackForm(permlink); // #10 — smooth-scroll to the form
		}
	}

	// ─── Featured-bid rate ─────────────────────────────────────────
	// Lazy-fetched the first time the user opens a FeatureBidForm.
	// undefined → use the form's bundled default (50 BLURT/hr); a
	// number → operator's configured rate from /v1/listing-fee.
	// Per Finding O30 (order-placement audit): without this, an
	// operator running a non-default rate would have their users
	// underpaying feature bids.  Cached per session.
	let featureBlurtPerHour: number | undefined = $state(undefined);
	let featureBlurtPerHourFetched = false;

	async function ensureFeatureRateFetched(): Promise<void> {
		if (featureBlurtPerHourFetched) return;
		featureBlurtPerHourFetched = true;
		const r = await fetchListingFee(resolveOrigin(MORPHIT_INDEXER_ORIGIN));
		if (r.kind === 'ok') {
			const v = r.quote.feature_fee_blurt_per_hour;
			if (typeof v === 'number' && v > 0) {
				featureBlurtPerHour = v;
			}
		}
		// Fetch error: stay on the bundled default.  No user-facing
		// signal — the form will quote the default rate, the
		// indexer will reject if the rate is mismatched, and the
		// rejection UI will surface the issue.  Better than blocking
		// the form opening on a network round-trip.
	}

	/** smooth-scroll to the just-opened Feature form. The form is
	 *  lazy-loaded, so its element may not exist for a frame or two after
	 *  the click; retry across a few rAFs until it mounts. The target div
	 *  carries `scroll-mt-24` (6rem ≈ an inch) so it lands an inch below the
	 *  viewport top, as requested — a breath of space above the
	 *  "🚀 Feature this order!" heading rather than flush against the top. */
	function scrollToFeatureForm(permlink: string): void {
		void scrollToLazySection(`feature-form-${permlink}`, loadFeatureBidForm);
	}

	/** #10 — smooth-scroll to the just-opened "Mark this trade complete"
	 *  (LeaveFeedbackForm) section, same treatment as the Feature form: the
	 *  form is lazy-loaded so retry across a few rAFs until it mounts, and its
	 *  container carries `scroll-mt-24` (≈1in) so it lands a breath below the
	 *  viewport top rather than flush against it. */
	async function scrollToFeedbackForm(permlink: string): Promise<void> {
		await scrollToLazySection(`feedback-form-${permlink}`, loadLeaveFeedbackForm);
	}

	/** Pages of the account's orders to read on load (100 each, newest
	 *  updated first). An account with more orders than this sees the newest
	 *  ones; every order stays reachable from its own page. */
	const MAX_ORDER_PAGES = 5;

	async function load(): Promise<void> {
		if (!blurtAccount) {
			phase = 'error';
			errorMessage = $_('my_orders.error.no_account');
			return;
		}
		phase = 'loading';
		const read = await getAccountOrderPages(blurtAccount, { maxPages: MAX_ORDER_PAGES });
		const all = read?.items ?? null;
		if (all === null) {
			console.warn('[my/orders] load failed');
			errorMessage = $_('my_orders.error.load_failed');
			phase = 'error';
			return;
		}
		// reflect a just-cancelled order even if the indexer hasn't
		// caught up yet (e.g. arriving here right after cancelling from the
		// order page). Chain is truth; this only bridges the ~1min lag.
		items = applyRecentCompletes(applyRecentCancels(all));
		phase = 'ready';
		// Task #14 — view counts and review candidates, in batch reads (one
		// request per 100 / 50 orders), so a page of orders costs a handful of
		// requests instead of two per order.
		void loadViewCounts(items.map((o) => o.permlink));
		void loadCounterparties(items.map((o) => o.permlink));

		// Deep links: `#order-<permlink>` (the outbid push) scrolls to the
		// order; `#feature=<permlink>` / `#cancel=<permlink>` (the hand-off
		// from a paired desktop) open that order's feature form or cancel
		// confirmation. Done after `phase = 'ready'` so the {#each} has
		// produced the target element; requestAnimationFrame gives the DOM
		// one commit cycle before we query.
		if (typeof window !== 'undefined') applyHashAction(window.location.hash);
	}

	/** Act on a /my/orders deep-link hash once the rows are loaded. The
	 *  permlink must be one of this account's orders. */
	function applyHashAction(hash: string): void {
		const action = parseMyOrdersHash(hash);
		if (action === null || action.kind === 'feedback') return;
		const o = items.find((x) => x.permlink === action.permlink);
		if (o === undefined) return;
		if (action.kind === 'feature') {
			if (
				isLive(o) &&
				!paidPermlinks.has(o.permlink) &&
				(o.fee_status === 'verified' || o.fee_status === 'verified_by_attestation')
			) {
				pendingFeaturePermlink = o.permlink;
				void ensureFeatureRateFetched();
				scrollToFeatureForm(o.permlink);
			}
			return;
		}
		if (action.kind === 'cancel') {
			if (isLive(o) && !paidPermlinks.has(o.permlink)) requestCancel(o.permlink);
			return;
		}
		requestAnimationFrame(() => {
			document.getElementById(`order-${o.permlink}`)?.scrollIntoView({
				behavior: 'smooth',
				block: 'start'
			});
		});
	}

	// SILENT re-fetch of the NEWEST page only, without the
	// phase='loading' flip (no spinner flicker) and without the hash action.
	// Polled (below) while an order is still provisional so the indexer's
	// confirmed row REPLACES the "Posting…" placeholder the moment it lands
	// (a just-posted order is always on the newest page). Older pages stay as
	// loaded, and the view-count / counterparty reads run only for orders
	// that were not shown before, so the 10 s poll costs one request, not a
	// fan-out over every order. On a transient fetch error we keep the
	// current view (and the placeholder) rather than blanking.
	async function silentRefetch(): Promise<void> {
		if (!blurtAccount) return;
		const result = await getOrdersByAccount(blurtAccount, { limit: 100 });
		if (!result.ok) return;
		const known = new Set(items.map((o) => o.permlink));
		items = applyRecentCompletes(applyRecentCancels(mergeNewestPage(items, result.data.items)));
		const fresh = items.map((o) => o.permlink).filter((p) => !known.has(p));
		if (fresh.length > 0) {
			void loadViewCounts(fresh);
			void loadCounterparties(fresh);
		}
	}

	async function loadViewCounts(permlinks: readonly string[]): Promise<void> {
		if (!blurtAccount || permlinks.length === 0) return;
		const counts = await fetchOrderViewCounts(blurtAccount, permlinks);
		if (counts === null) return;
		for (const [permlink, n] of counts) viewCounts[permlink] = n;
	}

	/** At most this many counterparty_lists requests in flight at once. */
	const COUNTERPARTY_CONCURRENCY = 4;

	/** for each order, load the set of trade partners the owner
	 *  may review (reviewable=true), COUNTERPARTY_LISTS_BATCH orders per
	 *  request and at most COUNTERPARTY_CONCURRENCY requests at once. A
	 *  failed lookup leaves the entry `undefined` → the row falls back to
	 *  the legacy free-type form (the indexer's provable-counterparty gate
	 *  still enforces). */
	async function loadCounterparties(permlinks: readonly string[]): Promise<void> {
		if (!blurtAccount || permlinks.length === 0) return;
		const account = blurtAccount;
		const chunks: string[][] = [];
		for (let i = 0; i < permlinks.length; i += COUNTERPARTY_LISTS_BATCH) {
			chunks.push(permlinks.slice(i, i + COUNTERPARTY_LISTS_BATCH));
		}
		const worker = async (): Promise<void> => {
			for (let chunk = chunks.shift(); chunk; chunk = chunks.shift()) {
				const r = await getOrderCounterpartyLists(account, chunk);
				if (!r.ok) continue;
				for (const p of chunk) {
					const list = r.data.lists[p];
					if (list === undefined) continue;
					reviewableCounterparties[p] = list.filter((it) => it.reviewable).map((it) => it.peer);
				}
			}
		};
		await Promise.all(
			Array.from({ length: Math.min(COUNTERPARTY_CONCURRENCY, chunks.length) }, worker)
		);
	}

	// A remembered account name alone (a locked visit) does not read the
	// account's orders: the page asks to unlock first, so a locked visit does
	// not announce the account to the operator. The read starts once a session
	// exists (on arrival, or when the user unlocks in place).
	let loadStarted = false;
	$effect(() => {
		if (!blurtAccount || !$hasAnySession || loadStarted) return;
		loadStarted = true;
		void load();
	});

	onMount(() => {
		// Deep-link support: if URL is /my/orders#feedback=<permlink>,
		// auto-open that order's LeaveFeedbackForm.  The reminder
		// banner uses this to land users directly on the form they
		// need without a second click.  Only fires if the user is
		// unlocked — locked users see the form's "unlock to leave
		// feedback" prompt instead, which is correct.
		if (typeof window !== 'undefined' && window.location.hash) {
			const action = parseMyOrdersHash(window.location.hash);
			if (action?.kind === 'feedback') {
				pendingFeedbackPermlink = action.permlink;
			}
		}
		// Sally finding M1/M8: tick once a second so the
		// per-order edit-window countdown updates live.  Cleared on
		// component unmount.  1s granularity is fine — the window
		// is 15 minutes total.
		const t = setInterval(() => {
			nowMs = Date.now();
		}, 1000);
		return () => clearInterval(t);
	});

	/** Live "now" timestamp for edit-window countdowns.  Updated
	 *  by the ticker in onMount.  Per-render reactive: when this
	 *  flips, every {#each} order row re-evaluates its
	 *  remaining-time helper. */
	let nowMs = $state(Date.now());

	/** Edit window — 15 minutes from order creation.  Source of
	 *  truth: indexer's REPLACE_WINDOW_MS at
	 *  apps/indexer/src/indexer/handlers/orderReplace.ts.
	 *  Window extended from 3 to 15 minutes 2026-05-07 per
	 *  ADR-0001 Amendment.  Keep all five frontend mirrors and
	 *  the indexer in sync if changed again. */
	const EDIT_WINDOW_MS = 15 * 60 * 1000;

	// Effective (query-time) order status — see $lib/orders/orderExpiry for the
	// full rationale and the timezone note.  Thin wrappers so every call site in
	// this file stays `isExpired(o)` / `isLive(o)` while the rule lives in a pure,
	// unit-tested module (orderExpiry.test.ts).  Both read the `nowMs` ticker so
	// the pill / label / actions flip the second an order crosses its deadline.
	function isExpired(o: OrderRecord): boolean {
		return isOrderExpired(o, nowMs);
	}
	function isLive(o: OrderRecord): boolean {
		return isOrderLive(o, nowMs);
	}

	// merge THIS browser's just-posted orders (staged in
	// `pendingOrders` by the post flow) so a freshly-posted order shows on
	// my/orders IMMEDIATELY as a data-bearing placeholder, ~50-90s before the
	// durable indexer surfaces it (the fast head-tailer is chat-only by design,
	// so paid order posts correctly aren't in it). Self-reconciling:
	// mergePendingOrders drops an entry the instant the confirmed list contains
	// it or it ages past PENDING_TTL_MS.
	const mergedItems = $derived(mergePendingOrders(items, $pendingOrders, nowMs));
	// Which merged rows are still PROVISIONAL (broadcast, not yet durable). Their
	// card shows a "Posting…" pill + an ARMING (disabled) Feature button — a
	// feature bid needs a confirmed order, so featuring is IMPOSSIBLE until then.
	// HARD RULE: presentational/arming ONLY, never a real feature action before
	// the order exists on chain.
	const provisionalKeys = $derived(
		pendingOrderKeys($pendingOrders, new Set(items.map(orderEchoKey)), nowMs)
	);
	function isProvisional(o: OrderRecord): boolean {
		return provisionalKeys.has(orderEchoKey(o));
	}
	// poll the indexer while ANY order is still provisional, so
	// its confirmed row lands (and drops the placeholder) on its own. Depends on
	// the BOOLEAN, not on `nowMs`, so it doesn't tear down + re-arm every tick —
	// it (re)arms only when provisional-ness flips, and self-stops the instant
	// nothing is provisional (confirmed, or aged out at PENDING_TTL_MS).
	const hasProvisional = $derived(provisionalKeys.size > 0);
	$effect(() => {
		if (!hasProvisional) return;
		const iv = setInterval(() => {
			void silentRefetch();
		}, 10_000);
		return () => clearInterval(iv);
	});
	// a ~1-minute countdown for the "Posting…" pill so the user
	// has a sense of how long until the order is durable (and the Feature button
	// un-arms). Basis is the order's own created_at (broadcast time, set at
	// addPendingOrder); clamped to [0,60] and reads `nowMs` so it ticks. Returns
	// 0 once elapsed — the pill then shows just "Posting…" (no stuck 0:00), the
	// poll above having almost certainly swapped in the real card by then.
	function postingCountdownSeconds(o: OrderRecord): number {
		const createdMs = new Date(o.created_at).getTime();
		if (!Number.isFinite(createdMs)) return 0;
		const remain = 60 - Math.floor((nowMs - createdMs) / 1000);
		return remain > 0 ? Math.min(60, remain) : 0;
	}
	function postingCountdownLabel(o: OrderRecord): string {
		const s = postingCountdownSeconds(o);
		return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	}
	// the post-confirmation "set up a featured bid" link deep-
	// links here as /my/orders?featuring=<permlink>; we ring + scroll that card so
	// the user lands right on the order they want to feature.
	const featuringPermlink = $derived($page.url.searchParams.get('featuring'));

	const visibleItems = $derived.by(() => {
		switch (filter) {
			case 'live':
				return mergedItems.filter((o) => isLive(o) && !paidPermlinks.has(o.permlink));
			case 'paid':
				return mergedItems.filter((o) => o.status === 'completed' || paidPermlinks.has(o.permlink));
			case 'cancelled':
				return mergedItems.filter((o) => o.status === 'cancelled');
			case 'expired':
				return mergedItems.filter((o) => isExpired(o));
			default:
				return mergedItems;
		}
	});

	// ─── Derived helpers ───────────────────────────────────────────
	function withinEditWindow(o: OrderRecord): boolean {
		if (!isLive(o)) return false;
		const createdMs = new Date(o.created_at).getTime();
		// Read nowMs (the live ticker) so callers re-evaluate when
		// the second hand moves.  Pre-Part-68 this read Date.now()
		// directly, which only updated on full re-render.
		return nowMs - createdMs < EDIT_WINDOW_MS;
	}

	/** Sally finding M1/M8: live remaining-seconds helper
	 *  for the edit-window countdown chip.  Returns null when the
	 *  window has expired, so the template can fall back to the
	 *  "edit window expired" copy. */
	function editWindowRemainingSeconds(o: OrderRecord): number | null {
		if (!isLive(o)) return null;
		// #21 — the rule + the formatter now live in `$lib/orders/editWindow`, so
		// this page and the order-detail page cannot drift apart on what "15
		// minutes" means or how it's rendered.
		return editWindowRemainingSecondsFor(o.created_at, nowMs);
	}

	/** The "Editing closed (15 min window)" note only shows during a
	 *  short grace period after the edit window lapses. Once the order
	 *  has been live ≥20 minutes the note stops showing (reactive via
	 *  nowMs) — by then the note is just noise in the action column. */
	function withinEditClosedNotice(o: OrderRecord): boolean {
		if (!isLive(o)) return false;
		const age = nowMs - new Date(o.created_at).getTime();
		return age >= EDIT_WINDOW_MS && age < 20 * 60 * 1000;
	}

	/** Format a seconds count as `1m 23s` / `42s` for the
	 *  countdown chip.  Hours are not possible inside a 15-minute
	 *  window, so the format only handles minutes + seconds. */


	function formatAmount(n: number | null): string {
		if (n === null) return '';
		return n % 1 === 0 ? String(n) : n.toFixed(2);
	}

	function cardTitle(o: OrderRecord): string {
		const goodsLabel = o.specific_barter_title || ($_('order_title.goods_services') as string);
		const tp = orderTitleParts(o, formatAmount, goodsLabel, { locale: currentLang });
		return $_(tp.key, { values: tp.values }) as string;
	}

	function stateLabel(o: OrderRecord): string {
		// A completed trade reads "Completed" regardless of the clock — the
		// seller marked it done, so it's not "Expired" even if past expires_at.
		if (o.status === 'completed') return $_('my_orders.order.state_completed');
		// A 'live' order past its expires_at reads "Expired", matching the
		// orderbook (which has already dropped it) — see isExpired().
		if (isExpired(o)) return $_('my_orders.order.state_expired');
		switch (o.status) {
			case 'live':
				return $_('my_orders.order.state_live');
			case 'cancelled':
				return $_('my_orders.order.state_cancelled');
			case 'expired':
				return $_('my_orders.order.state_expired');
			default:
				return '';
		}
	}

	function feeStatusLabel(o: OrderRecord): string {
		switch (o.fee_status) {
			case 'verified':
				return $_('my_orders.order.fee_verified');
			case 'pending_external':
				return $_('my_orders.order.fee_pending_external');
			case 'verified_by_attestation':
				return $_('my_orders.order.fee_verified_by_attestation');
			case 'reused':
				return $_('my_orders.order.fee_reused');
			case 'awaiting_payment':
				// v1.20.0 (MK-H2): posted with its own BTC fee address, not yet paid.
				return $_('my_orders.order.fee_awaiting_payment');
			case 'proof_unsupported':
				// v1.20.0 (M-X1): an XMR order with an OutProof only — cannot be checked.
				return $_('my_orders.order.fee_proof_unsupported');
			case 'missing':
				return $_('my_orders.order.fee_missing');
			case 'underpaid':
				return $_('my_orders.order.fee_underpaid');
			case 'unverified':
				// The DB-default initial state (order.ts always writes a
				// definite status, so this is only reached by a row left
				// at the column default — a migration artifact or a future
				// handler that forgets to set it). Neutral, NOT a rejection
				// — mirrors order-detail's `fee_unverified` ("Not yet
				// verified"), and the ink branch below keeps it out of the
				// red "fee rejected" treatment.
				return $_('my_orders.order.fee_unverified');
			default:
				// Future-proof: if the indexer adds a new fee_status
				// we don't recognize, fall back to the raw string
				// rather than rendering an empty pill.  Order_detail
				// uses the same defensive pattern.
				return o.fee_status ?? '';
		}
	}

	// ─── Re-list flow (item 4) ─────────────────────────────────────
	/** Re-list an EXPIRED or CANCELLED order.  Maps the OrderRecord back to the
	 *  ComposeDraft shape via the post-page's session-storage prefill
	 *  hook, then navigates.  The user reviews on /post (everything
	 *  pre-filled), edits if desired, optionally promotes to Featured,
	 *  pays a fresh listing fee.  This is NOT an "edit" — it produces
	 *  a brand new order with a fresh permlink and expiration; the
	 *  original stays expired/cancelled.  No silent re-sign of an old listing.
	 *
	 *  Cancelled orders qualify for the same reason expired ones do:
	 *  you cancelled because the terms went stale or the trade fell through,
	 *  and retyping the whole listing to try again is busywork. The cancelled
	 *  order is immutable on-chain and stays cancelled — re-listing only
	 *  pre-fills a new one.
	 *
	 *  Defensive about price_model shape: the on-chain field is
	 *  opaque (Record<string, unknown>) by typing.  We pattern-match
	 *  for the two known shapes ({kind:'spread',percent} or
	 *  {kind:'fixed',price}); anything else falls through to default
	 *  spread=0 so the user can fix manually.
	 */
	function relistOrder(o: OrderRecord): void {
		safeSession.set(RELIST_PREFILL_KEY, JSON.stringify(buildRelistPrefill(o, currentLang)));
		void gotoLocale('/post');
	}

	// ─── Cancel flow ───────────────────────────────────────────────
	function requestCancel(permlink: string): void {
		pendingCancelPermlink = permlink;
		cancelErrorPermlink = null;
		cancelErrorMessage = '';
	}

	function abortCancel(): void {
		pendingCancelPermlink = null;
	}

	async function confirmCancel(permlink: string): Promise<void> {
		const state = get(identity);
		if (state.state !== 'unlocked') {
			cancelErrorPermlink = permlink;
			cancelErrorMessage = $_('post_order.broadcast_error.body_locked');
			pendingCancelPermlink = null;
			return;
		}

		cancelErrorPermlink = null;
		cancelErrorMessage = '';

		try {
			await broadcastOrderCancel(state.live, permlink);
			// Success — the cancel is on chain. The indexer lags ~1min, so do
			// NOT block on a refetch (it would still report 'live' and leave the
			// modal sitting open). Instead give INSTANT feedback:
			// record the cancel + optimistically flip this order to 'cancelled'
			// right here, so the card AND the Live/Cancelled pill counts update
			// immediately (counts derive from `items`), then close the modal.
			recordCancel(permlink);
			items = applyRecentCancels(items);
			pendingCancelPermlink = null;
			// Background reconcile (non-blocking) — picks up anything else that
			// changed; applyRecentCancels inside load() keeps THIS order shown as
			// cancelled until the indexer catches up.
			void (async () => {
				await new Promise((r) => setTimeout(r, 1_500));
				await load();
			})();
		} catch (err) {
			console.warn('[my/orders] cancel broadcast failed:', err);
			cancelErrorPermlink = permlink;
			if (err instanceof BroadcastError && err.code === 'locked') {
				cancelErrorMessage = $_('post_order.broadcast_error.body_locked');
			} else if (err instanceof KeystoreError && err.kind === 'bad_password') {
				cancelErrorMessage = $_('post_order.broadcast_error.body_bad_password');
			} else if (err instanceof KeystoreError && err.kind === 'identity_mismatch') {
				cancelErrorMessage = $_('crypto.error.identity_mismatch');
			} else {
				cancelErrorMessage = $_('post_order.broadcast_error.body_generic');
			}
		} finally {
			pendingCancelPermlink = null;
		}
	}

	function requestComplete(permlink: string): void {
		pendingCompletePermlink = permlink;
		completeErrorPermlink = null;
		completeErrorMessage = '';
	}

	function abortComplete(): void {
		pendingCompletePermlink = null;
	}

	async function confirmComplete(permlink: string): Promise<void> {
		const state = get(identity);
		if (state.state !== 'unlocked') {
			completeErrorPermlink = permlink;
			completeErrorMessage = $_('post_order.broadcast_error.body_locked');
			pendingCompletePermlink = null;
			return;
		}

		completeErrorPermlink = null;
		completeErrorMessage = '';

		try {
			// v1.20.0 (G7) — name the counterparty when it is unambiguous (one
			// reviewable peer, else the verified payer) so the buyer is credited
			// the trade; the indexer records it only with a provable conversation.
			const peers = reviewableCounterparties[permlink];
			const counterparty =
				peers && peers.length === 1 ? peers[0] : get(tradeStates).get(permlink)?.engagedPeer;
			await broadcastOrderComplete(state.live, permlink, counterparty || undefined);
			// Optimistic (same bridge as cancel): flip to 'completed' so the card
			// + Live/Paid pill counts update instantly; the indexer lags ~1min.
			recordComplete(permlink);
			items = applyRecentCompletes(items);
			pendingCompletePermlink = null;
			void (async () => {
				await new Promise((r) => setTimeout(r, 1_500));
				await load();
			})();
		} catch (err) {
			console.warn('[my/orders] complete broadcast failed:', err);
			completeErrorPermlink = permlink;
			if (err instanceof BroadcastError && err.code === 'locked') {
				completeErrorMessage = $_('post_order.broadcast_error.body_locked');
			} else if (err instanceof KeystoreError && err.kind === 'bad_password') {
				completeErrorMessage = $_('post_order.broadcast_error.body_bad_password');
			} else if (err instanceof KeystoreError && err.kind === 'identity_mismatch') {
				completeErrorMessage = $_('crypto.error.identity_mismatch');
			} else {
				completeErrorMessage = $_('post_order.broadcast_error.body_generic');
			}
		} finally {
			pendingCompletePermlink = null;
		}
	}

	// per-locale internal-link wrapper.  See
	// $i18n/path.localePath() + the analogous helper in
	// [lang]/+layout.svelte for design rationale.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<Head routeKey="my_orders" noindex />

<div class="mx-auto max-w-4xl px-4 py-10 md:py-14">
	<header class="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
		<div>
			<h1 class="font-display text-3xl font-extrabold">
				<span class="brand-gradient-text">{$_('my_orders.heading')}</span>
			</h1>
			<p class="mt-2 text-ink-700 dark:text-ink-200">{$_('my_orders.subtitle')}</p>
			{#if blurtAccount}
				<!-- Batch K: link to user's account on our explorer.
				     Surfaces every chain op the user has authored,
				     including order posts, replace/cancel, feedback. -->
				<p class="mt-2 text-sm">
					<a href={lp(`/explorer/account/${blurtAccount}`)} class="text-morphit-emerald">
						{$_('my_orders.view_on_explorer')}
						<span class="nav-arrow nav-arrow-right" aria-hidden="true">⇨</span>
					</a>
				</p>
			{/if}
		</div>
		<a href={lp('/post')} class="btn-primary-sm self-start whitespace-nowrap">
			{$_('orderbook.post_cta')}
		</a>
	</header>

	<!-- Item 3: pending-feedback reminder banner.  Lists trades
	     where the counterparty has reviewed > 48h ago and the
	     user hasn't reciprocated.  Embeds LeaveFeedbackForm
	     inline so the user doesn't have to scroll-and-find. -->
	{#if blurtAccount && $hasAnySession}
		{#await loadPendingFeedbackReminderBanner() then PendingFeedbackReminderBanner}
			<PendingFeedbackReminderBanner />
		{/await}
	{/if}

	{#if !blurtAccount}
		<section class="card text-center">
			<h2 class="font-display text-xl font-bold">
				{$_('my_orders.no_account.title')}
			</h2>
			<p class="mt-2 text-ink-600 dark:text-ink-300">
				{$_('my_orders.no_account.body')}
			</p>
			<div class="mt-4 flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
				<BusyButton variant="primary" onclick={() => gotoLocale('/onboarding/register-name')}>
					{$_('my_orders.no_account.cta_register')}
				</BusyButton>
				<BusyButton variant="secondary" onclick={() => gotoLocale('/onboarding/import')}>
					{$_('my_orders.no_account.cta_unlock')}
				</BusyButton>
			</div>
		</section>
	{:else if !$isUnlocked && !$isPairedReadOnly}
		<!-- only block on "locked" when there is no
		     paired-readonly session either.  Paired sessions fall
		     through to the normal render path; the per-row write
		     affordances swap to WriteBlockedReadOnly inline cards
		     pointing the user at their phone.  Without this branch
		     widening, paired users hit a misleading "session locked,
		     unlock to continue" CTA they can't satisfy (their keys
		     live on their phone). -->
		<section class="card">
			<h2 class="font-display text-xl font-bold">{$_('my_orders.locked.title')}</h2>
			<p class="mt-2 text-ink-600 dark:text-ink-300">{$_('my_orders.locked.body')}</p>
			<div class="mt-4">
				<BusyButton variant="primary" onclick={() => gotoLocale('/onboarding/import')}>
					{$_('common.unlock')}
				</BusyButton>
			</div>
		</section>
	{:else if phase === 'loading'}
		<StatusLine kind="loading">{$_('my_orders.loading')}</StatusLine>
	{:else if phase === 'error'}
		<section class="card border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-950" role="alert">
			<h2 class="font-display text-lg font-bold text-red-900 dark:text-red-100">
				{$_('my_orders.error_title')}
			</h2>
			<p class="mt-2 text-sm text-red-800 dark:text-red-200">{$_('my_orders.error_body')}</p>
			<p class="mt-1 text-xs text-red-700 dark:text-red-300">{errorMessage}</p>
			<div class="mt-4">
				<BusyButton variant="primary" onclick={load}>
					{$_('common.retry')}
				</BusyButton>
			</div>
		</section>
	{:else if mergedItems.length === 0}
		<section class="card text-center">
			<h2 class="font-display text-lg font-bold">{$_('my_orders.empty_title')}</h2>
			<p class="mt-2 text-ink-600 dark:text-ink-300">{$_('my_orders.empty_body')}</p>
			<div class="mt-6">
				<BusyButton variant="primary" onclick={() => gotoLocale('/post')}>
					{$_('my_orders.empty_cta')}
				</BusyButton>
			</div>
		</section>

		<!-- Item 16 phase 3 (Item 1.2 from grandma investigation):
		     post-onboarding "what's next" panel.  Surfaces three
		     concrete next steps so a freshly-onboarded user doesn't
		     hit a dead end on /my/orders.  Only renders for the
		     truly-fresh case (zero orders).  -->
		<section class="mt-6">
			<h2 class="mb-4 font-display text-base font-bold">
				{$_('my_orders.next_steps.heading')}
			</h2>
			<div class="grid gap-3 sm:grid-cols-3">
				<a
					href={lp('/orderbook')}
					class="card text-left transition hover:-translate-y-1 hover:border-morphit-emerald hover:shadow-lg active:translate-y-0 active:scale-[0.99]"
				>
					<p class="text-2xl">🔍</p>
					<h3 class="mt-2 font-display text-base font-bold">
						{$_('my_orders.next_steps.browse_title')}
					</h3>
					<p class="mt-1 text-sm text-ink-600 dark:text-ink-300">
						{$_('my_orders.next_steps.browse_body')}
					</p>
				</a>
				<a
					href={lp('/post')}
					class="card text-left transition hover:-translate-y-1 hover:border-morphit-emerald hover:shadow-lg active:translate-y-0 active:scale-[0.99]"
				>
					<p class="text-2xl">✍️</p>
					<h3 class="mt-2 font-display text-base font-bold">
						{$_('my_orders.next_steps.post_title')}
					</h3>
					<p class="mt-1 text-sm text-ink-600 dark:text-ink-300">
						{$_('my_orders.next_steps.post_body')}
					</p>
				</a>
				<a
					href={lp('/faq#how_to_trade_walkthrough')}
					class="card text-left transition hover:-translate-y-1 hover:border-morphit-emerald hover:shadow-lg active:translate-y-0 active:scale-[0.99]"
				>
					<p class="text-2xl">📖</p>
					<h3 class="mt-2 font-display text-base font-bold">
						{$_('my_orders.next_steps.walkthrough_title')}
					</h3>
					<p class="mt-1 text-sm text-ink-600 dark:text-ink-300">
						{$_('my_orders.next_steps.walkthrough_body')}
					</p>
				</a>
			</div>
		</section>
	{:else}
		<!-- Filter chips -->
		<section class="mb-4">
			<p class="mb-2 text-sm font-semibold">{$_('my_orders.filter.heading')}</p>
			<div class="flex gap-2">
				{#each ['all', 'live', 'paid', 'cancelled', 'expired'] as f}
					<button
						type="button"
						onclick={() => (filter = f as FilterKind)}
						class="rounded-full border-2 px-4 py-1 text-sm transition active:scale-[0.98] {filter ===
						f
							? 'border-morphit-emerald bg-emerald-50 dark:bg-ink-800'
							: 'border-ink-200 hover:border-morphit-emerald hover:text-morphit-emerald dark:border-ink-700 dark:hover:border-morphit-emerald dark:hover:text-morphit-emerald'}"
					>
						{$_(`my_orders.filter.${f}`)}
						<span class="ml-1 text-xs text-ink-500">
							({counts[f as FilterKind]})
						</span>
					</button>
				{/each}
			</div>
		</section>

		<!-- Fee-status explainer. Carries the #fee-status anchor that the
		     orderbook's "Posted an order but don't see it?" link targets,
		     so arriving here lands on a clear explanation of why an order
		     might be missing from the public orderbook. scroll-mt keeps it
		     clear of the sticky header. -->
		{#if !feeStatusBannerDismissed}
			<section
				id="fee-status"
				class="relative mb-3 scroll-mt-20 rounded-xl border border-ink-200 bg-ink-50 p-3 pe-9 text-sm dark:border-ink-700 dark:bg-ink-900"
				aria-labelledby="fee-status-heading"
			>
				<button
					type="button"
					aria-label={$_('my_orders.fee_status_banner.dismiss')}
					title={$_('my_orders.fee_status_banner.dismiss') as string}
					onclick={dismissFeeStatusBanner}
					class="absolute end-2 top-2 flex h-6 w-6 items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-ink-200 hover:text-ink-700 dark:hover:bg-ink-800 dark:hover:text-ink-200"
				>
					✕
				</button>
				<p id="fee-status-heading" class="mb-1 font-semibold">
					{$_('my_orders.fee_status_banner.heading')}
				</p>
				<p class="text-ink-600 dark:text-ink-300">
					{$_('my_orders.fee_status_banner.body')}
				</p>
			</section>
		{/if}

		<!-- Orders list -->
		<ul class="space-y-3">
			{#each visibleItems as o (o.permlink)}
				{@const priceModelLabel = formatOrderPriceModel(
					o,
					$_ as unknown as Parameters<typeof formatOrderPriceModel>[1]
				)}
				<li
					id="order-{o.permlink}"
					class="card-interactive scroll-mt-20 card-hover-emerald {o.permlink === featuringPermlink
						? 'ring-2 ring-morphit-emerald ring-offset-2 dark:ring-offset-ink-900'
						: ''}"
				>
					<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
						<div class="flex-1">
							<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
								<span class="font-display text-lg font-bold">
									{cardTitle(o)}
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
							<div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
								{#if isProvisional(o)}
									<!-- just-posted, not yet durable: a "Posting…" pill
									     (animated dot) says so at a glance; drops to the normal pills the
									     instant the indexer confirms the order. -->
									<span
										class="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 font-semibold text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200"
									>
										<span class="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500"></span>
										{$_('my_orders.order.posting')}
										{#if postingCountdownSeconds(o) > 0}
											<span class="tabular-nums opacity-75">{postingCountdownLabel(o)}</span>
										{/if}
									</span>
								{/if}
								{#if !paidPermlinks.has(o.permlink) && !(o.status === 'completed' && o.completed_counterparty) && !isProvisional(o)}
									<!-- v1.5.0 — a verifiably-paid order is effectively taken; hide
									     the "Visible in orderbook" state pill (the "Paid by @peer"
									     badge below conveys the state). -->
									<span
										class="rounded-full border px-2 py-0.5 font-semibold {isLive(o)
											? 'border-morphit-emerald bg-emerald-50 text-emerald-900 dark:bg-ink-800 dark:text-emerald-100'
											: 'border-ink-300 text-ink-600 dark:border-ink-600 dark:text-ink-300'}"
									>
										{stateLabel(o)}
									</span>
								{/if}
								<PaymentStatusBadge
									orderPermlink={o.permlink}
									completedCounterparty={o.completed_counterparty ?? null}
								/>
								{#if !isLive(o)}
									<!-- an order that is no longer live (EXPIRED or
									     CANCELLED) is not on the orderbook anymore. This is NOT a
									     fee problem, so it gets a neutral "Not visible" pill and NO
									     "Learn more → order_fee_rejected" link. Previously a
									     verified-but-expired order fell through to the red rejected
									     branch, and a verified-but-cancelled order wrongly showed a
									     green "Visible in orderbook" pill. -->
									<span
										class="rounded-full border border-ink-300 bg-ink-50 px-2 py-0.5 text-ink-600 dark:border-ink-600 dark:bg-ink-800 dark:text-ink-300"
									>
										{$_('my_orders.order.not_visible_orderbook')}
									</span>
								{:else if o.fee_status === 'verified' || o.fee_status === 'verified_by_attestation'}
									<span
										class="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-emerald-900 dark:bg-ink-800 dark:text-emerald-100"
									>
										{feeStatusLabel(o)}
									</span>
								{:else if o.fee_status === 'pending_external' || o.fee_status === 'unverified' || o.fee_status === 'awaiting_payment'}
									<span
										class="rounded-full border border-ink-300 bg-ink-50 px-2 py-0.5 text-ink-700 dark:bg-ink-800 dark:text-ink-200"
									>
										{feeStatusLabel(o)}
									</span>
								{:else if o.fee_status}
									<span
										class="rounded-full border border-red-400 bg-red-50 px-2 py-0.5 text-red-900 dark:bg-red-950 dark:text-red-100"
									>
										{feeStatusLabel(o)}
									</span>
									<a
										href={lp('/faq#order_fee_rejected')}
										class="text-ink-500 underline hover:no-underline"
									>
										{$_('common.learn_more')}
									</a>
								{/if}
								<span class="text-ink-500">
									{$_('my_orders.order.posted_prefix')}
									<RelativeTime iso={o.created_at} format="terse" ago />
								</span>
								{#if viewCounts[o.permlink] !== undefined && viewCounts[o.permlink]! > 0}
									<!-- Task #14 — viewcount badge.  Visible only
									     to the order's author (this page only ever
									     shows the author's own orders).  Count is
									     non-unique by design — see
									     lib/orders/views.ts for the privacy
									     rationale. -->
									<span class="text-ink-500" title={$_('my_orders.order.viewed_tooltip')}>
										<span aria-hidden="true">👁</span>
										{$_('my_orders.order.viewed_count', {
											values: { count: viewCounts[o.permlink] }
										})}
									</span>
								{/if}
							</div>

							<!-- Order details: where, how, and when it expires —
							     the same facts the public order page shows, at a
							     glance for the owner. -->
							<dl class="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs">
								{#if o.payment_methods.length > 0}
									<div>
										<dt class="inline text-ink-500">{$_('order_detail.payment_methods')}:</dt>
										<dd class="inline text-ink-700 dark:text-ink-200">
											{displayNamesForMethods(o.payment_methods, instLookup).join(', ')}
										</dd>
									</div>
								{/if}
								{#if o.location_region}
									<div>
										<dt class="inline text-ink-500">{$_('order_detail.location')}:</dt>
										<dd class="inline text-ink-700 dark:text-ink-200">{o.location_region}</dd>
									</div>
								{/if}
								{#if o.expires_at}
									<div>
										<dt class="inline text-ink-500">{$_('order_detail.expires_on')}:</dt>
										<dd class="inline text-ink-700 dark:text-ink-200">
											{o.status === 'cancelled'
												? $_('my_orders.order.state_cancelled')
												: isExpired(o)
													? $_('my_orders.order.state_expired')
													: formatDayMonth(o.expires_at)}
										</dd>
									</div>
								{/if}
							</dl>

							{#if o.terms}
								<div class="mt-2 text-sm text-ink-700 dark:text-ink-200">
									<TermsText text={o.terms} />
								</div>
							{/if}
						</div>

						<!-- Action column -->
						<!-- t155: "look at the green buttons that say 'Re-list this order'.
						     THAT is the size of the buttons that i want." Re-list is already
						     `size="sm"` — and so were these. The size prop was never the
						     problem: this column was `flex-col` (children STRETCH to the
						     column width) with a `sm:min-w-[10rem]` floor, so the actions were
						     forced to >=160px wide regardless of their labels. Re-list sits in a
						     plain flex-col with no floor, so it hugs its text — the exact
						     difference the maintainer is pointing at. `items-end` lets each button size to
						     its own label and keeps the column right-aligned against the card
						     edge. -->
						<!-- fixed-width action column with items-stretch so
						     Edit / Feature / "No chats" / Cancel all render the SAME width. -->
						<div class="flex w-44 flex-none flex-col items-stretch gap-2">
							{#if isProvisional(o)}
								<!-- the just-posted order is not on-chain-confirmed
								     yet, so featuring it is IMPOSSIBLE (a feature bid needs a live
								     order). Show an ARMING, disabled Feature button — presentational
								     ONLY, never a real feature action — that lights up the moment the
								     order confirms and this becomes a normal live row. -->
								<BusyButton size="sm" variant="secondary" fullWidth disabled>
									🚀 {$_('my_orders.order.action_feature')}
								</BusyButton>
								<span class="text-center text-[11px] text-ink-500 dark:text-ink-400">
									{$_('my_orders.order.feature_arming_hint')}
								</span>
							{:else if isLive(o)}
								{#if withinEditWindow(o)}
									{@const remaining = editWindowRemainingSeconds(o)}
									<!-- edit-window countdown MERGED INTO the Edit
									     button (was an amber pill above an oversized button); now compact
									     (size="sm"), full-width, with the ✏️ glyph to match 🚀 on Feature. -->
									<BusyButton
										size="sm"
										variant="secondary"
										fullWidth
										onclick={() => gotoLocale(`/post/edit/${o.permlink}`)}
									>
										✏️ {$_('my_orders.order.action_edit')}{#if remaining !== null} · {formatRemainingMmSs(
											remaining
										)}{/if}
									</BusyButton>
								{:else if withinEditClosedNotice(o)}
									<span class="text-center text-xs text-ink-500">
										{$_('my_orders.order.action_edit_expired')}
									</span>
								{/if}

								<!-- Feature-bid disclosure. Only appears when requested
								     and hides itself on cancel / success. The form
								     pulls identity state itself; no prop plumbing
								     needed. -->
								{#if pendingFeaturePermlink === o.permlink && $isUnlocked}
									<!-- Feature form renders full-width below the card
									     body so it doesn't squeeze the action column. -->
								{:else if featureSuccessPermlink === o.permlink}
									{#if featureSuccessVerdict?.kind === 'queued'}
										<StatusLine kind="ok">
											{$_('feature_bid.result_queued', {
												values: {
													blurt: featureSuccessBlurt ?? 0,
													when: formatDayMonthTime(featureSuccessVerdict.startsAt)
												}
											})}
										</StatusLine>
									{:else if featureSuccessVerdict?.kind === 'waiting'}
										<StatusLine kind="ok">
											{$_('feature_bid.result_waiting', {
												values: { blurt: featureSuccessBlurt ?? 0 }
											})}
										</StatusLine>
									{:else if featureSuccessVerdict?.kind === 'pending'}
										<StatusLine kind="warn">
											{$_('feature_bid.result_unconfirmed', {
												values: { blurt: featureSuccessBlurt ?? 0 }
											})}
										</StatusLine>
									{:else}
										<StatusLine kind="ok">
											{$_('feature_bid.success', {
												values: { blurt: featureSuccessBlurt ?? 0 }
											})}
										</StatusLine>
									{/if}
								{:else if o.fee_status === 'verified' || o.fee_status === 'verified_by_attestation'}
									{#if $isPairedReadOnly}
										<!-- paired-readonly users see an inline
										     affordance pointing them at their phone instead
										     of a button that opens a form they can't sign.
										     Permlink is preserved in the deep link
										     (#feature=<permlink>) so the phone opens
										     that order's feature form. -->
										<WriteBlockedReadOnly
											variant="feature_order"
											orderPermlink={o.permlink}
											density="inline"
										/>
									{:else if !paidPermlinks.has(o.permlink)}
										<BusyButton
											size="sm"
											variant="secondary"
											fullWidth
											onclick={() => {
												pendingFeaturePermlink = o.permlink;
												// Lazy-fetch the operator's configured
												// per-hour rate.  Resolves quickly; the
												// form opens with the bundled default and
												// re-renders once the real value lands.
												void ensureFeatureRateFetched();
												// smooth-scroll down to the form.
												scrollToFeatureForm(o.permlink);
											}}
										>
											🚀 {$_('my_orders.order.action_feature')}
										</BusyButton>
									{/if}
								{/if}

								<!-- Feedback disclosure: user marks this trade
								     complete + reviews their counterparty. Per
								     ADR-0011 §8, feedback IS the trade-complete
								     signal. -->
								{#if pendingFeedbackPermlink === o.permlink && $isUnlocked}
									<!-- Feedback form renders full-width below the card
									     body so it doesn't squeeze the action column. -->
								{:else if feedbackSuccessPermlink === o.permlink}
									<StatusLine kind="ok">
										{$_('feedback.success_line')}
									</StatusLine>
								{:else if $isPairedReadOnly}
									<!-- paired-readonly affordance.  The
									     `feedback` variant deep-link expects `peer`
									     (the counterparty); orderPermlink here points
									     at the *order* so the phone can resolve the
									     counterparty.  We use the `feedback` variant
									     copy verbatim but the deep link goes to
									     /my/orders so the user lands on the same row. -->
									<WriteBlockedReadOnly
										variant="feedback"
										peer={blurtAccount}
										orderPermlink={o.permlink}
										density="inline"
									/>
								{:else if feedbackPickerPermlink === o.permlink}
									<!-- >1 reviewable trade partner — ask which
									     one before opening the (subject-locked) form. -->
									<div class="flex flex-col gap-2">
										<p class="text-xs text-ink-500 dark:text-ink-400">
											{$_('my_orders.order.feedback_pick_prompt')}
										</p>
										<!-- v1.5.0: tight avatar menu (reads like a select) —
										     keeps the identicon so look-alike handles can't be
										     confused. Picking opens the subject-locked form. -->
										<div
											class="divide-y divide-morphit-emerald/20 overflow-hidden rounded-xl border-2 border-morphit-emerald bg-morphit-emerald/5"
										>
											{#each reviewableCounterparties[o.permlink] ?? [] as peer (peer)}
												<button
													type="button"
													class="flex w-full items-center px-3 py-2 text-left text-sm transition-colors hover:bg-morphit-emerald/10 focus:outline-none focus-visible:bg-morphit-emerald/10"
													onclick={() => openFeedback(o.permlink, peer)}
												>
													<IdentityLabel account={peer} />
												</button>
											{/each}
										</div>
										<button
											type="button"
											class="self-start text-xs text-ink-500 underline hover:text-ink-700 dark:text-ink-400 dark:hover:text-ink-200"
											onclick={() => (feedbackPickerPermlink = null)}
										>
											{$_('common.cancel')}
										</button>
									</div>
								{:else if reviewableCounterparties[o.permlink]?.length === 0}
									<!-- v1.5.0: loaded, but nobody has provably
									     traded on this order yet (no two-way conversation), so
									     there's no one to review. The maintainer now wants an explicit
									     empty-state here (superseding the earlier #8 "render
									     nothing"), worded clearly so it doesn't read as a
									     broken review prompt. -->
									<div
										class="rounded-xl border-2 border-morphit-emerald/40 bg-morphit-emerald/5 px-3 py-2 text-xs text-ink-500 dark:text-ink-400"
									>
										{$_('my_orders.order.feedback_no_counterparty')}
									</div>
								{:else}
									<BusyButton size="sm" variant="secondary" fullWidth onclick={() => startFeedback(o.permlink)}>
										{$_('my_orders.order.action_feedback')}
									</BusyButton>
								{/if}

								{#if $isPairedReadOnly}
									<!-- paired-readonly users see an inline
									     affordance.  The #cancel=<permlink> deep link
									     opens that order's cancel confirmation. -->
									<WriteBlockedReadOnly
										variant="cancel_order"
										orderPermlink={o.permlink}
										density="inline"
									/>
								{:else}
									{#if !paidPermlinks.has(o.permlink)}
										<BusyButton size="sm" variant="danger" fullWidth onclick={() => requestCancel(o.permlink)}>
											{$_('order_detail.cancel_button')}
										</BusyButton>
									{/if}
								{/if}
								{#if !$isPairedReadOnly && $tradeStates.has(o.permlink)}
									<!-- v1.5.0 — "Mark as complete": second removal path parallel to
									     Cancel, shown once a trade is in progress on this live order.
									     For on-chain Blurt trades the auto-complete effect usually
									     fires first; this is the reliable path for off-chain
									     settlements (BTC/XMR/cash) and a manual force. -->
									<BusyButton size="sm" variant="secondary" fullWidth onclick={() => requestComplete(o.permlink)}>
										{$_('my_orders.order.action_complete')}
									</BusyButton>
								{/if}
							{:else if o.status === 'cancelled'}
								<span
									class="self-end rounded-full border border-ink-300 px-2.5 py-0.5 text-xs font-semibold text-ink-500 dark:border-ink-600 dark:text-ink-400"
								>
									{$_('my_orders.order.action_cancelled')}
								</span>
								<!-- a cancelled order can be re-listed, exactly like an expired
								     one: same pre-filled form, fresh permlink, fresh listing fee. The
								     cancelled order itself is immutable on-chain and stays cancelled. -->
								<BusyButton size="sm" variant="secondary" onclick={() => relistOrder(o)}>
									{$_('my_orders.order.action_relist')}
								</BusyButton>
								<span class="max-w-[13rem] text-xs text-ink-500 dark:text-ink-400">
									{$_('my_orders.order.action_relist_hint')}
								</span>
							{:else if o.status === 'completed' || paidPermlinks.has(o.permlink)}
								<!-- a Paid order can be re-listed too (you sold, and want to
								     offer the same again): same pre-filled form, fresh permlink,
								     fresh listing fee.  The paid order itself is immutable on-chain
								     and stays as it is.  Matches the 'paid' filter's own test
								     (status 'completed' OR a verified paid permlink); in-progress
								     live orders are caught by the isLive branch above, so this only
								     fires on a settled one. -->
								<BusyButton size="sm" variant="secondary" onclick={() => relistOrder(o)}>
									{$_('my_orders.order.action_relist')}
								</BusyButton>
								<span class="max-w-[13rem] text-xs text-ink-500 dark:text-ink-400">
									{$_('my_orders.order.action_relist_hint')}
								</span>
							{:else if isExpired(o)}
								<!-- Item 4: Re-list expired orders.  Pre-fills the
								     post form with the original terms; user can edit,
								     promote to Featured, pays a fresh listing fee.
								     Avoids retyping. -->
								<BusyButton size="sm" variant="secondary" onclick={() => relistOrder(o)}>
									{$_('my_orders.order.action_relist')}
								</BusyButton>
								<span class="max-w-[13rem] text-xs text-ink-500 dark:text-ink-400">
									{$_('my_orders.order.action_relist_hint')}
								</span>
							{/if}
							{#if cancelErrorPermlink === o.permlink && cancelErrorMessage}
								<StatusLine kind="warn">{cancelErrorMessage}</StatusLine>
							{/if}
							{#if completeErrorPermlink === o.permlink && completeErrorMessage}
								<StatusLine kind="warn">{completeErrorMessage}</StatusLine>
							{/if}
						</div>
					</div>
					{#if pendingFeaturePermlink === o.permlink && $isUnlocked}
						{#await loadFeatureBidForm() then FeatureBidForm}
							<div class="mt-3 scroll-mt-24" id="feature-form-{o.permlink}">
								<FeatureBidForm
									orderPermlink={o.permlink}
									feeBlurtPerHour={featureBlurtPerHour}
									onSuccess={(r) => {
										pendingFeaturePermlink = null;
										featureSuccessPermlink = o.permlink;
										featureSuccessBlurt = r.blurtPaid;
										featureSuccessVerdict = r.verdict;
										// Only a bid the indexer shows in a slot is "featured": then
										// jump to the orderbook to see it. A queued, waiting or
										// not-yet-recorded bid stays here with what it is.
										if (r.verdict.kind === 'visible') {
											addPendingFeatured(o, r.blurtPaid);
											void gotoLocale('/orderbook');
										}
									}}
									onCancel={() => (pendingFeaturePermlink = null)}
								/>
							</div>
						{:catch}
							<LazyLoadError />
						{/await}
					{/if}
					{#if pendingFeedbackPermlink === o.permlink && $isUnlocked}
						{#await loadLeaveFeedbackForm() then LeaveFeedbackForm}
							<div class="mt-3 scroll-mt-24" id="feedback-form-{o.permlink}">
								<!-- v1.5.5 — completeOwnedOrder: this page lists ONLY the
								     signed-in user's own orders, so the owner-only completion
								     guard is always satisfied here. Makes the "Mark complete /
								     review" button finally do the "mark complete" half. -->
								<LeaveFeedbackForm
									orderPermlink={o.permlink}
									prefillSubject={feedbackPrefillSubject ?? undefined}
									lockSubject={feedbackPrefillSubject !== null}
									completeOwnedOrder={true}
									onSuccess={() => {
										pendingFeedbackPermlink = null;
										feedbackPrefillSubject = null;
										feedbackSuccessPermlink = o.permlink;
									}}
									onCancel={() => {
										pendingFeedbackPermlink = null;
										feedbackPrefillSubject = null;
									}}
								/>
							</div>
						{:catch}
							<LazyLoadError />
						{/await}
					{/if}
					{#if o.fee_status === 'awaiting_payment' && o.btc_fee !== undefined && isLive(o) && blurtAccount}
						<!-- v1.20.0 (MK-H2): the order waits for its own BTC fee address to
						     be paid; show the address, amount and progress right here. -->
						<div class="mt-3">
							{#await loadBtcFeePayPanel() then BtcFeePayPanel}
								<BtcFeePayPanel account={blurtAccount} permlink={o.permlink} order={o} />
							{:catch}
								<LazyLoadError />
							{/await}
						</div>
					{/if}
				</li>
			{/each}
		</ul>
			<!-- the user HAS orders (so the "no orders at
			     all" state above did not fire), but the selected pill yields
			     none. A centered, quiet note beats a bare gap. -->
			{#if visibleItems.length === 0}
				<p class="mt-6 text-center text-sm text-ink-500 dark:text-ink-400">
					{$_('my_orders.empty_category')}
				</p>
			{/if}
	{/if}

	<ConfirmModal
		open={pendingCancelPermlink !== null}
		title={$_('my_orders.cancel.confirm_title') as string}
		body={$_('my_orders.cancel.confirm_body') as string}
		confirmLabel={$_('my_orders.cancel.confirm_button') as string}
		cancelLabel={$_('my_orders.cancel.cancel_button') as string}
		busyLabel={$_('my_orders.cancel.cancelling') as string}
		onConfirm={() => (pendingCancelPermlink ? confirmCancel(pendingCancelPermlink) : undefined)}
		onCancel={abortCancel}
	/>

	<ConfirmModal
		open={pendingCompletePermlink !== null}
		title={$_('my_orders.complete.confirm_title') as string}
		body={$_('my_orders.complete.confirm_body') as string}
		confirmLabel={$_('my_orders.complete.confirm_button') as string}
		cancelLabel={$_('my_orders.complete.cancel_button') as string}
		busyLabel={$_('my_orders.complete.completing') as string}
		onConfirm={() => (pendingCompletePermlink ? confirmComplete(pendingCompletePermlink) : undefined)}
		onCancel={abortComplete}
	/>
</div>
