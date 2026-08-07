<script lang="ts">
	import { page } from '$app/stores';
	import LazyLoadError from '$components/LazyLoadError.svelte';
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
	 * - Broadcast failures show a red error card with a Retry
	 *   BusyButton; nothing was paid, the user can try again safely.
	 * - Locked-session errors prompt the password flow without
	 *   losing the form state.
	 */

	import { onMount } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { _ } from 'svelte-i18n';
	import { gotoLocale } from '$i18n/navigate';
	import { get } from 'svelte/store';

	import Head from '$components/Head.svelte';
	import BusyButton from '$components/BusyButton.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import WriteBlockedReadOnly from '$components/WriteBlockedReadOnly.svelte';
	import RequireLiveSession from '$components/RequireLiveSession.svelte';
	import FocusedField from '$components/FocusedField.svelte';
	import Tooltip from '$components/Tooltip.svelte';
	import TermsText from '$components/TermsText.svelte';
	import MarkdownGuideModal from '$components/MarkdownGuideModal.svelte';
	import type { FaqKey } from '$utils/faqIndex';
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
	// cp376 byte-budget: these five render only after step 1 (or only
	// when a stablecoin asset is chosen), so their JS is deferred out of
	// the initial post-page bundle and loaded the moment the step that
	// needs them appears (lazy-loaders defined below; in Svelte 5 the
	// {#await} block evaluates each loader once when the step first
	// renders, so the control mounts once and isn't remounted on typing).
	//   - FiatCurrencySelect, PaymentMethodsPicker — step 2 / step 3
	//   - Usdt/Usdc/DaiNetworkPicker — step-1 stablecoin branch only
	// import PaymentMethodsPicker from '$components/PaymentMethodsPicker.svelte';
	// import FiatCurrencySelect from '$components/FiatCurrencySelect.svelte';
	import PrivacyWarningChip from '$components/PrivacyWarningChip.svelte';
	// import UsdtNetworkPicker from '$components/UsdtNetworkPicker.svelte';
	// import UsdcNetworkPicker from '$components/UsdcNetworkPicker.svelte';
	// import DaiNetworkPicker from '$components/DaiNetworkPicker.svelte';
	import {
		type UsdtNetwork,
		type UsdcNetwork,
		type DaiNetwork,
		isUsdtNetwork,
		isUsdcNetwork,
		isDaiNetwork
	} from '$lib/assets/networks';
	import { instanceAdditions } from '$lib/stores/instanceAdditions';
	import { displayNamesForMethods } from '$lib/payments/display';
	import { getInstanceSnapshot } from '$lib/stores/instance';

	import { identity, isUnlocked, isPairedReadOnly } from '$stores/identity';
	import { getPreferencesSnapshot, setPreference } from '$stores/userPreferences';
	import { useActiveKey, KeystoreError } from '$crypto/keystore';
	import UnlockActiveKeyModal from '$components/UnlockActiveKeyModal.svelte';
	import sodium from 'libsodium-wrappers-sumo';
	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import { broadcastNewOrder, BroadcastError } from '$blurt/ops/order';
	import { addPendingOrder } from '$lib/stores/pendingOrders';
	import { orderPayloadToRecord, type OrderPayload } from '$lib/orders/payload';
	import { computeFee, BASE_FEE_BLURT, resolveFeeRecipient, type FeeQuote } from '$lib/orders/fee';
	import { onDestroy } from 'svelte';
	import { getOrdersByAccount } from '$lib/indexer/client';
	import {
		ASSET_TICKERS,
		FIRST_ORDER_MIN_USD,
		isAssetTicker,
		isGoodsAsset,
		type AssetTicker
	} from '@morphit/asset-registry';
	import {
		checkWaiverEligibility,
		fetchListingFee,
		type WaiverEligibility
	} from '$lib/orders/listingFee';
	import { fetchFxRates, fiatToUsd, firstOrderMinInFiat, usdMinInFiat, usdToFiat } from '$lib/orders/fx';
	import type { FxResponse } from '@morphit/indexer-client';
	import { MORPHIT_INDEXER_ORIGIN, resolveOrigin } from '$net/config';
	import type { OrderFormInput } from '$lib/orders/payload';
	import { makeExpiryFlooredUtcDay } from '$lib/orders/payload';
	import { orderTitleParts } from '$lib/utils/orderTitle';
	import { sanitizeBarterTitle, SPECIFIC_BARTER_TITLE_MAX } from '$lib/orders/payload';
	import { termsHasForbiddenChar } from '$lib/orders/termsForbiddenChars';
	import { publishOrderPost } from '$lib/syndication/publish';
	import {
		isOrderBlogDefaultEnabled,
		hasFiredFirstTrade,
		firstTradeAnnounce,
		setFirstTradeAnnounce
	} from '$lib/utils/syndicationPrefs';
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
	// cp376 step lazy-loaders — defer step-2 / step-3 / stablecoin-branch
	// component JS out of the initial post-page bundle.  Same shape as the
	// cp165 loaders above; in Svelte 5 the {#await loadX() then C} block
	// evaluates the loader once when the step's enclosing {#if} first
	// renders it, so the control mounts once and inner reactive updates
	// (the user typing in that step) never remount it.
	const loadFiatCurrencySelect = () =>
		import('$components/FiatCurrencySelect.svelte').then((m) => m.default);
	const loadPaymentMethodsPicker = () =>
		import('$components/PaymentMethodsPicker.svelte').then((m) => m.default);
	const loadUsdtNetworkPicker = () =>
		import('$components/UsdtNetworkPicker.svelte').then((m) => m.default);
	const loadUsdcNetworkPicker = () =>
		import('$components/UsdcNetworkPicker.svelte').then((m) => m.default);
	const loadDaiNetworkPicker = () =>
		import('$components/DaiNetworkPicker.svelte').then((m) => m.default);
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
	// O (cp295): the fiat denomination is chosen via a single-select
	// FiatCurrencySelect (was a free-text field). `fiatArr` is the
	// component's 1-element binding; `fiat` stays a plain string derived
	// from it, so every existing read (validation, draft, broadcast,
	// price-model) is unchanged. The three former `fiat = …` writes now
	// set `fiatArr`.
	let fiatArr = $state<string[]>([]);
	const fiat = $derived(typeof fiatArr[0] === 'string' ? fiatArr[0] : '');
	let amountMin: string = $state(''); // kept as string so empty distinguishes from 0
	let amountMax: string = $state('');
	// cp368: error styling on the amount + fixed-price fields is gated on the
	// user having actually typed in them, so a pristine form (and a just-revealed
	// flat-price field) never shows a scary red border before any input. The
	// validators still drive step gating; these only gate the red border + the
	// inline message DISPLAY.
	let amountTouched: boolean = $state(false);
	let fixedPriceTouched: boolean = $state(false);
	type PriceModelKind = 'spread' | 'fixed';
	let priceModelKind = $state<PriceModelKind>('spread');
	let spreadPercent = $state('0');
	let fixedPrice = $state('');

	// ─── Form state (step 3) ───────────────────────────────────────
	let paymentMethods: string[] = $state([]);
	let pmDraft = $state('');
	// cp425 — for a BARTER (goods/services) listing, step 3 is a different
	// surface: the seller ticks which cryptos they'll accept as settlement
	// (the on-chain `accepted_assets` set) instead of picking fiat/in-person
	// payment methods. Crypto assets leave this empty.
	let acceptedAssets: AssetTicker[] = $state([]);
	let region = $state('');
	let terms = $state('');
	// v1.9.0 (Ken) — for a BARTER listing, the user's inline "what am I offering"
	// label typed where the summary reads "goods/services" (e.g. "bananas"). It
	// flows into the order title + Blurt announcement. Letters-only, ≤24 chars —
	// enforced on input via sanitizeBarterTitle; the builder + indexer re-check.
	let specificBarterTitle = $state('');
	// t.txt (v1.4.9 #2) — the markdown-guide modal for the Terms field.
	let mdGuideOpen = $state(false);

	/** cp474 (t.txt #11) — whether the markdown-icon's hover tooltip is showing.
	 *
	 *  THE BUG. Ken: "when i am typing in the Terms/details textarea, and I
	 *  accidentally mouseover the markdown icon, the tooltip won't disappear when
	 *  I stop mousing over the markdown icon."
	 *
	 *  It was a pure-CSS `group-hover:block` tooltip, so the ONLY thing that could
	 *  dismiss it was the pointer physically moving off the icon. That is a bad
	 *  bargain for this particular tooltip, because it is absolutely positioned
	 *  BELOW a 16px icon that sits directly above the Terms textarea — so it
	 *  covers the very field you are typing into. And while you type, browsers
	 *  hide the mouse cursor and do not re-evaluate `:hover` until the pointer
	 *  actually moves: a tooltip that opened as your hand left the mouse just sits
	 *  there over your text, with no mouseleave coming, until you jiggle the mouse.
	 *
	 *  So the tooltip is state-driven now, and TYPING dismisses it — the one
	 *  signal that unambiguously means "I'm using the field, not the icon".
	 *  Pointer and keyboard entry still open it; leaving/blurring still closes it. */
	let mdTipOpen = $state(false);

	// Typing in Terms dismisses the tooltip. `terms` is bound to the textarea, so
	// it changes on every keystroke — no new prop on the shared ProtectedTextarea.
	// Re-arms on the next deliberate hover/focus of the icon.
	$effect(() => {
		void terms;
		mdTipOpen = false;
	});

	// cp372 — animated "typewriter" placeholder for the Terms field.
	// A deliberately MULTI-LINGUAL, UNTRANSLATED set of example terms:
	// seeing real-world notes in several languages cycle through tells
	// grandma at a glance that this free-text field accepts whatever
	// she wants to write, in her own words / language.  These are
	// examples, NOT UI copy, so they are intentionally not localized.
	const TERMS_PLACEHOLDER_PHRASES = [
		'Please leave your dog at home',
		'Proszę usunąć pojazdy przed rozpoczęciem prac',
		'Weekends only',
		'На трибунах баскетбольной площадки',
		"Next to Biggie's Cafe",
		'Debajo del puente',
		'Banana trees at least 1 meter tall',
		'请在工作开始前取走您的个人物品'
	];
	let termsPlaceholder = $state(TERMS_PLACEHOLDER_PHRASES[0]);

	// Drive the typewriter on mount.  Self-contained + fully cleaned
	// up on unmount.  Honors prefers-reduced-motion: motion-sensitive
	// users get a plain cycle (no per-character animation) instead.
	onMount(() => {
		const phrases = TERMS_PLACEHOLDER_PHRASES;
		const reduce =
			typeof window !== 'undefined' &&
			window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

		if (reduce) {
			let i = 0;
			const id = setInterval(() => {
				i = (i + 1) % phrases.length;
				termsPlaceholder = phrases[i];
			}, 5000);
			return () => clearInterval(id);
		}

		let phraseIdx = 0;
		let charIdx = 0;
		let mode: 'typing' | 'holding' | 'erasing' = 'typing';
		let timer: ReturnType<typeof setTimeout>;
		const tick = (): void => {
			const phrase = phrases[phraseIdx];
			if (phrase === undefined) return;
			if (mode === 'typing') {
				charIdx++;
				termsPlaceholder = phrase.slice(0, charIdx);
				if (charIdx >= phrase.length) {
					mode = 'holding';
					timer = setTimeout(tick, 2400);
				} else {
					timer = setTimeout(tick, 55);
				}
			} else if (mode === 'holding') {
				mode = 'erasing';
				timer = setTimeout(tick, 28);
			} else {
				charIdx--;
				termsPlaceholder = phrase.slice(0, Math.max(0, charIdx));
				if (charIdx <= 0) {
					phraseIdx = (phraseIdx + 1) % phrases.length;
					mode = 'typing';
					timer = setTimeout(tick, 350);
				} else {
					timer = setTimeout(tick, 26);
				}
			}
		};
		timer = setTimeout(tick, 900);
		return () => clearTimeout(timer);
	});
	let expiresDays = $state(90);
	/** Per-order opt-in: also post this order's announcement to the
	 *  user's own Blurt blog. Defaults false so users actively opt
	 *  in. When true, Post B fires immediately after the order
	 *  broadcast succeeds — see syndicate/publish.ts. */
	let syndicateToBlog = $state(isOrderBlogDefaultEnabled());

	// O (cp295): animated example regions cycle through the placeholder,
	// mirroring the onboarding import account field. Runs only while the
	// field is empty; pauses the instant there's text and resumes when it
	// goes empty again. prefers-reduced-motion shows a single static
	// example with no animation. Region names are proper nouns, so they
	// are not localized (same rationale as the import account examples).
	const REGION_PLACEHOLDERS = [
		'Buenos Aires',
		'Lagos',
		'Berlin',
		'Manila',
		'São Paulo',
		'Nairobi',
		'Jakarta',
		'Istanbul'
	] as const;
	let regionPlaceholder = $state<string>(REGION_PLACEHOLDERS[0]);
	$effect(() => {
		if (region.length > 0) return;
		if (
			typeof window !== 'undefined' &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches
		) {
			regionPlaceholder = REGION_PLACEHOLDERS[0];
			return;
		}
		const TYPE_MS = 70;
		const DELETE_MS = 35;
		const HOLD_MS = 1600;
		const GAP_MS = 450;
		let nameIdx = 0;
		let charIdx = 0;
		let phase: 'typing' | 'holding' | 'deleting' = 'typing';
		let timer: ReturnType<typeof setTimeout>;
		const tick = (): void => {
			const name = REGION_PLACEHOLDERS[nameIdx] ?? REGION_PLACEHOLDERS[0];
			if (phase === 'typing') {
				charIdx += 1;
				regionPlaceholder = name.slice(0, charIdx);
				if (charIdx >= name.length) {
					phase = 'holding';
					timer = setTimeout(tick, HOLD_MS);
				} else {
					timer = setTimeout(tick, TYPE_MS);
				}
			} else if (phase === 'holding') {
				phase = 'deleting';
				timer = setTimeout(tick, DELETE_MS);
			} else {
				charIdx -= 1;
				regionPlaceholder = name.slice(0, charIdx);
				if (charIdx <= 0) {
					nameIdx = (nameIdx + 1) % REGION_PLACEHOLDERS.length;
					phase = 'typing';
					timer = setTimeout(tick, GAP_MS);
				} else {
					timer = setTimeout(tick, DELETE_MS);
				}
			}
		};
		timer = setTimeout(tick, GAP_MS);
		return () => clearTimeout(timer);
	});

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
	// JSON of the form state captured right after mount (draft restore + all
	// prefills). The auto-save effect only persists once the live state
	// diverges from this baseline — so arriving via a programmatic prefill
	// (e.g. ?welcome=1) without typing anything never writes a draft that
	// would later resurface as a phantom "Draft restored from N ago" banner.
	let baselineDraftJson: string | null = null;

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
		/** cp425 — accepted-crypto set for a barter draft. */
		acceptedAssets?: AssetTicker[];
		pmDraft: string;
		region: string;
		terms: string;
		specificBarterTitle?: string;
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
			acceptedAssets: [...acceptedAssets],
			pmDraft,
			region: region.length > 0 ? redactPrivateKeys(region) : region,
			terms: terms.length > 0 ? redactPrivateKeys(terms) : terms,
			specificBarterTitle: sanitizeBarterTitle(specificBarterTitle),
			expiresDays,
			syndicateToBlog,
			feeMethodChoice,
			externalTxId,
			txProof
		};
	}

	function applyDraft(d: ComposeDraft): void {
		// Defensive coercion (cp364) — a draft persisted by an OLDER build's
		// schema, or a hand-edited / corrupted localStorage slot, can carry a
		// field whose RUNTIME type no longer matches its declared type (e.g.
		// `fiat` saved as an array, or an amount saved as a number). The form
		// calls `.trim()` on the string fields downstream (fiat in step2Done /
		// fiatError, the amounts + spread/fixed in the validators + summary);
		// a non-string there throws an UNCAUGHT `…trim is not a function`
		// that aborts the whole Svelte render flush — which on /post shows up
		// as everything below Step 1 silently vanishing (Ken's beta.34
		// first-trade screenshot + the console TypeError). Coercing each field
		// to its declared type here lets a stale draft degrade gracefully but
		// never poison the form. A well-formed current-schema draft passes
		// through byte-identically (string→string, enum→enum, array→array).
		const str = (v: unknown): string => (typeof v === 'string' ? v : '');
		side = d.side === 'buy' || d.side === 'sell' ? d.side : null;
		asset = isAssetTicker(d.asset) ? d.asset : null;
		const f = str(d.fiat);
		fiatArr = f ? [f] : [];
		amountMin = str(d.amountMin);
		amountMax = str(d.amountMax);
		priceModelKind = d.priceModelKind === 'fixed' ? 'fixed' : 'spread';
		spreadPercent = str(d.spreadPercent);
		fixedPrice = str(d.fixedPrice);
		// cp368: a loaded draft carries real values, so treat the
		// amount / fixed-price fields as touched when non-empty —
		// an invalid saved value should show its error on resume
		// rather than hide behind the pristine-form gate.
		amountTouched = amountMin !== '' || amountMax !== '';
		fixedPriceTouched = fixedPrice !== '';
		paymentMethods = Array.isArray(d.paymentMethods)
			? d.paymentMethods.filter((m): m is string => typeof m === 'string')
			: [];
		// cp425 — restore the barter accepted-crypto set (only valid tickers).
		acceptedAssets = Array.isArray(d.acceptedAssets)
			? d.acceptedAssets.filter((t): t is AssetTicker => isAssetTicker(t))
			: [];
		pmDraft = str(d.pmDraft);
		region = str(d.region);
		terms = str(d.terms);
		specificBarterTitle = sanitizeBarterTitle(str(d.specificBarterTitle));
		expiresDays =
			typeof d.expiresDays === 'number' && Number.isFinite(d.expiresDays)
				? Math.max(1, Math.min(90, Math.floor(d.expiresDays)))
				: 90;
		syndicateToBlog = d.syndicateToBlog === true;
		feeMethodChoice =
			d.feeMethodChoice === 'blurt' ||
			d.feeMethodChoice === 'waived_first_buy' ||
			d.feeMethodChoice === 'btc' ||
			d.feeMethodChoice === 'xmr'
				? d.feeMethodChoice
				: 'blurt';
		externalTxId = str(d.externalTxId);
		txProof = str(d.txProof);
	}

	/** Heuristic: does the draft actually contain anything worth
	 *  restoring? An all-defaults snapshot is not worth announcing
	 *  to the user ("Restored from 2 minutes ago" when nothing was
	 *  typed is just noise).
	 *
	 *  side/asset are deliberately NOT counted: for a first-time
	 *  account the lock effect force-sets side='buy'/asset='BLURT'
	 *  without the user typing anything, so counting them made the
	 *  restore banner appear on a pristine first-trade form.  For
	 *  everyone else they're single-tap picks, trivially re-made —
	 *  not "content" worth a restore prompt.  They are still saved
	 *  and restored as part of the snapshot; this only governs
	 *  whether the banner/auto-save fires.  Real content is the
	 *  fields the user actually fills in. */
	function draftHasContent(d: ComposeDraft): boolean {
		return (
			d.fiat.length > 0 ||
			d.amountMin.length > 0 ||
			d.amountMax.length > 0 ||
			d.fixedPrice.length > 0 ||
			d.paymentMethods.length > 0 ||
			(d.acceptedAssets?.length ?? 0) > 0 ||
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
		fiatArr = [];
		amountMin = '';
		amountMax = '';
		priceModelKind = 'spread';
		spreadPercent = '0';
		fixedPrice = '';
		amountTouched = false;
		fixedPriceTouched = false;
		lastSeededFiat = '';
		paymentMethods = [];
		pmDraft = '';
		region = '';
		terms = '';
		specificBarterTitle = '';
		expiresDays = 90;
		syndicateToBlog = isOrderBlogDefaultEnabled();
		feeMethodChoice = 'blurt';
		externalTxId = '';
		txProof = '';
		// Re-baseline to the cleared state: the next auto-save only fires
		// once the user starts composing again.
		baselineDraftJson = JSON.stringify(snapshotDraft());
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

	// Mid-broadcast navigation guard (cp308 F-005). Order permlinks are
	// random per attempt, so a user who navigates away mid-broadcast —
	// unsure whether it landed — and re-posts creates a DUPLICATE on-chain
	// order. Cancel navigation while the chain op is in flight, exactly as
	// register-name guards its account-creation broadcast. (The success/
	// error views below drive the user's own navigation once it resolves.)
	beforeNavigate((nav) => {
		if (phase === 'broadcasting') {
			nav.cancel();
		}
	});

	let password = $state('');
	let passwordError = $state('');

	/** cp470 — focus a field the moment it mounts.  Applied to the
	 *  unlock-password input so entering the awaiting_password step (via
	 *  "Pay and Post this order") drops the cursor straight in: type the
	 *  password, press Enter (handled below), done — no click required.
	 *  A `use:` action rather than the `autofocus` attribute avoids the
	 *  Svelte a11y warning and fires exactly once, when the field appears. */
	function focusOnMount(node: HTMLElement): void {
		node.focus();
	}
	let broadcastError = $state('');
	let successPermlink: string | null = $state(null);

	/** #20 (Ken) — the success page used to show "View my order" the instant the
	 *  broadcast returned. The order isn't queryable yet at that moment, so the
	 *  button led straight to a not-found page: "I just paid, and my order
	 *  doesn't exist." Terrifying, and entirely our fault.
	 *
	 *  v1.7.0 — that was solved by POLLING the indexer until the order appeared,
	 *  and revealing the button only then. The poll has been removed, because it
	 *  never actually worked and could not have:
	 *
	 *    - Its own comment said "chain is 3s blocks + indexer lag, so this is
	 *      usually one or two ticks". It isn't. The indexer applies only blocks up
	 *      to last-irreversible (ADR-0008), which trails head by 45-63s — 22 to 31
	 *      ticks. The bound was 20 (~40s), so the poll RELIABLY timed out and
	 *      surfaced the button anyway ("a slow indexer must not make the order
	 *      unreachable"). The user then clicked it and the detail page, whose own
	 *      retry was also calibrated against poll lag, said "Order not found".
	 *      Both workarounds reasoned about the same wrong number, so the exact
	 *      scenario this comment was written to prevent happened every time.
	 *    - Making the poll longer would only have replaced a not-found with 60+
	 *      seconds of spinner. The order isn't missing; the indexer is behind.
	 *
	 *  `pendingOrders` fixes it at the root: this browser stages the order it just
	 *  broadcast, and the detail page reads it, so the button is safe to offer
	 *  immediately. No poll, no gate, no ~40s of extra `/v1/orders` requests per
	 *  post. ("fastpostorder", ADR-0051.) */
	function stagePostedOrder(payload: OrderPayload): void {
		if (!blurtAccount) return;
		addPendingOrder(orderPayloadToRecord(blurtAccount, payload, new Date().toISOString()));
	}

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
	// cp372: the indexer's USD→fiat table (/v1/fx).  Powers the
	// FX-aware first-order floor (so the client's pre-submit check
	// matches the indexer's authoritative one for ANY currency, not
	// just USD) and the live "$1-equivalent" Min-value default in the
	// user's own fiat.  Null = FX feed disabled / fetch failed → the
	// floor falls back to treating amount_min as already-USD (exactly
	// like the indexer), and no default is seeded.
	let fxTable: FxResponse | null = $state(null);

	/** cp470 — the listing fee's fiat equivalent, shown parenthesized
	 *  under the BLURT amount.  The fee is USD-equivalent; when the user
	 *  has a fiat set (their order `fiat`, seeded from the saved
	 *  preference) and the FX table can convert to it, echo the fee in
	 *  THAT currency — the same USD→fiat path the Min-value default uses.
	 *  Otherwise fall back to the operator's denomination (USD).  Null →
	 *  nothing to show (operator sent no fiat-per-BLURT, or no fee yet). */
	const feeFiatEcho = $derived.by(() => {
		if (fiatPerBlurt === null || feeQuote === null) return null;
		const inDenom = feeQuote.blurtAmount * fiatPerBlurt; // in denominationFiat
		if (
			fiat !== '' &&
			fiat.toUpperCase() !== denominationFiat.toUpperCase() &&
			denominationFiat.toUpperCase() === 'USD'
		) {
			const inPref = usdToFiat(fxTable, inDenom, fiat);
			if (inPref !== null) return formatFiat(inPref, fiat);
		}
		return formatFiat(inDenom, denominationFiat);
	});
	// Tracks which fiat the Min-value default was last seeded for, so
	// the seed re-syncs when the user switches currency (while the
	// field is still untouched) but never fights a user-typed value.
	let lastSeededFiat = $state('');
	// cp397: when arriving via the profile "Top up BLURT" CTA, the Min
	// field is seeded with this USD amount expressed in the user's fiat
	// (the conversion needs fx + a chosen fiat, which aren't ready at
	// prefill-read time, so a dedicated seed effect fills it once both
	// are). null = not a top-up arrival.
	let topupUsdMin = $state<number | null>(null);
	// cp372 Model A: live BTC/XMR fee amounts + USD echoes from
	// /v1/listing-fee, fed to ListingFeeAddressPanel so the BTC/XMR
	// quote tracks the operator's USD-equivalent fee instead of a fixed
	// crypto constant.  Undefined → panel quotes the chain-pinned amount.
	let btcFeeSatoshisLive: number | undefined = $state(undefined);
	let xmrFeePiconeroLive: string | undefined = $state(undefined);
	let btcFeeFiat: number | undefined = $state(undefined);
	let xmrFeeFiat: number | undefined = $state(undefined);
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
	/** O#1/#9 (cp295): a brand-new account — no prior orders on record,
	 *  or not yet visible in the index — is locked to its FUNDING trade:
	 *  a BUY of BLURT. BLURT is what pays listing fees, so until the
	 *  account holds some it can't list anything; making the first trade
	 *  a (free, waived) BLURT buy is the on-ramp. Same signal as the
	 *  waiver. On 'error' / not-yet-loaded we do NOT lock — if we can't
	 *  verify, fall back to the normal full picker. */
	const isFirstTrade = $derived(
		waiverEligibility !== null &&
			(waiverEligibility.kind === 'eligible' ||
				waiverEligibility.kind === 'eligible_unknown_account')
	);
	// Backstop the lock: while first-trade applies, hold side=buy,
	// asset=BLURT, and a 7-day expiry. The Step-1 picker and the expiry
	// <select> are hidden/disabled in the template, so nothing else
	// writes these during first-trade; the guards (write only when the
	// value is wrong) make this converge in finite steps — it never
	// loops — and guarantee the values even against a restored draft.
	$effect(() => {
		if (!isFirstTrade) return;
		if (side !== 'buy') side = 'buy';
		if (asset !== 'BLURT') asset = 'BLURT';
		if (expiresDays !== 7) expiresDays = 7;
	});
	/** Asset chips shown in Step 1: only BLURT during the first-trade
	 *  lock, the full set otherwise. */
	const assetTickersForPicker: readonly AssetTicker[] = $derived(
		isFirstTrade ? (['BLURT'] as const) : ASSET_TICKERS
	);
	/** Asset → FAQ deep-link. Every tradable asset has a `what_is_<ticker>`
	 *  FAQ entry EXCEPT BTC and XMR (no deep-link — matches the prior
	 *  per-asset Tooltip markup). The "Learn more" link is omitted for
	 *  those two; their explainer text still shows. */
	const ASSET_FAQ: Partial<Record<AssetTicker, FaqKey>> = {
		BLURT: 'what_is_blurt',
		USDT: 'what_is_usdt',
		USDC: 'what_is_usdc',
		DAI: 'what_is_dai',
		BCH: 'what_is_bch',
		LTC: 'what_is_ltc',
		DASH: 'what_is_dash',
		DOGE: 'what_is_doge',
		ZEC: 'what_is_zec',
		ARRR: 'what_is_arrr',
		DCR: 'what_is_dcr',
		SOL: 'what_is_sol',
		ETH: 'what_is_eth',
		XRP: 'what_is_xrp',
		BARTER: 'what_is_barter'
	};
	/** cp396 — the Step-1 asset blocks, ALPHABETIZED by ticker. Each block
	 *  carries its own coin icon (left of the ticker) and triggers a themed
	 *  explainer tooltip on hover (desktop) / focus-on-tap (mobile); the
	 *  separate ⓘ bubbles are gone. Tickers are uppercase ASCII so the
	 *  default lexicographic sort IS alphabetical.
	 *  cp425 — EXCEPT goods assets (BARTER): they aren't coins, so they sort
	 *  to the END of the picker, after the alphabetized cryptos. */
	const assetPickerItems = $derived(
		[...assetTickersForPicker]
			.sort((a, b) => {
				const ga = isGoodsAsset(a);
				const gb = isGoodsAsset(b);
				if (ga !== gb) return ga ? 1 : -1;
				return a < b ? -1 : a > b ? 1 : 0;
			})
			.map((a) => ({
				ticker: a,
				iconPath: `/icons/icon-${a.toLowerCase()}.svg`,
				explainerKey: `post_order.form.asset_explainer.${a.toLowerCase()}`,
				faqKey: ASSET_FAQ[a]
			}))
	);
	/** The user's choice for this order. Four options post-4b:
	 *    'blurt'              → pay standard BLURT fee (default)
	 *    'waived_first_buy'   → free, requires waiverOffered (4a)
	 *    'btc'                → pay fee in BTC (4b)
	 *    'xmr'                → pay fee in XMR (4b)
	 *  Non-BLURT methods require an external txid, captured in
	 *  externalTxId. */
	let feeMethodChoice = $state<'blurt' | 'waived_first_buy' | 'btc' | 'xmr'>('blurt');
	/** Whether the unlocked session actually holds the ACTIVE key.  Only a
	 *  'morphit-seed' session does; a 'posting-only' login (imported a single
	 *  posting WIF, or a posting-only keyfile) CANNOT sign a BLURT transfer,
	 *  so the BLURT listing-fee path is unavailable to it — LiveIdentity's
	 *  contract is that active-key features must guard with
	 *  an active key on this device (CAPABILITY, not provenance — a
	 *  'posting-active' session has one).  Such a user can still use the free
	 *  first-listing waiver or pay the fee in BTC/XMR (all posting-key only).
	 *  Without this guard, a posting-only user picking BLURT was prompted for
	 *  their password and then hit a generic "the chain didn't accept your
	 *  broadcast" — a *local* pre-broadcast failure mislabeled as a chain
	 *  rejection (the active key simply isn't on this device). */
	const hasActiveKey = $derived(
		$identity.state === 'unlocked' ? $identity.live.activePublicKey !== null : false
	);
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
		if (!trimmed.startsWith('OutProofV1') && !trimmed.startsWith('OutProofV2')) {
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

	// Latch so the first-buy waiver auto-selects ONCE when it first becomes
	// available — NOT on every effect run. (cp384 #8 added it so an explicit
	// BLURT choice wouldn't get reverted; cp386 #3 then hid the BLURT fee on
	// the waiver card entirely, so the waiver is simply the first-buy default
	// now.) Plain (non-reactive) let — a latch, deliberately not $state.
	// Re-armed when the waiver goes away.
	let waiverAutoSelectDone = false;

	$effect(() => {
		// cp386 (#3): on the FIRST-trade waiver card we don't offer paying the
		// fee in the asset being acquired ("buy BLURT with BLURT") — those
		// radios are hidden there and the reconciliation at the end of this
		// effect keeps feeMethodChoice off them. Scope is the waiver card only,
		// so the old XMR→xmr / BTC→btc auto-default is gone; later trades keep
		// every fee option (pay the ~$1 fee in what you already hold).

		// Auto-select the waiver ONCE when it first becomes available. On the
		// waiver card the BLURT fee is hidden (cp386 #3), so the free waiver is
		// the natural first-buy default; an explicit BTC/XMR choice still
		// sticks. Only blurt → waiver (never override an explicit BTC/XMR).
		if (waiverOffered && !waiverAutoSelectDone) {
			waiverAutoSelectDone = true;
			if (feeMethodChoice === 'blurt') {
				feeMethodChoice = 'waived_first_buy';
			}
		}
		// If the waiver goes away (e.g. side flips buy → sell mid-compose),
		// revert a waiver choice back to BLURT and re-arm the latch so the
		// waiver re-auto-selects if it becomes available again.
		if (!waiverOffered) {
			waiverAutoSelectDone = false;
			if (feeMethodChoice === 'waived_first_buy') {
				feeMethodChoice = 'blurt';
			}
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

		// cp386 (#3): on the FIRST-trade waiver card we hide the fee option
		// whose asset matches the trade (you're acquiring that asset and hold
		// none yet — e.g. "buy BLURT with BLURT" — and the free waiver is right
		// there). Scope is the waiver card ONLY: on later trades the user holds
		// the asset, so paying a ~$1 fee in it (esp. BLURT) is the easy path and
		// stays offered — we never force grandma onto a BTC/XMR txid for $1.
		// This guard just keeps feeMethodChoice off a now-hidden option on the
		// waiver card (restored draft, or asset switched to match a picked fee).
		const selectedFeeAsset =
			feeMethodChoice === 'blurt'
				? 'BLURT'
				: feeMethodChoice === 'btc'
					? 'BTC'
					: feeMethodChoice === 'xmr'
						? 'XMR'
						: null;
		if (waiverOffered && selectedFeeAsset !== null && selectedFeeAsset === asset) {
			feeMethodChoice = asset === 'BLURT' ? 'waived_first_buy' : 'blurt';
		}
	});

	/** Minimum first-order VALUE for a waiver-eligible buy, in the
	 *  order's fiat (the field the user fills, e.g. "Minimum value
	 *  in USD").  amount_min IS a fiat value everywhere in the
	 *  system — the orderbook renders it as "{min} – {max}
	 *  {fiat_currency}" — so the floor is a fiat-to-fiat check, no
	 *  price feed required.  Grandma thinks in her local currency,
	 *  NOT in BLURT: the requirement is "$1 USD-equivalent", shown
	 *  and checked in her currency, never "buy 500 BLURT" (which
	 *  sounds like a fortune and scares newcomers off).  $1 of BLURT
	 *  at ~$0.002 is ~500 BLURT and funds ~8 future listings at the
	 *  ~$0.125 BLURT listing fee, so a $1 first buy still leaves the
	 *  new user with room to be active.  This is the *floor* — also
	 *  enforced on the indexer; orders below it are rejected.
	 *
	 *  cp369: reverses the §F.11 "BLURT-denomination" regression
	 *  that compared this fiat-valued amount against a flat 500-BLURT
	 *  constant (so "$1" was read as "1 BLURT < 500" and rejected).
	 *  NOTE: $1-USD-equivalent is exact when the order's fiat is USD
	 *  (the default denomination); for a non-USD instance the precise
	 *  per-currency $1 conversion needs a USD↔local rate the single-
	 *  denomination price feed doesn't yet carry — tracked as a
	 *  multi-currency-pricing enhancement. */
	const WAIVER_MIN_FIAT_USD = FIRST_ORDER_MIN_USD;
	/** Suggested first-buy VALUE for the welcome flow, in the order's
	 *  fiat: ~$4 (≈ the old 2,000-BLURT suggestion at ~$0.002).  Pre-
	 *  filled when the user arrives via the orderbook welcome hero;
	 *  users who type a smaller value down to the $1 floor are still
	 *  accepted silently.  The UI never says "minimum $1" as a tax —
	 *  it shows what they GET at increasing sizes, which encourages a
	 *  bigger buy without feeling like a gate. */
	const WAIVER_SUGGESTED_DEFAULT = 4;

	/** Tier breakpoints for the first-buy benefits ladder.  Each
	 *  entry pairs a minimum first-order VALUE (in the order's fiat)
	 *  with an i18n key describing what the user gets at that level.
	 *  The ladder is rendered in step 2 when the waiver is offered.
	 *  Every row whose threshold ≤ the user's current `amountMin`
	 *  (also a fiat value) shows as "unlocked" (✓, emerald-bold);
	 *  higher rows show as "available if you increase" (○, muted).
	 *  $1 is at the bottom because it's the indexer's floor — orders
	 *  below it are rejected; $1+ lights at least this row.
	 *
	 *  cp369: the breakpoints are now fiat (USD-equivalent), not raw
	 *  BLURT quantities — the §F.11 BLURT-denomination regression had
	 *  them at 500/2000/10000/50000 BLURT, which never lit up against
	 *  a fiat-valued `amountMin` like $1.  The USD-equivalents at
	 *  ~$0.002/BLURT are ~$1/$4/$20/$100 (the legacy key names keep
	 *  their numeric suffix as a stable identifier only).  Descriptions
	 *  still hold: $1 ÷ ~$0.125 per listing ≈ 8 future listings. */
	const WAIVER_BENEFIT_TIERS: ReadonlyArray<{ readonly at: number; readonly key: string }> = [
		{ at: 1, key: 'post_order.waiver_benefits.tier_1' },
		{ at: 4, key: 'post_order.waiver_benefits.tier_4' },
		{ at: 20, key: 'post_order.waiver_benefits.tier_20' },
		{ at: 100, key: 'post_order.waiver_benefits.tier_100' }
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

			// cp372: fetch the USD→fiat table in parallel.  Best-effort —
			// a disabled feed / failure just leaves fxTable null and the
			// floor falls back to the USD-assumption (the indexer remains
			// authoritative either way).
			const fxPromise = fetchFxRates(resolveOrigin(MORPHIT_INDEXER_ORIGIN));

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
				// cp372 Model A: live BTC/XMR fee amounts + USD echoes.
				btcFeeSatoshisLive =
					typeof lf.quote.btc_fee_satoshis === 'number' ? lf.quote.btc_fee_satoshis : undefined;
				xmrFeePiconeroLive =
					typeof lf.quote.xmr_fee_piconero === 'string' ? lf.quote.xmr_fee_piconero : undefined;
				btcFeeFiat = typeof lf.quote.btc_fee_fiat === 'number' ? lf.quote.btc_fee_fiat : undefined;
				xmrFeeFiat = typeof lf.quote.xmr_fee_fiat === 'number' ? lf.quote.xmr_fee_fiat : undefined;
			}

			feeQuote = computeFee(activeCount + 1, operatorBaseBlurt);

			// cp372: settle the FX table (best-effort).
			const fx = await fxPromise;
			if (fx.kind === 'ok') fxTable = fx.table;
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
					// First-trade lock — force the funding-buy shape (buy BLURT,
					// 7-day expiry) SYNCHRONOUSLY here, in the same tick
					// waiverEligibility resolves and isFirstTrade flips true.
					// The reactive lock effect ($effect, below) also enforces
					// this, but a post-render effect lands a beat AFTER the
					// template recomputes step1Done off the just-flipped
					// isFirstTrade — so Step 2 (gated `{#if step1Done}`) and the
					// step nav could stay hidden, leaving a first-time trader
					// with just the asset card and nothing below it. Setting
					// side/asset at the SAME point isFirstTrade becomes true
					// keeps step1Done consistent within the flush and guarantees
					// the submitted order carries the right shape, not just the
					// gate. Mirror of the lock effect's guards (idempotent).
					if (r.kind === 'eligible' || r.kind === 'eligible_unknown_account') {
						if (side !== 'buy') side = 'buy';
						if (asset !== 'BLURT') asset = 'BLURT';
						if (expiresDays !== 7) expiresDays = 7;
					}
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
					specificBarterTitle: string;
					expiresDays: number;
					reason: string;
					topupUsdMin: number;
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
				if (
					asset === 'USDT' &&
					typeof p.assetNetwork === 'string' &&
					isUsdtNetwork(p.assetNetwork)
				) {
					usdtNetwork = p.assetNetwork;
				} else if (
					asset === 'USDC' &&
					typeof p.assetNetwork === 'string' &&
					isUsdcNetwork(p.assetNetwork)
				) {
					usdcNetwork = p.assetNetwork;
				} else if (
					asset === 'DAI' &&
					typeof p.assetNetwork === 'string' &&
					isDaiNetwork(p.assetNetwork)
				) {
					daiNetwork = p.assetNetwork;
				}
				if (typeof p.amountMin === 'string') amountMin = p.amountMin;
				if (typeof p.amountMax === 'string') amountMax = p.amountMax;
				if (typeof p.topupUsdMin === 'number' && Number.isFinite(p.topupUsdMin)) {
					topupUsdMin = p.topupUsdMin;
				}
				if (typeof p.fiat === 'string') fiatArr = p.fiat ? [p.fiat] : [];
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
				if (typeof p.specificBarterTitle === 'string')
					specificBarterTitle = sanitizeBarterTitle(p.specificBarterTitle);
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
		// defaults: side=buy, asset=BLURT, amountMin=$4 (a generous
		// starter value — see WAIVER_SUGGESTED_DEFAULT below for
		// rationale).  The actual gate floor is $1 USD-equivalent
		// (enforced silently on the indexer); users who type a
		// smaller value are still accepted as long as they're at
		// or above $1.  Don't overwrite anything the draft or
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
			// Same non-string guard as applyDraft: stored prefs feed fiatArr /
			// region, which are .trim()'d downstream — coerce to avoid a throw.
			if (fiat === '' && typeof prefs.fiat === 'string' && prefs.fiat !== '')
				fiatArr = [prefs.fiat];
			if (region === '' && typeof prefs.region === 'string' && prefs.region !== '')
				region = prefs.region;
		} catch {
			// localStorage unavailable / quota issues / private
			// browsing — preferences are best-effort, never block
			// the page.
		}

		// Capture the post-mount baseline (after restore + every prefill).
		// Until the user diverges from this, the auto-save effect stays quiet,
		// so a prefill-only visit never persists a phantom draft.
		baselineDraftJson = JSON.stringify(snapshotDraft());

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
			// Hold off until the post-mount baseline is captured, then only
			// persist once the user has actually diverged from it. This stops
			// a pure programmatic prefill (welcome CTA / re-list / stored
			// prefs) from being written and later resurrected as a phantom
			// "Draft restored from N ago" banner.
			if (baselineDraftJson === null) return;
			if (JSON.stringify(snapshot) === baselineDraftJson) return;
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

	/** Strip a raw input string down to a bare decimal — digits and at
	 *  most one dot.  Applied on the amount + fixed-price fields so a
	 *  user physically cannot type letters, a second dot, currency
	 *  symbols, or scientific-notation "e": the field only ever holds a
	 *  clean number-shaped string (or '').  Pairs with inputmode
	 *  "decimal" (numeric keypad on mobile) and a maxlength cap. */
	function keepDecimal(raw: string): string {
		let seenDot = false;
		let out = '';
		for (const ch of raw) {
			if (ch >= '0' && ch <= '9') out += ch;
			else if (ch === '.' && !seenDot) {
				out += ch;
				seenDot = true;
			}
		}
		return out;
	}

	/** Like keepDecimal but allows a single leading minus — the spread
	 *  field accepts negative percentages (e.g. -5 = 5% below market). */
	function keepSignedDecimal(raw: string): string {
		const neg = raw.trimStart().startsWith('-');
		return (neg ? '-' : '') + keepDecimal(raw);
	}

	const fiatError = $derived.by(() => {
		if (fiat.length === 0) return '';
		const trimmed = fiat.trim().toUpperCase();
		if (trimmed.length === 0) return $_('post_order.errors.fiat_empty');
		if (trimmed.length > 8) return $_('post_order.errors.fiat_too_long');
		if (!/^[A-Z]+$/.test(trimmed)) return $_('post_order.errors.fiat_bad_chars');
		return '';
	});

	const amountMinNum = $derived(amountMin === '' ? null : Number(amountMin));

	/** cp372 — the entered minimum converted to USD for the
	 *  first-order ($1) floor.  amount_min is denominated in the
	 *  selected `fiat`, so "1.20" on an AUD order is 1.20 AUD ≈
	 *  $0.79 — below the floor.  This MUST mirror the indexer's
	 *  authoritative check (order.ts): `fiatToUsd(amount_min, fiat)
	 *  ?? amount_min` — i.e. convert via the FX table, and on an
	 *  unknown currency / disabled feed fall back to treating the
	 *  amount as already-USD (no worse than pre-cp372, exact for
	 *  USD).  Null only when nothing is entered yet. */
	const waiverMinUsd = $derived(
		amountMinNum === null ? null : (fiatToUsd(fxTable, amountMinNum, fiat) ?? amountMinNum)
	);
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
		// Phase 3 / cp369: waiver-path orders must have amount_min set
		// AND ≥ $1 USD-equivalent (a fiat value). Mirrors the indexer's
		// `waiver_requires_min_usd` rejection so the user fails the
		// client-side gate before broadcast.
		//
		// cp129/cp369: the user-facing key is `waiver_min_required`.
		// The floor is "$1 USD-equivalent" in the order's fiat — a
		// fiat-to-fiat check (amount_min is a fiat value), no price
		// feed needed.  (cp369 reverses the §F.11 regression that
		// compared this fiat amount to a 500-BLURT constant.)  The
		// on-chain indexer rejection code (`waiver_requires_min_usd`)
		// stays as-is — a protocol constant not worth churning.
		if (feeMethodChoice === 'waived_first_buy') {
			// cp377 (E10): name the actual floor + fiat in the message
			// ("...at least 18 MXN") instead of the vague "floor shown
			// above".  The floor is $1-USD-equivalent in the order's fiat,
			// from the same `firstOrderMinInFiat` the hint above uses.  On a
			// USD instance / FX feed off, fall back to the plain "$1" wording.
			const floor = firstOrderMinInFiat(fxTable, fiat);
			const msg =
				floor === null || fiat.trim() === '' || fiat.trim().toUpperCase() === 'USD'
					? $_('post_order.errors.waiver_min_required_usd')
					: $_('post_order.errors.waiver_min_required', {
							values: { amount: String(floor), fiat }
						});
			if (amountMinNum === null) {
				return msg;
			}
			if (waiverMinUsd !== null && waiverMinUsd < WAIVER_MIN_FIAT_USD) {
				return msg;
			}
		}
		return '';
	});

	/** Per-field error attribution for the red border. The combined
	 *  `amountError` above still drives step gating + the single
	 *  bottom message, but the border should only redden the field
	 *  that's actually at fault — previously a min-only problem (e.g.
	 *  the waiver floor) reddened BOTH inputs. The cross-field
	 *  min>max condition reddens the max field (where the user can
	 *  fix it by raising the ceiling). */
	const amountMinHasError = $derived.by(() => {
		if (amountMinNum !== null) {
			if (!Number.isFinite(amountMinNum) || amountMinNum < 0) return true;
			if (amountMinNum > MAX_AMOUNT) return true;
		}
		if (feeMethodChoice === 'waived_first_buy') {
			if (amountMinNum === null || (waiverMinUsd !== null && waiverMinUsd < WAIVER_MIN_FIAT_USD))
				return true;
		}
		return false;
	});
	const amountMaxHasError = $derived.by(() => {
		if (amountMaxNum !== null) {
			if (!Number.isFinite(amountMaxNum) || amountMaxNum < 0) return true;
			if (amountMaxNum > MAX_AMOUNT) return true;
		}
		if (amountMinNum !== null && amountMaxNum !== null && amountMinNum > amountMaxNum) {
			return true;
		}
		return false;
	});

	/** cp372 — live "$1-equivalent" Min-value default.  Grandma thinks
	 *  in HER local currency, not BLURT and not USD, so on a first
	 *  (waiver) trade we pre-fill the Minimum-value field with $1-worth
	 *  of her selected fiat (rounded UP to a clean, friendly step so it
	 *  always clears the floor).  Safe-by-construction against the
	 *  cp364-class bugs: it touches NOTHING that gates a step, never
	 *  reads `amountMin` (so it can't loop), stops the instant the user
	 *  types (`amountTouched`), and re-seeds only when the user SWITCHES
	 *  currency while still untouched (tracked via `lastSeededFiat`).  A
	 *  restored draft sets `amountTouched`, so it is never re-seeded. */
	$effect(() => {
		if (!isFirstTrade || fxTable === null || fiat === '' || amountTouched) return;
		if (fiat === lastSeededFiat) return;
		const seed = firstOrderMinInFiat(fxTable, fiat);
		if (seed === null) return;
		amountMin = String(seed);
		lastSeededFiat = fiat;
	});

	/** cp397 — "Top up BLURT" (profile balance card) seeds the Min field
	 *  with a $5-equivalent in the user's fiat.  Same safe-by-construction
	 *  posture as the first-trade seed above: never reads amountMin, stops
	 *  once the user types (amountTouched), re-seeds only on a currency
	 *  switch while still untouched.  Owns returning-user top-up arrivals;
	 *  the first-trade seed (gated on isFirstTrade) owns first buys, so the
	 *  two never both seed. */
	$effect(() => {
		if (topupUsdMin === null || fxTable === null || fiat === '' || amountTouched) return;
		if (fiat === lastSeededFiat) return;
		const seed = usdMinInFiat(fxTable, topupUsdMin, fiat);
		if (seed === null) return;
		amountMin = String(seed);
		lastSeededFiat = fiat;
	});

	/** cp372 — grandma-facing explanation of the first-order minimum,
	 *  in HER currency.  Shown only on a first (waiver) trade once a
	 *  fiat is chosen.  With FX we show the converted "$1-equivalent"
	 *  (e.g. "about 18 MXN"); without FX (USD instance / feed off) we
	 *  show the plain $1 floor. */
	const firstOrderMinHint = $derived.by(() => {
		if (!isFirstTrade || fiat === '') return '';
		const eq = firstOrderMinInFiat(fxTable, fiat);
		const isUsd = fiat.trim().toUpperCase() === 'USD';
		// cp377 (E12): once she enters an amount ABOVE the floor, the hint
		// reflects HER value and what it's worth in USD (grandma sees her
		// own number, not a static restatement of the floor).  USD orders
		// skip this — the amount already IS USD, so there's no conversion
		// worth showing; they keep the plain floor line.
		if (
			!isUsd &&
			eq !== null &&
			amountMinNum !== null &&
			Number.isFinite(amountMinNum) &&
			amountMinNum > eq
		) {
			return $_('post_order.form.amount_entered_usd_hint', {
				values: {
					amount: String(amountMinNum),
					fiat,
					usd: formatFiat(waiverMinUsd ?? amountMinNum, denominationFiat)
				}
			});
		}
		if (eq === null || isUsd) {
			return $_('post_order.form.first_order_min_hint_usd');
		}
		return $_('post_order.form.first_order_min_hint', {
			values: { amount: String(eq), fiat }
		});
	});

	/** cp397 — for a RETURNING buyer (already completed a first buy, so
	 *  the waiver/first-order path no longer applies), the Min-field
	 *  helper restates their entered minimum in their own fiat plus its
	 *  USD-equivalent ("At least 100 MXN worth (≈ $5.00)"), replacing the
	 *  plain "Leave blank for no limit." once a value is present.  Empty
	 *  (no minimum set) → '' so the optional-limit line shows instead.
	 *  `waiverMinUsd` is the entered min converted to USD (falls back to
	 *  treating it as USD when the fiat is unknown / feed is off). */
	const returningMinHint = $derived.by(() => {
		if (isFirstTrade || fiat === '') return '';
		if (amountMinNum === null || !Number.isFinite(amountMinNum) || amountMinNum <= 0) return '';
		if (waiverMinUsd === null) return '';
		return $_('post_order.form.returning_min_hint', {
			values: {
				amount: String(amountMinNum),
				fiat,
				usd: formatFiat(waiverMinUsd, 'USD')
			}
		});
	});

	/** Input handlers for the number fields. Each sanitizes the raw
	 *  value and — crucially — writes the cleaned string back onto the
	 *  DOM element when it differs, so typed letters can't linger
	 *  visually. With one-way `value={…}` binding, when the cleaned
	 *  result equals the current state (e.g. typing letters into an
	 *  empty field both yield ''), Svelte sees no state change and
	 *  skips re-rendering the input — leaving the letters on screen
	 *  while the bound value stays empty, so validation never fired.
	 *  Forcing `currentTarget.value` keeps the box numeric. (cp368) */
	function syncCleaned(el: HTMLInputElement, clean: string): void {
		if (el.value !== clean) el.value = clean;
	}
	function handleAmountMinInput(e: Event & { currentTarget: HTMLInputElement }): void {
		amountTouched = true;
		const clean = keepDecimal(e.currentTarget.value);
		syncCleaned(e.currentTarget, clean);
		amountMin = clean;
	}
	function handleAmountMaxInput(e: Event & { currentTarget: HTMLInputElement }): void {
		amountTouched = true;
		const clean = keepDecimal(e.currentTarget.value);
		syncCleaned(e.currentTarget, clean);
		amountMax = clean;
	}
	function handleSpreadInput(e: Event & { currentTarget: HTMLInputElement }): void {
		const clean = keepSignedDecimal(e.currentTarget.value);
		syncCleaned(e.currentTarget, clean);
		spreadPercent = clean;
	}
	function handleFixedPriceInput(e: Event & { currentTarget: HTMLInputElement }): void {
		fixedPriceTouched = true;
		const clean = keepDecimal(e.currentTarget.value);
		syncCleaned(e.currentTarget, clean);
		fixedPrice = clean;
	}

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
	// cp425 — is the selected asset a goods asset (BARTER)? Barter is valued
	// directly in local currency and settled in crypto; several deriveds below
	// branch on it (price model, step 3, terms), so it's declared up here.
	const isBarter = $derived(asset !== null && isGoodsAsset(asset));

	const priceModelError = $derived.by(() => {
		// cp425 — a BARTER listing is valued directly in fiat (the amount range
		// above), not priced against a crypto, so there's no price model to
		// validate; the price-model UI is hidden and an inert model is shipped.
		if (isBarter) return '';
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
	 *  cp369: the ladder is now FIAT-FIRST.  `amountMin` and the tier
	 *  breakpoints (`WAIVER_BENEFIT_TIERS`) are both fiat values, so
	 *  each row shows the threshold in the order's fiat — e.g. "$1 —
	 *  ~8 future listings covered" — which is what grandma reads on
	 *  the field above.  The row lights up (✓) once her entered value
	 *  reaches the threshold.  No BLURT quantities are shown; that was
	 *  the §F.11 regression ("500 BLURT (~$1)") that confused the
	 *  fiat-valued amount with a BLURT amount.  Figures use locale-
	 *  aware formatting via `formatFiat`.
	 *
	 *  The tier amounts are USD-equivalents; on the default USD
	 *  instance the formatted unit matches exactly.  (A non-USD
	 *  instance would want the per-currency $1 conversion — see the
	 *  WAIVER_MIN_FIAT_USD note — a multi-currency-pricing follow-up.) */
	const waiverBenefitRows = $derived.by(
		(): ReadonlyArray<{
			readonly text: string;
			readonly unlocked: boolean;
		}> => {
			// cp377: the tier breakpoints (`WAIVER_BENEFIT_TIERS`) are USD
			// values ($1/$4/$20/$100), but `amountMin` is denominated in the
			// order's selected fiat.  Comparing the raw fiat amount to the USD
			// tiers was wrong (e.g. 30 MXN ≈ $1.67 was lighting up the $4 and
			// $20 rows as if it were $30).  Compare the USD-equivalent of the
			// entered amount — `waiverMinUsd`, the same value the indexer's
			// authoritative $1 floor check uses — against the USD tiers.
			const enteredUsd = waiverMinUsd ?? 0;
			return WAIVER_BENEFIT_TIERS.map((tier) => ({
				text: $_(tier.key, {
					values: { amount: formatFiat(tier.at, denominationFiat) }
				}) as string,
				unlocked: enteredUsd >= tier.at
			}));
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

	// cp425 — is the selected asset a goods asset (BARTER)? Barter's step 3
	// is the accepted-crypto picker (tick which cryptos to accept), not the
	// fiat/in-person payment methods, and it requires Terms.
	// cp425 — the cryptos a barter listing can accept as settlement: every
	// tradable asset EXCEPT goods themselves (no barter-for-barter). Stable
	// alphabetized list; the on-chain set is re-deduped/sorted by the indexer.
	const cryptoTickers: readonly AssetTicker[] = [...ASSET_TICKERS]
		.filter((t) => !isGoodsAsset(t))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

	function toggleAcceptedAsset(t: AssetTicker): void {
		acceptedAssets = acceptedAssets.includes(t)
			? acceptedAssets.filter((x) => x !== t)
			: [...acceptedAssets, t];
	}

	const step3Done = $derived(
		isBarter
			? acceptedAssets.length > 0
			: paymentMethods.length > 0 && paymentMethodsError === ''
	);

	// cp384 (#4) + cp425: Terms are REQUIRED when the deal is a barter — either
	// the legacy `barter_goods` PAYMENT METHOD on a crypto listing, OR a
	// first-class BARTER ASSET listing. A bare barter order with no terms is
	// useless to a counterparty: nobody knows what wares are on offer or wanted.
	const barterSelected = $derived(paymentMethods.includes('barter_goods'));
	const termsRequired = $derived(barterSelected || isBarter);
	const termsOkForBarter = $derived(!termsRequired || terms.trim().length >= 3);

	// Flash the Terms textarea border bright yellow 5× over ~5s every time a
	// barter deal becomes active (false → true) — either the barter_goods
	// PAYMENT METHOD is added (live on step 3, where the field is mounted) OR
	// the step-1 BARTER ASSET block is selected (the token bumps while step 3
	// is still gated closed; the flash then plays when the terms field mounts
	// on arrival, because ProtectedTextarea's flash effect fires on mount with
	// an already-nonzero token). Re-arms on each transition; the bumped token
	// makes ProtectedTextarea restart its border-flash animation.
	// `barterWasSelected` is a plain (non-reactive) latch so this effect only
	// fires on the transition, not on every unrelated re-render.
	let termsFlash = $state(0);
	let barterWasSelected = false;
	$effect(() => {
		const now = termsRequired;
		if (now && !barterWasSelected) {
			termsFlash += 1;
		}
		barterWasSelected = now;
	});

	// cp377 (F17): order terms soft cap.  TERMS_MAX mirrors the indexer's
	// authoritative `terms_too_long` rejection (>2048 in order.ts /
	// orderReplace.ts).  The textarea's hard `maxlength` is set higher
	// (TERMS_HARD_MAX) so the user CAN type past the soft cap and SEE the
	// over-limit warning (red counter + red border) rather than having
	// input silently truncated; the disabled Continue + the server check
	// are the real backstops.
	const TERMS_MAX = 2048;
	const TERMS_HARD_MAX = TERMS_MAX * 2;
	const termsOverLimit = $derived(terms.length > TERMS_MAX);
	// cp422: block submit if the terms contain a character the indexer
	// rejects (control / bidi / zero-width). Terms is multi-line markdown,
	// so TAB/LF/CR are permitted — see termsForbiddenChars.ts. Without this
	// gate the order broadcasts, pays its listing fee, and is then silently
	// dropped by the indexer (terms_forbidden_char) — a wasted, unrefundable
	// fee for an order that never appears.
	const termsForbidden = $derived(termsHasForbiddenChar(terms));

	const canReview = $derived(
		step1Done && step2Done && step3Done && !termsOverLimit && !termsForbidden && termsOkForBarter
	);

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
		// BLURT fee = a chain TRANSFER, which needs the active key.
		//
		// v1.8.14 (Ken) — this used to bail out with an error here, on the
		// reasoning "don't prompt for a password that can't succeed". That was
		// true when it was written and became false when `UnlockActiveKeyModal`
		// was added: a posting-only session CAN supply an Active key on the spot,
		// which is exactly what the modal is for, and what the fee-step copy has
		// been promising all along ("Morphit will ask for your Active key when
		// you post"). The stale guard fired first, so the promise was never kept
		// — Ken filled in a whole order, pressed Pay and Post, and got "The order
		// didn't go through" without ever being asked for anything.
		//
		// Fall through instead: `submitBroadcast()` below already opens the modal
		// when `!hasActiveKey && ephemeralActiveScalar === null`, and nothing has
		// been broadcast at that point, so the filled-in form is untouched behind
		// it. The key is used to sign and is never persisted.
		phase = 'awaiting_password';
		passwordError = '';
	}

	/** tt.txt #11 — paying the listing fee in BLURT is signed with the ACTIVE key.
	 *  A posting-only session has none on this device, so the radio used to carry
	 *  a red "you can't do this" note and nothing else. Now we unlock in place and
	 *  RESUME the broadcast: every field the user filled in stays exactly as it is.
	 *
	 *  The scalar lives only until `signCallback` has signed, then it's wiped. It
	 *  is never written to the keystore. */
	let ephemeralActiveScalar: Uint8Array | null = $state(null);
	let showUnlockForFee = $state(false);

	function wipeEphemeralActive(): void {
		if (ephemeralActiveScalar) {
			try {
				sodium.memzero(ephemeralActiveScalar);
			} catch {
				/* already zeroed */
			}
			ephemeralActiveScalar = null;
		}
	}

	onDestroy(wipeEphemeralActive);

	async function onFeeKeyUnlocked(scalar: Uint8Array): Promise<void> {
		ephemeralActiveScalar = scalar;
		showUnlockForFee = false;
		await submitBroadcast(); // resume exactly where the user left off
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
		const priceModel: Record<string, unknown> = isBarter
			? // cp425 — barter has no crypto-vs-fiat rate; the value is the
				// fiat amount range. Ship an inert, VALID model — spread 0%
				// (a 'fixed' price of 0 would fail the indexer's positive-price
				// check). The orderbook renders barter by its {min,max} value +
				// accepted cryptos, never by this model.
				{ kind: 'spread', percent: 0 }
			: priceModelKind === 'spread'
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
			// cp425 — a BARTER (goods/services) listing settles in crypto: its
			// payment_methods are the `pay_<crypto>` rails for the accepted
			// cryptos (so the orderbook's payment filter naturally shows which
			// coins it accepts), and the on-chain `acceptedAssets` set carries
			// the tickers. Crypto listings use the user-picked payment methods.
			paymentMethods: isBarter
				? acceptedAssets.map((a) => `pay_${a.toLowerCase()}`)
				: paymentMethods.map((pm) => redactPrivateKeys(pm)),
			acceptedAssets: isBarter && acceptedAssets.length > 0 ? acceptedAssets : undefined,
			// v1.9.0 (Ken) — the inline BARTER goods label. Only meaningful for a
			// barter listing; the builder + indexer re-sanitize (letters-only, ≤24)
			// and omit it when blank, so a crypto listing never carries it.
			specificBarterTitle: isBarter ? specificBarterTitle : undefined,
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
				// v1.7.0 "fastpostorder" — stage the order this browser just put on
				// chain, from the payload that was actually broadcast. The detail page
				// reads this, so "View my order" works instantly instead of hitting a
				// not-found for the ~45-63s the indexer needs to reach irreversibility.
				stagePostedOrder(result.payload);
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

		if (!hasActiveKey && ephemeralActiveScalar === null) {
			// Ask for the Active key before we prepare anything. Nothing has been
			// broadcast, nothing is lost; the form is untouched behind the modal.
			showUnlockForFee = true;
			phase = 'awaiting_password'; // awaiting a credential, nothing broadcast
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
				// A just-unlocked key signs once and is wiped immediately — the
				// keystore never sees it.
				if (ephemeralActiveScalar !== null) {
					const { signOrderWithFeeWithKey } = await import('$blurt/sign');
					try {
						return signOrderWithFeeWithKey(unsigned, ephemeralActiveScalar);
					} finally {
						wipeEphemeralActive();
					}
				}
				return useActiveKey(
					state.envelope,
					password,
					async (activePriv) => {
						const { signOrderWithFeeWithKey } = await import('$blurt/sign');
						return signOrderWithFeeWithKey(unsigned, activePriv);
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
				operatorBaseBlurt,
				resolveFeeRecipient(getInstanceSnapshot().fee_recipient)
			);
			// useActiveKey has wiped the scalar by now.
			successPermlink = result.permlink;
			// v1.7.0 "fastpostorder" — see the sibling branch above.
			stagePostedOrder(result.payload);
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
				if (/posting-only/i.test(msg)) {
					// Defense in depth: goToPasswordPrompt already gates this,
					// but if a posting-only session reaches useActiveKey it
					// throws a plain Error — classify it as such, not "chain
					// rejected" (nothing was broadcast).
					broadcastError = $_('post_order.broadcast_error.body_posting_only');
				} else if (
					// cp407 — the fee transfer's RECIPIENT (the treasury account)
					// isn't on-chain. This is the single most likely cause of a
					// well-funded BLURT-fee order failing (BTC/XMR fees pay the
					// treasury externally, so ONLY the BLURT path transfers to it,
					// so ONLY this path exposes a missing recipient). "does not
					// exist" ≠ the insufficient branch's "does not have", so no
					// overlap.
					/does not exist/i.test(msg) ||
					/unable to find account/i.test(msg) ||
					/unknown account/i.test(msg) ||
					/account.*not found/i.test(msg) ||
					/missing account/i.test(msg)
				) {
					broadcastError = $_('post_order.broadcast_error.body_recipient_missing');
				} else if (
					/insufficient/i.test(msg) ||
					/balance/i.test(msg) ||
					/enough/i.test(msg) ||
					/does not have/i.test(msg)
				) {
					broadcastError = $_('post_order.broadcast_error.body_insufficient_funds');
				} else if (
					// Blurt meters ops with a small fee taken from LIQUID BLURT
					// (an operation flat fee + a size-based bandwidth fee), NOT
					// with Steem/Hive-style Resource Credits. If the chain names
					// the fee/bandwidth component when an account can't cover it,
					// point the user at topping up liquid BLURT (we keep the RC
					// spellings too so a node that still uses the old wording is
					// caught, but the guidance is Blurt-correct).
					/resource credit/i.test(msg) ||
					/\bRC\b/.test(msg) ||
					/bandwidth/i.test(msg) ||
					/\bfee\b/i.test(msg) ||
					/manabar/i.test(msg)
				) {
					broadcastError = $_('post_order.broadcast_error.body_insufficient_rc');
				} else if (
					// cp407 — signature/authority mismatch: the Active key used
					// doesn't satisfy the account's on-chain active authority.
					/missing.*authority/i.test(msg) ||
					/required.*authority/i.test(msg) ||
					/signature/i.test(msg) ||
					/verify/i.test(msg)
				) {
					broadcastError = $_('post_order.broadcast_error.body_authority');
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
			counterAsset: fiat.trim().toUpperCase(),
			// Blank stays blank: '' must become null (an "any amount" listing),
			// never 0, which would read as a real bound of zero.
			amountMin: amountMin.trim() === '' ? null : Number(amountMin),
			amountMax: amountMax.trim() === '' ? null : Number(amountMax),
			// v1.9.0 (Ken) — the fields the redesigned announcement body mirrors from
			// the order detail page. Canonical method display names (no instance
			// lookup needed for the blog), the just-broadcast created time + derived
			// expiry, and the location/terms redacted with the SAME hook the on-chain
			// order uses so a stray WIF never lands in the public post either.
			paymentMethodNames: displayNamesForMethods([...paymentMethods]),
			createdAtIso: new Date().toISOString(),
			expiresAtIso: makeExpiryFlooredUtcDay(expiresDays).toISOString(),
			locationRegion: region.trim() ? redactPrivateKeys(region.trim()) : null,
			terms: terms.trim().length > 0 ? redactPrivateKeys(terms) : '',
			// v1.9.0 (Ken) — the barter goods label so the announcement headline reads
			// "…of bananas" like the order card/detail; null for crypto listings.
			specificBarterTitle: isBarter ? sanitizeBarterTitle(specificBarterTitle) : null,
			// t.txt #5 — the accepted crypto set, so a value-free barter blog title
			// reads "I want to sell {goods} for {cryptos}" — the SAME title the order
			// card and create-flow summary render. Null for crypto listings.
			acceptedAssets: isBarter && acceptedAssets.length > 0 ? [...acceptedAssets] : null
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
		fiatArr = [];
		amountMin = '';
		amountMax = '';
		priceModelKind = 'spread';
		spreadPercent = '0';
		fixedPrice = '';
		amountTouched = false;
		fixedPriceTouched = false;
		lastSeededFiat = '';
		paymentMethods = [];
		pmDraft = '';
		region = '';
		terms = '';
		specificBarterTitle = '';
		expiresDays = 90;
		syndicateToBlog = isOrderBlogDefaultEnabled();
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

	/** A live, plain-language recap of the order the user is composing,
	 *  shown just above the Notes field in the last step.  Assembled
	 *  from per-locale fragments (amount clause / price clause) slotted
	 *  into a side-specific template, so word order stays natural in
	 *  every locale — the template controls slot order, the fragments
	 *  carry the grammar.  Payment methods join via Intl.ListFormat
	 *  (locale-aware "A, B, or C") using the SAME display names the
	 *  picker shows (registry names, instance-addition names).  When no
	 *  method is picked yet the list shows a neutral "…" placeholder
	 *  that fills in as the user selects.  Empty until an asset exists
	 *  (the card only renders in step 3, where asset is already set). */
	// t.txt #5 (Ken) — build the BARTER summary sentence for a GIVEN goods label
	// via the SHARED orderTitleParts builder, so the create-flow summary is
	// word-for-word the order title (and the Blurt blog title, which just appends
	// "Want to trade?"). A valued barter reads "I want to sell 30–50 MXN of
	// {goods}"; a value-free one reads "I want to sell {goods} for {cryptos}" (the
	// accepted crypto set). Shared by the static summarySentence (goods = the
	// resolved title/label) and the editable step-3 preview (goods = a sentinel we
	// split on to slot in a live inline input). Reads the reactive
	// side/amount/fiat/accepted state directly. Assumes an asset is set.
	function barterTitleFor(goods: string): string {
		const minRaw = amountMin.trim();
		const maxRaw = amountMax.trim();
		const parts = orderTitleParts(
			{
				side: side ?? 'buy',
				asset: asset ?? '',
				fiat_currency: fiat.trim().toUpperCase(),
				amount_min: minRaw !== '' && Number.isFinite(Number(minRaw)) ? Number(minRaw) : null,
				amount_max: maxRaw !== '' && Number.isFinite(Number(maxRaw)) ? Number(maxRaw) : null,
				// value-free barter → "…for {cryptos}"; the '…' placeholder keeps the
				// sentence readable before any crypto is ticked.
				accepted_assets: acceptedAssets.length > 0 ? [...acceptedAssets] : ['…']
			},
			// show the amount as the user typed it (the orderbook applies its own
			// grouping formatter to the stored number; the WORDING is what must match)
			(n) => String(n),
			goods,
			{ locale: currentLang }
		);
		return $_(parts.key, { values: parts.values }) as string;

	}

	// A sentinel no user text can contain (letters + single spaces only; NUL can't
	// be typed) marks where the inline goods input goes. We render the title
	// sentence around it (see barterTitleFor).
	const BARTER_GOODS_SLOT = '\u0000BG\u0000';
	/** The editable BARTER sentence split into the text BEFORE and AFTER the inline
	 *  goods input. Null for non-barter (the plain summarySentence renders instead).
	 *  The template controls slot order per locale (e.g. zh puts {goods} after
	 *  {value}), so splitting the localized string is what keeps the input in the
	 *  grammatically-right spot in every language. */
	const barterSentenceParts = $derived.by((): { before: string; after: string } | null => {
		if (!isBarter || !asset) return null;
		const full = barterTitleFor(BARTER_GOODS_SLOT);
		const idx = full.indexOf(BARTER_GOODS_SLOT);
		if (idx < 0) return null;
		return { before: full.slice(0, idx), after: full.slice(idx + BARTER_GOODS_SLOT.length) };
	});

	const summarySentence = $derived.by((): string => {
		if (!asset) return '';
		const fiatCode = fiat.trim().toUpperCase();

		// cp425 — barter gets its own summary: goods/services valued in local
		// currency, settled in the accepted cryptos. No price-model or
		// payment-method language (both are crypto-trade concepts).
		if (isBarter) {
			// v1.9.0 (Ken) — the {goods} slot: the user's inline barter title if
			// they typed one, else the generic "goods/services" label. This STATIC
			// render (review + broadcast confirmation) uses the resolved text; the
			// editable step-3 preview swaps in a live inline input at this slot via
			// barterSentenceParts below.
			const goodsText =
				specificBarterTitle.trim() || ($_('order_title.goods_services') as string);
			return barterTitleFor(goodsText);
		}

		// v1.9.5 (Ken) — non-barter now uses the SAME sentence as the order title
		// and the Blurt blog (order_title.*): "I'm buying at least 50 MXN of ARRR
		// with BTC". Settlement is the accepted payment methods (resolved labels).
		// The price model (fixed/market) lives in its own form control, not this
		// one-line summary, so the summary reads verbatim like the title and blog.
		const minRaw = amountMin.trim();
		const maxRaw = amountMax.trim();
		const parts = orderTitleParts(
			{
				side: side ?? 'buy',
				asset: asset ?? '',
				fiat_currency: fiatCode,
				amount_min: minRaw !== '' && Number.isFinite(Number(minRaw)) ? Number(minRaw) : null,
				amount_max: maxRaw !== '' && Number.isFinite(Number(maxRaw)) ? Number(maxRaw) : null,
				// '…' placeholder keeps the sentence readable before any method is ticked
				payment_methods: paymentMethods.length > 0 ? [...paymentMethods] : ['…']
			},
			(n) => String(n),
			undefined,
			{
				methodDisplay: (m) =>
					displayNamesForMethods(m, (key) => $instanceAdditions.find((e) => e.key === key)?.name),
				locale: currentLang
			}
		);
		return $_(parts.key, { values: parts.values }) as string;
	});
</script>

<Head routeKey="post_order" noindex />

<div class="mx-auto max-w-3xl px-4 py-10 md:py-14">
	<RequireLiveSession />

	<!-- cp407 — shared extras rendered inside every order-SUMMARY card (step 4
	     review + the awaiting-password / broadcasting / error cards): a live
	     preview of the markdown-rendered terms exactly as they'll appear on the
	     posted order, plus the chosen listing-expiry. Terms block only when the
	     user actually wrote terms; the expiry line always shows. -->
	{#snippet orderSummaryExtras()}
		{#if terms.trim().length > 0}
			<div
				class="mt-3 border-t border-morphit-emerald/20 pt-3 text-sm text-ink-800 dark:text-ink-100"
			>
				<TermsText text={terms} />
			</div>
		{/if}
		<p class="mt-3 text-xs text-ink-500 dark:text-ink-400">
			{$_('post_order.form.expires_label')}: {$_(`post_order.form.expires_${expiresDays}d`)}
		</p>
	{/snippet}
	<header class="mb-8">
		<h1 class="font-display text-3xl font-extrabold">
			<span class="brand-gradient-text">{$_('post_order.heading')}</span>
		</h1>
		{#if !isFirstTrade && phase === 'editing'}
			<!-- The "tell traders what you want…" lead only makes sense while
			     the user is still composing/reviewing.  On the sign / posting /
			     error phases the order is already written, so we drop the lead
			     and instead surface the order summary (below) so the user can
			     see exactly what they're signing. -->
			<p class="mt-2 text-ink-700 dark:text-ink-200">
				{$_('post_order.subtitle')}
			</p>
		{/if}
	</header>

	<!-- Order summary on the sign / posting / error phases.  Editing and
	     reviewing render their own inline summaries; here we keep the same
	     📝 card pinned directly under the header so the user always sees what
	     they're about to sign (or what failed) — never a bare password box. -->
	{#if summarySentence && (phase === 'awaiting_password' || phase === 'broadcasting' || phase === 'error')}
		<div
			class="mb-6 rounded-xl border-2 border-morphit-emerald/40 bg-morphit-emerald/5 p-3"
			role="status"
			aria-live="polite"
		>
			<p class="text-sm text-ink-800 dark:text-ink-100">
				<span aria-hidden="true">📝</span>
				{summarySentence}
			</p>
			{@render orderSummaryExtras()}
		</div>
	{/if}

	<!-- Tier 2.5 (Part 93): green-tinted starter-pack helper for
	     first-time posters.  Detects (no orders on record →
	     plausibly first post), surfaces three safe-defaults
	     tips, and pre-flips the expiry default from 90 days to
	     7 days via the onFirstTimeStatus callback.  Per-session
	     dismissable.  Self-hides for experienced posters. -->
	{#if phase === 'editing'}
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
	{/if}

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
					{$_('common.unlock')}
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
					class="flex-none rounded-lg border border-ink-300 bg-white px-3 py-1.5 text-xs font-semibold text-ink-700 transition hover:border-red-500 hover:bg-red-50 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:border-ink-600 dark:bg-ink-900 dark:text-ink-200 dark:hover:bg-red-500/10"
					onclick={discardDraft}
				>
					{$_('post_order.draft.discard')}
				</button>
			</section>
		{/if}

		<!-- Step 1 -->
		<section class="card mb-4" aria-labelledby="step1-heading">
			<div class="mb-4 flex items-baseline justify-between gap-3">
				<h2 id="step1-heading" class="font-display text-lg font-bold">
					{#if isFirstTrade}{$_('post_order.form.step_1_heading_first')}{:else}{$_(
							'post_order.form.step_1_heading'
						)}{/if}
				</h2>
				<span class="shrink-0 text-xs font-medium text-ink-400 dark:text-ink-500">
					{$_('post_order.form.step_counter', { values: { n: 1, total: 4 } })}
				</span>
			</div>
			{#if isFirstTrade}
				<!-- O#1 (cp295): first-trade lock. The only useful thing a
				     brand-new account can do is BUY BLURT to fund itself
				     (BLURT pays listing fees), so the buy/sell + asset picker
				     is replaced by a fixed, explained "Buy BLURT" card and the
				     side is held to buy / asset to BLURT in the script. -->
				<div class="rounded-xl border-2 border-morphit-emerald/40 bg-morphit-emerald/5 p-4">
					<p class="flex items-center gap-2 font-display text-base font-bold text-morphit-emerald">
						<span aria-hidden="true">🌱</span>
						{$_('post_order.form.first_trade_title')}
					</p>
					<p class="mt-2 text-sm text-ink-700 dark:text-ink-200">
						{$_('post_order.form.first_trade_body')}
					</p>
				</div>
			{:else}
				<div class="grid gap-3 sm:grid-cols-2">
					<button
						type="button"
						onclick={() => (side = 'buy')}
						class="rounded-xl border-2 px-4 py-3 text-left transition active:scale-[0.98] {side ===
						'buy'
							? 'border-morphit-emerald bg-emerald-50 dark:bg-ink-800'
							: 'border-ink-200 hover:border-morphit-emerald/50 hover:bg-emerald-50/40 dark:border-ink-700 dark:hover:border-morphit-emerald/40 dark:hover:bg-morphit-emerald/[0.06]'}"
					>
						<span class="font-semibold">{$_('post_order.form.side_buy')}</span>
					</button>
					<button
						type="button"
						onclick={() => (side = 'sell')}
						class="rounded-xl border-2 px-4 py-3 text-left transition active:scale-[0.98] {side ===
						'sell'
							? 'border-morphit-emerald bg-emerald-50 dark:bg-ink-800'
							: 'border-ink-200 hover:border-morphit-emerald/50 hover:bg-emerald-50/40 dark:border-ink-700 dark:hover:border-morphit-emerald/40 dark:hover:bg-morphit-emerald/[0.06]'}"
					>
						<span class="font-semibold">{$_('post_order.form.side_sell')}</span>
					</button>
				</div>
			{/if}
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
				{#each assetPickerItems as item (item.ticker)}
					{@const a = item.ticker}
					{@const disabled = feeMethodChoice === 'waived_first_buy' && a !== 'BLURT'}
					<Tooltip textKey={item.explainerKey} faqKey={item.faqKey} hoverOpenDelayMs={1000}>
						{#snippet trigger()}
							<button
								type="button"
								{disabled}
								title={disabled
									? ($_('post_order.form.waiver_asset_locked_title') as string)
									: ''}
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
								class="flex items-center gap-2 rounded-xl border-2 px-4 py-2 transition active:scale-[0.98] {asset ===
								a
									? 'border-morphit-emerald bg-emerald-50 dark:bg-ink-800'
									: 'border-ink-200 dark:border-ink-700'} {disabled
									? 'cursor-not-allowed opacity-40'
									: asset === a
										? ''
										: 'hover:border-morphit-emerald/50 hover:bg-emerald-50/40 dark:hover:border-morphit-emerald/40 dark:hover:bg-morphit-emerald/[0.06]'}"
							>
								<img
									src={item.iconPath}
									alt=""
									aria-hidden="true"
									width="20"
									height="20"
									class="h-5 w-5 flex-none"
								/>
								<span class="font-mono font-semibold">{a}</span>
							</button>
						{/snippet}
					</Tooltip>
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
					{#await loadUsdtNetworkPicker() then UsdtNetworkPicker}
						<UsdtNetworkPicker bind:network={usdtNetwork} />
					{:catch}
						<LazyLoadError />
					{/await}
				</div>
			{/if}
			{#if asset === 'USDC'}
				<PrivacyWarningChip privacyWarningKey="usdc_centralized" />
				<!-- Same network-picker contract as USDT — required
				     pre-submit gate.  Three of USDC's four networks
				     share the EVM 0x address format, so the picker
				     is the only thing disambiguating which chain. -->
				<div class="mt-3">
					{#await loadUsdcNetworkPicker() then UsdcNetworkPicker}
						<UsdcNetworkPicker bind:network={usdcNetwork} />
					{:catch}
						<LazyLoadError />
					{/await}
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
					{#await loadDaiNetworkPicker() then DaiNetworkPicker}
						<DaiNetworkPicker bind:network={daiNetwork} />
					{:catch}
						<LazyLoadError />
					{/await}
				</div>
			{/if}
		</section>

		<!-- Step 2 (only appears after step 1 answered) -->
		{#if step1Done}
			<section class="card mb-4 animate-fade-up" aria-labelledby="step2-heading">
				<div class="mb-4 flex items-baseline justify-between gap-3">
					<h2 id="step2-heading" class="font-display text-lg font-bold">
						{$_('post_order.form.step_2_heading')}
					</h2>
					<span class="shrink-0 text-xs font-medium text-ink-400 dark:text-ink-500">
						{$_('post_order.form.step_counter', { values: { n: 2, total: 4 } })}
					</span>
				</div>

				<div class="mb-4">
					<span class="mb-1 block text-sm font-semibold">
						{$_(side === 'sell' ? 'post_order.form.fiat_label_sell' : 'post_order.form.fiat_label')}
					</span>
					{#await loadFiatCurrencySelect() then FiatCurrencySelect}
						<FiatCurrencySelect
							single
							bind:value={fiatArr}
							invalid={!!fiatError}
							describedById={fiatError ? 'fiat-error' : undefined}
						/>
					{:catch}
						<LazyLoadError />
					{/await}
					{#if fiatError}
						<StatusLine kind="warn" id="fiat-error">{fiatError}</StatusLine>
					{:else if fiat === ''}
						<p class="mt-1 text-xs text-ink-500 dark:text-ink-400">
							{$_('post_order.form.fiat_required_hint')}
						</p>
					{/if}
					{#if feeMethodChoice === 'waived_first_buy'}
						<p class="mt-2 text-xs text-ink-600 dark:text-ink-300">
							{$_('post_order.form.waiver_fiat_hint')}
						</p>
					{/if}
				</div>

				<div class="grid gap-4 sm:grid-cols-2">
					<label class="block">
						<span class="mb-1 block text-sm font-semibold">
							{fiat
								? $_('post_order.form.amount_min_label_in_fiat', { values: { fiat } })
								: $_('post_order.form.amount_min_label')}
						</span>
						<input
							type="text"
							inputmode="decimal"
							maxlength="16"
							id="post-amount-min"
							name="amount_min"
							value={amountMin}
							oninput={handleAmountMinInput}
							aria-invalid={amountTouched && amountMinHasError}
							aria-describedby={amountTouched && amountError ? 'amount-error' : undefined}
							class="w-full rounded-xl border {amountTouched && amountMinHasError
								? 'border-red-500 focus:ring-2 focus:ring-red-500 dark:border-red-500'
								: 'border-ink-200 dark:border-ink-700'} bg-white px-3 py-2 focus:outline-none dark:bg-ink-900"
						/>
						{#if firstOrderMinHint}
							<span class="mt-1 block text-xs text-ink-500 dark:text-ink-400">
								{firstOrderMinHint}
							</span>
						{:else if returningMinHint}
							<span class="mt-1 block text-xs text-ink-500 dark:text-ink-400">
								{returningMinHint}
							</span>
						{:else}
							<span class="mt-1 block text-xs text-ink-500 dark:text-ink-400">
								{$_('post_order.form.amount_optional_hint')}
							</span>
						{/if}
					</label>
					<label class="block">
						<span class="mb-1 block text-sm font-semibold">
							{fiat
								? $_('post_order.form.amount_max_label_in_fiat', { values: { fiat } })
								: $_('post_order.form.amount_max_label')}
						</span>
						<input
							type="text"
							inputmode="decimal"
							maxlength="16"
							id="post-amount-max"
							name="amount_max"
							value={amountMax}
							oninput={handleAmountMaxInput}
							aria-invalid={amountTouched && amountMaxHasError}
							aria-describedby={amountTouched && amountError ? 'amount-error' : undefined}
							class="w-full rounded-xl border {amountTouched && amountMaxHasError
								? 'border-red-500 focus:ring-2 focus:ring-red-500 dark:border-red-500'
								: 'border-ink-200 dark:border-ink-700'} bg-white px-3 py-2 focus:outline-none dark:bg-ink-900"
						/>
						<span class="mt-1 block text-xs text-ink-500 dark:text-ink-400">
							{$_('post_order.form.amount_optional_hint')}
						</span>
					</label>
				</div>

				<!-- cp396: amount min/max validation surfaces HERE, directly
				     under the amount fields and ABOVE the Price section, in
				     themed red (kind="error"). The min>max swap prompt belongs
				     next to the fields it's about, not buried below Price. -->
				{#if amountTouched && amountError}
					<StatusLine kind="error" id="amount-error">{amountError}</StatusLine>
				{/if}

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
				{#if !isBarter}
				<!-- cp425 — the spread/fixed price-model controls price a CRYPTO
				     against fiat; a BARTER (goods/services) listing is valued
				     directly in local currency (the amount above), so hide them. -->
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
											type="text"
											inputmode="decimal"
											maxlength="6"
											id="post-spread-percent"
											name="spread_percent"
											value={spreadPercent}
											oninput={handleSpreadInput}
											aria-invalid={!!priceModelError}
											aria-describedby={priceModelError ? 'price-model-error' : undefined}
											class="w-24 rounded-lg border {priceModelError
												? 'border-red-500 focus:ring-2 focus:ring-red-500 dark:border-red-500'
												: 'border-ink-200 dark:border-ink-700'} bg-white px-2 py-1 text-sm focus:outline-none dark:bg-ink-900"
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
											type="text"
											inputmode="decimal"
											maxlength="16"
											id="post-fixed-price"
											name="fixed_price"
											value={fixedPrice}
											oninput={handleFixedPriceInput}
											aria-invalid={fixedPriceTouched && !!priceModelError}
											aria-describedby={fixedPriceTouched && priceModelError
												? 'fixed-price-error'
												: undefined}
											class="w-32 rounded-lg border {fixedPriceTouched && priceModelError
												? 'border-red-500 focus:ring-2 focus:ring-red-500 dark:border-red-500'
												: 'border-ink-200 dark:border-ink-700'} bg-white px-2 py-1 text-sm focus:outline-none dark:bg-ink-900"
											placeholder={$_('post_order.form.price_model_fixed_placeholder') as string}
											aria-label={$_('post_order.form.price_model_fixed_aria') as string}
										/>
										<span class="text-sm text-ink-600 dark:text-ink-300">
											{fiat || $_('post_order.form.price_model_fiat_placeholder')}
										</span>
									</div>
									{#if fixedPriceTouched && priceModelError}
										<StatusLine kind="warn" id="fixed-price-error">{priceModelError}</StatusLine>
									{/if}
								{/if}
							</div>
						</label>
					</div>
				</fieldset>
				{/if}

				{#if feeMethodChoice === 'waived_first_buy'}
					<!-- First-buy benefits ladder (Q10 follow-up).  Rather
					     than expose the $1 floor as a "minimum"
					     constraint (which feels like a tax), we show the
					     user what they GET at increasing buy sizes.  The
					     current amount lights up the row that bracket
					     contains it; rows above show as "you'll also
					     unlock if you increase".  Pure presentation —
					     the indexer keeps enforcing the $1 USD-equivalent
					     floor silently.  Users who type below $1 see the
					     amountError validator surface a generic message,
					     not a "minimum $1" callout. -->
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
									<span dir="auto">{row.text}</span>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
			</section>
		{/if}

		<!-- Step 3 -->
		{#if step1Done && step2Done}
			<section class="card mb-4 animate-fade-up" aria-labelledby="step3-heading">
				<div class="mb-4 flex items-baseline justify-between gap-3">
					<h2 id="step3-heading" class="font-display text-lg font-bold">
						{$_(side === 'sell' ? 'post_order.form.step_3_heading_sell' : 'post_order.form.step_3_heading')}
					</h2>
					<span class="shrink-0 text-xs font-medium text-ink-400 dark:text-ink-500">
						{$_('post_order.form.step_counter', { values: { n: 3, total: 4 } })}
					</span>
				</div>

				<div class="mb-4">
					{#if isBarter}
						<p class="mb-1 text-sm font-semibold">{$_('post_order.form.barter_accept_label')}</p>
						<p class="mb-2 text-xs text-ink-500">{$_('post_order.form.barter_accept_hint')}</p>
						<div class="flex flex-wrap gap-2" role="group" aria-label={$_('post_order.form.barter_accept_label')}>
							{#each cryptoTickers as t (t)}
								{@const sel = acceptedAssets.includes(t)}
								<button
									type="button"
									onclick={() => toggleAcceptedAsset(t)}
									aria-pressed={sel}
									class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors {sel
										? 'border-morphit-emerald bg-morphit-emerald/10 text-morphit-emerald hover:bg-morphit-emerald/20'
										: 'border-ink-200 text-ink-600 hover:border-ink-300 hover:bg-ink-50 dark:border-ink-700 dark:text-ink-300 dark:hover:border-ink-600 dark:hover:bg-ink-800/60'}"
								>
									<img src={`/icons/icon-${t.toLowerCase()}.svg`} alt="" class="h-4 w-4" />
									{t}
								</button>
							{/each}
						</div>
					{:else}
						<p class="mb-1 text-sm font-semibold">{$_(side === 'sell' ? 'post_order.form.payment_methods_label_sell' : 'post_order.form.payment_methods_label')}</p>
						<p class="mb-2 text-xs text-ink-500">{$_('post_order.form.payment_methods_hint')}</p>
						{#await loadPaymentMethodsPicker() then PaymentMethodsPicker}
							<PaymentMethodsPicker
								bind:selected={paymentMethods}
								excludeForAsset={asset ?? undefined}
								instanceAdditions={$instanceAdditions}
								invalid={!!paymentMethodsError}
								describedById="payment-methods-error"
								firstTrade={isFirstTrade}
							/>
						{:catch}
							<LazyLoadError />
						{/await}
						{#if paymentMethodsError}
							<StatusLine kind="warn" id="payment-methods-error">{paymentMethodsError}</StatusLine>
						{/if}
					{/if}
				</div>

				<label class="mb-4 block">
					<span class="mb-1 block text-sm font-semibold">{$_('post_order.form.region_label')}</span>
					<input
						type="text"
						id="post-region"
						name="region"
						bind:value={region}
						dir="auto"
						maxlength="128"
						autocomplete="off"
						class="w-full rounded-xl border border-ink-200 bg-white px-3 py-2 focus:outline-none dark:border-ink-700 dark:bg-ink-900"
						placeholder={regionPlaceholder}
					/>
					<p class="mt-1 text-xs text-ink-500">{$_('post_order.form.region_hint')}</p>
				</label>

				{#if isBarter && barterSentenceParts}
					<!-- v1.9.0 (Ken) — the editable BARTER preview: "goods/services" is a
					     live inline fill-in-the-blank. The user types WHAT they're offering
					     (letters-only, ≤24) and it flows into the order title + the Blurt
					     announcement. `size` (in ch) grows the field with its content so the
					     sentence tail is pushed right and, on a narrow phone, wraps to the
					     next line instead of overflowing — the whole <p> flows and wraps. -->
					<div
						class="mb-4 rounded-xl border-2 border-morphit-emerald/40 bg-morphit-emerald/5 p-3"
						role="status"
						aria-live="polite"
					>
						<p class="text-sm leading-relaxed text-ink-800 dark:text-ink-100">
							<span aria-hidden="true">📝</span>
							{barterSentenceParts.before}<input
								type="text"
								inputmode="text"
								autocomplete="off"
								autocapitalize="none"
								spellcheck="false"
								class="barter-goods-field"
								class:filled={specificBarterTitle.length > 0}
								maxlength={SPECIFIC_BARTER_TITLE_MAX}
								size={Math.max(
									specificBarterTitle.length,
									($_('order_title.goods_services') as string).length
								)}
								placeholder={$_('order_title.goods_services') as string}
								aria-label={$_('order_title.goods_services') as string}
								bind:value={specificBarterTitle}
								oninput={(e) =>
									(specificBarterTitle = sanitizeBarterTitle(
										(e.currentTarget as HTMLInputElement).value
									))}
							/>{barterSentenceParts.after}
						</p>
					</div>
				{:else if summarySentence}
					<div
						class="mb-4 rounded-xl border-2 border-morphit-emerald/40 bg-morphit-emerald/5 p-3"
						role="status"
						aria-live="polite"
					>
						<p class="text-sm text-ink-800 dark:text-ink-100">
							<span aria-hidden="true">📝</span>
							{summarySentence}
						</p>
					</div>
				{/if}

				<label class="mb-4 block">
					<span class="mb-1 flex items-center justify-between gap-2 text-sm font-semibold">
					<span>{$_('post_order.form.terms_label')}</span>
					<!-- t.txt #2 — subdued markdown-guide icon over the field's top-right
					     corner. preventDefault stops the wrapping <label> from stealing
					     focus to the textarea.
					     cp474 (t.txt #11) — the tooltip is state-driven, not
					     `group-hover:block`. CSS hover could only be undone by moving the
					     pointer, and this tooltip covers the textarea it sits above, so
					     while you typed it just sat there over your text (browsers hide
					     the cursor and don't re-evaluate :hover until the pointer moves).
					     Typing now dismisses it — see `mdTipOpen`. Pointer AND keyboard
					     both open it; Escape closes it without moving the mouse. -->
					<button
						type="button"
						class="relative inline-flex text-ink-400 transition-colors hover:text-morphit-emerald focus:outline-none focus-visible:text-morphit-emerald"
						aria-label={$_('post_order.terms_md_guide.tooltip_title') as string}
						onmouseenter={() => (mdTipOpen = true)}
						onmouseleave={() => (mdTipOpen = false)}
						onfocus={() => (mdTipOpen = true)}
						onblur={() => (mdTipOpen = false)}
						onkeydown={(e) => {
							if (e.key === 'Escape') mdTipOpen = false;
						}}
						onclick={(e) => {
							e.preventDefault();
							e.stopPropagation();
							// The modal supersedes the tooltip — leaving it up would strand it
							// behind the dialog with no pointer left to un-hover it.
							mdTipOpen = false;
							mdGuideOpen = true;
						}}
					>
						<svg class="h-4 w-6" viewBox="0 0 208 128" fill="none" aria-hidden="true">
							<rect
								x="5"
								y="5"
								width="198"
								height="118"
								rx="12"
								stroke="currentColor"
								stroke-width="12"
							/>
							<path
								fill="currentColor"
								d="M30 98V30h20l20 25 20-25h20v68H90V59L70 84 50 59v39zm132 0-30-33h20V30h20v35h20z"
							/>
						</svg>
						{#if mdTipOpen}
						<span
							class="pointer-events-none absolute end-0 top-6 z-10 block w-56 rounded-lg bg-ink-900 p-2 text-start text-xs font-normal text-white shadow-lg dark:bg-ink-700"
							role="tooltip"
						>
							<span class="block font-semibold"
								>{$_('post_order.terms_md_guide.tooltip_title')}</span
							>
							<span class="mt-0.5 block text-ink-300"
								>{$_('post_order.terms_md_guide.tooltip_body')}</span
							>
						</span>
						{/if}
					</button>
				</span>
					<ProtectedTextarea
						bind:value={terms}
						name="order-terms"
						onDetect={handleTermsKeyDetect}
						rows={3}
						maxlength={TERMS_HARD_MAX}
						counterLimit={TERMS_MAX}
						flashToken={termsFlash}
						showCounter
						counterAlwaysVisible
						placeholder={termsPlaceholder}
					/>
					<span class="mt-1.5 block text-xs text-ink-500 dark:text-ink-400">
						{$_('post_order.form.terms_markdown_hint')}
					</span>
				</label>
				{#if termsForbidden}
					<p class="-mt-3 mb-4 text-sm text-red-700 dark:text-red-300" role="alert">
						{$_('post_order.form.terms_forbidden_char')}
					</p>
				{/if}

				<label class="block">
					<span class="mb-1 block text-sm font-semibold">{$_('post_order.form.expires_label')}</span
					>
					<select
						id="post-expires-days"
						name="expires_days"
						bind:value={expiresDays}
						disabled={isFirstTrade}
						class="w-full rounded-xl border border-ink-200 bg-white px-3 py-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-ink-700 dark:bg-ink-900"
					>
						<option value={1}>{$_('post_order.form.expires_1d')}</option>
						<option value={3}>{$_('post_order.form.expires_3d')}</option>
						<option value={7}>{$_('post_order.form.expires_7d')}</option>
						<option value={14}>{$_('post_order.form.expires_14d')}</option>
						<option value={30}>{$_('post_order.form.expires_30d')}</option>
						<option value={60}>{$_('post_order.form.expires_60d')}</option>
						<option value={90}>{$_('post_order.form.expires_90d')}</option>
					</select>
					{#if isFirstTrade}
						<p class="mt-1 text-xs text-ink-500">{$_('post_order.form.first_trade_expiry_note')}</p>
					{/if}
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
					class="mt-6 flex items-start gap-3 rounded-xl border-2 border-morphit-emerald/30 bg-morphit-emerald/5 p-4 dark:border-morphit-emerald/40"
				>
					<input
						type="checkbox"
						id="post-syndicate"
						name="syndicate"
						bind:checked={syndicateToBlog}
						class="mt-0.5 h-4 w-4 flex-none accent-morphit-emerald"
					/>
					<div class="min-w-0">
						<p class="flex items-center gap-2 font-semibold text-morphit-emerald">
							<span aria-hidden="true">📣</span>
							{$_('syndicate.opt_in_label')}
						</p>
						<p class="mt-2 text-sm text-ink-700 dark:text-ink-200">
							{$_('syndicate.opt_in_pitch')}
						</p>
					</div>
				</label>
				{#if isFirstTrade && !hasFiredFirstTrade(blurtAccount)}
					<!-- First-trade announcement opt-in (phase 1 only). Shown ONLY during the
					     genuine first-buy (isFirstTrade = waiver-eligible welcome-bonus path),
					     so it never reappears on a 2nd+ trade. Arms the one-time @morphit-community
					     post (blurt-176570) that fires when the user later leaves feedback on this
					     trade; default off, spent after the first trade. Distinct from the per-order
					     blog post above. The community post celebrates a NEW trader's first BUY so
					     curators can find + upvote it. -->
					<label
						class="mt-4 flex items-start gap-3 rounded-xl border-2 border-morphit-emerald/30 bg-morphit-emerald/5 p-4 dark:border-morphit-emerald/40"
					>
						<input
							type="checkbox"
							id="post-first-trade-announce"
							name="first-trade-announce"
							checked={$firstTradeAnnounce}
							onchange={(e) => setFirstTradeAnnounce(e.currentTarget.checked)}
							class="mt-0.5 h-4 w-4 flex-none accent-morphit-emerald"
						/>
						<div class="min-w-0">
							<p class="flex items-center gap-2 font-semibold text-morphit-emerald">
								<span aria-hidden="true">🎉</span>
								{$_('syndicate.first_trade_opt_in_label')}
							</p>
							<p class="mt-2 text-sm text-ink-700 dark:text-ink-200">
								{$_('syndicate.first_trade_opt_in_pitch')}
							</p>
							<p class="mt-2 text-xs text-ink-600 dark:text-ink-300">
								{$_('syndicate.first_trade_opt_in_help')}
							</p>
						</div>
					</label>
				{/if}
			</section>

			<!-- Continue to review -->
			<div class="mt-6 flex justify-end">
				<BusyButton variant="primary" disabled={!canReview} onclick={goToReview}>
					{$_('common.continue')}
				</BusyButton>
			</div>
		{/if}

		<!-- cp368: when step 1 is complete but step 2 isn't yet valid,
		     Step 3 + the Continue button are intentionally hidden
		     (progressive disclosure). Without a cue that's a silent
		     dead-end — the user can't see that finishing the fields
		     above unlocks the rest. Show a neutral nudge (never red). -->
		{#if step1Done && !step2Done}
			<p class="mt-6 text-center text-sm text-ink-500 dark:text-ink-400">
				{$_('post_order.form.continue_locked_hint')}
			</p>
		{/if}
	{:else if phase === 'reviewing'}
		<!-- Review: fee + summary + post button. -->

		{#if summarySentence}
			<div
				class="mb-4 rounded-xl border-2 border-morphit-emerald/40 bg-morphit-emerald/5 p-3"
				role="status"
				aria-live="polite"
			>
				<p class="text-sm text-ink-800 dark:text-ink-100">
					<span aria-hidden="true">📝</span>
					{summarySentence}
				</p>
				{@render orderSummaryExtras()}
			</div>
		{/if}

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
						<div class="flex items-baseline justify-between gap-3">
							<h2 id="waiver-heading" class="font-display text-lg font-bold">
								{$_('post_order.waiver.heading')}
							</h2>
							<span class="shrink-0 text-xs font-medium text-ink-400 dark:text-ink-500">
								{$_('post_order.form.step_counter', { values: { n: 4, total: 4 } })}
							</span>
						</div>
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
							{#if asset !== 'BLURT'}
								<label class="flex items-start gap-2 py-1" class:opacity-60={!hasActiveKey}>
									<input
										type="radio"
										name="fee-method"
										value="blurt"
										bind:group={feeMethodChoice}
										disabled={!hasActiveKey}
										class="mt-0.5 accent-morphit-emerald"
									/>
									<span class="text-sm">
										<span class="font-semibold">{$_('post_order.fee_method.blurt_label')}</span>
										<span class="block text-xs text-ink-500">
											{$_('post_order.fee_method.blurt_hint')}
										</span>
										{#if !hasActiveKey}
											<span class="mt-1 block text-xs text-red-600 dark:text-red-400">
												{$_('post_order.fee_method.blurt_needs_active_key')}
											</span>
										{/if}
									</span>
								</label>
							{/if}
							{#if asset !== 'BTC'}
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
							{/if}
							{#if asset !== 'XMR'}
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
							{/if}
						</fieldset>
					</div>
				</div>
			</section>
		{/if}

		{#if !waiverOffered}
			<section class="card mb-4" aria-labelledby="fee-method-heading">
				<div class="mb-4 flex items-baseline justify-between gap-3">
					<h2 id="fee-method-heading" class="font-display text-lg font-bold">
						{$_('post_order.fee_method.legend')}
					</h2>
					<span class="shrink-0 text-xs font-medium text-ink-400 dark:text-ink-500">
						{$_('post_order.form.step_counter', { values: { n: 4, total: 4 } })}
					</span>
				</div>
				<fieldset>
					<legend class="sr-only">{$_('post_order.fee_method.legend')}</legend>
					<label class="flex items-start gap-2 py-1" class:opacity-60={!hasActiveKey}>
						<input
							type="radio"
							name="fee-method"
							value="blurt"
							bind:group={feeMethodChoice}
							disabled={!hasActiveKey}
							class="mt-0.5 accent-morphit-emerald"
						/>
						<span class="text-sm">
							<span class="font-semibold">{$_('post_order.fee_method.blurt_label')}</span>
							<span class="block text-xs text-ink-500">
								{$_('post_order.fee_method.blurt_hint')}
							</span>
							{#if !hasActiveKey}
								<span class="mt-1 block text-xs text-red-600 dark:text-red-400">
									{$_('post_order.fee_method.blurt_needs_active_key')}
								</span>
							{/if}
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
				<ListingFeeAddressPanel
					method={feeMethodChoice}
					liveSatoshis={feeMethodChoice === 'btc' ? btcFeeSatoshisLive : undefined}
					livePiconero={feeMethodChoice === 'xmr' ? xmrFeePiconeroLive : undefined}
					feeFiat={feeMethodChoice === 'btc' ? btcFeeFiat : xmrFeeFiat}
					{denominationFiat}
				/>
			{:catch}
				<LazyLoadError />
			{/await}

			<section class="card mb-4" aria-labelledby="txid-heading">
				<div class="mb-3 flex items-center gap-2">
					<h2 id="txid-heading" class="font-display text-lg font-bold">
						{$_('post_order.fee_method.txid_label')}
					</h2>
					<Tooltip
						textKey="post_order.fee_method.txid_tooltip"
						faqKey="what_is_a_txid"
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
					maxlength="128"
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
				<p
					class="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
				>
					{$_('post_order.fee_method.tx_proof_privacy_note')}
				</p>

				<!-- Per-wallet "How to generate your proof"
				     instructions.  Inline expandable so the user
				     doesn't have to leave the page (grandma-friendly:
				     no required external doc lookup).  Default
				     collapsed to keep the page short for users who
				     already know the flow. -->
				<details
					class="mb-3 rounded-lg border border-ink-200 bg-ink-50 dark:border-ink-700 dark:bg-ink-900"
				>
					<summary class="cursor-pointer select-none px-3 py-2 text-sm font-semibold">
						{$_('post_order.fee_method.tx_proof_how_to_label')}
					</summary>
					<div
						class="space-y-3 border-t border-ink-200 px-3 py-3 text-xs text-ink-700 dark:border-ink-700 dark:text-ink-300"
					>
						<div>
							<div class="font-semibold">
								{$_('post_order.fee_method.tx_proof_how_to_cli_heading')}
							</div>
							<div class="mt-1">{$_('post_order.fee_method.tx_proof_how_to_cli_body')}</div>
						</div>
						<div>
							<div class="font-semibold">
								{$_('post_order.fee_method.tx_proof_how_to_gui_heading')}
							</div>
							<div class="mt-1">{$_('post_order.fee_method.tx_proof_how_to_gui_body')}</div>
						</div>
						<div>
							<div class="font-semibold">
								{$_('post_order.fee_method.tx_proof_how_to_cake_heading')}
							</div>
							<div class="mt-1">{$_('post_order.fee_method.tx_proof_how_to_cake_body')}</div>
						</div>
						<div>
							<div class="font-semibold">
								{$_('post_order.fee_method.tx_proof_how_to_feather_heading')}
							</div>
							<div class="mt-1">{$_('post_order.fee_method.tx_proof_how_to_feather_body')}</div>
						</div>
						<div>
							<div class="font-semibold">
								{$_('post_order.fee_method.tx_proof_how_to_other_heading')}
							</div>
							<div class="mt-1">{$_('post_order.fee_method.tx_proof_how_to_other_body')}</div>
						</div>
					</div>
				</details>

				<textarea
					dir="auto"
					id="tx-proof"
					rows="4"
					autocomplete="off"
					autocapitalize="none"
					spellcheck="false"
					bind:value={txProof}
					maxlength="1000"
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
					{#if feeFiatEcho !== null}
						<p class="mt-1 text-right text-xs text-ink-500">
							(≈&nbsp;{feeFiatEcho})
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
			<BusyButton variant="link" onclick={backToEditing}>
				<span class="nav-arrow nav-arrow-left" aria-hidden="true">⇦</span>
				{$_('common.back')}
			</BusyButton>
			<BusyButton
				variant="primary"
				disabled={(feeMethodChoice === 'blurt' && !feeQuote) ||
					(feeMethodChoice === 'btc' && externalTxIdError !== 'ok') ||
					(feeMethodChoice === 'xmr' && (externalTxIdError !== 'ok' || txProofError !== 'ok'))}
				onclick={goToPasswordPrompt}
			>
				{#if feeMethodChoice === 'waived_first_buy'}
					{$_('post_order.submit.primary_label_waived')}
				{:else if feeMethodChoice === 'btc' || feeMethodChoice === 'xmr'}
					{$_('post_order.submit.primary_label_external')}
				{:else if feeQuote}
					{$_('post_order.submit.primary_label')}
				{:else}
					{$_('post_order.fee.loading')}
				{/if}
			</BusyButton>
		</div>
	{:else if phase === 'awaiting_password'}
		<section class="card" aria-labelledby="password-heading">
			<h2 id="password-heading" class="mb-2 font-display text-lg font-bold">
				{$_('post_order.locked.fee_title')}
			</h2>
			<p class="mb-4 text-ink-600 dark:text-ink-300">
				{$_('post_order.locked.fee_body')}
			</p>
			<label class="block">
				<span class="mb-1 block text-sm font-semibold">
					{$_('post_order.locked.password_label', { values: { account: blurtAccount ?? '' } })}
				</span>
				<FocusedField focused={password.length === 0} valid={password.length >= 8}>
					<input
						use:focusOnMount
						type="password"
						maxlength="64"
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
					variant="link"
					onclick={() => {
						phase = 'reviewing';
						password = '';
					}}
				>
					<span class="nav-arrow nav-arrow-left" aria-hidden="true">⇦</span>
					{$_('common.cancel')}
				</BusyButton>
				<BusyButton variant="primary" disabled={password.length < 8} onclick={submitBroadcast}>
					{$_('common.unlock')}
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
					class="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
				>
					{$_('syndicate.success_failed')}
				</p>
			{/if}

			<div class="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
				{#if successPermlink && blurtAccount}
					<!-- #20 (Ken) — this used to be gated on the indexer having SEEN the
					     order, because offering it immediately sent the user to a
					     not-found page seconds after they'd paid a listing fee.
					     v1.7.0: the gate is gone because the destination is now safe —
					     the detail page reads the order this browser staged at broadcast
					     (`pendingOrders`), so there is nothing to wait for. The gate was
					     also failing open after ~40s anyway, against a 45-63s wait, so it
					     was sending users to the not-found page it existed to prevent. -->
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
								class="rounded-full border px-2 py-0.5 text-[11px] font-semibold tabular-nums {remaining <=
								30
									? 'animate-pulse border-red-300 bg-red-100 text-red-800 dark:border-red-700 dark:bg-red-900/40 dark:text-red-200'
									: 'border-morphit-emerald/30 bg-morphit-emerald/5 text-morphit-emerald'}"
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
						class="text-morphit-orchid group mt-3 inline-block font-semibold underline decoration-dotted underline-offset-2 transition hover:no-underline"
						href={lp(successPermlink ? `/my/orders?featuring=${successPermlink}` : '/my/orders')}
					>
						{$_('post_order.success.feature_upsell_cta')}
						<span class="nav-arrow nav-arrow-right" aria-hidden="true">⇨</span>
					</a>
				</div>
			{/if}
		</section>
	{:else if phase === 'error'}
		<section
			class="card border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-950"
			role="alert"
			aria-live="assertive"
		>
			<h2 class="font-display text-lg font-bold text-red-900 dark:text-red-100">
				{$_('post_order.broadcast_error.title')}
			</h2>
			<p class="mt-2 text-sm text-red-800 dark:text-red-200">
				{broadcastError}
			</p>
			<div class="mt-4">
				<BusyButton variant="primary" onclick={retryFromError}>
					{$_('common.retry')}
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
	{:catch}
		<LazyLoadError />
	{/await}
{/if}

{#if showUnlockForFee}
	<!-- tt.txt #11 — Active-key unlock for the BLURT listing fee. Raised OVER the
	     form, never replacing it: cancel and every field is still there. -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 p-4 backdrop-blur-sm"
		role="dialog"
		aria-modal="true"
	>
		<div
			class="max-h-[95dvh] w-full max-w-md overflow-y-auto overscroll-contain rounded-2xl border border-ink-200 bg-white p-5 shadow-morphit-card-hover dark:border-ink-700 dark:bg-ink-900"
		>
			<UnlockActiveKeyModal
				account={blurtAccount ?? ''}
				onUnlocked={onFeeKeyUnlocked}
				onCancel={() => {
					showUnlockForFee = false;
					phase = 'reviewing';
				}}
			/>
		</div>
	</div>
{/if}

<!-- t.txt (v1.4.9 #2) — markdown reference for the order Terms field. -->
<MarkdownGuideModal open={mdGuideOpen} onClose={() => (mdGuideOpen = false)} />

<style>
	/* v1.9.0 (Ken) — the inline BARTER "goods/services" fill-in-the-blank.
	   Underline-ONLY (no box), same colour as the sentence text via currentColor,
	   at reduced opacity; very faint until the user touches it, ~50% once they do.
	   `size` (set inline, in ch) grows the field with its content so the sentence
	   tail is pushed right and wraps on narrow phones instead of overflowing. */
	.barter-goods-field {
		display: inline;
		box-sizing: content-box;
		min-width: 2ch;
		max-width: 100%;
		padding: 0 0.15em;
		margin: 0;
		border: 0;
		border-bottom: 1px solid;
		/* faint when never touched */
		border-color: color-mix(in srgb, currentColor 22%, transparent);
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: center;
		/* baseline-align the field's text with the surrounding sentence (no
		   vertical nudge — a transform pushed it visibly too low, t.txt #5) */
		vertical-align: baseline;
		cursor: text;
		transition: border-color 120ms ease;
	}
	/* placeholder ("goods/services") — the sentence colour at 50% */
	.barter-goods-field::placeholder {
		color: color-mix(in srgb, currentColor 50%, transparent);
		opacity: 1;
	}
	.barter-goods-field:hover {
		border-color: color-mix(in srgb, currentColor 50%, transparent);
	}
	/* once it has content, keep the underline at a clear ~50% even when blurred */
	.barter-goods-field.filled {
		border-color: color-mix(in srgb, currentColor 50%, transparent);
	}
	/* t.txt #5 — focus does NOT turn the border green; it stays a 1px underline
	   the exact colour of the resting border-bottom (just made visible), so the
	   field reads as a fill-in-the-blank, not a boxed input. */
	.barter-goods-field:focus {
		outline: none;
		border-color: color-mix(in srgb, currentColor 50%, transparent);
	}
	/* WebKit/Firefox strip the browser's default inner spacing so the caret and
	   text hug the underline exactly. */
	.barter-goods-field::-webkit-search-decoration,
	.barter-goods-field::-webkit-search-cancel-button {
		display: none;
	}
</style>
