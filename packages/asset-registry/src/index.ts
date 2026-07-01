/**
 * @morphit/asset-registry — single source-of-truth for traded
 * assets across the indexer, relay, and frontend.
 *
 * Why this exists:
 *   Pre-collapse, the set of supported assets ('BTC' | 'XMR' |
 *   'BLURT') was duplicated across ~32 sites in the codebase —
 *   handler validators, API response types, frontend display
 *   filters, RSS feeds.  Adding a 4th asset (LTC, DOGE, DASH)
 *   meant touching every one and remembering not to miss any.
 *   This module is the canonical declaration; everything else
 *   imports from here.
 *
 * What this module is and isn't:
 *   IS: the chain-level enumeration of assets, their tickers,
 *       decimals, basic shape validators, and capability flags
 *       that govern what each asset can be used for.
 *   IS NOT: per-asset display polish (logos, accent colors,
 *       descriptions for the picker UI).  That's still in
 *       apps/web/src/lib/assets/registry.ts which extends the
 *       canonical entries here with frontend-only metadata.
 *
 * Adding a new asset:
 *   1. Add an entry to ASSETS below.  The ticker must be
 *      uppercase (BTC, not btc).  Pick `decimals` from the
 *      chain's smallest-unit definition (BTC: 8 sat,
 *      XMR: 12 piconero, BLURT: 3 milliBLURT).
 *   2. Add a UI extension in apps/web/src/lib/assets/registry.ts
 *      (logo, accent, picker description).  See ADDING-A-COIN.md.
 *   3. Write an explorer-fee-verifier under
 *      apps/indexer/src/indexer/fee/<ticker>ExplorerVerifier.ts
 *      (mirror bitcoinExplorerVerifier.ts / moneroExplorerVerifier.ts).
 *   4. Add asset-related i18n strings across all locales (the
 *      i18n parity smoke catches missing keys; if all locales
 *      need a string, the smoke is your checklist).
 *   5. Run `npm run check` (typecheck) and `bash scripts/run-smokes.sh`.
 *      The smokes catalog every asset reference; missing entries
 *      surface as test failures, not silent gaps.
 */

/** The set of asset tickers Morphit supports.  This is the
 *  canonical declaration; everything else derives from it.
 *
 *  Tickers are uppercase string literals.  The chain payload
 *  schema (orders, fees, attestations) uses these exact strings
 *  on the wire, so renaming one is a hard breaking change. */
export const ASSET_TICKERS = ['BTC', 'XMR', 'BLURT', 'USDT', 'USDC', 'DAI', 'BCH', 'LTC', 'DASH', 'DOGE', 'ZEC', 'ARRR', 'DCR', 'SOL', 'ETH', 'XRP'] as const;

/** TypeScript type union derived from the ASSET_TICKERS list.
 *  Use this as the type of any field that holds an asset
 *  identifier — handler params, API response columns,
 *  frontend props.  Never spell out the union manually
 *  ('BTC' | 'XMR' | 'BLURT') — that's how the pre-collapse
 *  duplication started. */
export type AssetTicker = (typeof ASSET_TICKERS)[number];

/** Per-asset chain-level metadata.  Frontend-only metadata
 *  (logos, accents, picker copy) lives in
 *  apps/web/src/lib/assets/registry.ts and EXTENDS this base. */
export interface AssetEntry {
	/** Wire-format ticker.  Uppercase string literal that appears
	 *  in chain operations, API responses, and database columns.
	 *  Renaming an entry is a HARD breaking change — chain history
	 *  embeds the old ticker forever. */
	readonly ticker: AssetTicker;
	/** Number of decimal places the asset's smallest on-chain unit
	 *  represents.  BTC: 8 (satoshi).  XMR: 12 (piconero).
	 *  BLURT: 3 (milliBLURT, the Graphene serialized format).  Used
	 *  by amount-formatters and by chain-fee jitter generators. */
	readonly decimals: number;
	/** True if the asset is the chain Morphit COORDINATES on (i.e.
	 *  the chain whose accounts and transactions are the source-of-
	 *  record for orders, feedback, etc.).  Today: only BLURT.  At
	 *  most one asset can have this flag. */
	readonly isCoordinationChain: boolean;
	/** True if the asset can be the OFFERED side of a trade
	 *  (`side: 'sell'` posts an offer to sell this asset).  Almost
	 *  always true; reserved for future "fee-only" or
	 *  "stable-only" tickers. */
	readonly canBeTraded: boolean;
	/** True if the asset can be used to PAY the listing fee.
	 *
	 *  ARCHITECTURAL INVARIANT (memory #23, 2026-05-13): listing
	 *  fees can ONLY be paid in BLURT, XMR, or BTC.  New tradable
	 *  assets (USDT, ARRR, etc.) are peer-to-peer TRADING ONLY —
	 *  never used to pay listing fees, cold-message fees, or
	 *  featured-slot bids.  Trade-only assets MUST set this to
	 *  `false`.  The `fee-method-enum-frozen-smoke.ts` smoke
	 *  enforces the indexer's `fee_method` union stays at exactly
	 *  `'blurt' | 'waived_first_buy' | 'btc' | 'xmr'` to lock the
	 *  invariant in the wire format.
	 *
	 *  BTC/XMR depend on the operator's external-tx-id verifier
	 *  setup at runtime, but the registry says "the protocol
	 *  permits it." */
	readonly canPayListingFee: boolean;
	/** Networks this asset is supported on.  Single-network assets
	 *  (BTC, XMR, BLURT) use `['mainnet']`.  Multi-network assets
	 *  (USDT exists on Ethereum/ERC-20, Tron/TRC-20, Solana/SPL,
	 *  etc.) list each network as a separate string.  The buyer
	 *  and seller MUST agree on which network at trade time —
	 *  cross-network sends (USDT-ERC20 to a TRC-20 address) lose
	 *  funds permanently.  The address-share modal renders a
	 *  network picker only when `supportedNetworks.length > 1`,
	 *  and emits a per-network warning in chat. */
	readonly supportedNetworks: readonly string[];
	/** Default network if the asset is multi-network.  `null`
	 *  forces explicit user choice every trade (the safest stance
	 *  for cross-chain-mis-send-prone assets like USDT).  Single-
	 *  network assets set this to their only network for
	 *  convenience. */
	readonly defaultNetwork: string | null;
	/** Optional i18n key for a privacy / decentralization warning
	 *  chip shown in the post-order form and address-share modal.
	 *  `null` for assets with meaningful on-chain privacy (XMR) or
	 *  fully-decentralized chains (BTC, BLURT).  Non-null for
	 *  transparent / centrally-controllable assets (Tether can
	 *  freeze any USDT address; USDT-ERC20 is blockchain-analytics
	 *  -tagged).  The locale value behind the key is the warning
	 *  text the user sees.  Per memory #19 (privacy #1), users
	 *  must be told when an asset they're considering is not
	 *  private. */
	readonly privacyWarningKey: string | null;
	/** Part 122 cp26 — Privacy-practices metadata.  Even on
	 *  fully-decentralized transparent chains (BTC/BCH/LTC/BLURT)
	 *  users can take wallet-side and trade-flow steps to reduce
	 *  on-chain linkability of their trades.  This field drives
	 *  the per-asset privacy guide page (`/[lang]/privacy/{asset}`)
	 *  and surfaces relevant nudges (fresh-address advice, opt-in
	 *  privacy techs) in the post-order + address-share UX.
	 *
	 *  Registry-driven so future asset additions (Dash, DOGE,
	 *  etc.) get the privacy framework automatically by
	 *  populating this struct.
	 *
	 *  `freshAddressAdvice`: how the user gets a fresh receive
	 *  address on this chain.  `'subaddress'` (XMR — wallet
	 *  generates a fresh subaddress per trade, recipient verifies
	 *  with view key); `'hd-derived'` (UTXO chains — BIP-32
	 *  derivation in any HD wallet); `'account-reuse'` (BLURT —
	 *  account-based, fresh-account-per-trade not grandma-
	 *  friendly, accept lower privacy posture).
	 *
	 *  `optInPrivacyTech`: array of standard opt-in privacy
	 *  technologies the chain supports.  Identifiers are
	 *  protocol names, NOT wallet names (Morphit deliberately
	 *  doesn't recommend specific wallets — even reputable ones
	 *  get compromised).  Currently used: 'mweb' (LTC
	 *  MimbleWimble Extension Blocks, native chain feature),
	 *  'cashfusion' (BCH community CoinJoin variant with
	 *  amount-randomization), 'coinjoin' (generic mixing protocol
	 *  family, BTC and most UTXO chains), 'payjoin' (BIP-78,
	 *  cooperative-input CoinJoin breaking common-input-ownership
	 *  heuristic, BTC and forks), 'privatesend' (Dash-specific
	 *  CoinJoin variant using denominated input/output amounts +
	 *  masternode coordination, pre-mix or per-send).  `null` for assets without opt-in privacy tech
	 *  (USDT, BLURT) or assets that are already private (XMR).
	 *
	 *  `privacyGuideKey`: i18n key prefix for the per-asset
	 *  privacy guide page content.  Pages live at
	 *  `/[lang]/privacy/{asset_lower}` and pull copy from
	 *  `privacy.guides.{asset_lower}.*`. */
	readonly privacyFeatures: {
		readonly freshAddressAdvice: 'subaddress' | 'hd-derived' | 'account-reuse';
		readonly optInPrivacyTech:
			| readonly ('mweb' | 'cashfusion' | 'coinjoin' | 'payjoin' | 'privatesend' | 'shielded-pools' | 'csppmix')[]
			| null;
		readonly privacyGuideKey: string;
	};
	/** Address shape — a permissive regex that matches well-formed
	 *  addresses for this asset.  Used by frontend forms for inline
	 *  typo detection.  Indexer-side and explorer-side verification
	 *  always happens independently — never trust the regex alone
	 *  for a security-relevant decision.
	 *
	 *  For multi-network assets, this regex must match a VALID
	 *  address on ANY of the supported networks; per-network
	 *  validation happens in the frontend address-share modal
	 *  via per-network regexes (see lib/assets/networks.ts).
	 *
	 *  For BLURT, this matches the account-name format because
	 *  BLURT transfers route by account name, not a hex address.
	 *
	 *  IMPORTANT: A regex match is NOT a checksum.  A user-supplied
	 *  address that passes this regex can still be wrong (bit-flip
	 *  in the address bar, malicious paste).  The regex defends
	 *  against form typos, not malice — receiver-side verification
	 *  in their wallet is the real check. */
	readonly addressShape: RegExp;
}

/**
 * The canonical asset registry.  Order is significant for UI
 * display (Monero first per the project's privacy-first audience
 * statement; Bitcoin second; BLURT last as the coordination
 * chain) but the iteration order shouldn't be relied on for
 * correctness — use isCoordinationChain / canBeTraded / etc.
 * predicates instead.
 *
 * Each entry is `Object.freeze`d at module load, and the array
 * itself is also frozen.  A `readonly` type alone is a
 * compile-time hint; freezing makes runtime mutation throw in
 * strict mode (and silently no-op in non-strict — either way
 * the registry stays canonical).  This is a defense-in-depth
 * step: a TypeScript-blind consumer (a JS file or a `(x as any)`
 * escape hatch) can't corrupt the registry's invariants.
 */
export const ASSETS: ReadonlyArray<AssetEntry> = Object.freeze([
	Object.freeze({
		ticker: 'XMR',
		decimals: 12,
		isCoordinationChain: false,
		canBeTraded: true,
		canPayListingFee: true,
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// XMR provides meaningful on-chain privacy by design;
		// no warning chip needed.
		privacyWarningKey: null,
		privacyFeatures: {
			freshAddressAdvice: 'subaddress',
			optInPrivacyTech: null,
			privacyGuideKey: 'xmr'
		},
		// Standard primary (4...), subaddress (8...), or integrated
		// (4... longer).  Source: Monero address spec.  Not a
		// checksum — wallet does that.
		addressShape:
			/^(4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}|8[0-9A-B][1-9A-HJ-NP-Za-km-z]{93}|4[1-9A-HJ-NP-Za-km-z]{105})$/
	}),
	Object.freeze({
		ticker: 'BTC',
		decimals: 8,
		isCoordinationChain: false,
		canBeTraded: true,
		canPayListingFee: true,
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// BTC is transparent but the chain is fully decentralized
		// and Bitcoin addresses cannot be frozen by an issuer.  No
		// warning chip — users opt into Bitcoin knowing its trace-
		// ability properties.
		privacyWarningKey: null,
		privacyFeatures: {
			freshAddressAdvice: 'hd-derived',
			optInPrivacyTech: ['coinjoin', 'payjoin'],
			privacyGuideKey: 'btc'
		},
		// P2PKH (1...), P2SH (3...), or Bech32 (bc1...).
		// Excludes P2TR for now — receiver wallets that support
		// taproot will accept Bech32 too.
		// Bech32 charset is BIP-173: 0-9 a-z minus {1, b, i, o}.
		addressShape:
			/^(1[1-9A-HJ-NP-Za-km-z]{25,34}|3[1-9A-HJ-NP-Za-km-z]{25,34}|bc1[023456789acdefghjklmnpqrstuvwxyz]{6,87})$/
	}),
	Object.freeze({
		ticker: 'BLURT',
		decimals: 3,
		isCoordinationChain: true,
		canBeTraded: true,
		canPayListingFee: true,
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// BLURT is Morphit's own coordination chain; transparent
		// by design but no issuer can freeze accounts.  No warning
		// chip.
		privacyWarningKey: null,
		privacyFeatures: {
			freshAddressAdvice: 'account-reuse',
			optInPrivacyTech: null,
			privacyGuideKey: 'blurt'
		},
		// Blurt account name: 3-16 chars, must start/end with
		// alphanumeric, lowercase + dashes only.
		addressShape: /^[a-z][a-z0-9-]{1,14}[a-z0-9]$/
	}),
	Object.freeze({
		ticker: 'USDT',
		// Tether uses 6 decimals on EVERY supported network (ERC-20,
		// TRC-20, SPL, BEP-20).  Confirmed via Tether's contract
		// docs: 0xdac17f958d2ee523a2206206994597c13d831ec7 on
		// Ethereum exposes decimals()=6, same on all other chains.
		decimals: 6,
		isCoordinationChain: false,
		canBeTraded: true,
		// MEMORY #23 INVARIANT: USDT is trade-only.  It cannot pay
		// listing fees, cold-message fees, or featured-slot bids.
		// The asset-registry-smoke + fee-method-enum-frozen-smoke
		// pin this from two directions.
		canPayListingFee: false,
		// Networks shipped at launch.  Native USDT only — bridged
		// variants (USDT.e on Avalanche L2 etc.) are deliberately
		// excluded per Ken's design decision: fewer footguns,
		// cleaner mental model.  Omni Layer is deprecated by
		// Tether themselves and excluded.  If a future network
		// gains material P2P-trading adoption, add it here AND
		// update apps/web/src/lib/assets/networks.ts with the
		// matching addressShape + txidShape + bundled explorer.
		supportedNetworks: ['erc20', 'trc20', 'spl', 'bep20'],
		// `null` forces the user to pick the network explicitly
		// every trade.  USDT is multi-network with INCOMPATIBLE
		// address formats — sending USDT-ERC20 to a TRC-20 address
		// loses funds permanently.  We refuse to default the user
		// into one of those losses.
		defaultNetwork: null,
		// Renders the privacy-warning chip in the post-order form
		// and the address-share modal.  Text lives in i18n
		// (assets.privacy_warnings.usdt_centralized).
		privacyWarningKey: 'usdt_centralized',
		privacyFeatures: {
			freshAddressAdvice: 'hd-derived',
			optInPrivacyTech: null,
			privacyGuideKey: 'usdt'
		},
		// Combined regex matching a VALID address on ANY of the
		// supported networks.  Per-network validation happens in
		// apps/web/src/lib/assets/networks.ts via per-network
		// regexes — this combined one is just the form-level
		// "is this even plausibly an address" check.
		//   - ERC-20 + BEP-20: 0x + 40 hex chars (Ethereum address)
		//   - TRC-20: T + 33 base58 chars (Tron address)
		//   - SPL: base58 32-44 chars (Solana pubkey, no prefix)
		addressShape:
			/^(0x[a-fA-F0-9]{40}|T[1-9A-HJ-NP-Za-km-z]{33}|[1-9A-HJ-NP-Za-km-z]{32,44})$/
	}),
	Object.freeze({
		ticker: 'USDC',
		// Circle's USDC uses 6 decimals on EVERY supported network
		// (Ethereum ERC-20, Solana SPL, Base, Polygon PoS).
		// Confirmed via Circle's contract registry: each chain's
		// USDC token contract exposes decimals()=6.  Matches USDT's
		// precision so the form-level amount handling is identical
		// between the two stablecoins.
		decimals: 6,
		isCoordinationChain: false,
		canBeTraded: true,
		// MEMORY #23 INVARIANT: USDC is trade-only.  It cannot pay
		// listing fees, cold-message fees, or featured-slot bids.
		// fee_method enum is frozen at BLURT/BTC/XMR; USDC joins
		// USDT/DAI/BCH/LTC/DASH/DOGE as Category-B trade-only assets.
		canPayListingFee: false,
		// Networks shipped at launch.  Native USDC only — bridged
		// variants (USDC.e on Avalanche / Optimism / Arbitrum,
		// USDbC, etc.) are deliberately excluded per the same
		// design decision as USDT: fewer footguns, cleaner mental
		// model.  Notably NO TRC-20: Circle has formally distanced
		// from Tron, and BEP-20 is excluded from this initial set
		// per the operator's canonical network list (the four chain-
		// specific block-explorer URLs supplied at addition time);
		// see ADR-0028 for the full network-set rationale.  If a
		// future network gains material P2P-trading adoption, add
		// it here AND update apps/web/src/lib/assets/networks.ts
		// with the matching addressShape + txidShape + bundled
		// explorer template.
		supportedNetworks: ['erc20', 'spl', 'base', 'polygon'],
		// `null` forces the user to pick the network explicitly
		// every trade.  USDC is multi-network with INCOMPATIBLE
		// address formats across the SPL chain — sending USDC on
		// Solana to an Ethereum-style 0x address loses funds
		// permanently.  Note that ERC-20 + Base + Polygon SHARE
		// the EVM 0x address format, so an address looks
		// indistinguishable between those three at the format
		// level — the network picker exists precisely to disambiguate
		// which chain the sender's wallet should broadcast on.
		defaultNetwork: null,
		// Renders the privacy-warning chip in the post-order form
		// and the address-share modal.  Same "centralized
		// stablecoin" warning shape as USDT — Circle can freeze
		// addresses on regulatory request just like Tether can.
		// Text lives in i18n (assets.privacy_warnings.usdc_centralized).
		privacyWarningKey: 'usdc_centralized',
		privacyFeatures: {
			freshAddressAdvice: 'hd-derived',
			optInPrivacyTech: null,
			privacyGuideKey: 'usdc'
		},
		// Combined regex matching a VALID address on ANY of the
		// supported networks.  Per-network validation happens in
		// apps/web/src/lib/assets/networks.ts via per-network
		// regexes — this combined one is just the form-level
		// "is this even plausibly an address" check.
		//   - ERC-20 + Base + Polygon: 0x + 40 hex chars (all EVM)
		//   - SPL: base58 32-44 chars (Solana pubkey, no prefix)
		// Note no Tron-style T-prefix branch since USDC isn't
		// issued on Tron by Circle.
		addressShape:
			/^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/
	}),
	Object.freeze({
		ticker: 'DAI',
		// MakerDAO's DAI uses 18 decimals on every supported network
		// — the EVM-standard ERC-20 precision.  Different from USDT
		// and USDC (which use 6 decimals because Tether/Circle chose
		// that for cheaper math at small amounts).  Higher decimals
		// means more microunit-jitter resolution: the same 0-999
		// microunit range we use for 6-decimal stablecoins gives
		// $0.001 jitter on USDT/USDC; for 18-decimal DAI the
		// equivalent micro-dollar resolution is 0-999 _trillionths_
		// of a DAI, which is far below any rounding the wallet UIs
		// surface.  The jitter routine clamps to 6-decimal display
		// precision regardless of the underlying token's decimals,
		// so the user-visible jitter is the same $0.001-magnitude
		// effect across all three stablecoins.
		decimals: 18,
		isCoordinationChain: false,
		canBeTraded: true,
		// MEMORY #23 INVARIANT: DAI is trade-only.  It cannot pay
		// listing fees, cold-message fees, or featured-slot bids.
		// fee_method enum is frozen at BLURT/BTC/XMR; DAI joins
		// USDT/USDC/BCH/LTC/DASH/DOGE as Category-B trade-only assets.
		// See ADR-0029 §4 for the rationale.
		canPayListingFee: false,
		// Networks shipped at launch: Ethereum, Polygon (PoS), Base,
		// Arbitrum One.  All four are canonical MakerDAO-issued
		// contracts on those chains (verified via the contract
		// addresses on each chain's explorer).  Notable exclusions:
		//   - Solana SPL: no canonical Maker-issued DAI on Solana.
		//     Existing Solana DAI variants are bridged/wrapped (e.g.,
		//     Wormhole, Allbridge); using them would add wrapper-
		//     custodian trust which defeats DAI's decentralization
		//     rationale.
		//   - Tron TRC-20: same — no canonical Maker DAI.
		//   - BNB Smart Chain (BEP-20): Binance-Peg DAI is wrapped
		//     not Maker-native; same exclusion rationale as USDC's
		//     BEP-20 (ADR-0028 §1).
		//   - Arbitrum Nova: only Arbitrum One ships in cp31; Nova
		//     is a separate chain with different security
		//     assumptions and is a separate decision.
		// See ADR-0029 §1 for the full network-set rationale.  If
		// MakerDAO ships native DAI on a new chain in the future,
		// add it here AND update apps/web/src/lib/assets/networks.ts
		// with the matching addressShape + txidShape + bundled
		// explorer template.
		supportedNetworks: ['erc20', 'polygon', 'base', 'arbitrum'],
		// `null` forces the user to pick the network explicitly
		// every trade.  All four DAI networks use the EVM 0x[40 hex]
		// address format, so they're visually IDENTICAL — the
		// network picker exists precisely to disambiguate which
		// chain the sender's wallet should broadcast on.  Cross-
		// network mis-send risk is the same class as USDC's three
		// EVM networks (ADR-0028); ADR-0029 §3 documents the
		// per-message warning surface for this asset.
		defaultNetwork: null,
		// Renders the privacy-warning chip in the post-order form
		// and the address-share modal.  DISTINCT from the USDT/USDC
		// `*_centralized` warning class — DAI has no direct address-
		// freeze power at the token contract level (MakerDAO can't
		// blacklist addresses the way Tether or Circle can).  But
		// DAI does have a Peg Stability Module (PSM) that holds USDC
		// as collateral, so when DAI's peg is supported by USDC,
		// Circle's freeze power transitively affects DAI redeemability.
		// The warning key reflects that nuance.  Text lives in i18n
		// (assets.privacy_warnings.dai_partly_centralized).
		// See ADR-0029 §2 for the design rationale on tone + content.
		privacyWarningKey: 'dai_partly_centralized',
		privacyFeatures: {
			freshAddressAdvice: 'hd-derived',
			optInPrivacyTech: null,
			privacyGuideKey: 'dai'
		},
		// Combined regex matching a VALID address on ANY of the
		// supported networks.  All four are EVM-style 0x[40 hex],
		// so the combined check is just the EVM address shape.
		// Per-network validation happens in
		// apps/web/src/lib/assets/networks.ts via per-network
		// regexes — this combined one is the form-level "is this
		// even plausibly an address" check.
		addressShape: /^0x[a-fA-F0-9]{40}$/
	}),
	Object.freeze({
		ticker: 'BCH',
		// Bitcoin Cash uses the same 8-decimal smallest unit as
		// Bitcoin (satoshi).  Confirmed via the BCH protocol
		// specification — BCH forked from BTC at block 478,558 and
		// preserved the satoshi-denominated amount semantics.
		decimals: 8,
		isCoordinationChain: false,
		canBeTraded: true,
		// MEMORY #23 INVARIANT: BCH is trade-only.  It cannot pay
		// listing fees, cold-message fees, or featured-slot bids.
		// The fee_method enum stays frozen at {blurt, btc, xmr,
		// waived_first_buy}; bch-trade-only-smoke pins this from
		// the registry side, fee-method-enum-frozen-smoke pins it
		// from the wire-format side.
		canPayListingFee: false,
		// Single-network coin.  No network picker needed in the
		// post-order form or address-share modal — defaults to
		// mainnet and stays there.
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// BCH is transparent (like BTC), but the chain is fully
		// decentralized and BCH addresses cannot be frozen by an
		// issuer.  Same posture as BTC: no warning chip needed.
		// Users opt into Bitcoin Cash knowing its traceability
		// properties.
		privacyWarningKey: null,
		privacyFeatures: {
			freshAddressAdvice: 'hd-derived',
			optInPrivacyTech: ['cashfusion'],
			privacyGuideKey: 'bch'
		},
		// CashAddr format (modern BCH standard) + legacy P2PKH/P2SH
		// (still accepted by most BCH wallets):
		//   - CashAddr with `bitcoincash:` prefix: 12-char prefix +
		//     42-char body (starts with q for P2PKH or p for P2SH,
		//     followed by 41 lowercase base32 chars).
		//   - CashAddr without prefix: same 42-char body alone.
		//   - Legacy P2PKH: starts with 1, 26-35 chars (same shape
		//     as BTC legacy).
		//   - Legacy P2SH: starts with 3, 26-35 chars.
		// CashAddr is case-insensitive but conventionally lowercase;
		// we accept lowercase only at the regex layer (wallets
		// normalize).  Permissive shape check — not a checksum
		// (BCH wallet does that on the receiving end).
		addressShape:
			/^(bitcoincash:[qp][a-z0-9]{41}|[qp][a-z0-9]{41}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/
	}),
	Object.freeze({
		ticker: 'LTC',
		// Litecoin uses the same 8-decimal smallest unit as Bitcoin
		// (litoshi == satoshi).  Confirmed via the Litecoin protocol
		// specification — LTC forked from BTC's codebase in 2011
		// and preserved the satoshi-denominated amount semantics
		// (just renamed "litoshi" for clarity).
		decimals: 8,
		isCoordinationChain: false,
		canBeTraded: true,
		// MEMORY #23 INVARIANT: LTC is trade-only.  It cannot pay
		// listing fees, cold-message fees, or featured-slot bids.
		// The fee_method enum stays frozen at {blurt, btc, xmr,
		// waived_first_buy}; ltc-trade-only-smoke pins this from
		// the registry side, fee-method-enum-frozen-smoke pins it
		// from the wire-format side.
		canPayListingFee: false,
		// Single-network coin.  No network picker needed in the
		// post-order form or address-share modal — defaults to
		// mainnet and stays there.
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// LTC is transparent (like BTC), but the chain is fully
		// decentralized and LTC addresses cannot be frozen by an
		// issuer.  Same posture as BTC and BCH: no warning chip
		// needed.  LTC ships an opt-in privacy upgrade — MWEB —
		// at the wallet level on a per-transaction basis.
		privacyWarningKey: null,
		privacyFeatures: {
			freshAddressAdvice: 'hd-derived',
			optInPrivacyTech: ['mweb'],
			privacyGuideKey: 'ltc'
		},
		// LTC address formats (chronological evolution):
		//   - Legacy P2PKH: starts with `L`, 26-35 chars base58
		//     (unambiguous with BTC since BTC P2PKH starts with 1).
		//   - Legacy P2SH: starts with `M`, 26-35 chars base58
		//     (modern Litecoin P2SH; introduced 2017 to disambiguate
		//     from the deprecated 3-prefix form which is BTC-shape
		//     ambiguous — see ADR-0025 §4).
		//   - Legacy P2SH (deprecated 3-prefix): still valid on the
		//     LTC chain; accepted here to match ADR-0024 §4 stance
		//     for BCH (wallet does chain-binding on receive).
		//   - Bech32/Bech32m: starts with `ltc1`, 6-87 chars body.
		//     Lowercase canonical (mixed-case forbidden by BIP-173);
		//     covers both segwit-v0 (ltc1q...) and taproot
		//     (ltc1p...).
		// Permissive shape check — not a checksum (LTC wallet does
		// that on the receiving end).
		addressShape:
			/^(L[1-9A-HJ-NP-Za-km-z]{25,34}|M[1-9A-HJ-NP-Za-km-z]{25,34}|3[1-9A-HJ-NP-Za-km-z]{25,34}|ltc1[02-9ac-hj-np-z]{6,87})$/
	}),
	Object.freeze<AssetEntry>({
		ticker: 'DASH',
		// Dash uses 8 decimals — "duff" is Dash's smallest unit,
		// satoshi-scale.  Confirmed via Dash Core protocol docs
		// (1 DASH = 100_000_000 duffs).
		decimals: 8,
		isCoordinationChain: false,
		canBeTraded: true,
		// MEMORY #23 INVARIANT: DASH is trade-only.  It cannot pay
		// listing fees, cold-message fees, or featured-slot bids.
		// The fee_method enum stays frozen at {blurt, btc, xmr,
		// waived_first_buy}; dash-trade-only-smoke pins this from
		// the registry side, fee-method-enum-frozen-smoke pins it
		// from the wire-format side.
		canPayListingFee: false,
		// Single-network coin.  No network picker needed in the
		// post-order form or address-share modal — defaults to
		// mainnet and stays there.
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// DASH is transparent at the base layer (like BTC/BCH/LTC),
		// fully decentralized, and addresses cannot be frozen by
		// an issuer.  PrivateSend (a Dash-specific CoinJoin
		// variant coordinated by masternodes) provides opt-in
		// privacy at the wallet level — users who pre-mix via
		// PrivateSend before sending get meaningful unlinkability
		// at moderate trade-off (extra rounds = stronger anonymity
		// set + higher fee).  No warning chip needed; same posture
		// as BTC/BCH/LTC.
		privacyWarningKey: null,
		privacyFeatures: {
			freshAddressAdvice: 'hd-derived',
			optInPrivacyTech: ['privatesend'],
			privacyGuideKey: 'dash'
		},
		// DASH address formats:
		//   - P2PKH (most common): starts with `X`, base58, 34
		//     chars total (33 after the X prefix).
		//   - P2SH (multisig, less common): starts with `7`, same
		//     length as P2PKH.
		// Both share the same length + base58 alphabet; the
		// version byte differs.  No bech32-equivalent native to
		// Dash — the chain stayed on base58 P2PKH/P2SH.
		// Permissive shape check; chain-binding happens on the
		// receiving wallet side.
		addressShape: /^[X7][1-9A-HJ-NP-Za-km-z]{33}$/
	}),
	Object.freeze<AssetEntry>({
		ticker: 'DOGE',
		// Dogecoin uses 8 decimals — "shibatoshi" (joke name, but
		// canonical) is Dogecoin's smallest unit, satoshi-scale.
		// 1 DOGE = 100_000_000 shibatoshi.  Confirmed via Dogecoin
		// Core protocol docs.
		decimals: 8,
		isCoordinationChain: false,
		canBeTraded: true,
		// MEMORY #23 INVARIANT: DOGE is trade-only.  It cannot pay
		// listing fees, cold-message fees, or featured-slot bids.
		// The fee_method enum stays frozen at {blurt, btc, xmr,
		// waived_first_buy}; doge-trade-only-smoke pins this from
		// the registry side, fee-method-enum-frozen-smoke pins it
		// from the wire-format side.
		canPayListingFee: false,
		// Single-network coin.  No network picker needed in the
		// post-order form or address-share modal — defaults to
		// mainnet and stays there.  (Dogecoin has no L2s with
		// formal community endorsement; the chain itself is the
		// only canonical home for DOGE the asset.)
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// DOGE is transparent at the base layer (like BTC/BCH/LTC),
		// fully decentralized via PoW (auxiliary-PoW merge-mined
		// with Litecoin since 2014), and addresses cannot be
		// frozen by an issuer.  No issuer at all — fair-launched,
		// no premine after the initial 100 billion coins were
		// emitted in the first year, then settled at a fixed
		// 5 billion DOGE/year tail emission for security funding.
		// No warning chip needed; same posture as BTC/BCH/LTC.
		privacyWarningKey: null,
		privacyFeatures: {
			freshAddressAdvice: 'hd-derived',
			optInPrivacyTech: null,
			privacyGuideKey: 'doge'
		},
		// DOGE address formats:
		//   - P2PKH (overwhelmingly common): starts with `D`,
		//     base58, 34 chars total (33 after the D prefix).
		//     Version byte 0x1E.
		//   - P2SH (multisig, rare in DOGE): starts with `9` or
		//     `A`, base58, 34 chars total.  Version byte 0x16.
		// All three share the same length + base58 alphabet; the
		// version byte differs.  No bech32 / segwit support —
		// Dogecoin Core has never activated segwit (still on
		// pre-segwit legacy chain semantics as of 2026-05).
		// Permissive shape check; chain-binding happens on the
		// receiving wallet side.
		addressShape: /^[D9A][1-9A-HJ-NP-Za-km-z]{33}$/
	}),
	Object.freeze<AssetEntry>({
		ticker: 'ZEC',
		// Zcash uses 8 decimals — "zatoshi" is Zcash's smallest
		// unit, satoshi-scale.  1 ZEC = 100_000_000 zatoshi.
		// Confirmed via Zcash protocol specification.
		decimals: 8,
		isCoordinationChain: false,
		canBeTraded: true,
		// MEMORY #23 INVARIANT: ZEC is trade-only.  It cannot pay
		// listing fees, cold-message fees, or featured-slot bids.
		// The fee_method enum stays frozen at {blurt, btc, xmr,
		// waived_first_buy}; zec-trade-only-smoke pins this from
		// the registry side, fee-method-enum-frozen-smoke pins it
		// from the wire-format side.
		canPayListingFee: false,
		// Single-network coin.  No network picker needed in the
		// post-order form or address-share modal — defaults to
		// mainnet and stays there.  (Zcash has testnet and
		// regtest networks for development but the only canonical
		// home for ZEC the asset is mainnet.)
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// Zcash is fully decentralized via PoW (Equihash variant,
		// halving schedule matching Bitcoin's), and addresses
		// cannot be frozen by an issuer.  Zcash supports both
		// transparent addresses (t1/t3, base58-encoded, similar
		// shape to Bitcoin's legacy addresses) and shielded
		// addresses using zero-knowledge proofs — Sapling pool
		// (zs1, bech32, ~78 chars) and Unified addresses (u1,
		// variable length, bundling Orchard + optional Sapling +
		// transparent receivers).  Per-address privacy: senders
		// and receivers can pick t-addr for transparent visibility
		// or z/u-addr for shielded transactions.  Both are
		// first-class on the protocol.  No warning chip needed;
		// the chain is decentralized and the privacy choice is
		// the user's per address.
		privacyWarningKey: null,
		privacyFeatures: {
			freshAddressAdvice: 'hd-derived',
			optInPrivacyTech: ['shielded-pools'],
			privacyGuideKey: 'zec'
		},
		// ZEC address formats:
		//   - t1 (transparent P2PKH): base58, ~35 chars total.
		//   - t3 (transparent P2SH, multisig): base58, ~35 chars.
		//   - zs1 (Sapling shielded): bech32, 78 chars total (zs1
		//     prefix + 75 bech32 data chars).
		//   - u1 (Unified Address bundling Orchard + optional
		//     Sapling/transparent receivers): bech32m, variable
		//     length (typically 90–300 chars depending on what's
		//     bundled).
		// Permissive shape check covering all four; chain-binding
		// happens on the receiving wallet side.  Bech32 alphabet
		// excludes `1`, `b`, `i`, `o` to avoid visual ambiguity
		// (we use [02-9ac-hj-np-z] for the bech32 data portion,
		// matching the LTC MWEB pattern).
		addressShape: /^(t[13][1-9A-HJ-NP-Za-km-z]{33}|zs1[02-9ac-hj-np-z]{75}|u1[02-9ac-hj-np-z]{30,300})$/
	}),
	Object.freeze<AssetEntry>({
		ticker: 'ARRR',
		// Pirate Chain uses 8 decimals — same smallest-unit semantics
		// as the BTC family.  Confirmed via Pirate Chain protocol
		// (forked from Zcash's Sapling codebase which inherited
		// Bitcoin's 8-decimal convention).
		decimals: 8,
		isCoordinationChain: false,
		canBeTraded: true,
		// MEMORY #23 INVARIANT: ARRR is trade-only.  It cannot pay
		// listing fees, cold-message fees, or featured-slot bids.
		// The fee_method enum stays frozen at {blurt, btc, xmr,
		// waived_first_buy}; arrr-trade-only-smoke pins this from
		// the registry side, fee-method-enum-frozen-smoke pins it
		// from the wire-format side (already lists 'arrr' as a
		// FORBIDDEN_TICKER for the fee_method axis).
		canPayListingFee: false,
		// Single-network coin.  Pirate Chain runs one mainnet
		// canonical chain.  No network picker shown.
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// Pirate Chain runs PoW (Equihash variant inherited from
		// Zcash); addresses cannot be frozen by an issuer.  The
		// chain operates on a default-shielded model: every
		// transaction goes through the Sapling shielded pool via
		// zk-SNARK proofs.  Sender, recipient, and amount are
		// hidden on-chain by construction.  No transparent
		// address type — only Sapling shielded (`zs1`-prefixed
		// bech32 addresses, 78 chars total).  No warning chip
		// needed; the chain is decentralized.
		privacyWarningKey: null,
		privacyFeatures: {
			// Sapling addresses derive from HD seeds in modern
			// Pirate Chain wallets.  Standard "fresh address per
			// trade" advice applies — using a new HD-derived
			// shielded address per trade defeats wallet-side
			// linkability that survives chain-level shielding
			// (the on-chain payload is private; what users SHARE
			// off-chain is what links trades together).
			freshAddressAdvice: 'hd-derived',
			// Pirate Chain's shielded pool is chain-level by
			// default (not opt-in like Zcash's), but the
			// underlying tech is the same Sapling zk-SNARK pool.
			// Per the privacy framework, `shielded-pools` is the
			// canonical tech tag for the Sapling protocol family.
			// (ARRR's default-shielded posture is reflected in
			// the per-asset guide content, not in the tech-tag
			// taxonomy.)
			optInPrivacyTech: ['shielded-pools'],
			privacyGuideKey: 'arrr'
		},
		// Pirate Chain Sapling address format:
		//   - `zs1` prefix + 75 bech32 data chars = 78 chars total
		// Same shape as Zcash Sapling addresses (visually
		// indistinguishable — context from the order/asset field
		// disambiguates).  Bech32 alphabet excludes `1`, `b`,
		// `i`, `o` to avoid visual ambiguity (we use
		// [02-9ac-hj-np-z] for the data portion, matching the
		// LTC MWEB and Zcash Sapling patterns).
		addressShape: /^zs1[02-9ac-hj-np-z]{75}$/
	}),
	Object.freeze<AssetEntry>({
		ticker: 'DCR',
		// Decred uses 8 decimals — same smallest-unit semantics as
		// the BTC family (Decred forked from a Bitcoin-derived
		// codebase in 2016 and inherited the 8-decimal convention).
		decimals: 8,
		isCoordinationChain: false,
		canBeTraded: true,
		// MEMORY #23 INVARIANT: DCR is trade-only.  It cannot pay
		// listing fees, cold-message fees, or featured-slot bids.
		// The fee_method enum stays frozen at {blurt, btc, xmr,
		// waived_first_buy}; dcr-trade-only-smoke pins this from
		// the registry side, fee-method-enum-frozen-smoke pins it
		// from the wire-format side.
		canPayListingFee: false,
		// Single-network coin.  Decred has a testnet but Morphit
		// trades only on mainnet (consistent with BCH/LTC/DASH/DOGE/
		// ZEC/ARRR — none of those run testnet on Morphit either).
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// Decred runs a hybrid Proof-of-Work + Proof-of-Stake
		// consensus (PoW miners + PoS ticket-holder voting on
		// every block).  On-chain governance (Politeia) lets
		// stakeholders propose and ratify protocol changes.
		// Addresses cannot be frozen by an issuer — fully
		// decentralized.  The chain is transparent at the base
		// layer (sender, recipient, and amount visible on chain)
		// but offers an opt-in mixing protocol (CoinShuffle++ /
		// CSPP, integrated in dcrwallet) for users who want
		// transaction-level privacy.  No warning chip needed;
		// the chain is decentralized.
		privacyWarningKey: null,
		privacyFeatures: {
			// Decred addresses derive from HD seeds in modern
			// wallets (dcrwallet, Decrediton, Cake Wallet for DCR).
			// Standard "fresh address per trade" advice applies —
			// transparent base layer means address reuse is
			// directly visible on chain.
			freshAddressAdvice: 'hd-derived',
			// Decred's privacy story is its opt-in CoinShuffle++
			// (CSPP) mixing protocol integrated into dcrwallet.
			// Users can enable mixing in their wallet to break
			// the on-chain transaction graph between deposit and
			// withdrawal.  Similar in posture to Dash's PrivateSend
			// (opt-in, wallet-side, defeats chain-graph analysis)
			// or Bitcoin's coinjoin (off-protocol mixing).
			// New tech tag introduced at cp43.
			optInPrivacyTech: ['csppmix'],
			privacyGuideKey: 'dcr'
		},
		// Decred address format:
		//   - `Ds` prefix: P2PKH-Secp256k1 (most common receive addr)
		//   - `Dc` prefix: P2SH (multisig, escrow scripts)
		//   - 33 base58 data chars after the 2-char prefix
		//   - 35 chars total
		// Base58 alphabet excludes `0`, `O`, `I`, `l` to avoid
		// visual ambiguity (we use [1-9A-HJ-NP-Za-km-z] — same as
		// BTC/DASH/DOGE/ZEC-transparent patterns).
		// Other prefixes exist (`Dp` extended pubkey, `Dr` extended
		// privkey, `De` Edwards) but are NOT used for receiving
		// regular payments — Morphit rejects them.
		addressShape: /^D[sc][1-9A-HJ-NP-Za-km-z]{33}$/
	}),
	Object.freeze<AssetEntry>({
		ticker: 'SOL',
		// Solana uses 9 decimals — 1 SOL = 1,000,000,000 lamports.
		// Unique smallest-unit precision among Morphit's tradable assets
		// (BTC family is 8, USDT/USDC/DAI is 6, BLURT is 3, XMR is
		// 12).  A new jitterSolAmount handles 9-decimal precision
		// (see apps/web/src/lib/chat/payload.ts).
		decimals: 9,
		isCoordinationChain: false,
		canBeTraded: true,
		// MEMORY #23 INVARIANT: SOL is trade-only.  Cannot pay
		// listing fees, cold-message fees, or featured-slot bids.
		// fee_method enum stays frozen at {blurt, btc, xmr,
		// waived_first_buy}.  sol-trade-only-smoke pins this from
		// the registry side; fee-method-enum-frozen-smoke from the
		// wire-format side.
		canPayListingFee: false,
		// Single-network coin.  Solana has devnet/testnet but
		// Morphit trades only on mainnet-beta (consistent with
		// every other single-network asset).
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// Solana runs delegated Proof-of-Stake consensus with
		// high-throughput Proof-of-History sequencing.  Validators
		// stake SOL and are rotated; no central freeze authority.
		// The chain is transparent at the base layer (sender,
		// recipient, and amount visible on chain).  No native
		// mixing protocol — Solana's privacy story is at the
		// network layer (wallet UX and address rotation), not at
		// the protocol layer.  No warning chip needed; chain is
		// decentralized.
		privacyWarningKey: null,
		privacyFeatures: {
			// Solana addresses derive from HD seeds in modern
			// wallets (Phantom, Solflare, Cake Wallet for SOL,
			// Trust Wallet).  Standard "fresh address per trade"
			// advice applies — transparent base layer means
			// address reuse is directly visible on chain.
			freshAddressAdvice: 'hd-derived',
			// Solana has no native opt-in mixing protocol.
			// Wallet-side address rotation is the user's primary
			// privacy lever.  Convention is `null` (not empty
			// array) for "no opt-in protocol tech available" —
			// matches XMR's pattern.  Type union accepts `null`
			// or non-empty readonly array; privacy-features-
			// registry-smoke rejects empty arrays.
			optInPrivacyTech: null,
			privacyGuideKey: 'sol'
		},
		// Solana address format:
		//   - Public keys are 32 bytes, encoded as base58
		//   - 32-44 base58 chars (most are exactly 44 chars)
		//   - Base58 alphabet excludes `0`, `O`, `I`, `l`
		//   - Same character class as USDT-Solana and
		//     USDC-Solana addresses (the LL #50 same-format-
		//     different-chain class; context disambiguates at
		//     the order layer via the asset field)
		// PROGRAM-DERIVED ADDRESSES (PDAs) are also 32 bytes
		// base58 but are OFF-CURVE (no private key) — sending
		// SOL to a PDA generally works at the protocol level
		// but recipients can't move funds out unless the program
		// has a withdraw instruction.  Morphit accepts the shape
		// at the regex layer; receiver-side wallet UX is
		// responsible for warning about PDA destinations.
		addressShape: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
	}),
	Object.freeze<AssetEntry>({
		ticker: 'ETH',
		// Ethereum uses 18 decimals on-chain — 1 ETH = 10^18 wei.
		// SAME on-chain precision as DAI (both are EVM-native).
		// However, the cp31 DAI design choice (ADR-0029) clamps
		// jitter to 6-decimal display precision regardless of
		// the underlying token's decimals.  Cp47 jitterEthAmount
		// applies the same 6-decimal clamp: at $2500/ETH a 0-999
		// microether jitter range is $0.0025 max — the same
		// $0.001-magnitude jitter UX the stablecoins use.  This
		// is verified at cp46 asset-payload-precision-parity-
		// smoke with expectedJitterDecimals: 6 for ETH.
		decimals: 18,
		isCoordinationChain: false,
		canBeTraded: true,
		// MEMORY #23 INVARIANT: ETH is trade-only.  Cannot pay
		// listing fees, cold-message fees, or featured-slot bids.
		// fee_method enum stays frozen at {blurt, btc, xmr,
		// waived_first_buy}.  eth-trade-only-smoke pins this
		// from the registry side; fee-method-enum-frozen-smoke
		// from the wire-format side.
		canPayListingFee: false,
		// Single-network coin.  Ethereum has multiple testnets
		// (Sepolia, Holesky) but Morphit trades only on mainnet.
		// Layer-2 networks (Arbitrum, Optimism, Base) are SEPARATE
		// chains — Morphit doesn't treat ETH-on-Arbitrum as the
		// same asset as ETH-on-mainnet because the receive
		// address chain context differs.  If we later add L2
		// ETH, that ships as a multi-network expansion (similar
		// to USDT-on-{ERC20,TRC20,SPL,BEP-20}).
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// Ethereum runs Proof-of-Stake consensus (post-Merge,
		// September 2022).  Validators stake ETH and are rotated;
		// no central freeze authority.  The chain is transparent
		// at the base layer (sender, recipient, and amount visible
		// on chain).  No native mixing protocol — Ethereum's
		// privacy story is at the wallet/contract layer (fresh
		// addresses, off-chain coordination), not at the protocol
		// layer.  Tornado Cash was a notable mixer contract but
		// is sanctioned in many jurisdictions; Morphit doesn't
		// recommend or rely on it.  No warning chip needed;
		// chain is decentralized.
		privacyWarningKey: null,
		privacyFeatures: {
			// Ethereum addresses derive from HD seeds in modern
			// wallets (MetaMask, Rabby, Frame, Trust Wallet,
			// Rainbow).  Standard "fresh address per trade"
			// advice applies — transparent base layer means
			// address reuse is directly visible on chain.
			freshAddressAdvice: 'hd-derived',
			// Ethereum has no native opt-in mixing protocol.
			// Wallet-side address rotation is the user's primary
			// privacy lever.  Same convention as XMR and SOL —
			// `null` for "no opt-in protocol tech available".
			// Tornado Cash existed as an external contract-level
			// mixer but is sanctioned; Morphit doesn't advertise
			// it.
			optInPrivacyTech: null,
			privacyGuideKey: 'eth'
		},
		// Ethereum address format:
		//   - 20 bytes, hex-encoded with `0x` prefix
		//   - Exactly 42 chars including the `0x`
		//   - Hex chars are case-insensitive at the protocol
		//     layer; EIP-55 defines a mixed-case checksum
		//     scheme that wallet UX uses to detect typos
		//   - Morphit accepts both lowercase and mixed-case
		//     (EIP-55 checksum), since both round-trip identically
		//     to the same on-chain address
		// MAJOR LL #50 OVERLAP: ETH addresses share their shape
		// with USDT-ERC20, USDC-ERC20, DAI-ERC20, USDC-Base,
		// USDC-Polygon, USDC-Arbitrum, DAI-Polygon, DAI-Arbitrum,
		// DAI-Base — every EVM token-account address.  Context
		// disambiguates at the order layer via the asset field
		// (and for multi-network assets, the network field).
		// Cp42 address-shape-overlap-smoke extended with ETH
		// specimens at cp47 — many new EXPECTED_OVERLAPS entries.
		// CONTRACT-ADDRESS DESTINATIONS: ETH can be sent to a
		// smart contract address that may not implement an ETH-
		// receive function (or implements one that rejects).
		// The 0x-40-hex regex doesn't distinguish externally-
		// owned-accounts (EOAs) from contracts; Morphit accepts
		// the shape and the wallet UX warns about contract
		// destinations.
		// ENS NAMES (alice.eth): NOT resolved by Morphit.  Users
		// must paste raw 0x addresses.  Resolving ENS would
		// require a centralized RPC dependency, violating the
		// distributed-no-SPOF design priority.
		addressShape: /^0x[a-fA-F0-9]{40}$/
	}),
	Object.freeze<AssetEntry>({
		ticker: 'XRP',
		// XRP uses 6 decimals on the XRP Ledger — 1 XRP =
		// 1,000,000 drops.  Same smallest-unit precision as
		// USDT/USDC/DAI, but XRP is the NATIVE token of XRPL,
		// not an ERC-20 token.  Cp49 jitterXrpAmount handles
		// the 6-decimal arithmetic with a clear separate
		// function (not reusing jitterStablecoinAmount) for
		// clarity since XRP is not a stablecoin.
		decimals: 6,
		isCoordinationChain: false,
		canBeTraded: true,
		// MEMORY #23 INVARIANT: XRP is trade-only.  Cannot pay
		// listing fees, cold-message fees, or featured-slot bids.
		// fee_method enum stays frozen at {blurt, btc, xmr,
		// waived_first_buy}.  xrp-trade-only-smoke pins this
		// from the registry side; fee-method-enum-frozen-smoke
		// from the wire-format side.
		canPayListingFee: false,
		// Single-network — XRPL mainnet only.
		supportedNetworks: ['mainnet'],
		defaultNetwork: 'mainnet',
		// XRPL runs Federated Byzantine Agreement (FBA) consensus
		// — NOT Proof-of-Work and NOT Proof-of-Stake.  Validators
		// on a Unique Node List (UNL) reach consensus on
		// transaction ordering.  Native XRP cannot be frozen by
		// any central authority — the freeze flag on XRPL applies
		// only to ISSUED tokens (IOUs), not to native XRP.  No
		// privacy-warning chip needed for native XRP trading.
		privacyWarningKey: null,
		privacyFeatures: {
			freshAddressAdvice: 'hd-derived',
			optInPrivacyTech: null,
			privacyGuideKey: 'xrp'
		},
		// XRP address: starts with 'r' + 24-34 base58 chars.
		// DESTINATION TAG and RESERVE REQUIREMENT are documented
		// in privacy.guides.xrp.caveats × 10 locales.
		addressShape: /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/
	})
] as const) as ReadonlyArray<AssetEntry>;

/** Quick lookup table.  Throws on miss — callers should pass an
 *  AssetTicker, which is type-checked, so a miss is a programmer
 *  error not a user error. */
const BY_TICKER: Readonly<Record<AssetTicker, AssetEntry>> = Object.freeze(
	ASSETS.reduce(
		(acc, a) => {
			acc[a.ticker] = a;
			return acc;
		},
		{} as Record<AssetTicker, AssetEntry>
	)
);

/** Get the registry entry for a given ticker.  Throws if the
 *  ticker isn't registered. */
export function getAsset(ticker: AssetTicker): AssetEntry {
	const a = BY_TICKER[ticker];
	if (a === undefined) {
		throw new Error(
			`@morphit/asset-registry: ticker '${ticker}' is not in ASSETS — register it in packages/asset-registry/src/index.ts`
		);
	}
	return a;
}

/** Type guard: is `s` a registered ticker string?  Use this at
 *  the boundary where untrusted strings (chain payloads, query
 *  params, JSON bodies) become typed AssetTicker values. */
export function isAssetTicker(s: unknown): s is AssetTicker {
	return typeof s === 'string' && (ASSET_TICKERS as readonly string[]).includes(s);
}

/** Convenience: as a Set<string> for O(1) string-level membership
 *  checks at chain-payload validation boundaries.  Wrapped in a
 *  Proxy that throws on any mutation method (add/delete/clear),
 *  so a TypeScript-blind consumer can't inject a fake ticker via
 *  `(ASSET_TICKERS_SET as any).add('FAKE')`.  ReadonlySet is just
 *  a compile-time view; this gives us runtime enforcement too. */
const _innerTickerSet = new Set<string>(ASSET_TICKERS);
export const ASSET_TICKERS_SET: ReadonlySet<string> = new Proxy(_innerTickerSet, {
	get(target, prop) {
		// Trap mutating methods.  Anything else passes through.
		if (prop === 'add' || prop === 'delete' || prop === 'clear') {
			return () => {
				throw new TypeError(
					`@morphit/asset-registry: ASSET_TICKERS_SET is immutable; ` +
						`mutation via .${String(prop)}() is rejected.`
				);
			};
		}
		const v = Reflect.get(target, prop, target);
		// Bind methods so `for (const t of ASSET_TICKERS_SET)` etc. work.
		return typeof v === 'function' ? v.bind(target) : v;
	}
}) as ReadonlySet<string>;

/** The asset that's the coordination chain (the chain whose
 *  transactions ARE Morphit's source-of-record).  Throws at
 *  module load if zero or more-than-one asset has the flag —
 *  this is a registry-correctness invariant. */
export const COORDINATION_CHAIN: AssetEntry = (() => {
	const matches = ASSETS.filter((a) => a.isCoordinationChain);
	if (matches.length !== 1) {
		throw new Error(
			`@morphit/asset-registry: exactly one asset must have isCoordinationChain=true; found ${matches.length}`
		);
	}
	return matches[0]!;
})();

/** Filter helpers — these read like sentences at call sites
 *  ("for asset of tradeable() ...") which makes the registry's
 *  capability flags self-documenting. */
export function tradeable(): readonly AssetEntry[] {
	return ASSETS.filter((a) => a.canBeTraded);
}

export function feePayable(): readonly AssetEntry[] {
	return ASSETS.filter((a) => a.canPayListingFee);
}

/** External assets — everything except the coordination chain.
 *  Used by the explorer-URL builder and the external-tx-id
 *  verifier registry. */
export function externalAssets(): readonly AssetEntry[] {
	return ASSETS.filter((a) => !a.isCoordinationChain);
}

// ════════════════════════════════════════════════════════════════
//  CANONICAL ECONOMICS — the single source of truth for what things
//  cost on Morphit (the fee + first-order economics).
// ════════════════════════════════════════════════════════════════
//
//  This lives INLINE in index.ts (not a separate economics.ts file)
//  ON PURPOSE. @morphit/asset-registry is consumed as RAW source —
//  its package.json `main`/`types` point straight at this file and
//  there is no build step. The mcp-server ships a compiled
//  `node dist/main.js` bin that value-imports ASSET_TICKERS from
//  here at RUNTIME, and plain Node ESM resolves a relative
//  `./economics.js` specifier LITERALLY (it does NOT remap .js→.ts
//  the way tsx and Vite do), so factoring this out into its own file
//  made `node dist/main.js` crash on startup with ERR_MODULE_NOT_FOUND.
//  A single self-contained index.ts is the invariant that lets every
//  consumer — Vite bundler, tsx, AND plain node — import the package.
//  DO NOT re-extract this into a separate file.
//
//  The frontend (which QUOTES the fee to the user) and the indexer
//  (which VALIDATES the on-chain payment) BOTH import these, so the
//  numbers physically cannot drift apart. People's money rides on
//  these values. Change a number here and NOWHERE ELSE — every other
//  reference is derived from these constants.
//
//  FIAT-FIRST — the governing principle: users think in their LOCAL
//  currency (USD, EUR, MXN, …), NEVER in BLURT. Telling someone "buy
//  500 BLURT" sounds like a fortune and scares newcomers away. So
//  every figure below is a USD target and the live crypto amount is
//  DERIVED from target ÷ live price — a fixed BLURT/satoshi/piconero
//  amount would silently drift (60 BLURT is ~12.5¢ today but half
//  that if BLURT halves).
//
//  In one breath:
//    • A new user's first BLURT buy must be worth at least $1 USD.
//    • Placing a listing costs ~25¢ USD in BTC/XMR, or HALF (~12.5¢)
//      in BLURT — the discount nudges users into the native economy.
//    • Listing fees can ONLY be paid in BLURT, XMR, or BTC; every
//      other tradable asset is trade-only (see `canPayListingFee`).

/**
 * First buy-order minimum, in USD.
 *
 * A new user's first BLURT buy is the fee-WAIVED welcome order. We
 * require it to be worth at least this much so the user leaves the
 * flow with a usable starter balance (~$1 of BLURT funds ~8 future
 * listings at the BLURT listing-fee rate). Checked against the
 * order's fiat VALUE (`amount_min`), which is itself a fiat amount —
 * so this is a fiat-to-fiat comparison and needs no price feed.
 *
 * Exact when the order's fiat is USD (the default denomination). A
 * non-USD instance wants this converted into its local currency via
 * a USD↔local rate; that is the open multi-currency-pricing item.
 */
export const FIRST_ORDER_MIN_USD = 1.0;

/**
 * Listing-fee USD targets, per payment method.
 *
 * These are the ONLY fee numbers in the system. The BLURT / satoshi
 * / piconero amounts a user actually pays are ALWAYS derived from
 * these ÷ the live price (see the helpers below) — never hardcoded.
 *
 *   btc / xmr : ~25¢ USD worth of the coin.
 *   blurt     : ~12.5¢ USD worth — half price, to reward paying in
 *               the native token.
 *
 * Only BLURT, BTC, and XMR can pay listing fees (the indexer's
 * `fee_method` enum is frozen to 'blurt' | 'btc' | 'xmr' |
 * 'waived_first_buy'); every other asset is trade-only.
 */
export const LISTING_FEE_USD: Readonly<Record<'blurt' | 'btc' | 'xmr', number>> = Object.freeze({
	blurt: 0.125,
	btc: 0.25,
	xmr: 0.25
});

/**
 * Reference prices (USD) used ONLY to seed the static fallback fee
 * amounts when no live price is available (cold start / price feed
 * down). They are NOT the live economics — the live amounts come
 * from the real price via the helpers below. Kept here so the
 * fallback amounts trace to the same USD targets rather than being
 * unexplained magic numbers scattered through the config.
 */
export const FEE_REFERENCE_PRICE_USD: Readonly<Record<'blurt' | 'btc' | 'xmr', number>> =
	Object.freeze({
		blurt: 0.002,
		btc: 60_000,
		xmr: 320
	});

/**
 * Tolerance the indexer grants when verifying a fee payment.
 *
 * Because the fee is USD-targeted (derived from a LIVE price), the
 * required crypto amount can move between the moment the user
 * fetched their quote and the moment the indexer validates the
 * on-chain payment. This band absorbs that drift so a good-faith
 * payment is NEVER rejected because the market ticked. The fee is a
 * few cents, so even a 15% band is a sub-cent-to-~4¢ difference —
 * economically negligible, and far cheaper than rejecting a real
 * user's order.
 *
 * (This is distinct from, and replaces for fee-amount purposes, the
 * tiny 0.1% floating-point-rounding tolerance the old BLURT-native
 * model used. A price-drift band has to be much wider than a
 * rounding band.)
 */
export const FEE_PRICE_TOLERANCE = 0.15;

/** Smallest-unit decimals per fee-capable asset (mirrors ASSETS:
 *  BTC 8 satoshi, XMR 12 piconero, BLURT 3 milliBLURT). */
const FEE_ASSET_DECIMALS: Readonly<Record<'blurt' | 'btc' | 'xmr', number>> = Object.freeze({
	blurt: 3,
	btc: 8,
	xmr: 12
});

function usablePrice(p: number): boolean {
	return Number.isFinite(p) && p > 0;
}

/**
 * Defense-in-depth behind the price feed's own plausibility envelope.
 * A garbage price can drive `target ÷ price` to a value that is:
 *   • effectively ∞ (price → 0⁺) → BigInt(∞) THROWS, and a number
 *     amount of ∞ makes the verifier reject every payment (DoS);
 *   • rounded to 0 (price → ∞) → a "free" listing, defeating the
 *     anti-Sybil purpose.
 * In either case we return null so the caller falls back to the sane
 * fixed FEE_FALLBACK amount rather than quoting/validating nonsense.
 * A real listing fee is always a small POSITIVE amount.
 */
function safeAmount(n: number): number | null {
	return Number.isFinite(n) && n > 0 ? n : null;
}
function safeUnitCount(n: number): number | null {
	// Smallest-unit counts (satoshi/piconero) must be exact positive
	// integers; an unsafe-integer result means the float already lost
	// precision (absurd price), so fall back.
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Derive the BLURT listing-fee BASE (in BLURT) from the live
 * BLURT/USD price. The Sybil-tier multiplier is applied ON TOP of
 * this by the caller (see the indexer's `expectedFeeBlurt` and the
 * frontend's `computeFee`). Returns null when no usable price is
 * available, so the caller can fall back to the reference amount.
 */
export function listingFeeBlurtBase(blurtUsdPrice: number): number | null {
	if (!usablePrice(blurtUsdPrice)) return null;
	return safeAmount(LISTING_FEE_USD.blurt / blurtUsdPrice);
}

/**
 * Derive the BTC listing fee in whole satoshis from the live
 * BTC/USD price. null when no usable price.
 */
export function listingFeeSatoshis(btcUsdPrice: number): number | null {
	if (!usablePrice(btcUsdPrice)) return null;
	return safeUnitCount(Math.round((LISTING_FEE_USD.btc / btcUsdPrice) * 10 ** FEE_ASSET_DECIMALS.btc));
}

/**
 * Derive the XMR listing fee in whole piconero (12-decimal unit)
 * from the live XMR/USD price, returned as a bigint. null when no
 * usable price.
 */
export function listingFeePiconero(xmrUsdPrice: number): bigint | null {
	if (!usablePrice(xmrUsdPrice)) return null;
	const pico = safeUnitCount(
		Math.round((LISTING_FEE_USD.xmr / xmrUsdPrice) * 10 ** FEE_ASSET_DECIMALS.xmr)
	);
	return pico === null ? null : BigInt(pico);
}

/**
 * Static FALLBACK fee amounts — what the reference prices imply.
 * Used to seed config defaults and to validate during a price-feed
 * outage. These trace to the same USD targets, so they're "right at
 * the reference price" rather than arbitrary constants.
 */
export const FEE_FALLBACK = Object.freeze({
	/** ~12.5¢ at $0.002/BLURT. */
	blurtBase: LISTING_FEE_USD.blurt / FEE_REFERENCE_PRICE_USD.blurt, // 62.5
	/** ~25¢ at $60k BTC. */
	satoshis: Math.round((LISTING_FEE_USD.btc / FEE_REFERENCE_PRICE_USD.btc) * 1e8), // 417
	/** ~25¢ at $320 XMR, as a piconero bigint. */
	piconero: BigInt(Math.round((LISTING_FEE_USD.xmr / FEE_REFERENCE_PRICE_USD.xmr) * 1e12)) // 781250000n
} as const);

/**
 * Model-A verification tolerance (cp372).
 *
 * The ENFORCED fee amount stays chain-pinned (a fork can't set its
 * own — see the poller's TreasurySource), but the live USD-targeted
 * amount the UI shows can drift from the pinned amount as crypto
 * prices move between operator re-pins.  To avoid rejecting a user
 * who paid exactly the live-displayed amount, the verifier accepts a
 * payment within FEE_PRICE_TOLERANCE *below* the pinned amount.
 *
 * Only the LOWER bound relaxes: the verifier is a floor (overpayment
 * is always fine), and when crypto depreciates the live amount rises
 * *above* the pin (already accepted).  The relaxation is a fixed
 * 15% — bounded and NOT fork-controllable — so the anti-fork
 * guarantee the pin provides is preserved (the most a payer saves is
 * 15% of the operator's chosen amount, ≈4¢ on a 25¢ fee).
 *
 * Returns the smallest integer satoshi count that must be observed
 * for the payment to count as fully paid.
 */
export function minAcceptableSatoshis(expectedSatoshis: number): number {
	if (!Number.isFinite(expectedSatoshis) || expectedSatoshis <= 0) return 0;
	return Math.floor(expectedSatoshis * (1 - FEE_PRICE_TOLERANCE));
}

/**
 * Piconero counterpart of {@link minAcceptableSatoshis}.  bigint-safe:
 * `1 - FEE_PRICE_TOLERANCE` is taken to 3 decimal places (×1000) so
 * the whole computation stays in integer bigint arithmetic — no
 * float round-trip on a 12-decimal value.
 */
export function minAcceptablePiconero(expectedPiconero: bigint): bigint {
	if (expectedPiconero <= 0n) return 0n;
	const keepPerMille = BigInt(Math.round((1 - FEE_PRICE_TOLERANCE) * 1000)); // 850 at 0.15
	return (expectedPiconero * keepPerMille) / 1000n;
}

/** True iff this asset can be used to pay a listing fee. Hardcoded to
 *  stay tied to the FROZEN fee_method enum (charter-level invariant),
 *  NOT the mutable registry. `economics-canonical-smoke` enforces that
 *  this set, the registry's `canPayListingFee` flags, and the
 *  LISTING_FEE_USD keys all agree — a divergence fails CI. */
export function isFeeCapableAsset(ticker: AssetTicker): ticker is 'BLURT' | 'BTC' | 'XMR' {
	return ticker === 'BLURT' || ticker === 'BTC' || ticker === 'XMR';
}
