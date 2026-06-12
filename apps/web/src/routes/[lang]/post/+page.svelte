<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	/**
	 * Morphit — post-an-order compose page.
	 *
	 * Progressive-disclosure form: three steps, each appearing only
	 * after the previous one is answered. This keeps grandma's eye
	 * on exactly one thing at a time.
	 *
	 *   Step 1: What to trade?  (side + asset)
	 *   Step 2: How much + price (fiat + amounts + price model)
	 *   Step 3: How to reach?   (payment methods + region + terms)
	 *   Review: fee quote, listing summary, "Post" button
	 *   Sign:   password prompt + JIT useActiveKey broadcast
	 *   Done:   success card with "View your order" + "Post another"
	 *
	 * Error handling:
	 * - Any input that fails client validation shows a StatusLine
	 *   kind=warn under the field.
	 * - Broadcast failures show an amber error card with a Retry
	 *   BusyButton; nothing was paid, the user can try again safely.
	 * - Locked-session errors prompt the password flow without
	 *   losing the form state.
	 */

	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { gotoLocale } from '$i18n/navigate';
	import { get } from 'svelte/store';

	import Head from '$components/Head.svelte';
	import BusyButton from '$components/BusyButton.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import WriteBlockedReadOnly from '$components/WriteBlockedReadOnly.svelte';
	import FocusedField from '$components/FocusedField.svelte';
	import Tooltip from '$components/Tooltip.svelte';
	import Term from '$components/Term.svelte';
	// cp165 byte-budget: ListingFeeAddressPanel renders only when
	// the user picks btc/xmr fee method (alt path; default is
	// BLURT-paid).  PrivateKeyWarningModal renders only on
	// detected key leak in user input (rare).  Both deferred.
	// import ListingFeeAddressPanel from '$components/ListingFeeAddressPanel.svelte';
	import FirstPostStarterPack from '$components/FirstPostStarterPack.svelte';
	import { formatFiat } from '$lib/i18n/formatters';
	import ProtectedTextarea from '$components/ProtectedTextarea.svelte';
	// cp165: lazy below (showTermsKeyWarning guard)
	// import PrivateKeyWarningModal from '$components/PrivateKeyWarningModal.svelte';
	import PaymentMethodsPicker from '$components/PaymentMethodsPicker.svelte';
	import PrivacyWarningChip from '$components/PrivacyWarningChip.svelte';
	import UsdtNetworkPicker from '$components/UsdtNetworkPicker.svelte';
	import UsdcNetworkPicker from '$components/UsdcNetworkPicker.svelte';
	import DaiNetworkPicker from '$components/DaiNetworkPicker.svelte';
	import {
		type UsdtNetwork,
		type UsdcNetwork,
		type DaiNetwork,
		isUsdtNetwork,
		isUsdcNetwork,
		isDaiNetwork
	} from '$lib/assets/networks';
	import { instanceAdditions } from '$lib/stores/instanceAdditions';
	import { getInstanceSnapshot } from '$lib/stores/instance';

	import { identity, isUnlocked, isPairedReadOnly } from '$stores/identity';
	import { getPreferencesSnapshot, setPreference } from '$stores/userPreferences';
	import { useActiveKey, KeystoreError } from '$crypto/keystore';
	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import { broadcastNewOrder, BroadcastError } from '$blurt/ops/order';
	import { computeFee, BASE_FEE_BLURT, type FeeQuote } from '$lib/orders/fee';
	import { getOrdersByAccount } from '$lib/indexer/client';
	import { ASSET_TICKERS, isAssetTicker, type AssetTicker } from '@morphit/asset-registry';
	import {
		checkWaiverEligibility,
		fetchListingFee,
		type WaiverEligibility
	} from '$lib/orders/listingFee';
	import { MORPHIT_INDEXER_ORIGIN, resolveOrigin } from '$net/config';
	import type { OrderFormInput } from '$lib/orders/payload';
	import { makeExpiryFlooredUtcDay } from '$lib/orders/payload';
	import { publishOrderPost } from '$lib/syndication/publish';
	import { redactPrivateKeys, type PrivateKeyMatch } from '$lib/security/privateKeyDetector';
	import { saveDraft, loadDraftWithMeta, clearDraft } from '$lib/drafts';
	import { safeSession } from '$lib/utils/safeStorage';
	import { triggerBalanceRefresh } from '$lib/balance/bus';

	/** Session-storage key written by other pages that want to
	 *  prefill the compose form (e.g. profile "Top up BLURT").
	 *  Format: JSON `{ side, asset, amountMin, amountMax, reason }`.
	 *  Read once at mount, then cleared. */
	const PREFILL_KEY = 'morphit.post.prefill';

	// ─── Gate: must be unlocked + have Blurt account ───────────────
	const blurtAccount = getUserBlurtAccount();

	// ─── Form state (step 1) ───────────────────────────────────────
	type Side = 'buy' | 'sell';
	type Asset = AssetTicker;

	let side = $state<Side | null>(null);
	let asset = $state<Asset | null>(null);

	// cp165 lazy-loaders
	const loadListingFeeAddressPanel = () =>
		import('$components/ListingFeeAddressPanel.svelte').then((m) => m.default);
	const loadPrivateKeyWarningModal = () =>
		import('$components/PrivateKeyWarningModal.svelte').then((m) => m.default);
	// Part 121 — when asset=USDT, the user MUST pick a network
	// (ERC-20/TRC-20/SPL/BEP-20).  Null when asset is not USDT
	// OR when USDT is picked but the user hasn't chosen yet.
	// canSubmit gates on this being non-null when asset==='USDT'.
	let usdtNetwork = $state<UsdtNetwork | null>(null);
	// Part 122 cp30 — same shape for USDC.  When asset=USDC the
	// user MUST pick a network (ERC-20/SPL/Base/Polygon) before
	// the form can submit.  Especially critical because three of
	// the four supported USDC networks share the EVM 0x[40 hex]
	// address shape — the picker is the only thing telling the
	// sender's wallet which chain to broadcast on.
	let usdcNetwork = $state<UsdcNetwork | null>(null);
	// Part 122 cp31 — DAI network discriminator.  When asset=DAI
	// the user MUST pick a network (ERC-20/Polygon/Base/Arbitrum)
	// before the form can submit.  All four DAI networks share
	// the EVM 0x[40 hex] address shape, so the picker is the only
	// thing telling the sender's wallet which chain to broadcast
	// on.  CP34 closure: this state + the gate + the reset + the
	// dispatch + the picker render block were all MISSING since
	// cp31 ship; DAI order posting was silently broken cp31→cp34.
	let daiNetwork = $state<DaiNetwork | null>(null);

	// ─── Form state (step 2) ───────────────────────────────────────
	let fiat = $state('');
	let amountMin: string = $state(''); // kept as string so empty distinguishes from 0
	let amountMax: string = $state('');
	type PriceModelKind = 'spread' | 'fixed';
	let priceModelKind = $state<PriceModelKind>('spread');
	let spreadPercent = $state('0');
	let fixedPrice = $state('');

	// ─── Form state (step 3) ───────────────────────────────────────
	let paymentMethods: string[] = $state([]);
	let pmDraft = $state('');
	let region = $state('');
	let terms = $state('');
	let expiresDays = $state(90);
	/** Per-order opt-in: also post this order's announcement to the
	 *  user's own Blurt blog. Defaults false so users actively opt
	 *  in. When true, Post B fires immediately after the order
	 *  broadcast succeeds — see syndicate/publish.ts. */
	let syndicateToBlog = $state(false);

	// ─── Private-key protection for the terms field ────────────────
	// The terms field is the highest-risk free-text input on this
	// screen (2048 char cap, so real keys fit). Gets the full
	// defense stack: visual highlight via ProtectedTextarea, warning
	// modal on submit, and redaction in buildOrderPayload.
	// region + pmDraft are short enough that keys rarely fit; they
	// rely on buildOrderPayload's redaction alone.
	let termsKeyMatches: readonly PrivateKeyMatch[] = $state([]);
	let showTermsKeyWarning = $state(false);
	let userAckedTermsKeyWarning = $state(false);

	function handleTermsKeyDetect(matches: readonly PrivateKeyMatch[]): void {
		termsKeyMatches = matches;
		if (matches.length === 0) userAckedTermsKeyWarning = false;
	}

	// ─── Draft persistence ─────────────────────────────────────────
	// Auto-save the in-progress form to localStorage so the user
	// can survive a crash, reboot, or offline event and come back
	// to exactly where they left off. Cleared on successful
	// broadcast. See $lib/drafts for the save/load semantics
	// (TTL + private-key redaction on write).
	const DRAFT_KEY = 'post.compose';
	let draftSavedAt = $state<Date | null>(null);
	let draftSaveTimeout: ReturnType<typeof setTimeout> | null = null;

	/** All form fields that constitute a "draft" — everything a user
	 *  types or picks during compose. Intentionally excludes:
	 *   - phase (UI state, not user data)
	 *   - password (never persisted)
	 *   - broadcastError / passwordError / successPermlink (outputs)
	 *   - feeQuote / waiverEligibility (computed, regenerated on load)
	 *   - termsKeyMatches / showTermsKeyWarning (transient warning state) */
	interface ComposeDraft {
		side: Side | null;
		asset: Asset | null;
		fiat: string;
		amountMin: string;
		amountMax: string;
		priceModelKind: PriceModelKind;
		spreadPercent: string;
		fixedPrice: string;
		paymentMethods: string[];
		pmDraft: string;
		region: string;
		terms: string;
		expiresDays: number;
		syndicateToBlog: boolean;
		feeMethodChoice: 'blurt' | 'waived_first_buy' | 'btc' | 'xmr';
		externalTxId: string;
		/** Part 108++ — XMR per-payment proof.  Persisted so the
		 *  user doesn't have to re-generate it from their wallet
		 *  if they close the tab between paying and submitting. */
		txProof: string;
	}

	function snapshotDraft(): ComposeDraft {
		// Per Finding R7 (extended from feedback audit): redact
		// private keys from free-text fields before persisting to
		// localStorage.  A user who types or pastes a key into
		// terms / region, then closes the browser without
		// submitting, would otherwise leave the key in storage
		// indefinitely.  In-memory state is unchanged; only the
		// snapshot is sanitized.  The order op also redacts at
		// broadcast time (apps/web/src/lib/orders/payload.ts) — this
		// is the parallel defense-in-depth for the persistence path.
		//
		// Note on txProof: the proof is per-payment, single-use,
		// reveals only "this txid paid this address this amount"
		// — substantially less sensitive than a private key, and
		// not subject to redaction.  We persist it so a tab-close
		// between proof generation and submission doesn't force
		// the user to regenerate from their wallet (grandma-
		// friendly recovery).
		return {
			side,
			asset,
			fiat,
			amountMin,
			amountMax,
			priceModelKind,
			spreadPercent,
			fixedPrice,
			paymentMethods: [...paymentMethods],
			pmDraft,
			region: region.length > 0 ? redactPrivateKeys(region) : region,
			terms: terms.length > 0 ? redactPrivateKeys(terms) : terms,
			expiresDays,
			syndicateToBlog,
			feeMethodChoice,
			externalTxId,
			txProof
		};
	}

	function applyDraft(d: ComposeDraft): void {
		side = d.side;
		asset = d.asset;
		fiat = d.fiat;
		amountMin = d.amountMin;
		amountMax = d.amountMax;
		priceModelKind = d.priceModelKind;
		spreadPercent = d.spreadPercent;
		fixedPrice = d.fixedPrice;
		paymentMethods = [...d.paymentMethods];
		pmDraft = d.pmDraft;
		region = d.region;
		terms = d.terms;
		expiresDays = d.expiresDays;
		syndicateToBlog = d.syndicateToBlog;
		feeMethodChoice = d.feeMethodChoice;
		externalTxId = d.externalTxId;
		// Restore txProof if present in the draft — back-compat:
		// drafts saved before Part 108++ won't have this key,
		// fall back to empty string.
		txProof = d.txProof ?? '';
	}

	/** Heuristic: does the draft actually contain anything worth
	 *  restoring? An all-defaults snapshot is not worth announcing
	 *  to the user ("Restored from 2 minutes ago" when nothing was
	 *  typed is just noise). */
	function draftHasContent(d: ComposeDraft): boolean {
		return (
			d.side !== null ||
			d.asset !== null ||
			d.fiat.length > 0 ||
			d.amountMin.length > 0 ||
			d.amountMax.length > 0 ||
			d.fixedPrice.length > 0 ||
			d.paymentMethods.length > 0 ||
			d.pmDraft.length > 0 ||
			d.region.length > 0 ||
			d.terms.length > 0 ||
			d.externalTxId.length > 0 ||
			(d.txProof?.length ?? 0) > 0
		);
	}

	function discardDraft(): void {
		clearDraft(DRAFT_KEY);
		draftSavedAt = null;
		// Reset every field to its initial value. We don't reload
		// the page; that would also reset fee quote + waiver
		// eligibility, adding latency the user hasn't asked for.
		side = null;
		asset = null;
		fiat = '';
		amountMin = '';
		amountMax = '';
		priceModelKind = 'spread';
		spreadPercent = '0';
		fixedPrice = '';
		paymentMethods = [];
		pmDraft = '';
		region = '';
		terms = '';
		expiresDays = 14;
		syndicateToBlog = false;
		feeMethodChoice = 'blurt';
		externalTxId = '';
		txProof = '';
	}

	/** Compact relative-time formatter matching /my/orders: 1m / 1h / 1d.
	 *  Input is a Date (the moment the draft was loaded). We show
	 *  this in the restore banner so the user knows roughly how
	 *  stale the recovered draft is. */
	function formatDraftAge(since: Date): string {
		const diff = Date.now() - since.getTime();
		const minutes = Math.floor(diff / 60_000);
		if (minutes < 1) return '<1m';
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h`;
		const days = Math.floor(hours / 24);
		return `${days}d`;
	}

	// ─── Flow state ────────────────────────────────────────────────
	type Phase = 'editing' | 'reviewing' | 'awaiting_password' | 'broadcasting' | 'success' | 'error';
	let phase = $state<Phase>('editing');
	let password = $state('');
	let passwordError = $state('');
	let broadcastError = $state('');
	let successPermlink: string | null = $state(null);
	/** Capture whether the broadcast that just succeeded used the
	 *  first-buy waiver. The post-broadcast success view celebrates
	 *  more loudly + tells the user what to expect next when their
	 *  free first buy just went live. Resets on postAnother(). */
	let successUsedWaiver = $state(false);
	/** Sally finding M1/M8 (Part 68): timestamp the moment we
	 *  flipped phase to 'success' so the success card can show
	 *  a live edit-window countdown.  Otherwise the user sees an
	 *  "Edit" button with no warning that the window is 15 minutes
	 *  total — by the time they click around, half the window
	 *  may already be gone. */
	let successFiredAt: number | null = $state(null);
	/** Live "now" timestamp for the success-card countdown. */
	let nowMs = $state(Date.now());
	/** Edit window (mirrors my/orders + post/edit). */
	const POST_EDIT_WINDOW_MS = 15 * 60 * 1000;

	/** Seconds left in the post-broadcast edit window, or null if
	 *  the window has expired or never started. */
	const editWindowRemainingSec = $derived.by((): number | null => {
		if (successFiredAt === null) return null;
		const remaining = successFiredAt + POST_EDIT_WINDOW_MS - nowMs;
		if (remaining <= 0) return null;
		return Math.ceil(remaining / 1000);
	});

	function formatRemainingMmSs(seconds: number): string {
		const m = Math.floor(seconds / 60);
		const s = seconds % 60;
		if (m === 0) return `${s}s`;
		return `${m}m ${s}s`;
	}

	/** Post B (per-order syndication to user's blog) result tracking.
	 *  - null: user didn't opt in, or order hasn't succeeded yet
	 *  - 'pending': order broadcast succeeded; we're broadcasting
	 *    the announcement comment now
	 *  - 'ok': comment broadcast successfully; surfaced on the
	 *    success card
	 *  - 'failed': comment broadcast failed; surfaced on the
	 *    success card so the user knows their order is up but the
	 *    blog post didn't go through
	 *  The order itself is always considered successful regardless
	 *  of this — Post B is best-effort, never blocks the order. */
	let syndicationStatus: null | 'pending' | 'ok' | 'failed' = $state(null);

	// ─── Fee calculation ───────────────────────────────────────────
	let feeQuote = $state<FeeQuote | null>(null);
	/** Optional fiat-per-BLURT for ambient subtext on the fee
	 *  display.  Populated from /v1/listing-fee when the operator
	 *  has the price feed enabled.  Null = no fiat echo shown.
	 *  cp128: previously `usdPerBlurt`; renamed because the operator
	 *  configures the denomination (USD/EUR/XDR/XAU/…). */
	let fiatPerBlurt: number | null = $state(null);
	let denominationFiat: string = $state('USD');
	let feeLoading = $state(false);
	let feeError = $state('');

	// ─── ADR-0011 waiver eligibility ───────────────────────────────
	// We look up waiver eligibility once on mount. It's just a check
	// against the indexer — if the account has no prior orders, the
	// free first BUY waiver is available. We don't refresh this
	// during the compose flow; the indexer verifies on submission
	// anyway, so a stale-positive becomes a silent fallback to BLURT
	// fee (and we show a friendly retry message).
	let waiverEligibility = $state<WaiverEligibility | null>(null);
	/** When true, the user's side=buy AND waiver is available. The
	 *  compose page offers "free first order" as the default and
	 *  hides the fee quote. */
	const waiverOffered = $derived(
		side === 'buy' &&
			waiverEligibility !== null &&
			(waiverEligibility.kind === 'eligible' ||
				waiverEligibility.kind === 'eligible_unknown_account')
	);
	/** The user's choice for this order. Four options post-4b:
	 *    'blurt'              → pay standard BLURT fee (default)
	 *    'waived_first_buy'   → free, requires waiverOffered (4a)
	 *    'btc'                → pay fee in BTC (4b)
	 *    'xmr'                → pay fee in XMR (4b)
	 *  Non-BLURT methods require an external txid, captured in
	 *  externalTxId. */
	let feeMethodChoice = $state<'blurt' | 'waived_first_buy' | 'btc' | 'xmr'>('blurt');
	/** External transaction ID for btc/xmr methods. Must be 64-char
	 *  hex (indexer validates; we also do a client-side check to
	 *  give immediate feedback). Empty when the method is blurt or
	 *  waived. */
	let externalTxId: string = $state('');
	/** Per-payment Monero proof string (Part 108++).  Required
	 *  when feeMethodChoice='xmr'.  Generated by the user's own
	 *  Monero wallet via `get_tx_proof` (CLI), the GUI's "Prove
	 *  transaction" dialog, or the equivalent in Cake / Feather.
	 *  Empty when fee method is anything other than XMR.
	 *
	 *  Privacy invariant: the proof reveals only "this txid paid
	 *  this address this amount" — exactly the public information
	 *  needed for verification, no more.  It does NOT reveal
	 *  other payments to the address, other transactions in the
	 *  user's wallet, or any wallet metadata.  The user is the
	 *  ONLY party that needs to hold any verification secret
	 *  (their tx_key from their own wallet, never published);
	 *  the indexer holds nothing. */
	let txProof: string = $state('');
	/** Client-side validation of txProof for fee_method=xmr.
	 *  Mirrors the indexer's order-handler structural validator
	 *  so the user gets immediate feedback instead of a chain
	 *  rejection later. */
	const txProofError = $derived.by(() => {
		if (feeMethodChoice !== 'xmr') return '';
		const trimmed = txProof.trim();
		if (trimmed.length === 0) {
			return $_('post_order.fee_method.tx_proof_required');
		}
		if (
			!trimmed.startsWith('OutProofV1') &&
			!trimmed.startsWith('OutProofV2')
		) {
			return $_('post_order.fee_method.tx_proof_malformed_prefix');
		}
		if (trimmed.length < 64 || trimmed.length > 4096) {
			return $_('post_order.fee_method.tx_proof_malformed_length');
		}
		if (!/^[A-Za-z0-9]+$/.test(trimmed)) {
			return $_('post_order.fee_method.tx_proof_malformed_charset');
		}
		return 'ok';
	});
	/** Client-side validation of externalTxId. Empty string for
	 *  blurt/waived paths; 'ok' when shape passes; any other
	 *  non-empty string is the (localized) error message.
	 *
	 *  Note: trim() before testing because paste-from-wallet
	 *  often inserts leading/trailing whitespace.  The submitter
	 *  also trims again before calling broadcastNewOrder; this
	 *  derivation just gives clean validation feedback in the
	 *  meantime. */
	const externalTxIdError = $derived.by(() => {
		if (feeMethodChoice !== 'btc' && feeMethodChoice !== 'xmr') return '';
		const trimmed = externalTxId.trim();
		if (trimmed.length === 0) {
			return $_('post_order.fee_method.txid_required');
		}
		if (!/^[0-9a-f]{64}$/i.test(trimmed)) {
			return $_('post_order.fee_method.txid_malformed');
		}
		return 'ok';
	});

	/** Tracks the last asset value we applied a fee-method
	 *  pre-selection for.  Used to fire the asset→fee-method
	 *  coercion exactly once per asset change, so explicit
	 *  later fee-method edits by the user stick. */
	let lastAutoSelectedForAsset = $state<Asset | null>(null);

	$effect(() => {
		// When the user picks XMR or BTC as the trade asset, default
		// the fee method to match.  Monero traders shouldn't have to
		// click around to find the XMR fee option — it should be the
		// natural default when they're trading XMR.  Same for BTC.
		// Fires once per asset change so explicit later edits stick.
		if (asset !== null && asset !== lastAutoSelectedForAsset) {
			lastAutoSelectedForAsset = asset;
			if (asset === 'XMR' && feeMethodChoice === 'blurt') {
				feeMethodChoice = 'xmr';
			} else if (asset === 'BTC' && feeMethodChoice === 'blurt') {
				feeMethodChoice = 'btc';
			}
		}

		// Auto-select waiver when it becomes available AND the user
		// hasn't already picked a specific method. Don't override an
		// explicit BTC/XMR choice.
		if (waiverOffered && feeMethodChoice === 'blurt') {
			feeMethodChoice = 'waived_first_buy';
		}
		// If the user changes side from buy → sell mid-compose, we
		// have to revert a waiver choice back to BLURT.
		if (!waiverOffered && feeMethodChoice === 'waived_first_buy') {
			feeMethodChoice = 'blurt';
		}
		// Waiver is BLURT-only. Two-way sync:
		//  - If the user picks the waiver, auto-set asset to BLURT
		//    (they can't redeem it on BTC/XMR anyway — indexer
		//    would reject `waiver_requires_blurt`).
		//  - If the user picks a non-BLURT asset while on the waiver,
		//    drop them back to the paid path so they don't get
		//    blindsided by an indexer rejection after broadcast.
		if (feeMethodChoice === 'waived_first_buy' && asset !== 'BLURT') {
			if (asset === null) {
				asset = 'BLURT';
			} else {
				feeMethodChoice = 'blurt';
			}
		}
	});

	/** Minimum BLURT amount for a waiver-eligible buy, so the
	 *  user's first trade pulls a meaningful starter balance into
	 *  their wallet.  500 BLURT is roughly $1 at typical recent
	 *  BLURT prices and lines up nicely with the 60 BLURT listing
	 *  fee (a waiver-buy of 500 BLURT covers ~8 future listings,
	 *  so the new user has room to be active).  This is the
	 *  *floor* — enforced on the indexer; orders below it are
	 *  rejected with `waiver_requires_min_usd`.  We don't expose
	 *  this floor in the UI by default; instead we suggest a
	 *  more generous default (`WAIVER_SUGGESTED_DEFAULT`) that
	 *  positions the user well in the loyalty-milestone curve. */
	const WAIVER_MIN_BLURT = 500;
	/** Suggested first-buy amount for the welcome flow.  2,000
	 *  BLURT crosses two thresholds at once: it carries the user
	 *  past the first 500-BLURT loyalty milestone (10 BP delegated
	 *  → see `loyalty_milestones` FAQ) AND gives them roughly 33
	 *  future listings at the discounted BLURT rate.  We pre-fill
	 *  this when the user comes through the orderbook welcome
	 *  hero; users who type a smaller value (down to the 500
	 *  floor) are still accepted silently.  The UI never tells
	 *  the user "minimum 500" — it tells them what they GET at
	 *  different sizes, which encourages a bigger buy without
	 *  feeling like a tax. */
	const WAIVER_SUGGESTED_DEFAULT = 2000;

	/** Tier breakpoints for the first-buy benefits ladder.  Each
	 *  entry pairs a minimum-amount threshold with an i18n key
	 *  describing what the user gets at that level.  The ladder
	 *  is rendered in step 2 when the waiver is offered.  Every
	 *  row whose threshold ≤ the user's current `amountMin` shows
	 *  as "unlocked" (✓, emerald-bold); higher rows show as
	 *  "available if you increase" (○, muted).  500 is at the
	 *  bottom because it's the indexer's silent floor — anything
	 *  smaller is rejected; anything ≥ 500 lights at least this
	 *  row.  Tiers chosen to align with the loyalty-milestone
	 *  thresholds (`loyalty_milestones` FAQ): 500 (~8 listings),
	 *  2000 (matches a 100-BLURT loyalty milestone if user later
	 *  spends fees), 10000 (heavy starter), 50000 (whale buy). */
	const WAIVER_BENEFIT_TIERS: ReadonlyArray<{ readonly at: number; readonly key: string }> = [
		{ at: 500, key: 'post_order.waiver_benefits.tier_500' },
		{ at: 2000, key: 'post_order.waiver_benefits.tier_2000' },
		{ at: 10_000, key: 'post_order.waiver_benefits.tier_10000' },
		{ at: 50_000, key: 'post_order.waiver_benefits.tier_50000' }
	];

	/** Operator's configured base fee per listing in BLURT, as
	 *  reported by /v1/listing-fee.  Read from the indexer rather
	 *  than bundled so a federation operator can tune their fee
	 *  without forking the frontend.  Falls back to the bundled
	 *  default when the indexer fetch fails.  See $lib/orders/fee
	 *  for the constant. */
	let operatorBaseBlurt: number = $state(BASE_FEE_BLURT);

	/** Tier 3.2 (Part 99) — persist the user's fiat / region
	 *  choice after a successful broadcast.  Best-effort; if
	 *  localStorage is unavailable or quota-exceeded, the form
	 *  still works, the user just won't see pre-fill on next
	 *  visit.  Only persists non-empty values; an order posted
	 *  with empty fiat/region (which the form actually
	 *  disallows on submission, but defense in depth) doesn't
	 *  overwrite a previously-set preference with an empty
	 *  string. */
	function persistPreferencesAfterSuccess(): void {
		try {
			if (fiat !== '') setPreference('fiat', fiat);
			if (region !== '') setPreference('region', region);
		} catch {
			// localStorage unavailable / quota / private browsing —
			// non-fatal, the broadcast already succeeded.
		}
	}

	async function recomputeFee(): Promise<void> {
		if (!blurtAccount) return;
		feeLoading = true;
		feeError = '';
		try {
			// Get current tier: count of orders in the user's 24h
			// window. The indexer returns all the user's orders;
			// we filter.
			const ordersPromise = getOrdersByAccount(blurtAccount, { limit: 100 });
			// Fetch the operator's configured base fee in parallel.
			// This is the authoritative number the indexer will
			// verify against; the bundled BASE_FEE_BLURT is only a
			// fallback for when this fetch fails.  Same call also
			// surfaces the optional USD echo if the operator has
			// the price feed enabled.
			const lfPromise = fetchListingFee(resolveOrigin(MORPHIT_INDEXER_ORIGIN));

			const result = await ordersPromise;
			if (!result.ok) {
				throw new Error(result.message);
			}
			const cutoff = Date.now() - 24 * 3600 * 1000;
			const activeCount = result.data.items.filter((o) => {
				const createdMs = new Date(o.created_at).getTime();
				// Order counts toward tier if it's currently live OR
				// was created in the last 24h (even if cancelled).
				return o.status === 'live' || createdMs >= cutoff;
			}).length;

			// Read operator's base from the listing-fee fetch.
			// Don't fail-hard on a flaky indexer — fall back to the
			// bundled default and let the user proceed.  If the
			// operator has changed their fee from the default, the
			// indexer will reject as fee_underpaid and the user
			// gets clear status feedback in their My Orders page.
			const lf = await lfPromise;
			if (lf.kind === 'ok') {
				if (typeof lf.quote.base_fee_blurt === 'number' && lf.quote.base_fee_blurt > 0) {
					operatorBaseBlurt = lf.quote.base_fee_blurt;
				}
				// cp128: renamed from blurt_price_usd + companion
				// denomination_fiat field.
				if (typeof lf.quote.blurt_price_fiat === 'number') {
					fiatPerBlurt = lf.quote.blurt_price_fiat;
				}
				if (typeof lf.quote.denomination_fiat === 'string') {
					denominationFiat = lf.quote.denomination_fiat;
				}
			}

			feeQuote = computeFee(activeCount + 1, operatorBaseBlurt);
		} catch (err) {
			feeError = err instanceof Error ? err.message : String(err);
			feeQuote = null;
		} finally {
			feeLoading = false;
		}
	}

	onMount(() => {
		// Pre-fetch the fee quote so grandma doesn't wait when she hits Post.
		if (blurtAccount) void recomputeFee();
		// Check waiver eligibility. A failure here just means we
		// don't offer the waiver; no error surface. The indexer
		// validates on submission regardless.
		if (blurtAccount) {
			void checkWaiverEligibility(resolveOrigin(MORPHIT_INDEXER_ORIGIN), blurtAccount)
				.then((r) => {
					waiverEligibility = r;
				})
				.catch(() => {
					waiverEligibility = { kind: 'error', message: '' };
				});
		}
		// Sally finding M1/M8 (Part 68): tick once a second to drive
		// the post-broadcast edit-window countdown.  Idle (does
		// nothing visible) until phase === 'success'.  Cleared on
		// component unmount.
		const t = setInterval(() => {
			nowMs = Date.now();
		}, 1000);
		// Restore a previously-saved draft, if one exists and
		// actually contains user content. A just-defaults snapshot
		// is silently ignored — showing a "Restored from X ago"
		// banner when nothing meaningful was saved is just noise.
		const saved = loadDraftWithMeta<ComposeDraft>(DRAFT_KEY);
		if (saved && draftHasContent(saved.value)) {
			applyDraft(saved.value);
			draftSavedAt = new Date(saved.meta.savedAt);
		}

		// One-shot prefill from another page (profile "Top up BLURT",
		// or my-orders "Re-list this order").  Applied AFTER draft
		// restore so a user who already had a draft in progress isn't
		// surprised — but the prefill wins for the specific fields it
		// sets.  Cleared after read so navigating back to /post
		// manually doesn't repeat.
		try {
			const raw = safeSession.get(PREFILL_KEY);
			if (raw) {
				safeSession.remove(PREFILL_KEY);
				const p = JSON.parse(raw) as Partial<{
					side: 'buy' | 'sell';
					asset: string;
					assetNetwork: string | null;
					amountMin: string;
					amountMax: string;
					fiat: string;
					priceModelKind: 'spread' | 'fixed';
					spreadPercent: string;
					fixedPrice: string;
					paymentMethods: string[];
					region: string;
					terms: string;
					expiresDays: number;
					reason: string;
				}>;
				if (p.side === 'buy' || p.side === 'sell') side = p.side;
				if (isAssetTicker(p.asset)) {
					asset = p.asset;
				}
				// cp36 Bob-4 fix — hydrate the matching multi-network
				// picker from the prefill payload's assetNetwork.
				// Defensive typeguards: an unknown value lands the
				// picker on null so the canSubmit gate forces the
				// user to re-pick rather than silently broadcasting
				// a stale value (same posture as the /post/edit
				// load hydration added in cp36).
				if (asset === 'USDT' && typeof p.assetNetwork === 'string' && isUsdtNetwork(p.assetNetwork)) {
					usdtNetwork = p.assetNetwork;
				} else if (asset === 'USDC' && typeof p.assetNetwork === 'string' && isUsdcNetwork(p.assetNetwork)) {
					usdcNetwork = p.assetNetwork;
				} else if (asset === 'DAI' && typeof p.assetNetwork === 'string' && isDaiNetwork(p.assetNetwork)) {
					daiNetwork = p.assetNetwork;
				}
				if (typeof p.amountMin === 'string') amountMin = p.amountMin;
				if (typeof p.amountMax === 'string') amountMax = p.amountMax;
				if (typeof p.fiat === 'string') fiat = p.fiat;
				if (p.priceModelKind === 'spread' || p.priceModelKind === 'fixed') {
					priceModelKind = p.priceModelKind;
				}
				if (typeof p.spreadPercent === 'string') spreadPercent = p.spreadPercent;
				if (typeof p.fixedPrice === 'string') fixedPrice = p.fixedPrice;
				if (Array.isArray(p.paymentMethods)) {
					// Defensive copy — the array could contain
					// non-strings if the source was tampered with.
					paymentMethods = p.paymentMethods.filter((m): m is string => typeof m === 'string');
				}
				if (typeof p.region === 'string') region = p.region;
				if (typeof p.terms === 'string') terms = p.terms;
				if (typeof p.expiresDays === 'number' && Number.isFinite(p.expiresDays)) {
					// Clamp to the schema-allowed range; the UI
					// validates on submit anyway, but a hostile
					// session-storage write shouldn't reach the
					// form with out-of-range data.
					expiresDays = Math.max(1, Math.min(90, Math.floor(p.expiresDays)));
				}
			}
		} catch {
			// Bad JSON in session storage — ignore, don't break the
			// post page over a poisoned key.
			safeSession.remove(PREFILL_KEY);
		}

		// ?welcome=1 query param — landed here from the orderbook's
		// WelcomeFirstBuyHero CTA. Set the new-user-friendly
		// defaults: side=buy, asset=BLURT, amountMin=2000 (the
		// first loyalty-milestone threshold — see WAIVER_SUGGESTED_DEFAULT
		// below for rationale).  The actual gate floor is 500 BLURT
		// (enforced silently on the indexer); users who type a
		// smaller value are still accepted as long as they're at
		// or above 500.  Don't overwrite anything the draft or
		// PREFILL already populated; only fill empties so a user
		// who half-composed something earlier isn't surprised.
		try {
			if (typeof window !== 'undefined') {
				const params = new URLSearchParams(window.location.search);
				if (params.get('welcome') === '1') {
					if (side === null) side = 'buy';
					if (asset === null) asset = 'BLURT';
					if (amountMin === '') amountMin = String(WAIVER_SUGGESTED_DEFAULT);
				}
			}
		} catch {
			// Window/searchParams shouldn't throw, but defense in depth.
		}

		// Tier 3.2 (Part 99) — third-tier preferences pre-fill.
		// Only fills empty fields, AFTER draft-restore and
		// session-prefill have had their chances.  A user with a
		// half-composed draft sees their draft values; a user
		// arriving from a "Re-list this order" prefill sees those
		// values; a user landing on a fresh /post with an empty
		// form gets their stored fiat / region preferences (if any)
		// applied so they don't have to re-pick the same values
		// every time.  Empty preferences (the default for a brand-
		// new user) are silently no-op.
		try {
			const prefs = getPreferencesSnapshot();
			if (fiat === '' && prefs.fiat !== '') fiat = prefs.fiat;
			if (region === '' && prefs.region !== '') region = prefs.region;
		} catch {
			// localStorage unavailable / quota issues / private
			// browsing — preferences are best-effort, never block
			// the page.
		}

		return () => {
			if (draftSaveTimeout) clearTimeout(draftSaveTimeout);
			clearInterval(t);
		};
	});

	// ─── Auto-save ─────────────────────────────────────────────────
	// Whenever any draft field changes, schedule a debounced write
	// so we don't thrash localStorage on every keystroke. 500 ms
	// means a user typing continuously gets one write per 500 ms,
	// not 50. Only fires while the user is still EDITING — once
	// they've moved past editing (review → broadcasting → success),
	// the draft is either being preserved for retry or cleared.
	$effect(() => {
		// Re-run when any persisted field changes.
		void side;
		void asset;
		void fiat;
		void amountMin;
		void amountMax;
		void priceModelKind;
		void spreadPercent;
		void fixedPrice;
		void paymentMethods;
		void pmDraft;
		void region;
		void terms;
		void expiresDays;
		void syndicateToBlog;
		void feeMethodChoice;
		void externalTxId;
		void phase;

		// Don't save while broadcasting/success — those states
		// shouldn't overwrite the last good editing snapshot, and
		// on success the draft is cleared anyway.
		if (phase !== 'editing' && phase !== 'reviewing') return;

		if (draftSaveTimeout) clearTimeout(draftSaveTimeout);
		draftSaveTimeout = setTimeout(() => {
			const snapshot = snapshotDraft();
			// Skip writes when the snapshot has nothing worth saving
			// — avoids churning the storage slot with an all-defaults
			// envelope and avoids showing "Restored" later for a
			// draft that would restore nothing.
			if (draftHasContent(snapshot)) {
				saveDraft(DRAFT_KEY, snapshot);
			}
		}, 500);
	});

	// ─── Validation ────────────────────────────────────────────────
	const step1Done = $derived(
		side !== null &&
			asset !== null &&
			(asset !== 'USDT' || usdtNetwork !== null) &&
			(asset !== 'USDC' || usdcNetwork !== null) &&
			(asset !== 'DAI' || daiNetwork !== null)
	);

	const fiatError = $derived.by(() => {
		if (fiat.length === 0) return '';
		const trimmed = fiat.trim().toUpperCase();
		if (trimmed.length === 0) return $_('post_order.errors.fiat_empty');
		if (trimmed.length > 8) return $_('post_order.errors.fiat_too_long');
		if (!/^[A-Z]+$/.test(trimmed)) return $_('post_order.errors.fiat_bad_chars');
		return '';
	});

	const amountMinNum = $derived(amountMin === '' ? null : Number(amountMin));
	const amountMaxNum = $derived(amountMax === '' ? null : Number(amountMax));

	/** Sanity cap.  Mirror of indexer's MAX_AMOUNT in
	 *  apps/indexer/src/indexer/handlers/order.ts.  Beyond
	 *  hyperinflation worst cases — anything past 1e12 is a typo
	 *  or attack.  Catching client-side gives Sally an immediate
	 *  error instead of a chain-broadcast → indexer-rejection
	 *  round-trip. */
	const MAX_AMOUNT = 1e12;

	const amountError = $derived.by(() => {
		if (amountMinNum !== null) {
			if (!Number.isFinite(amountMinNum) || amountMinNum < 0) {
				return $_('post_order.errors.amount_min_negative');
			}
			if (amountMinNum > MAX_AMOUNT) {
				return $_('post_order.errors.amount_min_too_large');
			}
		}
		if (amountMaxNum !== null) {
			if (!Number.isFinite(amountMaxNum) || amountMaxNum < 0) {
				return $_('post_order.errors.amount_max_negative');
			}
			if (amountMaxNum > MAX_AMOUNT) {
				return $_('post_order.errors.amount_max_too_large');
			}
		}
		if (amountMinNum !== null && amountMaxNum !== null && amountMinNum > amountMaxNum) {
			return $_('post_order.errors.amount_min_exceeds_max');
		}
		// Phase 3: waiver-path orders must have amount_min set AND
		// ≥ WAIVER_MIN_BLURT BLURT. Mirrors the indexer's
		// `waiver_requires_min_usd` rejection so the user fails the
		// client-side gate before broadcast.
		//
		// cp129 i18n-key rename: the key was `waiver_min_usd_required`
		// (historical, from when the floor was thought of as a USD
		// constant).  Renamed to `waiver_min_required` since the
		// underlying constant is BLURT-denominated and denomination-
		// independent.  The on-chain indexer rejection code
		// (`waiver_requires_min_usd`) stays as-is — that's a protocol
		// constant we shouldn't churn on without consensus.
		if (feeMethodChoice === 'waived_first_buy') {
			if (amountMinNum === null) {
				return $_('post_order.errors.waiver_min_required');
			}
			if (amountMinNum < WAIVER_MIN_BLURT) {
				return $_('post_order.errors.waiver_min_required');
			}
		}
		return '';
	});

	/** Validation for the price-model picker.
	 *
	 *  - 'spread' kind: `spreadPercent` must parse as a finite
	 *    number in [-50, 50].  An out-of-range or non-numeric
	 *    value would be silently coerced to 0 by `Number(...)`
	 *    in submitPost, which would mean "user typed +5% but
	 *    we posted 0%" — quietly wrong is worse than failing
	 *    the gate.  The 50% cap is conservative; any genuine
	 *    use case beyond that (firesale, distress sale) is
	 *    better expressed as 'fixed'.
	 *  - 'fixed' kind: `fixedPrice` must parse as a finite
	 *    positive number.  Empty / zero / negative is invalid
	 *    because there's no sensible default — unlike spread
	 *    where 0 means "market", a fixed price of 0 just
	 *    means the user forgot to type one.
	 *
	 *  Returns '' when valid (or when the field is empty in
	 *  spread mode — empty spread defaults to 0, which IS
	 *  valid).
	 */
	const priceModelError = $derived.by(() => {
		if (priceModelKind === 'spread') {
			// Empty spread is OK — it means "market price" (0%).
			if (spreadPercent.trim() === '') return '';
			const n = Number(spreadPercent);
			if (!Number.isFinite(n)) {
				return $_('post_order.errors.spread_not_a_number');
			}
			if (n < -50 || n > 50) {
				return $_('post_order.errors.spread_out_of_range');
			}
			return '';
		}
		// 'fixed' kind — must have a positive finite number.
		if (fixedPrice.trim() === '') {
			return $_('post_order.errors.fixed_price_required');
		}
		const n = Number(fixedPrice);
		if (!Number.isFinite(n) || n <= 0) {
			return $_('post_order.errors.fixed_price_invalid');
		}
		if (n > MAX_AMOUNT) {
			return $_('post_order.errors.fixed_price_too_large');
		}
		return '';
	});

	/** Rendered benefits ladder rows for the current amountMin.
	 *  Populated only when the waiver is offered (the surrounding
	 *  UI gates the render).  Computed once per amountMin change.
	 *
	 *  When the operator's price feed is enabled and a fresh
	 *  BLURT/fiat value is available (`fiatPerBlurt`), each tier
	 *  row shows the live fiat equivalent of that tier amount —
	 *  e.g. "500 BLURT (~$1) — ~8 future listings covered".
	 *  Without fiat context, rows fall back to BLURT-only labels.
	 *  This way a new user immediately understands the dollar
	 *  weight of each option rather than guessing.  Fiat figures
	 *  are formatted with locale-aware grouping and 2 decimals
	 *  (or 0 decimals if the figure is ≥ 10, where cents are noise).
	 *
	 *  cp128 rename: `_with_usd` → `_with_fiat` since the
	 *  denomination is now operator-configurable.  The
	 *  `{denomination_fiat}` interpolation placeholder lets the
	 *  i18n string carry the unit (e.g. "{amount} BLURT (~{fiat}
	 *  {denomination_fiat})").  Today the `_with_fiat` keys don't
	 *  exist in the locale files — the lookup gracefully degrades
	 *  to the BLURT-only label — but the future correct shape is
	 *  in place. */
	const waiverBenefitRows = $derived.by(
		(): ReadonlyArray<{
			readonly text: string;
			readonly unlocked: boolean;
		}> => {
			const n = amountMinNum ?? 0;
			const formatBlurt = (amount: number): string =>
				amount.toLocaleString(undefined, { maximumFractionDigits: 0 });
			const formatFiatNumber = (amount: number): string => {
				const decimals = amount >= 10 ? 0 : 2;
				return amount.toLocaleString(undefined, {
					minimumFractionDigits: decimals,
					maximumFractionDigits: decimals
				});
			};
			return WAIVER_BENEFIT_TIERS.map((tier) => {
				const fiatAmount =
					fiatPerBlurt !== null && fiatPerBlurt > 0 ? tier.at * fiatPerBlurt : null;
				// Pick the with-fiat i18n variant when we have a live
				// price; fall back to the plain BLURT-only key when
				// we don't.  Both keys interpolate {amount}; the
				// with-fiat variant also interpolates {fiat} and
				// {denomination_fiat}.
				const i18nKey = fiatAmount !== null ? `${tier.key}_with_fiat` : tier.key;
				return {
					text: $_(i18nKey, {
						values: {
							amount: formatBlurt(tier.at),
							fiat: fiatAmount !== null ? formatFiatNumber(fiatAmount) : '',
							denomination_fiat: denominationFiat
						}
					}) as string,
					unlocked: n >= tier.at
				};
			});
		}
	);

	const step2Done = $derived(
		fiat.trim().length > 0 && fiatError === '' && amountError === '' && priceModelError === ''
	);

	const paymentMethodsError = $derived.by(() => {
		if (paymentMethods.length === 0) {
			return ''; // empty is OK while editing; only required to submit
		}
		if (paymentMethods.length > 12) {
			return $_('post_order.errors.payment_methods_too_many');
		}
		for (const m of paymentMethods) {
			if (m.length > 32) return $_('post_order.errors.payment_method_too_long');
		}
		return '';
	});

	const step3Done = $derived(paymentMethods.length > 0 && paymentMethodsError === '');

	const canReview = $derived(step1Done && step2Done && step3Done);

	// ─── Transition handlers ───────────────────────────────────────
	function goToReview(): void {
		if (!canReview) return;
		phase = 'reviewing';
	}

	function backToEditing(): void {
		phase = 'editing';
	}

	function goToPasswordPrompt(): void {
		// Waived and btc/xmr orders need only the posting key, which is
		// already active in the unlocked session — no password prompt.
		// Jump straight to submission.
		if (
			feeMethodChoice === 'waived_first_buy' ||
			feeMethodChoice === 'btc' ||
			feeMethodChoice === 'xmr'
		) {
			void submitBroadcast();
			return;
		}
		phase = 'awaiting_password';
		passwordError = '';
	}

	async function submitBroadcast(): Promise<void> {
		// Private-key gate: if terms contains a detected key and the
		// user hasn't acknowledged the warning yet, show the modal
		// instead of broadcasting. (region + pmDraft rely on the
		// silent redaction in buildOrderPayload; terms is long
		// enough to warrant the UI interrupt too.)
		if (termsKeyMatches.length > 0 && !userAckedTermsKeyWarning) {
			showTermsKeyWarning = true;
			return;
		}

		const state = get(identity);
		if (state.state !== 'unlocked') {
			broadcastError = $_('post_order.broadcast_error.body_locked');
			phase = 'error';
			return;
		}
		// Waived orders have no fee quote by design. Only the BLURT
		// path requires one here.
		if (feeMethodChoice === 'blurt' && !feeQuote) {
			// Display the localized friendly message; raw feeError
			// (a possibly-English exception message) goes to the
			// debug tooltip via the same pattern used at the inline
			// fee-error display (~line 1776).
			broadcastError = $_('post_order.errors.fee_not_ready');
			phase = 'error';
			return;
		}
		if (!blurtAccount) {
			broadcastError = $_('post_order.no_account.body');
			phase = 'error';
			return;
		}

		phase = 'broadcasting';

		// Build the form input. We've already validated; this just
		// funnels values into the typed shape.
		const priceModel: Record<string, unknown> =
			priceModelKind === 'spread'
				? { kind: 'spread', percent: Number(spreadPercent) || 0 }
				: { kind: 'fixed', price: Number(fixedPrice) };

		const input: OrderFormInput = {
			side: side!,
			asset: asset!,
			fiatCurrency: fiat.trim().toUpperCase(),
			amountMin: amountMinNum,
			amountMax: amountMaxNum,
			priceModel,
			// Sally finding L8 (Part 68): defense-in-depth — apply
			// redactPrivateKeys to region AND every payment-method
			// entry, the same hook that already runs on `terms`.
			// A user pasting from a clipboard that still has a WIF
			// (because they just copied from another Blurt UI) into
			// a plain text field shouldn't accidentally broadcast
			// it on-chain.  No UX cost on the clean path: redact is
			// a no-op when there's no key to find.
			locationRegion: region.trim() ? redactPrivateKeys(region.trim()) : null,
			paymentMethods: paymentMethods.map((pm) => redactPrivateKeys(pm)),
			terms: terms.trim() || null,
			expiresAt: makeExpiryFlooredUtcDay(expiresDays),
			feeMethod: feeMethodChoice,
			externalTxId:
				feeMethodChoice === 'btc' || feeMethodChoice === 'xmr'
					? externalTxId.trim().toLowerCase()
					: undefined,
			// Part 108++ — XMR per-payment proof.  Required for
			// fee_method=xmr; ignored for everything else.
			txProof: feeMethodChoice === 'xmr' ? txProof.trim() : undefined,
			// Part 121 / cp30 / cp31 — sub-network for multi-network
			// assets.  USDT, USDC, and DAI all carry a network
			// discriminator; single-network assets (BTC/XMR/BLURT/BCH/
			// LTC/DASH/DOGE) pass undefined and the payload builder
			// omits the field.  CP34 closure: cp31 added DAI to the
			// registry + payment_method + chat surfaces but MISSED
			// this assetNetwork dispatch — meaning DAI orders posted
			// via the form went out without an asset_network field
			// and the indexer's order handler rejected them with
			// 'asset_network_required_for_dai'.  DAI order posting
			// was silently broken cp31→cp34 (~1 day).
			assetNetwork:
				asset === 'USDT' && usdtNetwork !== null
					? usdtNetwork
					: asset === 'USDC' && usdcNetwork !== null
						? usdcNetwork
						: asset === 'DAI' && daiNetwork !== null
							? daiNetwork
							: undefined,
			// REVISIT-LIST item 5 — pull the configured operator
			// tag from the instance store (synchronous accessor;
			// store hydrates on +layout mount, by the time the
			// user reaches the post form it's settled).  When
			// null (unbranded instance), this is omitted from
			// the eventual on-chain payload — the indexer treats
			// no-tag as "treasury keeps 100%."
			operatorTag: getInstanceSnapshot().operator_tag ?? undefined
		};

		// Branch on fee method. Waived and btc/xmr share a posting-
		// only path (no active-key prompt, no fee quote). BLURT runs
		// the existing flow.
		if (
			feeMethodChoice === 'waived_first_buy' ||
			feeMethodChoice === 'btc' ||
			feeMethodChoice === 'xmr'
		) {
			try {
				const result = await broadcastNewOrder(
					state.live,
					null,
					input,
					0, // unused for non-BLURT paths
					BASE_FEE_BLURT // unused for non-BLURT paths; sane default if reached
				);
				successPermlink = result.permlink;
				successUsedWaiver = feeMethodChoice === 'waived_first_buy';
				// Sally finding M1/M8: stamp success time so the
				// edit-window countdown chip can render live.
				successFiredAt = Date.now();
				phase = 'success';
				password = '';
				// Broadcast succeeded — drop the draft. If the user
				// comes back to /post later they'll start fresh.
				clearDraft(DRAFT_KEY);
				draftSavedAt = null;
				// Tier 3.2 — remember fiat/region for next time.
				persistPreferencesAfterSuccess();
				// No fee debit on waived/btc/xmr paths, so the BLURT
				// balance hasn't moved.  Don't trigger the balance
				// bus here — see the BLURT-paid path below for the
				// counterpart.
				// Fire Post B in the background if user opted in.
				// Best-effort; the success card renders the result
				// reactively as it lands.
				if (syndicateToBlog) {
					void fireSyndicationPost(result.permlink);
				}
			} catch (err) {
				password = '';
				// Map raw exception text to a localized message.
				// The raw text is English (network library output)
				// and shouldn't surface to non-English users.
				const msg = err instanceof Error ? err.message : String(err); // smoke-ok-raw-local: used only for regex classification + console.warn
				console.warn('[post] waived/btc/xmr broadcast failed:', err);
				if (/insufficient/i.test(msg) || /balance/i.test(msg)) {
					broadcastError = $_('post_order.broadcast_error.body_insufficient_funds');
				} else {
					broadcastError = $_('post_order.broadcast_error.body_generic');
				}
				phase = 'error';
			}
			return;
		}

		// Fresh price for the fee in case it's drifted while the user
		// was reviewing.
		let freshFee: FeeQuote;
		try {
			await recomputeFee();
			if (!feeQuote) throw new Error(feeError);
			freshFee = feeQuote;
		} catch (err) {
			// `err.message` here is the raw fee-fetch exception text
			// (English, network-library specific).  Surface a
			// localized message instead and keep the raw text in
			// the console for debugging.
			console.warn('[post] fee recompute failed:', err);
			broadcastError = $_('post_order.errors.fee_not_ready');
			phase = 'error';
			return;
		}

		try {
			// Phase F.5 audit fix (F-18) — sign-callback pattern.
			// broadcastNewOrder prepares the unsigned tx, calls our
			// callback (wrapped in useActiveKey) to sign, then
			// broadcasts.  The active-key scalar lives only for
			// the synchronous signOrderWithFeeWithKey call (~10ms),
			// not the full network roundtrip.
			const signCallback = async (
				unsigned: import('@beblurt/dblurt').Transaction
			): Promise<import('@beblurt/dblurt').SignedTransaction> => {
				return useActiveKey(
					state.envelope,
					password,
					async (activePriv) => {
						const { signOrderWithFeeWithKey } = await import('$blurt/sign');
						return signOrderWithFeeWithKey(unsigned, state.live.posting.privateKey, activePriv);
					},
					// M6: pin to the live session's posting pubkey so
					// envelope decrypt verifies identity continuity.
					state.live.posting.publicKey
				);
			};
			const result = await broadcastNewOrder(
				state.live,
				signCallback,
				input,
				freshFee.nth,
				operatorBaseBlurt
			);
			// useActiveKey has wiped the scalar by now.
			successPermlink = result.permlink;
			// We're in the BLURT-paid branch; the waived/btc/xmr
			// branches return early at line ~939 above, so by the
			// time we reach this point feeMethodChoice can only be
			// 'blurt' and `successUsedWaiver` is always false here.
			// (TS narrows correctly; the explicit literal makes the
			// invariant readable for the next reader.)
			successUsedWaiver = false;
			// Sally finding M1/M8: stamp success time so the
			// edit-window countdown chip can render live.
			successFiredAt = Date.now();
			phase = 'success';
			// Clear password from memory.
			password = '';
			// Broadcast succeeded — drop the draft.
			clearDraft(DRAFT_KEY);
			draftSavedAt = null;
			// Tier 3.2 — remember fiat/region for next time.
			persistPreferencesAfterSuccess();
			// BLURT-paid path: the fee transfer has been broadcast,
			// so the user's BLURT balance just decreased by
			// `feeQuote.amountBlurt`.  Nudge any visible balance
			// card to refresh now rather than wait for its 5s tick.
			triggerBalanceRefresh();
			// Fire Post B in the background if user opted in.
			if (syndicateToBlog) {
				void fireSyndicationPost(result.permlink);
			}
		} catch (err) {
			password = '';
			if (err instanceof BroadcastError && err.code === 'locked') {
				broadcastError = $_('post_order.broadcast_error.body_locked');
			} else if (err instanceof KeystoreError && err.kind === 'bad_password') {
				// Wrong password.  Without this branch, the user just
				// sees "broadcast failed" and has no idea the password
				// is the problem.  Phase is 'error' which surfaces the
				// retry button — but the password input is back in the
				// `awaiting_password` phase, so we route there
				// explicitly and tell the user what went wrong via the
				// existing broadcastError surface.
				broadcastError = $_('post_order.broadcast_error.body_bad_password');
			} else if (err instanceof KeystoreError && err.kind === 'identity_mismatch') {
				// Audit 2026-05 finding 1-4: typed dispatch.
				broadcastError = $_('crypto.error.identity_mismatch');
			} else {
				const msg = err instanceof Error ? err.message : String(err); // smoke-ok-raw-local: used only for regex classification + console.warn
				console.warn('[post] BLURT-path broadcast failed:', err);
				if (/insufficient/i.test(msg) || /balance/i.test(msg)) {
					broadcastError = $_('post_order.broadcast_error.body_insufficient_funds');
				} else {
					broadcastError = $_('post_order.broadcast_error.body_generic');
				}
			}
			phase = 'error';
		}
	}

	function retryFromError(): void {
		// Keep the form state; just go back to the review step so
		// the user can re-read before trying again.
		phase = 'reviewing';
		broadcastError = '';
	}

	/** Fire Post B (the per-order syndication post to the user's
	 *  Blurt blog). Called only on the success path of a successful
	 *  order broadcast, and only when the user opted in.
	 *
	 *  Best-effort: a failure here does NOT roll back the order,
	 *  does NOT change `phase` from 'success', and does NOT block
	 *  the user from continuing. The order is already on-chain;
	 *  the blog post is a bonus.
	 *
	 *  We use the `syndicationStatus` reactive state so the success
	 *  card can render the live state (pending → ok / failed). */
	async function fireSyndicationPost(orderPermlink: string): Promise<void> {
		const state = get(identity);
		if (state.state !== 'unlocked') {
			// Lost unlock between order broadcast and this call.
			// Soft-fail — the order is already up.
			syndicationStatus = 'failed';
			return;
		}
		if (!asset) {
			// Defensive — shouldn't happen since asset must be set
			// to have built the order, but guard anyway.
			syndicationStatus = 'failed';
			return;
		}
		syndicationStatus = 'pending';
		const result = await publishOrderPost(state.live, {
			orderPermlink,
			side: side === 'sell' ? 'sell' : 'buy',
			asset,
			counterAsset: fiat.trim().toUpperCase()
		});
		if (result.ok) {
			syndicationStatus = 'ok';
		} else {
			syndicationStatus = 'failed';
		}
	}

	function postAnother(): void {
		// Reset everything for a fresh listing.
		side = null;
		asset = null;
		fiat = '';
		amountMin = '';
		amountMax = '';
		priceModelKind = 'spread';
		spreadPercent = '0';
		fixedPrice = '';
		paymentMethods = [];
		pmDraft = '';
		region = '';
		terms = '';
		expiresDays = 14;
		syndicateToBlog = false;
		syndicationStatus = null;
		successPermlink = null;
		successUsedWaiver = false;
		// Sally finding M1/M8: clear the success-stamp so the
		// next post's countdown starts fresh, not from now-relative-
		// to-the-prior-broadcast.
		successFiredAt = null;
		phase = 'editing';
		void recomputeFee();
	}

	// Part 121 cp7 — per-locale internal-link wrapper.  See
	// $i18n/path.localePath() + the analogous helper in
	// [lang]/+layout.svelte for design rationale.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<Head routeKey="post_order" noindex />

<div class="mx-auto max-w-3xl px-4 py-10 md:py-14">
	<header class="mb-8">
		<h1 class="font-display text-3xl font-extrabold">
			<span class="brand-gradient-text">{$_('post_order.heading')}</span>
		</h1>
		<p class="mt-2 text-ink-700 dark:text-ink-200">
			{$_('post_order.subtitle')}
		</p>
	</header>

	<!-- Tier 2.5 (Part 93): green-tinted starter-pack helper for
	     first-time posters.  Detects (no orders on record →
	     plausibly first post), surfaces three safe-defaults
	     tips, and pre-flips the expiry default from 90 days to
	     7 days via the onFirstTimeStatus callback.  Per-session
	     dismissable.  Self-hides for experienced posters. -->
	<FirstPostStarterPack
		onFirstTimeStatus={(isFirstTime) => {
			if (isFirstTime && expiresDays === 90) {
				// Safer default for first-time posters.  Only
				// flip if still at the form's default — don't
				// override a value loaded from a saved draft.
				expiresDays = 7;
			}
		}}
	/>

	<!-- Gate 1: user must have a Blurt account. -->
	{#if !blurtAccount}
		<section class="card text-center">
			<h2 class="font-display text-xl font-bold">
				{$_('post_order.no_account.title')}
			</h2>
			<p class="mt-2 text-ink-600 dark:text-ink-300">
				{$_('post_order.no_account.body')}
			</p>
			<div class="mt-4">
				<BusyButton variant="primary" onclick={() => gotoLocale('/onboarding/register-name')}>
					{$_('post_order.no_account.cta')}
				</BusyButton>
			</div>
		</section>

		<!-- Gate 2a: paired-readonly session (ADR-0022 QR-pair, Option A).
	     Posting an order signs a transaction with the posting key,
	     which lives on the user's phone — not on this device.
	     Show the WriteBlocked affordance pointing them to Morphit on
	     their phone instead of the "unlock" CTA, which would have no
	     password to gate against (paired sessions have no envelope). -->
	{:else if $isPairedReadOnly}
		<section class="card">
			<WriteBlockedReadOnly variant="post_order" />
		</section>

		<!-- Gate 2b: user must be unlocked to broadcast. The unlock flow
	     happens in the submission path itself via useActiveKey; we
	     don't need a blocking gate here — but a locked session means
	     the identity store has no envelope to sign from. -->
	{:else if !$isUnlocked}
		<section class="card">
			<h2 class="font-display text-xl font-bold">{$_('post_order.locked.title')}</h2>
			<p class="mt-2 text-ink-600 dark:text-ink-300">{$_('post_order.locked.body')}</p>
			<div class="mt-4">
				<BusyButton variant="primary" onclick={() => gotoLocale('/onboarding/import')}>
					{$_('post_order.locked.unlock')}
				</BusyButton>
			</div>
		</section>

		<!-- Main flow. -->
	{:else if phase === 'editing'}
		{#if draftSavedAt}
			<!-- Restore banner: tells the user their previous form
			     state was recovered from storage, and gives them a
			     single tap to throw it away and start fresh. Shown
			     only while draftSavedAt is set; a successful broadcast
			     or an explicit Discard clears it. -->
			<section
				class="mb-4 flex items-center justify-between gap-3 rounded-xl border border-morphit-emerald/40 bg-emerald-50 px-4 py-3 text-sm dark:border-morphit-emerald/50 dark:bg-ink-800"
				role="status"
				aria-live="polite"
			>
				<p class="text-ink-800 dark:text-ink-100">
					{$_('post_order.draft.restored_banner', {
						values: { age: formatDraftAge(draftSavedAt) }
					})}
				</p>
				<button
					type="button"
					class="flex-none rounded-lg border border-ink-300 bg-white px-3 py-1.5 text-xs font-semibold text-ink-700 transition hover:border-red-500 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:border-ink-600 dark:bg-ink-900 dark:text-ink-200"
					onclick={discardDraft}
				>
					{$_('post_order.draft.discard')}
				</button>
			</section>
		{/if}

		<!-- Step 1 -->
		<section class="card mb-4" aria-labelledby="step1-heading">
			<h2 id="step1-heading" class="mb-4 font-display text-lg font-bold">
				{$_('post_order.form.step_1_heading')}
			</h2>
			<div class="grid gap-3 sm:grid-cols-2">
				<button
					type="button"
					onclick={() => (side = 'buy')}
					class="rounded-xl border-2 px-4 py-3 text-left transition active:scale-[0.98] {side ===
					'buy'
						? 'border-morphit-emerald bg-emerald-50 dark:bg-ink-800'
						: 'border-ink-200 dark:border-ink-700'}"
				>
					<span class="font-semibold">{$_('post_order.form.side_buy')}</span>
				</button>
				<button
					type="button"
					onclick={() => (side = 'sell')}
					class="rounded-xl border-2 px-4 py-3 text-left transition active:scale-[0.98] {side ===
					'sell'
						? 'border-morphit-emerald bg-emerald-50 dark:bg-ink-800'
						: 'border-ink-200 dark:border-ink-700'}"
				>
					<span class="font-semibold">{$_('post_order.form.side_sell')}</span>
				</button>
			</div>
			<p class="mb-2 mt-6 flex items-center gap-2 text-sm font-semibold">
				{$_('post_order.form.asset_label')}
			</p>
			<!-- Sally finding M3 (Part 68): when the waiver is
			     selected, BTC and XMR chips are disabled with a
			     `title` tooltip — invisible on mobile/touch.
			     Surface the explanation as a visible inline note
			     ABOVE the chip row so a user who picked the waiver
			     doesn't see two greyed-out buttons with no
			     explanation. -->
			{#if feeMethodChoice === 'waived_first_buy'}
				<p
					class="mb-2 rounded-lg border border-morphit-emerald/30 bg-morphit-emerald/5 p-2 text-xs text-morphit-emerald"
				>
					🌱 {$_('post_order.form.waiver_asset_hint')}
				</p>
			{/if}
			<!-- Item 16 phase 2 (Item 1.1 from grandma investigation):
			     each asset chip carries a tooltip explaining what the
			     asset is, so first-time users don't have to guess.  -->
			<div class="flex flex-wrap gap-2">
				{#each ASSET_TICKERS as a}
					{@const disabled = feeMethodChoice === 'waived_first_buy' && a !== 'BLURT'}
					<div class="flex items-center gap-1">
						<button
							type="button"
							{disabled}
							title={disabled ? ($_('post_order.form.waiver_asset_locked_title') as string) : ''}
							onclick={() => {
								asset = a as Asset;
								// Part 121 / cp30 / cp31: reset network when
								// leaving a multi-network asset, so a re-pick
								// later forces a fresh explicit choice (no
								// stale network value).
								if (a !== 'USDT') usdtNetwork = null;
								if (a !== 'USDC') usdcNetwork = null;
								if (a !== 'DAI') daiNetwork = null;
							}}
							class="rounded-xl border-2 px-4 py-2 font-mono font-semibold transition active:scale-[0.98] {asset ===
							a
								? 'border-morphit-emerald bg-emerald-50 dark:bg-ink-800'
								: 'border-ink-200 dark:border-ink-700'} {disabled
								? 'cursor-not-allowed opacity-40'
								: ''}"
						>
							{a}
						</button>
						{#if a === 'BLURT'}
							<Tooltip
								textKey="post_order.form.asset_explainer.blurt"
								faqKey="what_is_blurt"
							/>
						{:else if a === 'BTC'}
							<Tooltip textKey="post_order.form.asset_explainer.btc" />
						{:else if a === 'XMR'}
							<Tooltip textKey="post_order.form.asset_explainer.xmr" />
						{:else if a === 'USDT'}
							<Tooltip textKey="post_order.form.asset_explainer.usdt" faqKey="what_is_usdt" />
						{:else if a === 'USDC'}
							<Tooltip textKey="post_order.form.asset_explainer.usdc" faqKey="what_is_usdc" />
						{:else if a === 'DAI'}
							<Tooltip textKey="post_order.form.asset_explainer.dai" faqKey="what_is_dai" />
						{:else if a === 'BCH'}
							<Tooltip textKey="post_order.form.asset_explainer.bch" faqKey="what_is_bch" />
						{:else if a === 'LTC'}
							<Tooltip textKey="post_order.form.asset_explainer.ltc" faqKey="what_is_ltc" />
						{:else if a === 'DASH'}
							<Tooltip textKey="post_order.form.asset_explainer.dash" faqKey="what_is_dash" />
						{:else if a === 'DOGE'}
							<Tooltip textKey="post_order.form.asset_explainer.doge" faqKey="what_is_doge" />
						{:else if a === 'ZEC'}
							<Tooltip textKey="post_order.form.asset_explainer.zec" faqKey="what_is_zec" />
						{:else if a === 'ARRR'}
							<Tooltip textKey="post_order.form.asset_explainer.arrr" faqKey="what_is_arrr" />
						{:else if a === 'DCR'}
							<Tooltip textKey="post_order.form.asset_explainer.dcr" faqKey="what_is_dcr" />
						{:else if a === 'SOL'}
							<Tooltip textKey="post_order.form.asset_explainer.sol" faqKey="what_is_sol" />
						{:else if a === 'ETH'}
							<Tooltip textKey="post_order.form.asset_explainer.eth" faqKey="what_is_eth" />
						{:else if a === 'XRP'}
							<Tooltip textKey="post_order.form.asset_explainer.xrp" faqKey="what_is_xrp" />
						{/if}
					</div>
				{/each}
			</div>

			<!-- Part 121 / cp30 — privacy/decentralization warning chip.
			     Renders only when the chosen asset has a non-null
			     privacyWarningKey in the canonical registry.  USDT,
			     USDC, and DAI are the three stablecoin assets that
			     surface here (USDT/USDC are issuer-centralized;
			     DAI is partly-centralized via its collateral mix);
			     BTC/XMR/BLURT/BCH/LTC/DASH/DOGE/ZEC/ARRR/DCR/SOL/ETH/XRP all carry
			     null and skip. -->
			{#if asset === 'USDT'}
				<PrivacyWarningChip privacyWarningKey="usdt_centralized" />
				<!-- Network picker is REQUIRED when asset is USDT.
				     No default network — the user must pick every
				     time, because cross-network sends lose funds.
				     canSubmit gates on usdtNetwork !== null above. -->
				<div class="mt-3">
					<UsdtNetworkPicker bind:network={usdtNetwork} />
				</div>
			{/if}
			{#if asset === 'USDC'}
				<PrivacyWarningChip privacyWarningKey="usdc_centralized" />
				<!-- Same network-picker contract as USDT — required
				     pre-submit gate.  Three of USDC's four networks
				     share the EVM 0x address format, so the picker
				     is the only thing disambiguating which chain. -->
				<div class="mt-3">
					<UsdcNetworkPicker bind:network={usdcNetwork} />
				</div>
			{/if}
			{#if asset === 'DAI'}
				<PrivacyWarningChip privacyWarningKey="dai_partly_centralized" />
				<!-- Part 122 cp31 — DAI 4 EVM networks (ERC-20 /
				     Polygon / Base / Arbitrum).  ALL FOUR share the
				     EVM 0x[40 hex] address format — DAI is the
				     highest cross-network address-confusion surface
				     on Morphit; picker is the only thing telling
				     the sender's wallet which chain to broadcast
				     on.  CP34 closure: this render block was
				     MISSING since cp31 ship — DaiNetworkPicker
				     existed in the components dir but was never
				     mounted from the post page.  canSubmit gates
				     on daiNetwork !== null above. -->
				<div class="mt-3">
					<DaiNetworkPicker bind:network={daiNetwork} />
				</div>
			{/if}
		</section>

		<!-- Step 2 (only appears after step 1 answered) -->
		{#if step1Done}
			<section class="card mb-4 animate-fade-up" aria-labelledby="step2-heading">
				<h2 id="step2-heading" class="mb-4 font-display text-lg font-bold">
					{$_('post_order.form.step_2_heading')}
				</h2>

				<label class="mb-4 block">
					<span class="mb-1 block text-sm font-semibold">
						{$_('post_order.form.fiat_label')}
					</span>
					<FocusedField focused={fiat.length === 0} valid={fiat.length > 0 && fiatError === ''}>
						<input
							type="text"
							bind:value={fiat}
							maxlength="8"
							autocomplete="off"
							aria-invalid={!!fiatError}
							aria-describedby={fiatError ? 'fiat-error' : undefined}
							class="w-full rounded-2xl bg-transparent px-4 py-3 text-base uppercase outline-none dark:text-ink-50"
							placeholder={$_('post_order.form.fiat_placeholder')}
						/>
					</FocusedField>
					{#if fiatError}
						<StatusLine kind="warn" id="fiat-error">{fiatError}</StatusLine>
					{/if}
					{#if feeMethodChoice === 'waived_first_buy'}
						<p class="mt-2 text-xs text-ink-600 dark:text-ink-300">
							{$_('post_order.form.waiver_fiat_hint')}
						</p>
					{/if}
				</label>

				<div class="grid gap-4 sm:grid-cols-2">
					<label class="block">
						<span class="mb-1 block text-sm font-semibold">
							{$_('post_order.form.amount_min_label')}
						</span>
						<input
							type="number"
							min="0"
							step="0.01"
							bind:value={amountMin}
							aria-invalid={!!amountError}
							aria-describedby={amountError ? 'amount-error' : undefined}
							class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
						/>
					</label>
					<label class="block">
						<span class="mb-1 block text-sm font-semibold">
							{$_('post_order.form.amount_max_label')}
						</span>
						<input
							type="number"
							min="0"
							step="0.01"
							bind:value={amountMax}
							aria-invalid={!!amountError}
							aria-describedby={amountError ? 'amount-error' : undefined}
							class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
						/>
					</label>
				</div>
				<p class="mt-1 text-xs text-ink-500">{$_('post_order.form.amount_optional_hint')}</p>

				<!-- Price model picker.  Two shapes shipped: 'spread'
				     (relative to current market rate, with an optional
				     +/- N%) and 'fixed' (a flat fiat price per unit).
				     Default 'spread' / 0% = "market price", which is
				     what most casual traders want.  The 'fixed' option
				     exists for users who specifically want to lock in
				     a price regardless of where the market moves;
				     useful for "I'll sell my BTC at $100k flat,
				     period."  See ADR-0011 §price-model and
				     priceModelDisplay.ts for the on-chain shape.

				     Submission shape (assembled in submitPost):
				       spread → { kind: 'spread', percent: <number> }
				       fixed  → { kind: 'fixed',  price:   <number> } -->
				<fieldset class="mt-4 rounded-xl border border-ink-200 p-3 dark:border-ink-700">
					<legend class="px-2 text-sm font-semibold">
						{$_('post_order.form.price_model_legend')}
					</legend>
					<p class="mb-3 text-xs text-ink-500">
						{$_('post_order.form.price_model_hint')}
					</p>

					<div class="space-y-2">
						<label
							class="flex cursor-pointer items-start gap-3 rounded-lg p-2 hover:bg-ink-50 dark:hover:bg-ink-800"
						>
							<input
								type="radio"
								name="price-model-kind"
								value="spread"
								bind:group={priceModelKind}
								class="mt-0.5 h-4 w-4 flex-none accent-morphit-emerald"
							/>
							<div class="min-w-0">
								<p class="font-semibold">
									{$_('post_order.form.price_model_spread_label')}
								</p>
								<p class="text-xs text-ink-600 dark:text-ink-300">
									{$_('post_order.form.price_model_spread_help')}
								</p>
								{#if priceModelKind === 'spread'}
									<div class="mt-2 flex items-center gap-2">
										<input
											type="number"
											step="0.1"
											min="-50"
											max="50"
											bind:value={spreadPercent}
											aria-invalid={!!priceModelError}
											aria-describedby={priceModelError ? 'price-model-error' : undefined}
											class="w-24 rounded-lg border-2 border-ink-200 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
											aria-label={$_('post_order.form.price_model_spread_aria') as string}
										/>
										<span class="text-sm text-ink-600 dark:text-ink-300">%</span>
										<span class="text-xs text-ink-500">
											{$_('post_order.form.price_model_spread_unit_hint')}
										</span>
									</div>
									{#if priceModelError}
										<StatusLine kind="warn" id="price-model-error">{priceModelError}</StatusLine>
									{/if}
								{/if}
							</div>
						</label>

						<label
							class="flex cursor-pointer items-start gap-3 rounded-lg p-2 hover:bg-ink-50 dark:hover:bg-ink-800"
						>
							<input
								type="radio"
								name="price-model-kind"
								value="fixed"
								bind:group={priceModelKind}
								class="mt-0.5 h-4 w-4 flex-none accent-morphit-emerald"
							/>
							<div class="min-w-0">
								<p class="font-semibold">
									{$_('post_order.form.price_model_fixed_label')}
								</p>
								<p class="text-xs text-ink-600 dark:text-ink-300">
									{$_('post_order.form.price_model_fixed_help')}
								</p>
								{#if priceModelKind === 'fixed'}
									<div class="mt-2 flex items-center gap-2">
										<input
											type="number"
											step="0.01"
											min="0"
											bind:value={fixedPrice}
											aria-invalid={!!priceModelError}
											aria-describedby={priceModelError ? 'fixed-price-error' : undefined}
											class="w-32 rounded-lg border-2 border-ink-200 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
											placeholder={$_('post_order.form.price_model_fixed_placeholder') as string}
											aria-label={$_('post_order.form.price_model_fixed_aria') as string}
										/>
										<span class="text-sm text-ink-600 dark:text-ink-300">
											{fiat || $_('post_order.form.price_model_fiat_placeholder')}
										</span>
									</div>
									{#if priceModelError}
										<StatusLine kind="warn" id="fixed-price-error">{priceModelError}</StatusLine>
									{/if}
								{/if}
							</div>
						</label>
					</div>
				</fieldset>

				{#if feeMethodChoice === 'waived_first_buy'}
					<!-- First-buy benefits ladder (Q10 follow-up).  Rather
					     than expose the 500-BLURT floor as a "minimum"
					     constraint (which feels like a tax), we show the
					     user what they GET at increasing buy sizes.  The
					     current amount lights up the row that bracket
					     contains it; rows above show as "you'll also
					     unlock if you increase".  Pure presentation —
					     the indexer keeps enforcing the 500 floor
					     silently.  Users who type below 500 see the
					     amountError validator surface a generic message,
					     not a "minimum 500" callout. -->
					<div class="mt-2 rounded-lg border border-morphit-emerald/30 bg-morphit-emerald/5 p-3">
						<p class="text-xs font-semibold text-morphit-emerald">
							{$_('post_order.form.waiver_benefits_heading')}
						</p>
						<ul class="mt-1.5 space-y-1 text-xs text-ink-700 dark:text-ink-200">
							{#each waiverBenefitRows as row}
								<li
									class="flex items-baseline gap-2 {row.unlocked
										? 'font-semibold text-morphit-emerald'
										: 'text-ink-500 dark:text-ink-400'}"
								>
									<span aria-hidden="true">{row.unlocked ? '✓' : '○'}</span>
									<span>{row.text}</span>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
				{#if amountError}
					<StatusLine kind="warn" id="amount-error">{amountError}</StatusLine>
				{/if}
			</section>
		{/if}

		<!-- Step 3 -->
		{#if step1Done && step2Done}
			<section class="card mb-4 animate-fade-up" aria-labelledby="step3-heading">
				<h2 id="step3-heading" class="mb-4 font-display text-lg font-bold">
					{$_('post_order.form.step_3_heading')}
				</h2>

				<div class="mb-4">
					<p class="mb-1 text-sm font-semibold">{$_('post_order.form.payment_methods_label')}</p>
					<p class="mb-2 text-xs text-ink-500">{$_('post_order.form.payment_methods_hint')}</p>
					<PaymentMethodsPicker
						bind:selected={paymentMethods}
						excludeForAsset={asset ?? undefined}
						instanceAdditions={$instanceAdditions}
						invalid={!!paymentMethodsError}
						describedById="payment-methods-error"
					/>
					{#if paymentMethodsError}
						<StatusLine kind="warn" id="payment-methods-error">{paymentMethodsError}</StatusLine>
					{/if}
				</div>

				<label class="mb-4 block">
					<span class="mb-1 block text-sm font-semibold">{$_('post_order.form.region_label')}</span>
					<input
						type="text"
						bind:value={region}
						maxlength="128"
						class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
						placeholder={$_('post_order.form.region_placeholder')}
					/>
					<p class="mt-1 text-xs text-ink-500">{$_('post_order.form.region_hint')}</p>
				</label>

				<label class="mb-4 block">
					<span class="mb-1 block text-sm font-semibold">{$_('post_order.form.terms_label')}</span>
					<ProtectedTextarea
						bind:value={terms}
						onDetect={handleTermsKeyDetect}
						rows={3}
						maxlength={2048}
						showCounter
						placeholder={$_('post_order.form.terms_placeholder') as string}
					/>
				</label>

				<label class="block">
					<span class="mb-1 block text-sm font-semibold">{$_('post_order.form.expires_label')}</span
					>
					<select
						bind:value={expiresDays}
						class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
					>
						<option value={1}>{$_('post_order.form.expires_1d')}</option>
						<option value={3}>{$_('post_order.form.expires_3d')}</option>
						<option value={7}>{$_('post_order.form.expires_7d')}</option>
						<option value={14}>{$_('post_order.form.expires_14d')}</option>
						<option value={30}>{$_('post_order.form.expires_30d')}</option>
						<option value={60}>{$_('post_order.form.expires_60d')}</option>
						<option value={90}>{$_('post_order.form.expires_90d')}</option>
					</select>
				</label>

				<!-- New syndication model: per-order opt-in posts the
				     order announcement to the user's own Blurt blog
				     IMMEDIATELY after order broadcast succeeds.
				     Signed by the user's posting key. Free (Mana
				     only). Distinct from the automatic first-trade
				     post to the @morphit community.
				     Sally finding H9 (Part 68): copy upgraded to a
				     selling-point pitch — same voice as the
				     first-trade disclosure on LeaveFeedbackForm —
				     so the user understands syndication = more eyes
				     = more trades = upvote earnings to Blurt wallet.
				     Default still off; we never auto-broadcast a
				     per-order post.  Border emerald to match the
				     "this is a benefit" framing. -->
				<label
					class="flex items-start gap-3 rounded-xl border-2 border-morphit-emerald/30 bg-morphit-emerald/5 p-4 dark:border-morphit-emerald/40"
				>
					<input
						type="checkbox"
						bind:checked={syndicateToBlog}
						class="mt-1 h-5 w-5 flex-none accent-morphit-emerald"
					/>
					<div class="min-w-0">
						<p class="flex items-center gap-2 font-semibold text-morphit-emerald">
							<span aria-hidden="true">📣</span>
							{$_('syndicate.opt_in_label')}
						</p>
						<p class="mt-2 text-sm text-ink-700 dark:text-ink-200">
							{$_('syndicate.opt_in_pitch')}
						</p>
						<p class="mt-2 text-xs text-ink-600 dark:text-ink-300">
							{$_('syndicate.opt_in_help')}
						</p>
					</div>
				</label>
			</section>

			<!-- Continue to review -->
			<div class="mt-6 flex justify-end">
				<BusyButton variant="primary" disabled={!canReview} onclick={goToReview}>
					{$_('common.continue')}
				</BusyButton>
			</div>
		{/if}
	{:else if phase === 'reviewing'}
		<!-- Review: fee + summary + post button. -->

		<!-- ADR-0011: waiver affordance. When eligible+buy, the UI
		     defaults to waiver. Users can still choose BLURT fee via
		     the radio below if they want (e.g. to keep the waiver for
		     a later, larger trade). -->
		{#if waiverOffered}
			<section
				class="card mb-4 border-morphit-emerald/40 bg-morphit-emerald/5"
				aria-labelledby="waiver-heading"
			>
				<div class="flex items-start gap-3">
					<span class="text-2xl" aria-hidden="true">🌱</span>
					<div class="flex-1">
						<h2 id="waiver-heading" class="font-display text-lg font-bold">
							{$_('post_order.waiver.heading')}
						</h2>
						<p class="mt-1 text-sm text-ink-600 dark:text-ink-300">
							{$_('post_order.waiver.body')}
						</p>

						<fieldset class="mt-4">
							<legend class="sr-only">{$_('post_order.fee_method.legend')}</legend>
							<label class="flex items-start gap-2 py-1">
								<input
									type="radio"
									name="fee-method"
									value="waived_first_buy"
									bind:group={feeMethodChoice}
									class="mt-0.5 accent-morphit-emerald"
								/>
								<span class="text-sm">
									<span class="font-semibold">{$_('post_order.fee_method.waived_label')}</span>
									<span class="block text-xs text-ink-500">
										{$_('post_order.fee_method.waived_hint')}
									</span>
								</span>
							</label>
							<label class="flex items-start gap-2 py-1">
								<input
									type="radio"
									name="fee-method"
									value="blurt"
									bind:group={feeMethodChoice}
									class="mt-0.5 accent-morphit-emerald"
								/>
								<span class="text-sm">
									<span class="font-semibold">{$_('post_order.fee_method.blurt_label')}</span>
									<span class="block text-xs text-ink-500">
										{$_('post_order.fee_method.blurt_hint')}
									</span>
								</span>
							</label>
							<label class="flex items-start gap-2 py-1">
								<input
									type="radio"
									name="fee-method"
									value="btc"
									bind:group={feeMethodChoice}
									class="mt-0.5 accent-morphit-emerald"
								/>
								<span class="text-sm">
									<span class="font-semibold">{$_('post_order.fee_method.btc_label')}</span>
									<span class="block text-xs text-ink-500">
										{$_('post_order.fee_method.btc_hint')}
									</span>
								</span>
							</label>
							<label class="flex items-start gap-2 py-1">
								<input
									type="radio"
									name="fee-method"
									value="xmr"
									bind:group={feeMethodChoice}
									class="mt-0.5 accent-morphit-emerald"
								/>
								<span class="text-sm">
									<span class="font-semibold">{$_('post_order.fee_method.xmr_label')}</span>
									<span class="block text-xs text-ink-500">
										{$_('post_order.fee_method.xmr_hint')}
									</span>
								</span>
							</label>
						</fieldset>
					</div>
				</div>
			</section>
		{/if}

		{#if !waiverOffered}
			<section class="card mb-4" aria-labelledby="fee-method-heading">
				<h2 id="fee-method-heading" class="mb-4 font-display text-lg font-bold">
					{$_('post_order.fee_method.legend')}
				</h2>
				<fieldset>
					<legend class="sr-only">{$_('post_order.fee_method.legend')}</legend>
					<label class="flex items-start gap-2 py-1">
						<input
							type="radio"
							name="fee-method"
							value="blurt"
							bind:group={feeMethodChoice}
							class="mt-0.5 accent-morphit-emerald"
						/>
						<span class="text-sm">
							<span class="font-semibold">{$_('post_order.fee_method.blurt_label')}</span>
							<span class="block text-xs text-ink-500">
								{$_('post_order.fee_method.blurt_hint')}
							</span>
						</span>
					</label>
					<label class="flex items-start gap-2 py-1">
						<input
							type="radio"
							name="fee-method"
							value="btc"
							bind:group={feeMethodChoice}
							class="mt-0.5 accent-morphit-emerald"
						/>
						<span class="text-sm">
							<span class="font-semibold">{$_('post_order.fee_method.btc_label')}</span>
							<span class="block text-xs text-ink-500">
								{$_('post_order.fee_method.btc_hint')}
							</span>
						</span>
					</label>
					<label class="flex items-start gap-2 py-1">
						<input
							type="radio"
							name="fee-method"
							value="xmr"
							bind:group={feeMethodChoice}
							class="mt-0.5 accent-morphit-emerald"
						/>
						<span class="text-sm">
							<span class="font-semibold">{$_('post_order.fee_method.xmr_label')}</span>
							<span class="block text-xs text-ink-500">
								{$_('post_order.fee_method.xmr_hint')}
							</span>
						</span>
					</label>
				</fieldset>
			</section>
		{/if}

		{#if feeMethodChoice === 'btc' || feeMethodChoice === 'xmr'}
			<!-- Part 106 — render the canonical fee address with
			     copy + QR + chain-pinned badge.  Closes the pre-
			     Part-106 fork-attack vector where the operator
			     could social-engineer a hostile address into the
			     user's flow. -->
			{#await loadListingFeeAddressPanel() then ListingFeeAddressPanel}
				<ListingFeeAddressPanel method={feeMethodChoice} />
			{/await}

			<section class="card mb-4" aria-labelledby="txid-heading">
				<div class="mb-3 flex items-center gap-2">
					<h2 id="txid-heading" class="font-display text-lg font-bold">
						{$_('post_order.fee_method.txid_label')}
					</h2>
					<Tooltip
						textKey="post_order.fee_method.txid_tooltip"
						faqKey="xmr_txid"
						ariaLabel={$_('post_order.fee_method.txid_tooltip_aria')}
					/>
				</div>
				<input
					id="external-tx-id"
					type="text"
					autocomplete="off"
					autocapitalize="none"
					spellcheck="false"
					bind:value={externalTxId}
					placeholder={$_('post_order.fee_method.txid_placeholder')}
					class="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 font-mono text-sm tracking-tight dark:border-ink-600 dark:bg-ink-900"
					aria-invalid={externalTxIdError !== '' && externalTxIdError !== 'ok'}
					aria-describedby="txid-msg"
				/>
				<p
					id="txid-msg"
					class="mt-2 text-xs {externalTxIdError !== '' && externalTxIdError !== 'ok'
						? 'text-red-600 dark:text-red-400'
						: 'text-ink-500'}"
				>
					{#if externalTxIdError !== '' && externalTxIdError !== 'ok'}
						{externalTxIdError}
					{:else}
						{$_('post_order.fee_method.txid_hint')}
					{/if}
				</p>
			</section>
		{/if}

		{#if feeMethodChoice === 'xmr'}
			<!-- Part 108++ — XMR per-payment tx_proof.  Eliminates
			     the need for any indexer (canonical or community)
			     to hold the treasury wallet's view key.  The user
			     generates a per-payment proof from their own wallet
			     after paying; any indexer verifies the proof
			     against the txid + treasury address using a public
			     explorer endpoint or local monerod RPC.  Privacy
			     invariant: the proof reveals only "this txid paid
			     this address this amount" — exactly the public
			     information needed for verification, no more.
			     Decentralization invariant: every indexer can
			     verify every payment independently. -->
			<section class="card mb-4" aria-labelledby="tx-proof-heading">
				<div class="mb-3 flex items-center gap-2">
					<h2 id="tx-proof-heading" class="font-display text-lg font-bold">
						{$_('post_order.fee_method.tx_proof_label')}
					</h2>
					<Tooltip
						textKey="post_order.fee_method.tx_proof_tooltip"
						faqKey="xmr_tx_proof"
						ariaLabel={$_('post_order.fee_method.tx_proof_tooltip_aria')}
					/>
				</div>

				<!-- Privacy reassurance: the proof reveals only this
				     one payment, nothing else about the user's
				     wallet.  Render BEFORE the textarea so the user
				     understands what they're sharing. -->
				<p class="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
					{$_('post_order.fee_method.tx_proof_privacy_note')}
				</p>

				<!-- Per-wallet "How to generate your proof"
				     instructions.  Inline expandable so the user
				     doesn't have to leave the page (grandma-friendly:
				     no required external doc lookup).  Default
				     collapsed to keep the page short for users who
				     already know the flow. -->
				<details class="mb-3 rounded-lg border border-ink-200 bg-ink-50 dark:border-ink-700 dark:bg-ink-900">
					<summary class="cursor-pointer select-none px-3 py-2 text-sm font-semibold">
						{$_('post_order.fee_method.tx_proof_how_to_label')}
					</summary>
					<div class="space-y-3 border-t border-ink-200 px-3 py-3 text-xs text-ink-700 dark:border-ink-700 dark:text-ink-300">
						<div>
							<div class="font-semibold">{$_('post_order.fee_method.tx_proof_how_to_cli_heading')}</div>
							<div class="mt-1">{$_('post_order.fee_method.tx_proof_how_to_cli_body')}</div>
						</div>
						<div>
							<div class="font-semibold">{$_('post_order.fee_method.tx_proof_how_to_gui_heading')}</div>
							<div class="mt-1">{$_('post_order.fee_method.tx_proof_how_to_gui_body')}</div>
						</div>
						<div>
							<div class="font-semibold">{$_('post_order.fee_method.tx_proof_how_to_cake_heading')}</div>
							<div class="mt-1">{$_('post_order.fee_method.tx_proof_how_to_cake_body')}</div>
						</div>
						<div>
							<div class="font-semibold">{$_('post_order.fee_method.tx_proof_how_to_feather_heading')}</div>
							<div class="mt-1">{$_('post_order.fee_method.tx_proof_how_to_feather_body')}</div>
						</div>
						<div>
							<div class="font-semibold">{$_('post_order.fee_method.tx_proof_how_to_other_heading')}</div>
							<div class="mt-1">{$_('post_order.fee_method.tx_proof_how_to_other_body')}</div>
						</div>
					</div>
				</details>

				<textarea
					id="tx-proof"
					rows="4"
					autocomplete="off"
					autocapitalize="none"
					spellcheck="false"
					bind:value={txProof}
					placeholder={$_('post_order.fee_method.tx_proof_placeholder')}
					class="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 font-mono text-xs tracking-tight dark:border-ink-600 dark:bg-ink-900"
					aria-invalid={txProofError !== '' && txProofError !== 'ok'}
					aria-describedby="tx-proof-msg"
				></textarea>
				<p
					id="tx-proof-msg"
					class="mt-2 text-xs {txProofError !== '' && txProofError !== 'ok'
						? 'text-red-600 dark:text-red-400'
						: 'text-ink-500'}"
				>
					{#if txProofError !== '' && txProofError !== 'ok'}
						{txProofError}
					{:else}
						{$_('post_order.fee_method.tx_proof_hint')}
					{/if}
				</p>
			</section>
		{/if}

		{#if feeMethodChoice === 'blurt'}
			<section class="card mb-4" aria-labelledby="review-heading">
				<h2 id="review-heading" class="mb-4 font-display text-lg font-bold">
					<Term key="listing_fee">{$_('post_order.fee.heading')}</Term>
				</h2>

				{#if feeLoading}
					<StatusLine kind="loading">{$_('post_order.fee.loading')}</StatusLine>
				{:else if feeError}
					<StatusLine kind="warn">
						<span title={feeError}>{$_('post_order.fee.error_friendly')}</span>
					</StatusLine>
				{:else if feeQuote}
					<div class="flex items-baseline justify-between">
						<span class="text-sm font-semibold">
							{#if feeQuote.nth <= 3}
								{$_('post_order.fee.tier_label_normal')}
							{:else if feeQuote.nth <= 10}
								{$_('post_order.fee.tier_label_busy', { values: { nth: feeQuote.nth } })}
							{:else}
								{$_('post_order.fee.tier_label_high')}
							{/if}
						</span>
						<span class="font-display text-xl font-bold">
							{feeQuote.blurtFormatted}
						</span>
					</div>
					{#if fiatPerBlurt !== null}
						<p class="mt-1 text-right text-xs text-ink-500">
							~{formatFiat(feeQuote.blurtAmount * fiatPerBlurt, denominationFiat)}
						</p>
					{/if}
					<p class="mt-4 text-sm text-ink-600 dark:text-ink-300">
						{$_('post_order.fee.explainer')}
					</p>
				{/if}
			</section>
		{/if}

		{#if syndicateToBlog}
			<!-- Reminder: this order will also be posted to the
			     user's Blurt blog when they hit Post. Renders only
			     when opted-in so the default opted-out case is
			     visually quiet. -->
			<div
				class="mb-4 rounded-xl border border-morphit-emerald/30 bg-morphit-emerald/5 p-3 text-sm"
			>
				<p class="font-semibold text-morphit-emerald">
					{$_('syndicate.review_on_title')}
				</p>
				<p class="mt-1 text-ink-600 dark:text-ink-300">
					{$_('syndicate.review_on_body')}
				</p>
			</div>
		{/if}

		<p class="mb-4 text-sm text-ink-600 dark:text-ink-300">
			{$_('post_order.submit.review_hint')}
		</p>

		<div class="flex flex-col gap-3 sm:flex-row sm:justify-between">
			<BusyButton variant="ghost" onclick={backToEditing}>
				← {$_('common.back')}
			</BusyButton>
			<BusyButton
				variant="primary"
				disabled={(feeMethodChoice === 'blurt' && !feeQuote) ||
					(feeMethodChoice === 'btc' && externalTxIdError !== 'ok') ||
					(feeMethodChoice === 'xmr' &&
						(externalTxIdError !== 'ok' || txProofError !== 'ok'))}
				onclick={goToPasswordPrompt}
			>
				{#if feeMethodChoice === 'waived_first_buy'}
					{$_('post_order.submit.primary_label_waived')}
				{:else if feeMethodChoice === 'btc' || feeMethodChoice === 'xmr'}
					{$_('post_order.submit.primary_label_external')}
				{:else if feeQuote}
					{$_('post_order.submit.primary_label', { values: { fee: feeQuote.blurtFormatted } })}
				{:else}
					{$_('post_order.fee.loading')}
				{/if}
			</BusyButton>
		</div>
	{:else if phase === 'awaiting_password'}
		<section class="card" aria-labelledby="password-heading">
			<h2 id="password-heading" class="mb-2 font-display text-lg font-bold">
				{$_('post_order.locked.title')}
			</h2>
			<p class="mb-4 text-ink-600 dark:text-ink-300">
				{$_('post_order.locked.body')}
			</p>
			<label class="block">
				<span class="mb-1 block text-sm font-semibold">
					{$_('post_order.locked.password_label')}
				</span>
				<FocusedField focused={password.length === 0} valid={password.length >= 8}>
					<input
						type="password"
						bind:value={password}
						autocomplete="current-password"
						onkeydown={(e) => {
							if (e.key === 'Enter' && password.length >= 8) submitBroadcast();
						}}
						class="w-full rounded-2xl bg-transparent px-4 py-3 text-base outline-none dark:text-ink-50"
					/>
				</FocusedField>
				{#if passwordError}
					<StatusLine kind="error">{passwordError}</StatusLine>
				{/if}
			</label>
			<div class="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-between">
				<BusyButton
					variant="ghost"
					onclick={() => {
						phase = 'reviewing';
						password = '';
					}}
				>
					← {$_('common.cancel')}
				</BusyButton>
				<BusyButton variant="primary" disabled={password.length < 8} onclick={submitBroadcast}>
					{$_('post_order.locked.unlock')}
				</BusyButton>
			</div>
		</section>
	{:else if phase === 'broadcasting'}
		<section class="card text-center" aria-live="polite">
			<div class="mx-auto mb-4 h-12 w-12 animate-pulse-soft rounded-full bg-morphit-gradient"></div>
			<StatusLine kind="loading">
				{$_('post_order.submit.pending_broadcasting')}
			</StatusLine>
		</section>
	{:else if phase === 'success'}
		<section class="card animate-fade-up text-center" aria-live="polite" role="status">
			<svg
				class="mx-auto mb-4 h-16 w-16 text-morphit-emerald"
				viewBox="0 0 24 24"
				fill="none"
				aria-hidden="true"
			>
				<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" />
				<path
					d="M7 12l3 3 7-7"
					stroke="currentColor"
					stroke-width="2.5"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
			{#if successUsedWaiver}
				<h2 class="font-display text-2xl font-extrabold">
					🌱 {$_('post_order.success.waiver_title')}
				</h2>
				<p class="mt-2 text-ink-600 dark:text-ink-300">
					{$_('post_order.success.waiver_body')}
				</p>
				<div
					class="mx-auto mt-5 max-w-prose rounded-xl border border-morphit-emerald/30 bg-morphit-emerald/5 p-4 text-left text-sm"
				>
					<p class="font-semibold text-morphit-emerald">
						{$_('post_order.success.waiver_next_heading')}
					</p>
					<ol class="mt-2 list-decimal space-y-2 pl-5 text-ink-700 dark:text-ink-200">
						<li>{$_('post_order.success.waiver_step_1')}</li>
						<li>{$_('post_order.success.waiver_step_2')}</li>
						<li>{$_('post_order.success.waiver_step_3')}</li>
					</ol>
				</div>
			{:else}
				<h2 class="font-display text-2xl font-extrabold">{$_('post_order.success.title')}</h2>
				<p class="mt-2 text-ink-600 dark:text-ink-300">{$_('post_order.success.body')}</p>
			{/if}

			{#if syndicationStatus === 'pending'}
				<p class="mt-4 text-sm text-ink-500 dark:text-ink-400">
					{$_('syndicate.success_pending')}
				</p>
			{:else if syndicationStatus === 'ok'}
				<p class="mt-4 rounded-lg bg-morphit-emerald/10 p-3 text-sm text-morphit-emerald">
					{$_('syndicate.success_ok')}
				</p>
			{:else if syndicationStatus === 'failed'}
				<p
					class="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200"
				>
					{$_('syndicate.success_failed')}
				</p>
			{/if}

			<div class="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
				{#if successPermlink && blurtAccount}
					<BusyButton
						variant="primary"
						onclick={() => gotoLocale(`/@${blurtAccount}/${successPermlink}`)}
					>
						{$_('post_order.success.view_my_order_cta')}
					</BusyButton>
				{:else}
					<BusyButton variant="primary" onclick={() => gotoLocale('/orderbook')}>
						{$_('post_order.success.view_cta')}
					</BusyButton>
				{/if}
				<BusyButton variant="secondary" onclick={postAnother}>
					{$_('post_order.success.post_another')}
				</BusyButton>
				{#if successPermlink}
					{@const remaining = editWindowRemainingSec}
					<div class="flex flex-col items-center gap-1 sm:flex-row">
						<BusyButton
							variant="ghost"
							onclick={() => gotoLocale(`/post/edit/${successPermlink}`)}
							disabled={remaining === null}
						>
							{$_('post_order.success.edit_cta')}
						</BusyButton>
						<!-- Sally finding M1/M8 (Part 68): live countdown
						     so the user knows the edit window is short
						     (15 minutes total) and ticking.  Pre-Part-68
						     this was an unlabeled Edit button and users
						     could miss the deadline without warning. -->
						{#if remaining !== null}
							<span
								class="rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums {remaining <=
								30
									? 'animate-pulse bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200'
									: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'}"
								title={$_('post_order.success.edit_window_tooltip') as string}
							>
								{$_('post_order.success.edit_window_countdown', {
									values: { remaining: formatRemainingMmSs(remaining) }
								})}
							</span>
						{:else}
							<span class="text-[11px] text-ink-500">
								{$_('post_order.success.edit_window_expired')}
							</span>
						{/if}
					</div>
				{/if}
			</div>

			<!-- Featured-slot upsell.  Surfaced after the user completes
			     a successful post so they can promote it without
			     hunting around the app for the option.  We deliberately
			     skip the upsell when the user just took the waiver path
			     (successUsedWaiver) — that's a first-time-user moment
			     where layering a "now pay BLURT to feature it" pitch
			     would feel mercenary.  The waiver flow already shows
			     its own onboarding next-steps panel above. -->
			{#if !successUsedWaiver}
				<div
					class="border-morphit-orchid/30 bg-morphit-orchid/5 dark:bg-morphit-orchid/10 mx-auto mt-6 max-w-prose rounded-xl border p-4 text-sm"
				>
					<p class="text-morphit-orchid font-semibold">
						✨ {$_('post_order.success.feature_upsell_heading')}
					</p>
					<p class="mt-2 text-ink-700 dark:text-ink-200">
						{$_('post_order.success.feature_upsell_body')}
					</p>
					<a
						class="text-morphit-orchid mt-3 inline-block font-semibold underline decoration-dotted underline-offset-2 hover:decoration-solid"
						href={lp('/my/orders')}
					>
						{$_('post_order.success.feature_upsell_cta')}
					</a>
				</div>
			{/if}
		</section>
	{:else if phase === 'error'}
		<section
			class="card border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950"
			role="alert"
			aria-live="assertive"
		>
			<h2 class="font-display text-lg font-bold text-amber-900 dark:text-amber-100">
				{$_('post_order.broadcast_error.title')}
			</h2>
			<p class="mt-2 text-sm text-amber-800 dark:text-amber-200">
				{broadcastError}
			</p>
			<div class="mt-4">
				<BusyButton variant="primary" onclick={retryFromError}>
					{$_('post_order.broadcast_error.retry')}
				</BusyButton>
			</div>
		</section>
	{/if}
</div>

{#if showTermsKeyWarning}
	{#await loadPrivateKeyWarningModal() then PrivateKeyWarningModal}
		<PrivateKeyWarningModal
			matches={termsKeyMatches}
			onEdit={() => {
				showTermsKeyWarning = false;
			}}
			onSendAnyway={() => {
				showTermsKeyWarning = false;
				userAckedTermsKeyWarning = true;
				void submitBroadcast();
			}}
		/>
	{/await}
{/if}
