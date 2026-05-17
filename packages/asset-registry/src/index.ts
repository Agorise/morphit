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
export const ASSET_TICKERS = ['BTC', 'XMR', 'BLURT', 'USDT', 'BCH', 'LTC'] as const;

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
		// needed.  (LTC has an opt-in privacy upgrade — MWEB —
		// but it's wallet-side and per-transaction, not a chain
		// property; users who want Morphit's strongest privacy
		// posture should use XMR.)
		privacyWarningKey: null,
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
