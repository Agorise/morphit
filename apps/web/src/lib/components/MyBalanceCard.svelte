<!--
	Morphit — private balance card.

	Renders the user's BLURT, BP (Blurt Power), and voting power on
	their own profile page.  Visible ONLY when `viewerAccount ===
	profileAccount` (parent gate); never displayed to public viewers.

	Why:
	  - Users buy a small amount of BLURT at signup and power it up
	    into BP (staked VESTS).  More BP raises their voting-power
	    ceiling; transfers spend the liquid BLURT balance.  A visible
	    indicator lets them see where they stand at a glance.
	  - The "Top up BLURT" button pre-fills a buy order so the user
	    doesn't retype known fields.

	Data flow:
	  1. On mount, fetch the chain's get_accounts + DGP in parallel.
	  2. Compute BP from VESTS via balanceMath.vestsToBlurtPower.
	  3. Compute voting power % via balanceMath.votingPowerPercent from
	     the EFFECTIVE vesting (own + received − delegated) and the
	     present clock time.
	  4. Display.  Refresh once per minute while mounted (cheap; one
	     RPC call).

	Privacy posture: chain balances are public.  This card is private
	to the user only as a courtesy — anyone curious can fetch the
	account themselves.  No private data is exposed beyond what's
	already on chain.
-->
<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { onMount, onDestroy } from 'svelte';
	import { _, locale } from 'svelte-i18n';
	import { goto } from '$app/navigation';
	import { fetchAccountBalance } from '$blurt/accountBalance';
	import { computePowerDownProgress, type PowerDownProgress } from '$blurt/powerDownProgress';
	import { fetchAccountHistory } from '$blurt/accountHistory';
	import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';
	import { vestsToBlurtPower, votingPowerPercent, parseAssetAmount } from '$blurt/balanceMath';
	import { computeBlurtVestingApr, formatApr } from '$blurt/apr';
	import {
		categorizeOp,
		filterByDateRange,
		type HistoryOp,
		type CategorizerPredicates,
		type PnlRow
	} from '$lib/pnl/categorize';
	import { buildPnlCsv, downloadCsv } from '$lib/pnl/exportCsv';
	import { FEE_RECIPIENT, resolveFeeRecipient } from '$lib/orders/fee';
	import { getInstanceSnapshot } from '$stores/instance';
	import { fetchListingFee } from '$lib/orders/listingFee';
	import { formatFiatGlued } from '$i18n/formatters';
	import { fetchFxRates, fiatToUsd, usdToFiat } from '$lib/orders/fx';
	import type { FxResponse } from '@morphit/indexer-client';
	import { userPreferences } from '$stores/userPreferences';
	import { safeSession } from '$lib/utils/safeStorage';
	import { subscribeBalanceRefresh, triggerBalanceRefresh } from '$lib/balance/bus';
	import { broadcastClaimReward } from '$blurt/sign';
	import { liveIdentity } from '$stores/identity';
	import AnimatedNumber from '$components/AnimatedNumber.svelte';
	import Tooltip from '$components/Tooltip.svelte';
	import LazyLoadError from '$components/LazyLoadError.svelte';

	/** cp424 — the Power up / Power down modal is lazy-loaded: it pulls in
	 *  the active-key signing path (incl. the withdraw_vesting serializer +
	 *  bytebuffer), which shouldn't sit in the initial profile-card chunk
	 *  when most viewers never open it. */
	const loadPowerModal = () => import('$components/PowerModal.svelte').then((m) => m.default);

	/** cp424 — the Send modal is lazy-loaded for the same reason as
	 *  PowerModal: it pulls the active-key transfer-signing path, which
	 *  shouldn't sit in the initial profile-card chunk. */
	const loadSendModal = () => import('$components/SendBlurtModal.svelte').then((m) => m.default);

	/** The canonical operator account name (Featured-listing
	 *  revenue sink, release-op signer).  Reused as the
	 *  categorizer's "operator" predicate. */
	const OPERATOR_ACCOUNT = 'morphit';

	interface Props {
		/** The account whose balances to display.  Caller is
		 *  responsible for ensuring this matches the signed-in
		 *  user; this component does NOT enforce that gate. */
		account: string;
	}
	const { account }: Props = $props();

	type LoadState = 'loading' | 'ready' | 'error';
	let loadState = $state<LoadState>('loading');
	let errorMsg = $state('');
	let blurtBalance = $state(NaN);
	let bpBalance = $state(NaN);
	// cp510 [12] — BP delegated IN to this account (received_vesting_shares
	// converted to BP). Separate from own staked BP (vesting_shares): it's
	// power lent to the user — e.g. Morphit's welcome delegation from
	// morphit-relay — not owned stake, so it's surfaced as its own line rather
	// than folded into the "staked BLURT" figure.
	let receivedBp = $state(NaN);
	/** cp424 — captured for the Power up / Power down modal. `vestingFund`
	 *  + `totalVests` are the raw DGP pool strings that drive the BP→VESTS
	 *  conversion for a partial power-down (blurtPowerToVests parses them);
	 *  `vestingSharesRaw` is the EXACT on-chain vesting_shares string, used
	 *  verbatim for "power down everything" so no dust is left behind. */
	let vestingFund = $state('');
	let totalVests = $state('');
	let vestingSharesRaw = $state('');
	/** cp439 — in-progress power-down summary (amount left + finish date) for
	 *  the Power down modal's 💡 section. null when nothing is powering down. */
	let powerDownProgress = $state<PowerDownProgress | null>(null);
	let manaPct = $state(NaN);
	let vestingApr = $state(NaN);
	// cp396 — unclaimed author/curation rewards. `*Display` are the parsed
	// numbers shown to the user (BLURT liquid + BP via the chain's
	// reward_vesting_blurt). `*Raw` are the exact Graphene asset strings the
	// claim_reward_balance op consumes (claim ALL). `claiming` guards the
	// in-flight broadcast; `claimError` surfaces a failure inline.
	let rewardBlurt = $state(0);
	let rewardBp = $state(0);
	let rewardBlurtRaw = $state('0.000 BLURT');
	let rewardVestsRaw = $state('0.000000 VESTS');
	let claiming = $state(false);
	let claimError = $state('');
	const hasUnclaimed = $derived(rewardBlurt > 0 || rewardBp > 0);
	/** Live BLURT price in the operator's fiat, fetched from
	 *  /v1/listing-fee (present only when the operator runs the price
	 *  feed; morphit.io does). null until loaded or when unavailable —
	 *  in which case the USD-equivalent line is simply omitted. */
	let blurtPriceFiat = $state<number | null>(null);
	let denomFiat = $state('USD');
	/** cp429 — FX table (USD-anchored) so the balance's fiat value can be
	 *  shown in the USER's saved preferred fiat, not the operator's
	 *  denomination. Best-effort: null → we fall back to denomFiat. */
	let fxTable = $state<FxResponse | null>(null);
	/** "~5,67 € eur"-style approximate fiat value of the liquid BLURT balance.
	 *  Shown in the user's saved preferred fiat when set (and convertible),
	 *  otherwise the operator's denomination. The number + symbol are
	 *  locale-formatted by formatFiat (activeLocale()); the lowercase code is
	 *  appended deliberately because in many locales "$"/"€" alone is
	 *  ambiguous. null → render nothing. */
	/** cp433 — when the user hasn't explicitly chosen a display fiat, fall
	 *  back to a sensible default for their INTERFACE LANGUAGE rather than
	 *  always showing the operator's USD denomination. Language ≠ country, so
	 *  this is best-effort (a Spanish speaker in Mexico can still pick MXN in
	 *  their preferences, which always wins); it just means a German-language
	 *  user sees "€ eur" instead of "$ usd" out of the box. Any currency not
	 *  in the FX table simply falls through to the operator denomination. */
	const LOCALE_DEFAULT_FIAT: Record<string, string> = {
		en: 'USD',
		de: 'EUR',
		fr: 'EUR',
		it: 'EUR',
		es: 'EUR',
		pl: 'PLN',
		ru: 'RUB',
		'zh-CN': 'CNY',
		'zh-HK': 'HKD',
		fa: 'USD'
	};
	function localeDefaultFiat(lang: string | undefined): string | undefined {
		return lang ? LOCALE_DEFAULT_FIAT[lang] : undefined;
	}

	const usdLabel = $derived.by(() => {
		if (blurtPriceFiat === null || !Number.isFinite(blurtBalance)) return null;
		// Value in the operator's fiat (what blurtPriceFiat is denominated in).
		const valueInDenom = blurtBalance * blurtPriceFiat;
		let value = valueInDenom;
		let fiat = denomFiat;
		// The user's saved preferred fiat wins — but only when it differs from
		// the operator's denomination AND we can actually convert to it (via
		// the USD-anchored FX table). Any missing piece falls back to denomFiat
		// so the line stays correct rather than lying with an unconverted number.
		const wantFiat = $userPreferences.fiat ?? localeDefaultFiat($page.data?.lang);
		if (wantFiat && wantFiat !== denomFiat && fxTable !== null) {
			const usd = fiatToUsd(fxTable, valueInDenom, denomFiat);
			const converted = usd !== null ? usdToFiat(fxTable, usd, wantFiat) : null;
			if (converted !== null) {
				value = converted;
				fiat = wantFiat;
			}
		}
		return `~${formatFiatGlued(value, fiat)} ${fiat.toLowerCase()}`;
	});

	/** Refresh interval.  Aggressive at 5 seconds: Blurt blocks
	 *  every ~3 seconds, so a 5s poll gives near-real-time updates
	 *  for a user watching their wallet during an active trade.
	 *  At rest (tab not visible), polling pauses — we resume on
	 *  visibilitychange and immediately refresh.  Components that
	 *  trigger known balance changes (fee broadcast, mark-as-sent,
	 *  fund release ack) call `triggerBalanceRefresh()` to nudge
	 *  the next refresh without waiting for the tick. */
	const REFRESH_MS = 5_000;
	let refreshTimer: ReturnType<typeof setInterval> | null = null;
	/** Per-component bus unsubscribe.  Set in onMount, called in
	 *  onDestroy. */
	let unsubscribeBus: (() => void) | null = null;
	/** Visibility handler captured at mount-time so we can remove
	 *  it cleanly in onDestroy. */
	let visibilityHandler: (() => void) | null = null;
	/** BATCH14-3 audit fix — flag indicating a refresh is currently
	 *  in flight.  When the polling tick fires (every 5s) AND the
	 *  bus also fires, two overlapping refreshes would otherwise
	 *  execute, doubling RPC traffic.  On a slow upstream this can
	 *  stack up.  We swallow extra triggers while one is pending —
	 *  the in-flight call will land soon enough; a missed nudge
	 *  is recovered by the next 5s tick. */
	let refreshInFlight = false;

	async function refresh(opts: { hard?: boolean } = {}): Promise<void> {
		// A `hard` refresh is user-initiated (the manual refresh button).
		// It must NEVER be swallowed by the in-flight guard — that guard
		// exists only to coalesce the 5s poll tick with bus nudges, and a
		// click landing mid-tick was silently dropped (the icon spun but
		// nothing refetched). A hard refresh also forces a cache-busted,
		// no-store fetch, so it cannot be answered from the browser HTTP
		// cache, the service worker, or any reverse proxy — the indexer
		// then reads the live chain balance. Soft refreshes (tick / bus /
		// mount / visibility) coalesce via the gate and use the normal
		// short-cached path.
		const hard = opts.hard === true;
		if (refreshInFlight && !hard) return;
		if (!hard) refreshInFlight = true;
		try {
			// cp295 — read balance via the indexer (same-origin), NOT
			// directly from a Blurt RPC node. The indexer fetches account
			// + DGP server-side across the full node pool, so third-party
			// nodes never see the user's IP or which account they're
			// viewing (privacy #1), and the load no longer depends on
			// whichever nodes happen to be browser-CORS-clean today.
			const result = await fetchAccountBalance(
				resolveOrigin(MORPHIT_INDEXER_ORIGIN),
				account,
				fetch,
				hard
			);
			if (result.kind !== 'ok') {
				if (result.kind === 'error') {
					console.warn('[MyBalanceCard] balance load failed:', result.message);
				}
				errorMsg = $_('my_balance.error.load_failed');
				loadState = 'error';
				return;
			}
			const { account: acct, dgp } = result.data;
			blurtBalance = parseAssetAmount(acct.balance);
			bpBalance = vestsToBlurtPower(
				acct.vesting_shares,
				dgp.total_vesting_fund_blurt,
				dgp.total_vesting_shares
			);
			// cp510 [12] — delegated-in BP (received_vesting_shares → BP), same
			// pool conversion. Shown as a separate "+ N BP delegated to you" line.
			receivedBp = vestsToBlurtPower(
				acct.received_vesting_shares,
				dgp.total_vesting_fund_blurt,
				dgp.total_vesting_shares
			);
			// cp424 — retain the raw pool figures + exact vesting_shares for
			// the Power up / Power down modal (BP↔VESTS conversion + dust-free
			// "power down everything").
			vestingFund =
				typeof dgp.total_vesting_fund_blurt === 'string'
					? dgp.total_vesting_fund_blurt
					: String(dgp.total_vesting_fund_blurt);
			totalVests =
				typeof dgp.total_vesting_shares === 'string'
					? dgp.total_vesting_shares
					: String(dgp.total_vesting_shares);
			vestingSharesRaw =
				typeof acct.vesting_shares === 'string'
					? acct.vesting_shares
					: String(acct.vesting_shares);
			// cp439 — an in-progress power-down (amount still to release + the
			// date the last weekly payout lands) for the Power down modal's 💡
			// section. null when the account isn't powering down.
			powerDownProgress = computePowerDownProgress(
				{
					vesting_withdraw_rate: acct.vesting_withdraw_rate,
					next_vesting_withdrawal: acct.next_vesting_withdrawal,
					to_withdraw: acct.to_withdraw,
					withdrawn: acct.withdrawn
				},
				vestingFund,
				totalVests
			);
			manaPct = votingPowerPercent(
				acct.voting_power,
				acct.last_vote_time,
				Math.floor(Date.now() / 1000)
			);
			// Batch K: APR. Cheap to recompute every refresh; inputs
			// arrived in the same response. Pure formula, no memoization.
			vestingApr = computeBlurtVestingApr({
				head_block_number: dgp.head_block_number,
				current_supply: dgp.current_supply,
				total_vesting_fund_blurt: dgp.total_vesting_fund_blurt
			});
			// cp396 — unclaimed rewards. While a claim is in flight we DON'T
			// overwrite from a soft poll (the optimistic clear must win until
			// the post-claim hard refresh lands); otherwise sync from chain.
			if (!claiming) {
				rewardBlurtRaw = acct.reward_blurt_balance;
				rewardVestsRaw = acct.reward_vesting_balance;
				rewardBlurt = parseAssetAmount(acct.reward_blurt_balance);
				rewardBp = parseAssetAmount(acct.reward_vesting_blurt);
			}
			loadState = 'ready';
		} catch (err) {
			console.warn('[MyBalanceCard] balance load failed:', err);
			errorMsg = $_('my_balance.error.load_failed');
			loadState = 'error';
		} finally {
			// BATCH14-3: clear the in-flight gate.  Must run on BOTH
			// success and error paths or a single failed refresh
			// would permanently lock subsequent refreshes. A hard
			// refresh never set the gate, so it must not clear it
			// (doing so could release a concurrent soft refresh early).
			if (!hard) refreshInFlight = false;
		}
	}

	/** Fetch the live BLURT/fiat price from /v1/listing-fee so the
	 *  balance can show an approximate fiat value. Best-effort: any
	 *  failure (price feed off, stale, or unreachable) leaves
	 *  blurtPriceFiat null and the USD-equivalent line is omitted. The
	 *  price moves slowly, so this runs once on mount and again on a
	 *  manual refresh — not on every 5s balance tick. */
	async function loadPrice(): Promise<void> {
		try {
			const r = await fetchListingFee(resolveOrigin(MORPHIT_INDEXER_ORIGIN));
			if (
				r.kind === 'ok' &&
				typeof r.quote.blurt_price_fiat === 'number' &&
				r.quote.blurt_price_fiat > 0
			) {
				blurtPriceFiat = r.quote.blurt_price_fiat;
				if (typeof r.quote.denomination_fiat === 'string' && r.quote.denomination_fiat) {
					denomFiat = r.quote.denomination_fiat;
				}
			}
		} catch {
			// Price feed unavailable → USD-equivalent simply not shown.
		}
		// cp429 — fetch the USD-anchored FX table so the value can be shown in
		// the user's preferred fiat. Separate best-effort call: if it fails the
		// balance still shows the operator's-denomination value.
		try {
			const fx = await fetchFxRates(resolveOrigin(MORPHIT_INDEXER_ORIGIN));
			if (fx.kind === 'ok') fxTable = fx.table;
		} catch {
			// FX feed unavailable → fall back to the operator's denomination.
		}
	}

	/** True only while a USER-initiated refresh is running, so the
	 *  refresh button's icon spins on click but NOT on the silent 5s
	 *  auto-refresh (which would make the icon strobe). Mirrors the
	 *  block-explorer account page's manual-refresh affordance. */
	let manualRefreshing = $state(false);

	async function manualRefresh(): Promise<void> {
		if (manualRefreshing) return;
		manualRefreshing = true;
		// Always show a visible spin on click. Without a floor, a click that
		// lands while the silent 5s auto-refresh is mid-flight makes refresh()
		// early-return (the refreshInFlight guard) so fast that the true→false
		// flip coalesces into one reactive flush and the icon never visibly
		// spins — the user perceives a dead button that only "works" a couple
		// seconds later, once the auto-refresh window has passed. A short floor
		// guarantees prompt feedback regardless of what the refresh did.
		const minSpin = new Promise<void>((resolve) => setTimeout(resolve, 600));
		try {
			await Promise.all([refresh({ hard: true }), loadPrice(), minSpin]);
		} finally {
			manualRefreshing = false;
		}
	}

	// ─── cp424 — Power up (stake) / Power down (unstake) ───────────────
	// Both sign with the ACTIVE key, so they're only offered to a full
	// seed session ('morphit-seed'). A posting-only login (imported a
	// posting WIF / posting-only keyfile) has no active key locally and
	// CANNOT sign these — the buttons stay hidden for it (matching the
	// /post BLURT-fee active-key gate, cp406), rather than letting the
	// user fill a form only to hit a "no active key" wall.
	/** CAPABILITY, not provenance (tt.txt #11). A 'posting-active' session — a
	 *  posting-only import that chose to keep its verified Active key on this
	 *  device — CAN sign a transfer. Asking `origin === 'morphit-seed'` would
	 *  wrongly deny it. Ask whether the key is actually there. */
	const hasActiveKey = $derived(($liveIdentity?.activePublicKey ?? null) !== null);
	let powerMode = $state<'up' | 'down' | null>(null);
	/** cp433 — when true, the liquid-BLURT odometer applies its next change
	 *  with no red flash. Set for a few seconds after a power-DOWN so the
	 *  tiny per-op fee debit doesn't paint the balance red and scare the
	 *  user (the money that actually moves is BP, released weekly). All
	 *  other balance changes flash red/green as normal. */
	let suppressBlurtFlashOnce = $state(false);
	let suppressTimer: ReturnType<typeof setTimeout> | null = null;
	function openPower(mode: 'up' | 'down'): void {
		powerMode = mode;
	}
	function closePower(): void {
		powerMode = null;
	}
	function onPowerDone(): void {
		const wasPowerDown = powerMode === 'down';
		powerMode = null;
		if (wasPowerDown) {
			// The fee debit may not land until the next block or two, so keep
			// the BLURT odometer quiet for a few seconds — long enough for the
			// fee to appear on a poll without a scary red flash.
			suppressBlurtFlashOnce = true;
			if (suppressTimer !== null) clearTimeout(suppressTimer);
			suppressTimer = setTimeout(() => {
				suppressBlurtFlashOnce = false;
				suppressTimer = null;
			}, 12_000);
		}
		// The op settled on-chain; pull fresh balances so the odometers
		// animate to the new totals (and nudge other balance-aware views).
		triggerBalanceRefresh();
		void refresh({ hard: true });
	}

	// ─── cp424 — Send BLURT to any Blurt account ───────────────────────
	// Also active-key-signed, so gated on the same hasActiveKey as the
	// staking actions.
	let sendOpen = $state(false);
	function openSend(): void {
		sendOpen = true;
	}
	function closeSend(): void {
		sendOpen = false;
	}
	function onSendDone(): void {
		sendOpen = false;
		triggerBalanceRefresh();
		void refresh({ hard: true });
	}

	function topUpBlurt(): void {
		// Stash a one-shot prefill request in sessionStorage; the
		// post page reads + clears on mount.  We deliberately don't
		// use URL params because the post page already has its own
		// draft restoration logic — adding a second source of state
		// would race.  Session storage gives us a clean handoff that
		// expires when the tab closes.
		safeSession.set(
			'morphit.post.prefill',
			JSON.stringify({
				side: 'buy',
				asset: 'BLURT',
				// Min = $5-equivalent in the user's fiat; max blank. The
				// post page converts $5 → fiat once fx + the chosen fiat
				// are ready (it owns the fx table), so we pass the USD
				// intent rather than a literal fiat amount here.
				amountMax: '',
				topupUsdMin: 5,
				reason: 'topup'
			})
		);
		void goto(lp('/post'));
	}

	// cp396 — claim unclaimed rewards into usable balances. Broadcasts
	// claim_reward_balance with the posting key, optimistically clears the
	// unclaimed line (so it disappears at once), then hard-refreshes so the
	// BLURT/BP odometers above animate up to the post-claim totals.
	async function claimRewards(): Promise<void> {
		const live = $liveIdentity;
		if (claiming || !hasUnclaimed || !live) return;
		claiming = true;
		claimError = '';
		const blurtArg = rewardBlurtRaw;
		const vestsArg = rewardVestsRaw;
		try {
			await broadcastClaimReward(live, account, blurtArg, vestsArg);
			// Optimistic clear — the line vanishes immediately on success.
			rewardBlurt = 0;
			rewardBp = 0;
			rewardBlurtRaw = '0.000 BLURT';
			rewardVestsRaw = '0.000000 VESTS';
			claiming = false;
			// Hard refresh: pulls the post-claim balances so the existing
			// AnimatedNumber odometers animate to the new totals. Then nudge
			// any other balance-aware components on this device.
			await refresh({ hard: true });
			triggerBalanceRefresh();
		} catch {
			// Broadcast failed — keep the (un-cleared) amounts so the user can
			// retry, and surface a themed error line beneath the claim row.
			claiming = false;
			claimError = $_('profile.my_balance.claim_error');
		}
	}

	// ─── P&L export ───────────────────────────────────────────────
	let exporting = $state(false);
	let exportError = $state('');

	/** Fetch the user's last 365 days of account history, paged
	 *  through the chain's get_account_history API.  Returns the
	 *  union of all returned ops in chronological order.
	 *
	 *  Pagination: the chain accepts up to 10_000 entries per call.
	 *  We page backward from the head until we hit ops older than
	 *  one year OR the start of history.  In practice an active
	 *  account does ~100s of ops/year; one page is usually enough.
	 *  We cap at 5 pages (50_000 ops) to bound the worst case —
	 *  someone with that much chain activity has unusual needs and
	 *  can ask for a larger window in the future. */
	async function fetchYearOfHistory(account: string): Promise<HistoryOp[]> {
		const PAGE = 10_000;
		const MAX_PAGES = 5;
		const oneYearAgoSec = Math.floor(Date.now() / 1000) - 365 * 86_400;

		const collected: HistoryOp[] = [];
		// Walk backward.  `from = -1` means "most recent"; we
		// receive the latest PAGE ops in chronological order.  Then
		// `from = oldestSeen - 1` for the next page.
		let from = -1;
		for (let page = 0; page < MAX_PAGES; page++) {
			// One page via the indexer (privacy: no direct RPC from the
			// browser). get_account_history shape per entry:
			//   [seq, { block, trx_id, timestamp, op: [name, body] }]
			const r = await fetchAccountHistory(
				resolveOrigin(MORPHIT_INDEXER_ORIGIN),
				account,
				from,
				PAGE
			);
			if (r.kind !== 'ok') break;
			const history = r.entries;
			if (history.length === 0) break;

			// `history` is ordered oldest-first within the window.
			// `seq` is monotonically increasing across history.
			let oldestSeen = Number.POSITIVE_INFINITY;
			let pageHasYearOld = false;
			for (const entry of history) {
				if (!Array.isArray(entry) || entry.length !== 2) continue;
				const seq = entry[0];
				const op = entry[1];
				if (typeof seq !== 'number') continue;
				oldestSeen = Math.min(oldestSeen, seq);
				const ts = Date.parse(op.timestamp + (op.timestamp.endsWith('Z') ? '' : 'Z')) / 1000;
				if (Number.isFinite(ts) && ts < oneYearAgoSec) {
					pageHasYearOld = true;
				}
				collected.push(op);
			}

			// If this page reached year-old territory OR returned
			// fewer than the page size (start of history), stop.
			if (pageHasYearOld || history.length < PAGE) break;
			if (oldestSeen <= 0) break;
			from = oldestSeen - 1;
		}
		return collected;
	}

	async function exportPnl(): Promise<void> {
		if (exporting) return;
		exporting = true;
		exportError = '';
		try {
			const ops = await fetchYearOfHistory(account);
			const opFeeAccount = resolveFeeRecipient(getInstanceSnapshot().fee_recipient);
			const preds: CategorizerPredicates = {
				// cp407 — recognise BOTH this instance's operator fee account and
				// the canonical treasury, so fee transfers light up whether the
				// user paid a federated operator or the canonical morphit-fees.
				isFeesAccount: (n) => n === opFeeAccount || n === FEE_RECIPIENT,
				isOperatorAccount: (n) => n === OPERATOR_ACCOUNT,
				// Featured-bid memos use a documented prefix.  Keep
				// the predicate lenient so a future memo-format
				// change still lights up.
				isFeaturedBidMemo: (m) => /^featured-bid:/.test(m)
			};
			const rows: PnlRow[] = [];
			for (const op of ops) {
				const r = categorizeOp(op, account, preds);
				if (r) rows.push(r);
			}
			// Filter to past 365 days inclusive.  History fetch may
			// have returned a few ops slightly older than that
			// (page boundary effect); trim now.
			const nowSec = Math.floor(Date.now() / 1000);
			const startSec = nowSec - 365 * 86_400;
			const windowed = filterByDateRange(rows, startSec, nowSec);

			const csv = buildPnlCsv(
				windowed,
				{
					timestamp: $_('profile.pnl.csv_header.timestamp'),
					category: $_('profile.pnl.csv_header.category'),
					counterparty: $_('profile.pnl.csv_header.counterparty'),
					blurtAmount: $_('profile.pnl.csv_header.blurt_amount'),
					memo: $_('profile.pnl.csv_header.memo'),
					trxId: $_('profile.pnl.csv_header.trx_id'),
					block: $_('profile.pnl.csv_header.block')
				},
				{
					blurt_received: $_('profile.pnl.category.blurt_received'),
					blurt_sent: $_('profile.pnl.category.blurt_sent'),
					order_fee: $_('profile.pnl.category.order_fee'),
					featured_bid: $_('profile.pnl.category.featured_bid'),
					featured_payout: $_('profile.pnl.category.featured_payout')
				}
			);

			const today = new Date().toISOString().slice(0, 10);
			downloadCsv(csv, `morphit-pnl-${account}-${today}.csv`);
		} catch (err) {
			console.warn('[MyBalanceCard] PnL export failed:', err);
			exportError = $_('my_balance.error.export_failed');
		} finally {
			exporting = false;
		}
	}

	function startPolling(): void {
		if (refreshTimer !== null) return;
		refreshTimer = setInterval(() => {
			void refresh();
		}, REFRESH_MS);
	}

	function stopPolling(): void {
		if (refreshTimer !== null) {
			clearInterval(refreshTimer);
			refreshTimer = null;
		}
	}

	onMount(() => {
		void refresh();
		void loadPrice();
		// Subscribe to the global balance-refresh bus so other
		// components (FundsSentModal, post-broadcast success, etc.)
		// can nudge an immediate refetch when they know a balance-
		// affecting op just landed.
		unsubscribeBus = subscribeBalanceRefresh(() => {
			void refresh();
		});
		// Only poll while the tab is visible — saves background
		// RPC traffic and battery.  When the tab comes back into
		// view, immediately refresh and restart the timer so the
		// user sees fresh data the moment they switch back.
		visibilityHandler = () => {
			if (typeof document === 'undefined') return;
			if (document.visibilityState === 'visible') {
				void refresh();
				startPolling();
			} else {
				stopPolling();
			}
		};
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', visibilityHandler);
			if (document.visibilityState === 'visible') {
				startPolling();
			}
		} else {
			// Non-browser (SSR): just kick the timer; visibility
			// API is not relevant.  startPolling() stays a no-op
			// in environments that lack setInterval.
			startPolling();
		}
	});

	onDestroy(() => {
		stopPolling();
		if (unsubscribeBus !== null) {
			unsubscribeBus();
			unsubscribeBus = null;
		}
		if (visibilityHandler !== null && typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', visibilityHandler);
			visibilityHandler = null;
		}
	});

	/** Threshold below which we show the "running low" hint.
	 *  Half of the typical $1-of-BLURT signup amount; enough to
	 *  remind the user without being naggy. */
	const LOW_BLURT_THRESHOLD = 5;
	const LOW_MANA_THRESHOLD = 25; // percent

	const showLowBalanceHint = $derived(
		Number.isFinite(blurtBalance) && blurtBalance < LOW_BLURT_THRESHOLD
	);
	const showLowManaHint = $derived(Number.isFinite(manaPct) && manaPct < LOW_MANA_THRESHOLD);

	// cp396 — mobile exact-amount popovers. On mobile the three values render
	// abbreviated (floored BLURT/BP, 0-decimal voting %) to fit the 3-column
	// card on narrow phones. Tapping a value reveals its EXACT amount in a
	// small popover. Desktop already shows full precision, so the popovers are
	// wired only on the mobile (sm:hidden / mobile-decimals) tap targets.
	let openExact = $state<'blurt' | 'bp' | 'mana' | null>(null);
	function toggleExact(v: 'blurt' | 'bp' | 'mana'): void {
		openExact = openExact === v ? null : v;
	}
	function fmtExact(n: number, decimals: number): string {
		if (!Number.isFinite(n)) return '—';
		// App-selected locale (matches AnimatedNumber), not the browser's.
		try {
			return n.toLocaleString($locale ?? undefined, {
				minimumFractionDigits: decimals,
				maximumFractionDigits: decimals
			});
		} catch {
			return n.toLocaleString(undefined, {
				minimumFractionDigits: decimals,
				maximumFractionDigits: decimals
			});
		}
	}
	const exactBlurt = $derived(`${fmtExact(blurtBalance, 3)} BLURT`);
	const exactBp = $derived(`${fmtExact(bpBalance, 3)} BP`);
	const exactMana = $derived(`${fmtExact(manaPct, 2)}%`);
	// Outside-tap / Escape dismiss for the open popover. Scoped to the open
	// window and self-cleaning, so no listener lingers once it closes.
	$effect(() => {
		if (openExact === null) return;
		const onPointer = (e: Event): void => {
			const t = e.target as HTMLElement | null;
			if (t && !t.closest('[data-exact-tip]')) openExact = null;
		};
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === 'Escape') openExact = null;
		};
		document.addEventListener('pointerdown', onPointer, true);
		document.addEventListener('keydown', onKey, true);
		return () => {
			document.removeEventListener('pointerdown', onPointer, true);
			document.removeEventListener('keydown', onKey, true);
		};
	});

	// Part 121 cp7 — per-locale internal-link wrapper.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<section
	class="card border border-morphit-emerald/30 bg-emerald-50/30 dark:border-morphit-emerald/40 dark:bg-emerald-950/20"
	aria-label={$_('profile.my_balance.section_label', { values: { account } })}
>
	<header class="mb-3 flex items-center justify-between">
		<h2 class="font-display text-base font-bold">
			{$_('profile.my_balance.title', { values: { account } })}
		</h2>
		<div class="flex items-center gap-2">
			<span class="hidden text-xs text-ink-500 dark:text-ink-400 sm:inline">
				{$_('profile.my_balance.private_label')}
			</span>
			<button
				type="button"
				onclick={manualRefresh}
				disabled={manualRefreshing}
				aria-label={$_('explorer.account.refresh_label')}
				title={$_('explorer.account.refresh_label')}
				class="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-ink-300 text-ink-600 transition hover:border-morphit-emerald hover:bg-ink-50 hover:text-morphit-emerald disabled:cursor-wait disabled:opacity-100 dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-900"
			>
				<svg
					class="h-3.5 w-3.5 {manualRefreshing ? 'animate-spin' : ''}"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M21 12a9 9 0 1 1-2.64-6.36" />
					<path d="M21 3v6h-6" />
				</svg>
			</button>
		</div>
	</header>

	{#if loadState === 'loading'}
		<p class="text-sm text-ink-500 dark:text-ink-400">
			{$_('profile.my_balance.loading')}
		</p>
	{:else if loadState === 'error'}
		<p class="text-sm text-red-700 dark:text-red-300">
			{$_('profile.my_balance.error')}: {errorMsg}
		</p>
	{:else}
		<!-- Ken — three evenly spaced columns. `grid-cols-3` already gives the
		     columns equal WIDTH, but with `gap-3` the BLURT column's fiat
		     approximation ran right up against "BP (staked BLURT)" while a wide
		     gap yawned before "Voting" — equal columns, visibly unequal rhythm.
		     A roomier `gap-x-6` restores the breathing space on both sides; the
		     fiat wraps under the balance rather than crowding its neighbour when
		     the column is narrow. -->
		<dl class="grid grid-cols-3 gap-x-6 gap-y-3">
			{#snippet exactTip(text: string)}
				<span
					role="tooltip"
					class="absolute left-1/2 top-full z-40 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 font-mono text-xs font-semibold text-ink-800 shadow-morphit-card dark:border-ink-700 dark:bg-ink-900 dark:text-ink-100"
					>{text}</span
				>
			{/snippet}
			<div>
				<dt class="text-xs text-ink-500 dark:text-ink-400">
					{$_('profile.my_balance.blurt_label')}
				</dt>
				<dd class="font-mono text-lg font-semibold leading-tight">
					<!-- Ken — the balance and its fiat approximation sit on one baseline,
					     separated by exactly one space.
					     Previously the fiat was an `inline-block` with `ml-1`: an
					     inline-block aligns by its own last line-box baseline, not the
					     mono digits' baseline, so it rode slightly low, and `ml-1` on top
					     of the inline gap read as two spaces. A baseline flex row aligns
					     the two texts exactly, `gap-x-1` is the single space, and
					     `flex-wrap` still gives the fiat its own text-xs line-box when it
					     wraps — which is what `inline-block` was there to buy (v1.1.5:
					     inline, it inherited the dd's text-lg line-height and left a
					     phantom gap that read as a stray line-feed). -->
					<span class="flex flex-wrap items-baseline gap-x-1">
						<span>
							<!-- Desktop: full BLURT precision with grouping (e.g. 5,055.031). -->
							<span class="hidden sm:inline"
								><AnimatedNumber
									value={blurtBalance}
									decimals={3}
									durationMs={3000}
									silent={suppressBlurtFlashOnce}
									localeSignColors
								/></span
							><!-- Mobile: floored integer; tap to reveal the exact amount (cp396). -->
							<span class="relative sm:hidden" data-exact-tip
								><button
									type="button"
									onclick={() => toggleExact('blurt')}
									aria-label={`${$_('profile.my_balance.blurt_label')} ${exactBlurt}`}
									class="cursor-pointer underline decoration-dotted underline-offset-2"
									><AnimatedNumber
										value={Math.floor(blurtBalance)}
										decimals={0}
										grouping={false}
										durationMs={3000}
										silent={suppressBlurtFlashOnce}
										localeSignColors
									/></button
								>{#if openExact === 'blurt'}{@render exactTip(exactBlurt)}{/if}</span
							>
						</span>
						{#if usdLabel}
							<!-- cp515 (t.txt) — `relative -top-0.5` optical lift. The row is
							     `items-baseline`, so the two texts share a TRUE baseline — which is
							     typographically correct and still reads as "sitting low", because
							     text-xs next to text-lg mono digits has a much smaller cap-height,
							     so its optical centre falls well below the big number's. Nudging it
							     up ~2px aligns the perceived centres without breaking the baseline
							     row or the wrap behaviour. -->
							<span
								class="relative -top-0.5 font-sans text-xs font-normal leading-tight text-ink-500 dark:text-ink-400"
								>({usdLabel})</span
							>
						{/if}
					</span>
				</dd>
				{#if hasActiveKey && blurtBalance > 0}
					<button
						type="button"
						onclick={() => openPower('up')}
						class="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold text-morphit-teal underline decoration-dotted underline-offset-2 hover:text-morphit-emerald hover:no-underline dark:text-morphit-emerald"
					><span aria-hidden="true">↑</span>{$_('profile.wallet.power_up_action')}</button>
				{/if}
			</div>
			<div>
				<dt class="text-xs text-ink-500 dark:text-ink-400">
					{$_('profile.my_balance.bp_staked_label')}
				</dt>
				<dd class="flex items-center gap-1.5 font-mono text-lg font-semibold">
					<!-- Desktop: full BP precision with grouping. -->
					<span class="hidden sm:inline"
						><AnimatedNumber value={bpBalance} decimals={3} durationMs={3000} localeSignColors /></span
					><!-- Mobile: floored integer; tap to reveal the exact amount (cp396). -->
					<span class="relative sm:hidden" data-exact-tip
						><button
							type="button"
							onclick={() => toggleExact('bp')}
							aria-label={`${$_('profile.my_balance.bp_staked_label')} ${exactBp}`}
							class="cursor-pointer underline decoration-dotted underline-offset-2"
							><AnimatedNumber
								value={Math.floor(bpBalance)}
								decimals={0}
								grouping={false}
								durationMs={3000}
								localeSignColors
							/></button
						>{#if openExact === 'bp'}{@render exactTip(exactBp)}{/if}</span
					>
					{#if Number.isFinite(receivedBp) && receivedBp > 0}
						<!-- cp511 [12-revise] — delegated-in BP as a tiny tap/hover info icon
						     (NOT a line — keeps the card uncluttered). Reveals "+ N BP delegated
						     to you" only when a delegation exists. -->
						<!-- cp515 (t.txt) — `relative -top-px` optical lift. `items-center` centres
						     the icon in the ROW's line box, and that box includes descender space
						     the mono digits never use, so a centred icon reads as low against
						     them. 1px up sits it on the digits' optical centre. -->
						<span class="relative -top-px inline-flex">
							<Tooltip
								textKey="profile.my_balance.delegated_in_label"
								textValues={{ bp: fmtExact(receivedBp, 3) }}
								noBorder
							/>
						</span>
					{/if}
				</dd>
				{#if Number.isFinite(vestingApr)}
					<!-- Batch K: APR display.  Phrased as "Currently
					     earning N% APR" so users understand BP isn't
					     idle stake — it accrues yield from chain
					     inflation.  Computed pure-functionally from
					     DGP; no extra fetch. -->
					<dd class="text-xs text-ink-500 dark:text-ink-400">
						{$_('profile.my_balance.apr_label', {
							values: { apr: formatApr(vestingApr) }
						})}
					</dd>
				{/if}
				{#if hasActiveKey && bpBalance > 0}
					<button
						type="button"
						onclick={() => openPower('down')}
						class="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold text-morphit-teal underline decoration-dotted underline-offset-2 hover:text-morphit-emerald hover:no-underline dark:text-morphit-emerald"
					><span aria-hidden="true">↓</span>{$_('profile.wallet.power_down_action')}</button>
				{/if}
			</div>
			<div>
				<dt class="text-xs text-ink-500 dark:text-ink-400">
					{$_('profile.my_balance.voting_label')}
				</dt>
				<dd class="font-mono text-lg font-semibold">
					<!-- Desktop: 2-decimal precision. -->
					<span class="hidden sm:inline"
						><AnimatedNumber value={manaPct} decimals={2} durationMs={3000} />%</span
					><!-- Mobile: 0-decimal; tap to reveal the exact percentage (cp396). -->
					<span class="relative sm:hidden" data-exact-tip
						><button
							type="button"
							onclick={() => toggleExact('mana')}
							aria-label={`${$_('profile.my_balance.voting_label')} ${exactMana}`}
							class="cursor-pointer underline decoration-dotted underline-offset-2"
							><AnimatedNumber value={manaPct} decimals={0} durationMs={3000} />%</button
						>{#if openExact === 'mana'}{@render exactTip(exactMana)}{/if}</span
					>
				</dd>
			</div>
		</dl>

		{#if showLowBalanceHint || showLowManaHint}
			<p class="mt-3 flex items-start gap-1.5 text-xs font-medium text-red-600 dark:text-red-400">
				<span aria-hidden="true" class="flex-none">⚠</span>
				<span>
					{#if showLowBalanceHint}
						{$_('profile.my_balance.low_blurt_hint')}
					{:else}
						{$_('profile.my_balance.low_voting_hint')}
					{/if}
				</span>
			</p>
		{/if}

		{#if hasUnclaimed}
			<!-- cp396 — unclaimed author/curation rewards. Highlighted line ABOVE
			     the Top up button; claiming sweeps them into usable balances (the
			     odometers above animate up), then this line disappears. The Claim
			     button only renders when keys are present (a paired-readonly device
			     can't sign — it sees the line as info only). -->
			<div
				data-unclaimed-rewards
				class="mt-4 flex items-center justify-between gap-3 rounded-xl border-2 border-morphit-emerald/40 bg-morphit-emerald/10 p-3 dark:border-morphit-emerald/50 dark:bg-morphit-emerald/15"
			>
				<div class="min-w-0">
					<p class="flex items-center gap-1.5 text-sm font-semibold text-morphit-emerald">
						<span aria-hidden="true">🎁</span>
						{$_('profile.my_balance.unclaimed_label')}
					</p>
					<p class="mt-0.5 font-mono text-sm font-semibold text-ink-800 dark:text-ink-100">
						{#if rewardBlurt > 0}{fmtExact(rewardBlurt, 3)} BLURT{/if}{#if rewardBlurt > 0 && rewardBp > 0}<span
								class="px-1 font-sans font-normal text-ink-400">+</span
							>{/if}{#if rewardBp > 0}{fmtExact(rewardBp, 3)} BP{/if}
					</p>
				</div>
				{#if $liveIdentity}
					<button
						type="button"
						onclick={claimRewards}
						disabled={claiming}
						class="flex-none rounded-xl bg-morphit-btn px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
					>
						{claiming
							? $_('profile.my_balance.claiming')
							: $_('profile.my_balance.claim_now')}
					</button>
				{/if}
			</div>
			{#if claimError}
				<p class="mt-2 flex items-start gap-1.5 text-xs font-medium text-red-600 dark:text-red-400">
					<span aria-hidden="true" class="flex-none">⚠</span>
					<span>{claimError}</span>
				</p>
			{/if}
		{/if}

		<!-- cp424 — P&L grouped next to Top up (stacked under on mobile). The
		     "Send" button (right on desktop / stacked-under on mobile) lands in
		     the reserved right slot with the Send modal in the next increment. -->
		<div class="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
			<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
				<button
					type="button"
					onclick={topUpBlurt}
					class="rounded-xl bg-morphit-btn px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110 active:scale-[0.98]"
				>
					{$_('profile.my_balance.top_up_blurt')}
				</button>
				<button
					type="button"
					onclick={exportPnl}
					disabled={exporting}
					class="inline-flex items-center justify-center gap-2 rounded-xl border border-ink-300 px-4 py-2 text-sm font-semibold transition hover:bg-ink-50 active:scale-[0.98] disabled:opacity-50 dark:border-ink-700 dark:hover:bg-ink-900"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
						class="h-4 w-4 flex-none"
					>
						<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
						<polyline points="7 10 12 15 17 10" />
						<line x1="12" y1="15" x2="12" y2="3" />
					</svg>
					{exporting ? $_('profile.pnl.exporting') : $_('profile.pnl.export_button')}
				</button>
			</div>
			<!-- tt.txt #11 — Send used to be HIDDEN outright for a posting-only
			     session. A control that silently isn't there teaches nothing; the
			     user concludes Morphit can't send BLURT at all. The button is now
			     always offered, and the modal explains + unlocks in place. -->
			<button
				type="button"
				onclick={openSend}
				class="inline-flex items-center justify-center gap-2 rounded-xl bg-morphit-btn px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110 active:scale-[0.98]"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
					class="h-4 w-4 flex-none"
				>
					<path d="m22 2-7 20-4-9-9-4Z" />
					<path d="M22 2 11 13" />
				</svg>
				{$_('profile.send.send_button')}
			</button>
		</div>
		{#if exportError}
			<p class="mt-2 text-xs text-red-700 dark:text-red-300">
				{$_('profile.pnl.export_error')}: {exportError}
			</p>
		{/if}
	{/if}

	{#if powerMode}
		{#await loadPowerModal() then PowerModal}
			<PowerModal
				mode={powerMode}
				{account}
				{blurtBalance}
				{bpBalance}
				{vestingFund}
				{totalVests}
				{vestingSharesRaw}
				powerDown={powerDownProgress}
				onDone={onPowerDone}
				onCancel={closePower}
			/>
		{:catch}
			<LazyLoadError />
		{/await}
	{/if}

	{#if sendOpen}
		{#await loadSendModal() then SendBlurtModal}
			<SendBlurtModal {account} {blurtBalance} onDone={onSendDone} onCancel={closeSend} />
		{:catch}
			<LazyLoadError />
		{/await}
	{/if}
</section>
