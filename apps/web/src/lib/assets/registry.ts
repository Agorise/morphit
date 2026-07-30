/**
 * Morphit — frontend asset registry.
 *
 * Single source of truth for per-coin UI metadata.  Every
 * component that displays a ticker, renders a themed accent
 * color, validates an address, or picks decimal precision
 * looks up its data here.
 *
 * Adding a new coin to the frontend UI is a single-file change
 * (this file) plus an SVG logo bundled at static/icons/icon-<lower
 * ticker>.svg.
 *
 * IMPORTANT: this registry exists for UI rendering.  The
 * on-chain payload schema (see lib/chat/payload.ts and
 * lib/orders/payload.ts) constrains which methods a chain op
 * may carry.  Extending that schema is a separate, more
 * involved process — see docs/ADDING-A-COIN.md.  This registry
 * lets you wire UI for an already-supported coin or stage UI
 * for an upcoming chain-payload extension.
 */

import type { ChatAssetTicker } from '$lib/chat/payload';

/** Address-shape validator.  Returns true if the string LOOKS
 *  like a valid address for this asset.  Must NOT require a
 *  network round-trip; this is for inline form-validation UX.
 *  Indexer-side and explorer-side verification still happens
 *  independently. */
export type AddressValidator = (s: string) => boolean;

/** Per-asset metadata.  All fields required so the registry is
 *  self-describing — components don't need to check for
 *  missing fields, and the next person adding a coin sees the
 *  full required shape at a glance. */
export interface AssetMetadata {
	/** Lower-case identifier matching the chain payload's
	 *  ChatAssetTicker string union. */
	readonly ticker: ChatAssetTicker;
	/** Display ticker (uppercase, e.g. "BTC"). */
	readonly displayTicker: string;
	/** Full name (e.g. "Bitcoin"). */
	readonly displayName: string;
	/** One-line description shown in pickers and tooltips. */
	readonly oneLineDescription: string;
	/** SVG logo path relative to the static root.  Components
	 *  prefix with the served origin or use as-is for inline
	 *  <img src=...>.  Always 1:1 aspect ratio. */
	readonly logoSvgPath: string;
	/** Tailwind utility class for the brand accent color.  Used
	 *  for borders, dot indicators, hover rings.  Keep these
	 *  contained to one or two utilities; full styling is the
	 *  consumer's call. */
	readonly accentClass: string;
	/** How many decimal places this asset's smallest unit
	 *  represents.  BTC: 8 (sat).  XMR: 12 (piconero).  BLURT: 3
	 *  (millibBLURT — Graphene's serialized format). */
	readonly decimals: number;
	/** True if the asset supports a memo/payment-id field on its
	 *  base-layer transaction.  Drives whether the address-share
	 *  modal exposes a memo input. */
	readonly supportsMemo: boolean;
	/** Address validator — synchronous, no I/O.  Should be
	 *  permissive (cheap shape check) rather than strict
	 *  (checksum-verify): we want to catch typos in the form,
	 *  not duplicate the wallet's own validation. */
	readonly addressValidator: AddressValidator;
	/** Whether the asset can be used for the LISTING-FEE payment
	 *  on this instance.  Memory #23 (2026-05-13): only BLURT/
	 *  BTC/XMR may have this true.  Trade-only assets (USDT,
	 *  ARRR, etc.) MUST set this false. */
	readonly canBeUsedForListingFee: boolean;
	/** Whether the asset can be the TRADED asset (the side: 'buy
	 *  X' / 'sell X' driver of the orderbook).  All current
	 *  assets can; reserved for future "fee-only" or "stable-
	 *  only" tickers. */
	readonly canBeTraded: boolean;
	/** Networks this asset is supported on.  Single-network assets
	 *  use `['mainnet']`.  Multi-network assets (future USDT, etc.)
	 *  list each.  Mirrors the canonical registry's
	 *  `supportedNetworks`. */
	readonly supportedNetworks: readonly string[];
	/** Default network or `null` to force explicit user choice. */
	readonly defaultNetwork: string | null;
	/** i18n key for the privacy/decentralization warning chip,
	 *  or null if no warning is needed (BTC/XMR/BLURT). */
	readonly privacyWarningKey: string | null;
}

// ─── Address validators ──────────────────────────────────────────

// BTC — re-export the cheap shape checks from chat/payload.ts so
// we don't duplicate.  Centralizing here would mean chat/payload
// imports from registry, but registry imports from chat/payload
// for the ChatAssetTicker type — circular.  Inline copies stay.
const BTC_P2PKH_RE = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const BTC_P2SH_RE = /^3[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const BTC_BECH32_RE = /^bc1[023456789acdefghjklmnpqrstuvwxyz]{6,87}$/;

const XMR_STANDARD_RE = /^4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/;
const XMR_SUBADDRESS_RE = /^8[0-9A-B][1-9A-HJ-NP-Za-km-z]{93}$/;
const XMR_INTEGRATED_RE = /^4[1-9A-HJ-NP-Za-km-z]{105}$/;

// Blurt account name — validates as the recipient identifier
// since BLURT transfers are routed by account name, not a hex
// address.  cp175 F-007: aligned to the CANONICAL Morphit account
// pattern (the same /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/ used by
// isValidBlurtAccount in $lib/chat/payload and the ops/ validators)
// so all account-name validators in the frontend agree. Multi-
// segment dotted names are accepted, but the name must end
// alphanumeric — cp176 tightened the canonical so a trailing dash or
// dot is rejected (real Blurt names can't end in punctuation). This
// is a client-side UX shape check only — the authoritative account
// check is the chain + indexer extractSigner. Parity across copies
// is enforced by blurt-account-regex-parity-smoke.
const BLURT_ACCOUNT_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

const validateBtc: AddressValidator = (s) =>
	BTC_P2PKH_RE.test(s) || BTC_P2SH_RE.test(s) || BTC_BECH32_RE.test(s);

const validateXmr: AddressValidator = (s) =>
	XMR_STANDARD_RE.test(s) || XMR_SUBADDRESS_RE.test(s) || XMR_INTEGRATED_RE.test(s);

const validateBlurt: AddressValidator = (s) => BLURT_ACCOUNT_RE.test(s);

// USDT per-network address shapes.  See lib/assets/networks.ts
// for the per-network metadata used by the address-share modal;
// THIS validator is the any-network combined check (passes if
// the string is a plausibly-valid USDT address on ANY supported
// network).  Per-network pinning is the address-share modal's
// job, not this validator's.
const USDT_ERC20_OR_BEP20_RE = /^0x[a-fA-F0-9]{40}$/;
const USDT_TRC20_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const USDT_SPL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const validateUsdt: AddressValidator = (s) =>
	USDT_ERC20_OR_BEP20_RE.test(s) ||
	USDT_TRC20_RE.test(s) ||
	USDT_SPL_RE.test(s);

// USDC — Ethereum + Base + Polygon all share the EVM 0x[40 hex]
// address format; SPL is base58 32-44 chars.  Note no TRC-20
// variant (Circle doesn't issue on Tron) and no BEP-20 in the
// initial set (filed as REVISIT for non-breaking later add).
// Per-network disambiguation is the network picker's job; this
// validator is the form-level "is this even plausibly a USDC
// address" check.
const USDC_EVM_RE = /^0x[a-fA-F0-9]{40}$/;
const USDC_SPL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const validateUsdc: AddressValidator = (s) =>
	USDC_EVM_RE.test(s) || USDC_SPL_RE.test(s);

// DAI — ALL FOUR supported networks (Ethereum, Polygon, Base,
// Arbitrum) use the same EVM 0x[40 hex] address format.  Unlike
// USDC, no SPL branch — Maker doesn't issue native DAI on Solana
// (only third-party wrapped variants exist, which Morphit
// excludes per ADR-0029 §1).  Cross-network mis-send risk is the
// SAME amplification class as USDC's ERC-20/Base/Polygon (three-
// way visual identity) but with an extra EVM network (Arbitrum)
// added — so DAI has the highest cross-network address-confusion
// surface of any asset on Morphit.  Per-network disambiguation is
// the network picker's job.
const DAI_EVM_RE = /^0x[a-fA-F0-9]{40}$/;

const validateDai: AddressValidator = (s) => DAI_EVM_RE.test(s);

// BCH — CashAddr (with or without `bitcoincash:` prefix) and
// legacy P2PKH/P2SH.  Inlined copies mirroring chat/payload.ts
// (we can't import to avoid the same registry-imports-payload
// circular).
const BCH_CASHADDR_PREFIXED_RE = /^bitcoincash:[qp][a-z0-9]{41}$/;
const BCH_CASHADDR_BARE_RE = /^[qp][a-z0-9]{41}$/;
const BCH_LEGACY_P2PKH_RE = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const BCH_LEGACY_P2SH_RE = /^3[1-9A-HJ-NP-Za-km-z]{25,34}$/;

const validateBch: AddressValidator = (s) =>
	BCH_CASHADDR_PREFIXED_RE.test(s) ||
	BCH_CASHADDR_BARE_RE.test(s) ||
	BCH_LEGACY_P2PKH_RE.test(s) ||
	BCH_LEGACY_P2SH_RE.test(s);

// LTC — legacy P2PKH (L...), modern P2SH (M...), deprecated P2SH
// (3..., BTC-shape ambiguous per ADR-0025 §4), bech32/bech32m
// (ltc1...).  Inlined copies mirroring chat/payload.ts.
const LTC_LEGACY_P2PKH_RE = /^L[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const LTC_LEGACY_P2SH_M_RE = /^M[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const LTC_LEGACY_P2SH_3_RE = /^3[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const LTC_BECH32_RE = /^ltc1[02-9ac-hj-np-z]{6,87}$/;

const validateLtc: AddressValidator = (s) =>
	LTC_LEGACY_P2PKH_RE.test(s) ||
	LTC_LEGACY_P2SH_M_RE.test(s) ||
	LTC_LEGACY_P2SH_3_RE.test(s) ||
	LTC_BECH32_RE.test(s);

// DASH address regex (cp27).  P2PKH starts with `X`, P2SH starts
// with `7`; both base58, 34 chars total.  Permissive shape check
// — receiving wallet does checksum and chain-binding.  See
// payload.ts and the canonical asset-registry entry for the full
// rationale.
const DASH_P2PKH_RE = /^X[1-9A-HJ-NP-Za-km-z]{33}$/;
const DASH_P2SH_RE = /^7[1-9A-HJ-NP-Za-km-z]{33}$/;

const validateDash: AddressValidator = (s) =>
	DASH_P2PKH_RE.test(s) || DASH_P2SH_RE.test(s);

// DOGE address regex (cp33).  P2PKH starts with `D`, P2SH starts
// with `9` or `A` (multi-sig variants).  No bech32 — Dogecoin
// Core has not activated segwit as of 2026-05.  Length is 34
// chars total (33 after the version-byte prefix).
const DOGE_P2PKH_RE = /^D[1-9A-HJ-NP-Za-km-z]{33}$/;
const DOGE_P2SH_RE = /^[9A][1-9A-HJ-NP-Za-km-z]{33}$/;

const validateDoge: AddressValidator = (s) =>
	DOGE_P2PKH_RE.test(s) || DOGE_P2SH_RE.test(s);

// ZEC address regex (cp39).  Zcash supports both transparent
// (base58, t1/t3 prefixes, ~35 chars total) and shielded
// (bech32/bech32m, zs1 Sapling pool or u1 Unified Address) formats.
// All four are first-class on the protocol; Morphit accepts any
// valid shape so recipients can pick the address type that
// matches their preferred privacy posture.  See payload.ts and
// the canonical asset-registry entry for the full rationale.
const ZEC_T_RE = /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/;
const ZEC_ZS_RE = /^zs1[02-9ac-hj-np-z]{75}$/;
const ZEC_U_RE = /^u1[02-9ac-hj-np-z]{30,300}$/;

const validateZec: AddressValidator = (s) =>
	ZEC_T_RE.test(s) || ZEC_ZS_RE.test(s) || ZEC_U_RE.test(s);

// ARRR address regex (cp41 — Part 122).  Pirate Chain ships
// chain-level default-shielded transactions via the Sapling zk-SNARK
// pool.  Only one address format: `zs1` Sapling shielded
// (bech32, 78 chars total — same shape as Zcash Sapling addresses).
// No transparent addresses — Pirate Chain forcibly migrated all
// transparent funds to the shielded pool early in the chain's
// life.  No Unified Address (`u1`) format — Pirate Chain does
// not implement Zcash's NU5/Orchard pool.
const ARRR_ZS_RE = /^zs1[02-9ac-hj-np-z]{75}$/;

const validateArrr: AddressValidator = (s) => ARRR_ZS_RE.test(s);

// DCR address regex (cp43 — Part 122).  Decred uses base58check
// with two address types used for receiving payments:
//   - `Ds` P2PKH-Secp256k1 (most common)
//   - `Dc` P2SH (multisig / scripts)
// 33 base58 data chars after the 2-char prefix = 35 chars total.
// Other prefixes (`Dp` extended pubkey, `Dr` extended privkey,
// `De` Edwards-curve) are NOT used for regular receive — they
// would be incorrect to share as trade payment destinations and
// are rejected by this regex.
const DCR_RE = /^D[sc][1-9A-HJ-NP-Za-km-z]{33}$/;

const validateDcr: AddressValidator = (s) => DCR_RE.test(s);

// SOL address regex (cp45 — Part 122).  Solana public keys are
// 32 bytes encoded as base58 (32-44 chars, most are 44).  Same
// character class as USDT/USDC SPL addresses — context (the
// asset field) disambiguates at the order layer per LL #50.
//
// PROGRAM-DERIVED ADDRESSES (PDAs) match this regex but are
// off-curve — funds sent to a PDA require the owning program to
// implement a withdraw path.  Morphit accepts the shape; wallet
// UX on the receiver side is responsible for PDA warnings.
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const validateSol: AddressValidator = (s) => SOL_RE.test(s);

// ETH address regex (cp47 — Part 122).  Ethereum addresses are
// 20-byte hex with 0x prefix — exactly 42 chars total.  Both
// lowercase and EIP-55 mixed-case checksum forms accepted.
//
// SAME shape as USDT-ERC20, USDC-ERC20, DAI-ERC20, and every
// EVM token-account address on Base/Polygon/Arbitrum/BSC.
// Context disambiguates at the order layer (asset field +
// network field for multi-network assets) per LL #50.  cp47
// extends address-shape-overlap-smoke with ETH specimens.
//
// CONTRACT ADDRESSES match this regex but are smart-contract
// accounts not EOAs.  Sending ETH to a contract that doesn't
// implement a receive() / fallback() function may revert.
// Morphit accepts the shape; receiver-side wallet UX is
// responsible for contract-destination warnings.
//
// ENS NAMES (alice.eth) are NOT accepted by this regex — Morphit
// requires raw 0x addresses to avoid centralized RPC dependency
// on ENS resolution (violates the distributed-no-SPOF design
// priority).
const ETH_RE = /^0x[a-fA-F0-9]{40}$/;

const validateEth: AddressValidator = (s) => ETH_RE.test(s);

// XRP address regex (cp49 — Part 122).  XRPL addresses start with
// 'r' followed by 24-34 base58 chars.  DESTINATION TAGS ride
// separately in URI `?dt=N` (NOT in the regex).  RESERVE
// REQUIREMENT: XRPL accounts need ≥1 XRP base reserve to exist.
const XRP_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

const validateXrp: AddressValidator = (s) => XRP_RE.test(s);

// ─── Registry ────────────────────────────────────────────────────

/** The full registry, ordered for display purposes (Monero
 *  first per the project's audience-priority statement;
 *  Bitcoin second; BLURT last because it's the chain-of-record,
 *  not the typical traded asset).
 *
 *  cp474 — the literal below is `as const`, which is a COMPILE-time
 *  claim only: it vanishes at runtime, so anything holding a
 *  reference could rewrite an entry in place.  This registry ships
 *  to the BROWSER and carries `addressShape` (the regex behind
 *  inline address-typo detection) and the display tickers users
 *  read before sending funds, so a mutated entry is a
 *  user-visible integrity problem, not just a tidiness one.  The
 *  sibling `@morphit/asset-registry` freezes for exactly this
 *  reason ("an escape hatch can't corrupt the registry's
 *  invariants"); this copy had simply never been given the same
 *  treatment.  Freeze the array AND each entry.  Nothing mutates
 *  ASSETS in place (`ReadonlyArray` denies push/sort at compile
 *  time, and callers already spread-then-sort), so this is
 *  enforcement of an existing contract, not a behaviour change. */
const ASSETS_SOURCE: ReadonlyArray<AssetMetadata> = [
	{
		ticker: 'xmr',
		displayTicker: 'XMR',
		displayName: 'Monero',
		oneLineDescription: 'Privacy-focused cryptocurrency.  Default and recommended on Morphit.',
		logoSvgPath: '/icons/icon-xmr.svg',
		accentClass: 'text-orange-500',
		decimals: 12,
		supportsMemo: false, // Subaddresses replace payment-IDs in modern XMR
		addressValidator: validateXmr,
		canBeUsedForListingFee: true,
		canBeTraded: true,
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		privacyWarningKey: null
	},
	{
		ticker: 'btc',
		displayTicker: 'BTC',
		displayName: 'Bitcoin',
		oneLineDescription: 'The original cryptocurrency.  Recommend SegWit (bc1...) addresses.',
		logoSvgPath: '/icons/icon-btc.svg',
		accentClass: 'text-amber-500',
		decimals: 8,
		supportsMemo: false, // BTC doesn't carry transaction memos
		addressValidator: validateBtc,
		canBeUsedForListingFee: true,
		canBeTraded: true,
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		privacyWarningKey: null
	},
	{
		ticker: 'blurt',
		displayTicker: 'BLURT',
		displayName: 'Blurt',
		oneLineDescription: 'The chain Morphit coordinates on.  Used for network fees by default.',
		logoSvgPath: '/icons/icon-blurt.svg',
		accentClass: 'text-morphit-emerald',
		decimals: 3,
		supportsMemo: true, // BLURT transfers carry a plaintext memo field
		addressValidator: validateBlurt,
		canBeUsedForListingFee: true,
		canBeTraded: true,
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		privacyWarningKey: null
	},
	{
		ticker: 'usdt',
		displayTicker: 'USDT',
		displayName: 'Tether',
		oneLineDescription:
			'Stablecoin pegged to USD.  Centrally controlled.  Trade-only — cannot pay listing fees.',
		logoSvgPath: '/icons/icon-usdt.svg',
		// Amber to mirror the privacy-warning chip's visual treatment.
		// Distinguishes USDT from BTC's amber (BTC is amber-500;
		// USDT is amber-400 — slightly lighter to read as "warning"
		// vs "branded yellow").
		accentClass: 'text-amber-400',
		decimals: 6, // Same on all four supported networks
		supportsMemo: false,
		addressValidator: validateUsdt,
		// MEMORY #23 INVARIANT: USDT cannot pay listing fees.
		canBeUsedForListingFee: false,
		canBeTraded: true,
		// Multi-network: ERC-20, TRC-20, SPL, BEP-20.
		// Native USDT only — bridged versions excluded.
		supportedNetworks: ['erc20', 'trc20', 'spl', 'bep20'],
		// null forces explicit user choice every trade.
		// Cross-network sends lose funds permanently.
		defaultNetwork: null,
		privacyWarningKey: 'usdt_centralized'
	},
	{
		ticker: 'usdc',
		displayTicker: 'USDC',
		displayName: 'USD Coin',
		oneLineDescription:
			'Stablecoin pegged to USD, issued by Circle.  Centrally controlled.  Trade-only — cannot pay listing fees.',
		logoSvgPath: '/icons/icon-usdc.svg',
		// Circle brand blue (#2775CA approx).  text-blue-500 reads
		// as "Circle blue" while staying clearly distinct from
		// USDT's amber-400 (the other centralized stablecoin) and
		// from BLURT's emerald.  Both stablecoins keep the
		// privacy-warning chip; the accent color isn't the
		// warning channel.
		accentClass: 'text-blue-500',
		decimals: 6, // Same on all four supported networks (Circle standard)
		supportsMemo: false,
		addressValidator: validateUsdc,
		// MEMORY #23 INVARIANT: USDC cannot pay listing fees.
		// Trade-only Category B asset alongside USDT/DAI/BCH/LTC/DASH/DOGE.
		canBeUsedForListingFee: false,
		canBeTraded: true,
		// Multi-network: ERC-20, SPL, Base, Polygon.  Native USDC
		// only — bridged versions (USDC.e, USDbC, etc.) excluded.
		// No TRC-20 (Circle doesn't issue on Tron) and no BEP-20
		// in the initial set; see ADR-0028 + REVISIT-LIST for the
		// non-breaking later-add path.
		supportedNetworks: ['erc20', 'spl', 'base', 'polygon'],
		// null forces explicit user choice every trade.  Note
		// ERC-20 + Base + Polygon SHARE the EVM 0x address shape,
		// so an address looks identical between those three at
		// the format level — the picker is what disambiguates
		// which chain the sender's wallet should broadcast on.
		defaultNetwork: null,
		privacyWarningKey: 'usdc_centralized'
	},
	{
		ticker: 'dai',
		displayTicker: 'DAI',
		displayName: 'Dai',
		// Honest one-liner per ADR-0029 §2 + Memory #29 ("respectful
		// to that coin's community").  Acknowledges DAI's
		// decentralization edge over single-issuer stablecoins
		// without overselling — the PSM/USDC backing dependency is
		// real and we don't pretend otherwise.  The per-asset
		// privacy guide at /privacy/dai gives the full picture.
		oneLineDescription:
			'Stablecoin pegged to USD, issued by MakerDAO.  More decentralized than USDT/USDC at the contract level (no admin freeze power), but partly backed by USDC via the Peg Stability Module.  Trade-only — cannot pay listing fees.',
		logoSvgPath: '/icons/icon-dai.svg',
		// MakerDAO orange (#F5AC37) — the canonical brand color
		// shipping in Ken's supplied icon.  text-orange-500
		// (~#f97316) is the closest Tailwind utility class; reads
		// as "Maker orange" while staying clearly distinct from
		// USDT amber-400, USDC blue-500, BLURT emerald, etc.  The
		// privacy-warning chip stays as a separate channel; the
		// accent isn't the warning surface.
		accentClass: 'text-yellow-600',
		// EVM-standard 18 decimals — different from USDT/USDC's 6.
		// Affects the underlying token's smallest-unit math but
		// not the user-visible amount-jitter resolution (the
		// jitter routine clamps to 6-decimal display precision
		// regardless of token decimals, so the user-visible
		// $0.001 jitter effect is uniform across all three
		// stablecoins).
		decimals: 18,
		supportsMemo: false,
		addressValidator: validateDai,
		// MEMORY #23 INVARIANT: DAI cannot pay listing fees.
		// Trade-only Category B asset alongside USDT/USDC/BCH/LTC/DASH/DOGE.
		canBeUsedForListingFee: false,
		canBeTraded: true,
		// Multi-network: ERC-20 (native), Polygon (PoS), Base,
		// Arbitrum.  All Maker-issued native; bridged variants
		// (Wormhole DAI on Solana etc.) excluded per ADR-0029 §1
		// to avoid wrapper-custodian trust dependency.
		supportedNetworks: ['erc20', 'polygon', 'base', 'arbitrum'],
		// null forces explicit user choice every trade.  ALL FOUR
		// networks share the EVM 0x address shape, so addresses
		// are visually indistinguishable across them — the picker
		// is the ONLY thing that disambiguates which chain the
		// sender's wallet should broadcast on.  This makes DAI
		// the highest cross-network address-confusion surface of
		// any asset on Morphit; the per-message warning in
		// ChatMessage uses the same template as USDC's EVM
		// branches but applied to all 4 DAI networks.
		defaultNetwork: null,
		// DISTINCT from the USDT/USDC `*_centralized` class — DAI
		// has no direct token-contract address-freeze function, but
		// the PSM holds USDC as collateral so Circle's freeze power
		// transitively affects DAI redeemability.  Warning copy
		// gives DAI credit for the design choice while being honest
		// about the dependency.  See ADR-0029 §2.
		privacyWarningKey: 'dai_partly_centralized'
	},
	{
		ticker: 'bch',
		displayTicker: 'BCH',
		displayName: 'Bitcoin Cash',
		oneLineDescription:
			'Bitcoin Cash — bigger blocks, lower per-tx fees.  Trade-only — cannot pay listing fees.',
		logoSvgPath: '/icons/icon-bch.svg',
		// BCH brand green.  text-lime-500 is visually distinct from
		// BLURT's text-morphit-emerald, XMR's text-orange-500, BTC's
		// text-amber-500, USDT's text-amber-400.  Reads as "green"
		// (the Bitcoin Cash community color) without colliding.
		accentClass: 'text-lime-500',
		decimals: 8, // Same as BTC — sat-denominated smallest unit
		supportsMemo: false, // BCH transactions don't carry memos (same as BTC)
		addressValidator: validateBch,
		// MEMORY #23 INVARIANT: BCH cannot pay listing fees.
		// Trade-only Category B coin.
		canBeUsedForListingFee: false,
		canBeTraded: true,
		// Single-network — mainnet only.
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// BCH is transparent (like BTC) but decentralized — no
		// issuer can freeze addresses.  Same posture as BTC: no
		// privacy warning chip.
		privacyWarningKey: null
	},
	{
		ticker: 'ltc',
		displayTicker: 'LTC',
		displayName: 'Litecoin',
		oneLineDescription:
			'Litecoin — fast, low-fee Bitcoin fork.  Trade-only — cannot pay listing fees.',
		logoSvgPath: '/icons/icon-ltc.svg',
		// LTC brand silver/gray.  text-slate-400 reads as the
		// Litecoin "silver" without colliding with BCH's lime-500,
		// BTC's amber-500, USDT's amber-400, XMR's orange-500, or
		// BLURT's morphit-emerald.
		accentClass: 'text-slate-400',
		decimals: 8, // Same as BTC — litoshi == satoshi
		supportsMemo: false, // LTC transactions don't carry memos (same as BTC)
		addressValidator: validateLtc,
		// MEMORY #23 INVARIANT: LTC cannot pay listing fees.
		// Trade-only Category B coin.
		canBeUsedForListingFee: false,
		canBeTraded: true,
		// Single-network — mainnet only.
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// LTC is transparent (like BTC and BCH) but decentralized —
		// no issuer can freeze addresses.  Same posture as BTC: no
		// privacy warning chip.  LTC ships MWEB opt-in privacy at
		// the wallet level on a per-tx basis.
		privacyWarningKey: null
	},
	{
		ticker: 'dash',
		displayTicker: 'DASH',
		displayName: 'Dash',
		oneLineDescription:
			'Dash — fast-confirmation transparent chain with opt-in PrivateSend mixing.  Trade-only — cannot pay listing fees.',
		logoSvgPath: '/icons/icon-dash.svg',
		// DASH brand blue (#008CE7).  text-sky-500 reads as the
		// Dash blue without colliding with BCH lime-500, LTC
		// slate-400, BTC amber-500, USDT amber-400, XMR orange-500,
		// or BLURT morphit-emerald.
		accentClass: 'text-sky-500',
		decimals: 8, // Same as BTC — duff == satoshi
		supportsMemo: false, // DASH transactions don't carry memos (same as BTC)
		addressValidator: validateDash,
		// MEMORY #23 INVARIANT: DASH cannot pay listing fees.
		// Trade-only Category B coin.
		canBeUsedForListingFee: false,
		canBeTraded: true,
		// Single-network — mainnet only.
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// DASH is transparent at the base layer (like BTC/BCH/LTC)
		// and fully decentralized — no issuer can freeze
		// addresses.  Same posture as BTC: no privacy warning chip.
		// DASH ships an opt-in privacy upgrade — PrivateSend, a
		// masternode-coordinated CoinJoin variant — at the wallet
		// level on a per-tx basis.  Users who want transparent +
		// opt-in mixing can pre-mix via PrivateSend before sharing
		// the address on Morphit.
		privacyWarningKey: null
	},
	{
		ticker: 'doge',
		displayTicker: 'DOGE',
		displayName: 'Dogecoin',
		oneLineDescription:
			'Dogecoin — transparent PoW chain with fair launch, merge-mined with Litecoin since 2014.  Trade-only — cannot pay listing fees.',
		logoSvgPath: '/icons/icon-doge.svg',
		// DOGE brand gold (#C2A633).  text-yellow-500 reads as
		// Dogecoin gold without colliding with BCH lime-500, LTC
		// slate-400, DASH sky-500, BTC amber-500, USDT amber-400,
		// XMR orange-500, BLURT morphit-emerald, USDC blue-500,
		// or DAI orange-500.
		accentClass: 'text-yellow-500',
		decimals: 8, // Same as BTC — shibatoshi == satoshi
		supportsMemo: false, // DOGE transactions don't carry memos (same as BTC)
		addressValidator: validateDoge,
		// MEMORY #23 INVARIANT: DOGE cannot pay listing fees.
		// Trade-only Category B coin.
		canBeUsedForListingFee: false,
		canBeTraded: true,
		// Single-network — mainnet only.  Dogecoin has no L2
		// with formal community endorsement.
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// DOGE is transparent at the base layer (like BTC/BCH/LTC)
		// and fully decentralized — no issuer can freeze
		// addresses.  Same posture as BTC: no privacy warning chip.
		// DOGE has no native privacy upgrade (no PrivateSend
		// equivalent).  The chain's social posture — fair launch,
		// no premine after the initial year, no foundation-
		// controlled supply — gives it strong decentralization
		// credentials.
		privacyWarningKey: null
	},
	{
		ticker: 'zec',
		displayTicker: 'ZEC',
		displayName: 'Zcash',
		oneLineDescription:
			'Zcash — transparent + shielded transactions via zk-SNARKs; recipients pick t-addr or z/u-addr.  Trade-only — cannot pay listing fees.',
		logoSvgPath: '/icons/icon-zec.svg',
		// ZEC brand gold-yellow (#F2B525).  text-amber-400 reads
		// as the Zcash brand color and stays distinct from BCH
		// lime-500, LTC slate-400, DASH sky-500, BTC amber-500,
		// USDT amber-400 — wait, USDT is also amber-400.  Use
		// text-yellow-400 instead to land at the Zcash gold tone
		// while staying distinct from the existing 10.  (DOGE
		// uses yellow-500 already, so 400 vs 500 gives the
		// distinction.)
		accentClass: 'text-yellow-400',
		decimals: 8, // Same as BTC — zatoshi == satoshi
		supportsMemo: false, // Memo content travels inside the shielded payload, not the address
		addressValidator: validateZec,
		// MEMORY #23 INVARIANT: ZEC cannot pay listing fees.
		// Trade-only Category B coin.
		canBeUsedForListingFee: false,
		canBeTraded: true,
		// Single-network — mainnet only.
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// Zcash is fully decentralized via PoW and addresses
		// cannot be frozen by an issuer.  The chain supports both
		// transparent addresses (t1/t3, base58, similar shape to
		// Bitcoin's legacy addresses) and shielded addresses using
		// zero-knowledge proofs (zs1 Sapling and u1 Unified
		// Address bundling Orchard receivers).  Per-address
		// privacy: recipients pick t-addr for transparent
		// visibility or z/u-addr for shielded transactions; both
		// are first-class on the protocol.  No warning chip
		// needed.
		privacyWarningKey: null
	},
	{
		ticker: 'arrr',
		displayTicker: 'ARRR',
		displayName: 'Pirate Chain',
		oneLineDescription:
			'Pirate Chain — chain-level shielded transactions via zk-SNARK Sapling pool; every transaction is private by construction.  Trade-only — cannot pay listing fees.',
		logoSvgPath: '/icons/icon-arrr.svg',
		// ARRR brand gold gradient (#b38c30 → #f2de98).  Distinct
		// from existing assignments: USDT amber-400, DOGE yellow-500,
		// ZEC yellow-400, BTC amber-500 — wait, BTC is amber-500.
		// Use text-amber-600 to land a richer/warmer gold tone
		// (closer to the b38c30 dark stop) while staying distinct
		// from BTC's brighter amber-500 and the other 10.
		accentClass: 'text-amber-600',
		decimals: 8, // Same as BTC — Sapling inherited the 8-decimal smallest-unit convention from Bitcoin
		supportsMemo: false, // Memo content travels inside the shielded payload, not the address
		addressValidator: validateArrr,
		// MEMORY #23 INVARIANT: ARRR cannot pay listing fees.
		// Trade-only Category B coin.
		canBeUsedForListingFee: false,
		canBeTraded: true,
		// Single-network — mainnet only.
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// Pirate Chain is decentralized via PoW (Equihash variant
		// inherited from Zcash); addresses cannot be frozen by an
		// issuer.  Every transaction goes through the Sapling
		// shielded pool — there's no transparent address option.
		// The chain hides sender, recipient, and amount by
		// construction.  No warning chip needed.
		privacyWarningKey: null
	},
	{
		ticker: 'dcr',
		displayTicker: 'DCR',
		displayName: 'Decred',
		oneLineDescription:
			'Decred — hybrid PoW/PoS cryptocurrency with on-chain governance (Politeia) and opt-in CoinShuffle++ (CSPP) mixing.  Trade-only — cannot pay listing fees.',
		logoSvgPath: '/icons/icon-dcr.svg',
		// Decred brand teal-green (#2dd8a3) and blue (#2970ff) — use
		// text-teal-500 to land a clean teal accent distinct from
		// every existing assignment: BTC amber-500, USDT amber-400,
		// USDC blue-500, DAI yellow-600 (cp42), BCH lime-500, LTC
		// slate-400, DASH sky-500, DOGE yellow-500, ZEC yellow-400,
		// ARRR amber-600, XMR orange-500.
		accentClass: 'text-teal-500',
		decimals: 8, // Same as BTC — Decred inherited the 8-decimal smallest-unit convention from Bitcoin
		supportsMemo: false,
		addressValidator: validateDcr,
		// MEMORY #23 INVARIANT: DCR cannot pay listing fees.
		// Trade-only Category B coin.
		canBeUsedForListingFee: false,
		canBeTraded: true,
		// Single-network — mainnet only.
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// Decred is decentralized via hybrid PoW + PoS consensus
		// (every block is mined by PoW miners AND voted on by 5
		// PoS ticket-holders chosen pseudo-randomly).  Politeia
		// on-chain governance lets stakeholders propose and
		// ratify protocol changes.  Addresses cannot be frozen
		// by an issuer.  No warning chip needed.
		privacyWarningKey: null
	},
	{
		ticker: 'sol',
		displayTicker: 'SOL',
		displayName: 'Solana',
		oneLineDescription:
			'Solana — high-throughput Proof-of-Stake cryptocurrency.  Trade-only — cannot pay listing fees.',
		logoSvgPath: '/icons/icon-sol.svg',
		// Solana brand gradient runs purple (#9945ff) to green
		// (#19fb9b).  text-violet-500 lands a clean violet accent
		// distinct from every existing assignment: BTC amber-500,
		// USDT amber-400, USDC blue-500, DAI yellow-600, BCH
		// lime-500, LTC slate-400, DASH sky-500, DOGE yellow-500,
		// ZEC yellow-400, ARRR amber-600, XMR orange-500, DCR
		// teal-500.  Verified at cp45 via cp42 asset-accent-class-
		// uniqueness-smoke.
		accentClass: 'text-violet-500',
		decimals: 9, // 1 SOL = 1,000,000,000 lamports
		supportsMemo: false,
		addressValidator: validateSol,
		// MEMORY #23 INVARIANT: SOL cannot pay listing fees.
		// Trade-only Category B coin.
		canBeUsedForListingFee: false,
		canBeTraded: true,
		// Single-network — mainnet only.
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// Solana is decentralized via delegated Proof-of-Stake
		// with Proof-of-History sequencing.  No central freeze
		// authority.  Transparent base layer.  No warning chip
		// needed.
		privacyWarningKey: null
	},
	{
		ticker: 'eth',
		displayTicker: 'ETH',
		displayName: 'Ethereum',
		oneLineDescription:
			'Ethereum — Proof-of-Stake cryptocurrency.  Trade-only — cannot pay listing fees.',
		logoSvgPath: '/icons/icon-eth.svg',
		// Ethereum brand color is #627EEA (a blue-purple).
		// text-indigo-500 lands a clean indigo accent distinct
		// from every existing assignment.  Verified at cp47 via
		// cp42 asset-accent-class-uniqueness-smoke.
		accentClass: 'text-indigo-500',
		decimals: 18, // 1 ETH = 10^18 wei
		supportsMemo: false,
		addressValidator: validateEth,
		// MEMORY #23 INVARIANT: ETH cannot pay listing fees.
		// Trade-only Category B coin.
		canBeUsedForListingFee: false,
		canBeTraded: true,
		// Single-network — mainnet only.  Layer-2 networks are
		// SEPARATE chains and would be added as multi-network if
		// ever shipped.
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// Ethereum is decentralized via Proof-of-Stake (post-
		// Merge, September 2022).  No central freeze authority.
		// Transparent base layer; no warning chip needed.
		privacyWarningKey: null
	},
	{
		ticker: 'xrp',
		displayTicker: 'XRP',
		displayName: 'Ripple (XRP)',
		oneLineDescription:
			'Ripple (XRP) — Federated Byzantine Agreement cryptocurrency.  Trade-only — cannot pay listing fees.',
		logoSvgPath: '/icons/icon-xrp.svg',
		accentClass: 'text-cyan-600',
		decimals: 6,
		supportsMemo: false,
		addressValidator: validateXrp,
		canBeUsedForListingFee: false,
		canBeTraded: true,
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// Native XRP cannot be frozen by any central authority
		// (freeze flag applies only to issued tokens/IOUs).
		privacyWarningKey: null
	},
	{
		// cp425 — BARTER: goods/services as a tradable asset (not a crypto).
		// Display metadata only; every crypto-shaped path (address, price,
		// network, memo, listing-fee) is gated away by isGoodsAsset().
		ticker: 'barter',
		displayTicker: 'BARTER',
		displayName: 'Barter (goods/services)',
		oneLineDescription:
			'Goods or services — sell or buy wares directly for crypto.  Priced in your local currency; settled in the crypto(s) you accept.',
		logoSvgPath: '/icons/icon-barter.svg',
		accentClass: 'text-stone-500',
		// Goods are valued in fiat, not a crypto amount.
		decimals: 0,
		supportsMemo: false,
		// Goods have no receive address — the wares change hands off-platform
		// (described in the listing's Terms). Never-valid; every address path
		// is gated away from barter by isGoodsAsset().
		addressValidator: () => false,
		canBeUsedForListingFee: false,
		canBeTraded: true,
		// No chain → no network (goods change hands off-platform); empty so
		// the network-icon smoke doesn't expect an icon. isGoodsAsset() guards
		// every network path away from barter.
		supportedNetworks: [],
		defaultNetwork: null,
		privacyWarningKey: null
	}
] as const;

export const ASSETS: ReadonlyArray<AssetMetadata> = Object.freeze(
	ASSETS_SOURCE.map((a) => Object.freeze(a))
);

const BY_TICKER: Readonly<Record<ChatAssetTicker, AssetMetadata>> = Object.freeze(
	ASSETS.reduce(
		(acc, a) => {
			acc[a.ticker] = a;
			return acc;
		},
		{} as Record<ChatAssetTicker, AssetMetadata>
	)
);

/** Look up a registered asset by its lower-case ticker.  Throws
 *  if the ticker isn't registered — caller should pass values
 *  from the ChatAssetTicker type union, which is constrained by
 *  the chain-payload schema. */
export function getAsset(ticker: ChatAssetTicker): AssetMetadata {
	const a = BY_TICKER[ticker];
	if (a === undefined) {
		throw new Error(
			`getAsset: ticker '${ticker}' not in registry — register it in lib/assets/registry.ts`
		);
	}
	return a;
}

/** cp406 — resolve a ticker that may be UPPERCASE to the lower-case
 *  ChatAssetTicker used across the chat UI + payment modals, or null when it
 *  isn't a tradable chat asset. `OrderRecord.asset` is the canonical UPPERCASE
 *  AssetTicker ('BLURT'), but this registry + ChatAssetTicker are lower-case
 *  ('blurt'); without folding the case an uppercase order asset never matched,
 *  so the composer "Pay now" asset-lock silently failed and the modal fell back
 *  to the free 16-coin picker. Case-insensitive + total. */
export function chatAssetFromTicker(ticker: string): ChatAssetTicker | null {
	const lower = ticker.toLowerCase();
	return Object.prototype.hasOwnProperty.call(BY_TICKER, lower)
		? (lower as ChatAssetTicker)
		: null;
}

/** Filter helpers for common UI-side queries. */
export function tradeableAssets(): readonly AssetMetadata[] {
	return ASSETS.filter((a) => a.canBeTraded);
}

export function feePayableAssets(): readonly AssetMetadata[] {
	return ASSETS.filter((a) => a.canBeUsedForListingFee);
}

export function memoCapableAssets(): readonly AssetMetadata[] {
	return ASSETS.filter((a) => a.supportsMemo);
}
