/**
 * Morphit — external chain-explorer URL builders (pure helpers).
 *
 * Pure-function half of the explorer URL builders.  Lives in a
 * separate file from `urls.ts` so node-side smokes and tests
 * can import these helpers without pulling in Svelte stores
 * (which require the SvelteKit `$lib` alias resolver).
 *
 * `urls.ts` is the thin wrapper that consults the
 * `instance.chat_link_urls` operator overrides; this module
 * holds the txid regexes, the bundled defaults, the
 * substitution helper, and the validator for chat-link URL
 * templates.  Both files re-export the bundled-default
 * constants so callers can reference them by either path.
 */

/** BTC txid: 64 hex chars (32 bytes).  Case-insensitive. */
export const BTC_TXID_RE = /^[0-9a-fA-F]{64}$/;

/** XMR txid: 64 hex chars (32 bytes).  Case-insensitive. */
export const XMR_TXID_RE = /^[0-9a-fA-F]{64}$/;

/** BCH txid (Part 122 cp21).  64 hex chars (sha256d of the
 *  transaction, same format as BTC since BCH forked from BTC).
 *  Case-insensitive at the regex layer; chat-link substitution
 *  normalizes to lowercase before URL construction. */
export const BCH_TXID_RE = /^[0-9a-fA-F]{64}$/;

/** LTC txid (Part 122 cp24).  64 hex chars (sha256d, same as
 *  BTC and BCH since all three share Bitcoin's hash structure).
 *  Case-insensitive at regex layer; substitution normalizes. */
export const LTC_TXID_RE = /^[0-9a-fA-F]{64}$/;

/** DASH txid (Part 122 cp27).  64 hex chars (sha256d, same as
 *  the whole BTC family — DASH forked from Litecoin which forked
 *  from Bitcoin, preserving the hash structure). */
export const DASH_TXID_RE = /^[0-9a-fA-F]{64}$/;
export const DOGE_TXID_RE = /^[0-9a-fA-F]{64}$/;

/** ZEC txid (Part 122 cp39).  64 hex chars — same shape for
 *  transparent and shielded transactions; the shielded payload
 *  is hidden inside the tx, but the txid itself is canonical
 *  and shareable. */
export const ZEC_TXID_RE = /^[0-9a-fA-F]{64}$/;

/** ARRR txid (Part 122 cp41).  64 hex chars — Pirate Chain
 *  Sapling shielded transactions surface a canonical 64-char
 *  hex txid even though sender/recipient/amount are hidden
 *  inside the shielded payload. */
export const ARRR_TXID_RE = /^[0-9a-fA-F]{64}$/;

/** DCR txid (Part 122 cp43).  64 hex chars — Decred forked
 *  from a Bitcoin-derived codebase and inherited the 32-byte
 *  SHA-256 txid convention. */
export const DCR_TXID_RE = /^[0-9a-fA-F]{64}$/;

/** SOL txid (Part 122 cp45).  Solana transaction signatures
 *  are 64 bytes encoded as base58, surfacing as 87-88 char
 *  strings.  Notably DIFFERENT from the BTC/ZEC/ARRR/DCR family's
 *  64-hex-char convention — Solana uses base58 throughout for
 *  addresses, signatures, and mint addresses. */
export const SOL_TXID_RE = /^[1-9A-HJ-NP-Za-km-z]{87,88}$/;

/** ETH txid (Part 122 cp47).  Ethereum transaction hashes are
 *  32 bytes hex with optional 0x prefix — 64 hex chars (or 66
 *  with prefix).  Same shape as the EVM stablecoin txid forms
 *  (USDT-ERC20, USDC-ERC20, DAI-ERC20, USDC-Base, etc).  Asset
 *  field disambiguates at order layer per LL #50. */
export const ETH_TXID_RE = /^(0x)?[a-fA-F0-9]{64}$/;

/** XRP txid (Part 122 cp49).  XRPL transaction hashes are 256-bit
 *  (32 bytes) hex, conventionally uppercase on the chain but the
 *  regex is case-insensitive.  64 hex chars, NO prefix — same
 *  shape as the BTC-family hex txids (BTC/BCH/LTC/DASH/DOGE/ZEC/
 *  ARRR/DCR).  Asset field disambiguates per LL #50. */
export const XRP_TXID_RE = /^[a-fA-F0-9]{64}$/;

/** Blurt trx_id: 40 hex chars (20 bytes). */
export const BLURT_TRXID_RE = /^[0-9a-fA-F]{40}$/;

/** Account-name format used elsewhere in the codebase. */
export const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

/** Bundled defaults used when an operator hasn't overridden
 *  the per-instance template (via
 *  `MORPHIT_FRONTEND_{BTC,XMR,BCH,LTC}_CHAT_LINK_URL`), or when
 *  the store hasn't loaded yet (SSR / pre-hydration / fetch fail).
 *  Per the original Batch K choices:
 *   - mempool.space: no JS, no tracking, fast, popular
 *   - xmrchain.net: reference for Monero block explorers
 *   - blockchair.com/bitcoin-cash: established multi-chain
 *     explorer, predictable URL format, good uptime (Part 122
 *     cp21 BCH addition; chosen from operator's eight-explorer
 *     candidate list as the best balance of reliability +
 *     URL-format predictability — operators wanting different
 *     defaults override via MORPHIT_FRONTEND_BCH_CHAT_LINK_URL)
 *   - litecoinspace.org/tx/{txid}: community-led Litecoin
 *     explorer modeled on mempool.space (no JS tracking, open
 *     source, privacy-aligned with Morphit's priority #1).
 *     Chosen from operator's seven-explorer candidate list as
 *     the BTC-mempool-equivalent for LTC.  Operators wanting
 *     different defaults override via
 *     MORPHIT_FRONTEND_LTC_CHAT_LINK_URL.
 *
 *  Operators wanting different defaults override per-instance;
 *  these bundled values are the "do nothing, ship sensible"
 *  fallback. */
export const BUNDLED_BTC_CHAT_LINK_URL = 'https://mempool.space/tx/{txid}';
export const BUNDLED_XMR_CHAT_LINK_URL = 'https://xmrchain.net/tx/{txid}';
export const BUNDLED_BCH_CHAT_LINK_URL =
	'https://blockchair.com/bitcoin-cash/transaction/{txid}';
export const BUNDLED_LTC_CHAT_LINK_URL = 'https://litecoinspace.org/tx/{txid}';

/** Bundled DASH chat-link explorer (Part 122 cp27).
 *
 *  Chosen from operator's nine-explorer candidate list as the
 *  community-led, official-project equivalent of mempool.space /
 *  litecoinspace.org for Dash:
 *
 *    https://insight.dash.org/insight/tx/{txid}
 *
 *  Rationale aligned with priority #1 (privacy / anonymity):
 *
 *  - insight.dash.org is the official Dash project's Insight
 *    instance — community-led, open-source backend, no
 *    third-party ad/tracking layer.  Same posture as
 *    litecoinspace.org for LTC.
 *
 *  Other candidates evaluated and not chosen:
 *
 *  - blockchair.com/dash and tokenview.io/dash — multi-chain
 *    aggregators, commercial, more tracking surface.
 *  - oklink.com/dash and blockchain.com/explorer/assets/dash —
 *    exchange-affiliated; conflicts with priority #2
 *    (decentralization — no exchange chokepoint).
 *  - bitinfocharts.com, blockexplorer.one, chainz.cryptoid.info
 *    — third-party aggregators with various ad/analytics
 *    overhead.
 *  - explorer.dash.org/insight/ — official, same backend as
 *    insight.dash.org; we use the shorter subdomain.
 *
 *  Operators wanting different defaults override via
 *  MORPHIT_FRONTEND_DASH_CHAT_LINK_URL. */
export const BUNDLED_DASH_CHAT_LINK_URL = 'https://insight.dash.org/insight/tx/{txid}';

/** DOGE chat-link explorer default (cp33 — Part 122).
 *  blockchair.com chosen from Ken's 9-explorer survey for
 *  predictable URL format, multi-chain support (already used as
 *  BCH default — operator gets one origin in their CSP allowlist
 *  for two chains), uptime track record, no aggressive
 *  fingerprinting, and HTTPS-only.
 *
 *  Full survey (Ken-provided 2026-05-19):
 *  - dogechain.info — community-favored historical default;
 *    occasional uptime issues and sketchy ad inventory.
 *  - blockchair.com/dogecoin — clean URL pattern, multi-chain,
 *    no JS tracking by default (chosen as bundled default).
 *  - bitinfocharts.com/dogecoin — aggregator, ad-heavy.
 *  - live.blockcypher.com/doge/ — BlockCypher infra, free tier
 *    rate-limited.
 *  - blockexplorer.one/dogecoin/mainnet — multi-chain aggregator.
 *  - blockchain.com/explorer/assets/doge — Blockchain.com
 *    exchange-affiliated; conflicts with priority #2
 *    (decentralization — no exchange chokepoint).
 *  - sochain.com/DOGE, chain.so/DOGE — older "SoChain" service,
 *    same vendor; uptime variable.
 *  - oklink.com — OKLink (OKX-affiliated); exchange-adjacent.
 *
 *  Operators wanting different defaults override via
 *  MORPHIT_FRONTEND_DOGE_CHAT_LINK_URL. */
export const BUNDLED_DOGE_CHAT_LINK_URL = 'https://blockchair.com/dogecoin/transaction/{txid}';

/** ZEC chat-link explorer (cp39 — Part 122).  Default uses
 *  Zcash's community-run mainnet explorer at
 *  mainnet.zcashexplorer.app — official project pointer,
 *  no third-party tracking, supports both transparent and
 *  shielded tx lookups by txid.  Privacy/decentralization
 *  rationale matches the BUNDLED_DASH_CHAT_LINK_URL
 *  (insight.dash.org) and BUNDLED_BTC_CHAT_LINK_URL
 *  (blockstream.info) choices: prefer a project-aligned or
 *  community-run explorer over third-party aggregators.
 *
 *  Operator's 7-explorer survey at cp39:
 *  - mainnet.zcashexplorer.app — community-run, official-style
 *    pointer.  CHOSEN as bundled default.
 *  - blockchair.com/zcash — third-party multi-chain aggregator;
 *    we already use blockchair for DOGE, but ZEC has a
 *    community-run option so prefer that.
 *  - zcashinfo.com — community-run; lower traffic; secondary.
 *  - 3xpl.com/zcash — third-party aggregator; less focused.
 *  - blockexplorer.one/zcash/mainnet — generic aggregator.
 *  - zcash.tokenview.io — Tokenview multi-chain; vendor-hosted.
 *  - cipherscan.app — newer privacy-focused explorer; smaller
 *    community footprint at launch.
 *
 *  Operators wanting different defaults override via
 *  MORPHIT_FRONTEND_ZEC_CHAT_LINK_URL. */
export const BUNDLED_ZEC_CHAT_LINK_URL = 'https://mainnet.zcashexplorer.app/transactions/{txid}';

/** ARRR chat-link explorer (cp41 — Part 122).  Default uses
 *  Pirate Chain's official project explorer at
 *  explorer.piratechain.com — project-aligned, no third-party
 *  tracking, supports shielded-transaction lookups by txid.
 *  Privacy/decentralization rationale matches the choices for
 *  BUNDLED_ZEC_CHAT_LINK_URL (mainnet.zcashexplorer.app) and
 *  BUNDLED_BTC_CHAT_LINK_URL (blockstream.info): prefer a
 *  project-aligned explorer over third-party aggregators or
 *  exchange-affiliated services.
 *
 *  Operator's 3-explorer survey at cp41:
 *  - explorer.piratechain.com — official project explorer.
 *    CHOSEN as bundled default.
 *  - pirate.explorer.dexstats.info — community-run, supports
 *    Komodo-ecosystem coins including ARRR; secondary.
 *  - blockchain.com/explorer/assets/arrr — third-party
 *    aggregator; multi-asset; tertiary.
 *
 *  Operators wanting different defaults override via
 *  MORPHIT_FRONTEND_ARRR_CHAT_LINK_URL. */
export const BUNDLED_ARRR_CHAT_LINK_URL = 'https://explorer.piratechain.com/tx/{txid}';

/** DCR chat-link explorer (cp43 — Part 122).  Default uses
 *  Decred's official project explorer at dcrdata.decred.org —
 *  project-aligned, run by Decred itself (no third-party
 *  tracking), supports both transparent and mixed-output
 *  transactions, full Politeia governance integration.
 *  Privacy/decentralization rationale matches the choices for
 *  BUNDLED_ZEC_CHAT_LINK_URL (mainnet.zcashexplorer.app) and
 *  BUNDLED_ARRR_CHAT_LINK_URL (explorer.piratechain.com):
 *  prefer a project-aligned explorer over third-party
 *  aggregators or exchange-affiliated services.
 *
 *  Operator's 4-explorer survey at cp43:
 *  - dcrdata.decred.org — official project explorer.
 *    CHOSEN as bundled default.
 *  - blockchain.com/explorer/assets/dcr — third-party
 *    aggregator; multi-asset; secondary.
 *  - dcr.tokenview.io — Tokenview multi-chain explorer;
 *    tertiary.
 *  - bitinfocharts.com/decred/ — community-run analytics +
 *    block explorer; quaternary.
 *
 *  Operators wanting different defaults override via
 *  MORPHIT_FRONTEND_DCR_CHAT_LINK_URL. */
export const BUNDLED_DCR_CHAT_LINK_URL = 'https://dcrdata.decred.org/tx/{txid}';

/** SOL chat-link explorer (cp45 — Part 122).  Default uses
 *  Solana's official project explorer at explorer.solana.com —
 *  project-aligned, run by Solana Labs, no third-party tracking,
 *  supports SPL token transfers and native SOL transfers, full
 *  validator/staking visibility.
 *
 *  Privacy/decentralization rationale matches the choices for
 *  BUNDLED_ZEC_CHAT_LINK_URL (mainnet.zcashexplorer.app),
 *  BUNDLED_ARRR_CHAT_LINK_URL (explorer.piratechain.com), and
 *  BUNDLED_DCR_CHAT_LINK_URL (dcrdata.decred.org): prefer a
 *  project-aligned explorer over third-party aggregators or
 *  exchange-affiliated services.
 *
 *  Operator's 5-explorer survey at cp45:
 *  - explorer.solana.com — official project explorer.
 *    CHOSEN as bundled default.
 *  - solscan.io — third-party aggregator; most popular by
 *    traffic; rich UI; secondary.
 *  - solanabeach.io — validator-focused explorer; tertiary.
 *  - www.oklink.com/solana — OKX-affiliated, third-party;
 *    quaternary.
 *  - solana.fm — community-run; was unreachable at cp45 survey
 *    time (per Ken's note "not working?"); not surveyed.
 *
 *  Operators wanting different defaults override via
 *  MORPHIT_FRONTEND_SOL_CHAT_LINK_URL. */
export const BUNDLED_SOL_CHAT_LINK_URL = 'https://explorer.solana.com/tx/{txid}';

/** ETH chat-link explorer (cp47 — Part 122).  Default uses
 *  Blockscout's official Ethereum mainnet instance at
 *  eth.blockscout.com — open-source explorer, project-aligned
 *  with Ethereum's transparency ethos, frequently used by
 *  Ethereum L2s (Optimism, Base, Gnosis Chain all run Blockscout
 *  instances), self-hostable.
 *
 *  Rationale matches the choices for BUNDLED_ZEC_CHAT_LINK_URL
 *  (mainnet.zcashexplorer.app), BUNDLED_ARRR_CHAT_LINK_URL
 *  (explorer.piratechain.com), BUNDLED_DCR_CHAT_LINK_URL
 *  (dcrdata.decred.org), BUNDLED_SOL_CHAT_LINK_URL
 *  (explorer.solana.com): prefer an open-source / project-
 *  aligned explorer over third-party aggregators or exchange-
 *  affiliated services.
 *
 *  NOTE: unlike Solana (Solana Labs runs the official explorer)
 *  or Decred (Decred project runs dcrdata), there is no single
 *  Ethereum-Foundation-blessed explorer.  Etherscan is the de
 *  facto popular choice but is third-party (Etherscan Inc),
 *  closed-source, and has historically been the target of
 *  AML/compliance pressure.  Blockscout is the most aligned
 *  with Ethereum's open-source ethos.
 *
 *  Operator's 9-explorer survey at cp47:
 *  - eth.blockscout.com — open-source Blockscout.
 *    CHOSEN as bundled default.
 *  - etherscan.io — most popular by traffic; third-party,
 *    closed-source; secondary.
 *  - blockchair.com/ethereum — multi-chain aggregator;
 *    tertiary.
 *  - ethplorer.io — token-focused; quaternary.
 *  - www.oklink.com/ethereum — OKX-affiliated, third-party;
 *    quinary.
 *  - www.blockchain.com/explorer/assets/eth — multi-asset
 *    exchange-affiliated; senary.
 *  - blockexplorer.one/ethereum/mainnet — multi-chain;
 *    septenary.
 *  - routescan.io — multi-chain aggregator; octonary.
 *  - beaconcha.in — consensus-layer (beacon chain) explorer,
 *    NOT suitable for regular transaction lookups; surveyed
 *    for completeness, not chosen.
 *
 *  Operators wanting different defaults override via
 *  MORPHIT_FRONTEND_ETH_CHAT_LINK_URL. */
export const BUNDLED_ETH_CHAT_LINK_URL = 'https://eth.blockscout.com/tx/{txid}';

/** XRP chat-link explorer (cp49 — Part 122).  Default uses XRP
 *  Ledger Foundation's official livenet explorer at
 *  livenet.xrpl.org — non-profit foundation, project-aligned,
 *  separate from Ripple Labs Inc. (the for-profit company that
 *  created XRP).
 *
 *  Rationale matches the choices for BUNDLED_ZEC_CHAT_LINK_URL
 *  (mainnet.zcashexplorer.app), BUNDLED_ARRR_CHAT_LINK_URL
 *  (explorer.piratechain.com), BUNDLED_DCR_CHAT_LINK_URL
 *  (dcrdata.decred.org), BUNDLED_SOL_CHAT_LINK_URL
 *  (explorer.solana.com), BUNDLED_ETH_CHAT_LINK_URL
 *  (eth.blockscout.com): prefer a project-aligned / non-profit-
 *  foundation explorer over commercial or exchange-affiliated
 *  ones.
 *
 *  Operator's 5-explorer survey at cp49:
 *  - livenet.xrpl.org — XRP Ledger Foundation (non-profit).
 *    CHOSEN as bundled default.
 *  - xrpscan.com — XRPL-focused, third-party; secondary.
 *  - bithomp.com — XRPL-focused with token/NFT support; tertiary.
 *  - blockchair.com/xrp-ledger — multi-chain aggregator;
 *    quaternary.
 *  - blockexplorer.one/xrp/mainnet — multi-chain third-party;
 *    quinary.
 *
 *  Operators wanting different defaults override via
 *  MORPHIT_FRONTEND_XRP_CHAT_LINK_URL. */
export const BUNDLED_XRP_CHAT_LINK_URL = 'https://livenet.xrpl.org/transactions/{txid}';

/** cp167 — best→worst ordered lists of bundled explorer templates
 *  per asset.  The first element is the same string as the singular
 *  `BUNDLED_<ASSET>_CHAT_LINK_URL` constant above; the rest are
 *  alternatives the frontend offers in a "Open in other explorer"
 *  dropdown so users who don't trust (or can't reach) the primary
 *  have grandma-friendly options ready to click.
 *
 *  Selection criteria for secondaries:
 *    - No auth required, no captcha, no JS-mandatory wall
 *    - Direct deep-link from txid to transaction page
 *    - Project-maintained or community-vetted (not scraper-bait)
 *    - Independent infrastructure from the primary (different
 *      operator, ideally different jurisdiction) so a censorship
 *      event taking down the primary doesn't take down the
 *      whole list
 *
 *  Operators who configure a single override URL via
 *  MORPHIT_FRONTEND_<ASSET>_CHAT_LINK_URL prepend that to the
 *  list at lookup time (see externalExplorerUrls in urls.ts);
 *  the bundled list provides the fallback chain. */
export const BUNDLED_BTC_CHAT_LINK_URLS: readonly string[] = [
	BUNDLED_BTC_CHAT_LINK_URL,
	'https://mempool.observer/tx/{txid}',
	'https://blockstream.info/tx/{txid}',
	'https://btcscan.org/tx/{txid}'
];

export const BUNDLED_XMR_CHAT_LINK_URLS: readonly string[] = [
	BUNDLED_XMR_CHAT_LINK_URL,
	'https://localmonero.co/blocks/tx/{txid}',
	'https://moneroblocks.info/tx/{txid}',
	'https://monero.com/tx/{txid}'
];

export const BUNDLED_BCH_CHAT_LINK_URLS: readonly string[] = [
	BUNDLED_BCH_CHAT_LINK_URL,
	'https://blockchair.com/bitcoin-cash/transaction/{txid}',
	'https://3xpl.com/bitcoin-cash/transaction/{txid}'
];

export const BUNDLED_LTC_CHAT_LINK_URLS: readonly string[] = [
	BUNDLED_LTC_CHAT_LINK_URL,
	'https://blockchair.com/litecoin/transaction/{txid}',
	'https://live.blockcypher.com/ltc/tx/{txid}'
];

export const BUNDLED_DASH_CHAT_LINK_URLS: readonly string[] = [
	BUNDLED_DASH_CHAT_LINK_URL,
	'https://blockchair.com/dash/transaction/{txid}',
	'https://live.blockcypher.com/dash/tx/{txid}'
];

export const BUNDLED_DOGE_CHAT_LINK_URLS: readonly string[] = [
	BUNDLED_DOGE_CHAT_LINK_URL,
	'https://dogechain.info/tx/{txid}',
	'https://live.blockcypher.com/doge/tx/{txid}'
];

export const BUNDLED_ZEC_CHAT_LINK_URLS: readonly string[] = [
	BUNDLED_ZEC_CHAT_LINK_URL,
	'https://blockchair.com/zcash/transaction/{txid}',
	'https://zcash.tokenview.io/en/tx/{txid}'
];

export const BUNDLED_ARRR_CHAT_LINK_URLS: readonly string[] = [
	BUNDLED_ARRR_CHAT_LINK_URL
	// Pirate Chain has limited public explorer coverage; the
	// official one is the only widely-used choice.  Adding fallback
	// candidates requires verifying independent infrastructure.
];

export const BUNDLED_DCR_CHAT_LINK_URLS: readonly string[] = [
	BUNDLED_DCR_CHAT_LINK_URL,
	'https://explorer.dcrdata.org/tx/{txid}',
	'https://blockchair.com/decred/transaction/{txid}'
];

export const BUNDLED_SOL_CHAT_LINK_URLS: readonly string[] = [
	BUNDLED_SOL_CHAT_LINK_URL,
	'https://solscan.io/tx/{txid}',
	'https://solana.fm/tx/{txid}',
	'https://xray.helius.xyz/tx/{txid}'
];

export const BUNDLED_ETH_CHAT_LINK_URLS: readonly string[] = [
	BUNDLED_ETH_CHAT_LINK_URL,
	'https://etherscan.io/tx/{txid}',
	'https://ethplorer.io/tx/{txid}',
	'https://3xpl.com/ethereum/transaction/{txid}'
];

export const BUNDLED_XRP_CHAT_LINK_URLS: readonly string[] = [
	BUNDLED_XRP_CHAT_LINK_URL,
	'https://xrpscan.com/tx/{txid}',
	'https://bithomp.com/explorer/{txid}',
	'https://blockchair.com/xrp-ledger/transaction/{txid}'
];

/** cp174 — per-NETWORK ordered explorer-alternative lists for the
 *  multi-network tokens (USDT, USDC, DAI).  Keyed by network rather
 *  than by asset because the explorer for a given chain is the same
 *  regardless of which token rides on it: an ERC-20 USDT tx and an
 *  ERC-20 DAI tx both resolve on Ethereum explorers, so the fallback
 *  chain is shared.
 *
 *  The first element of each list is the SAME template as the
 *  per-network `bundledExplorerUrl` in `lib/assets/networks.ts`
 *  (the primary); the rest are independent-infrastructure
 *  alternatives selected by the same criteria as the native-chain
 *  `BUNDLED_<ASSET>_CHAT_LINK_URLS` lists above (no auth/captcha/
 *  JS-wall, direct txid deep-link, project- or community-vetted,
 *  different operator from the primary).  The erc20 and spl lists
 *  reuse the exact alternatives already vetted for ETH and SOL.
 *
 *  Consumed by usdt/usdc/daiExplorerUrls() in urls.ts (the plural
 *  builders), which prepend any operator override and then walk
 *  this list.  Singular usdt/usdc/daiExplorerUrl() are unchanged
 *  and still return just the primary for callers that want one URL. */
export const TOKEN_NETWORK_EXPLORER_URLS: Readonly<Record<string, readonly string[]>> =
	Object.freeze({
		// EVM — Ethereum mainnet (erc20)
		erc20: Object.freeze([
			'https://etherscan.io/tx/{txid}',
			'https://ethplorer.io/tx/{txid}',
			'https://3xpl.com/ethereum/transaction/{txid}'
		]),
		// Tron (trc20)
		trc20: Object.freeze([
			'https://tronscan.org/#/transaction/{txid}',
			'https://tronscan.io/#/transaction/{txid}',
			'https://3xpl.com/tron/transaction/{txid}'
		]),
		// Solana (spl) — reuses the SOL-vetted alternatives
		spl: Object.freeze([
			'https://solscan.io/tx/{txid}',
			'https://solana.fm/tx/{txid}',
			'https://explorer.solana.com/tx/{txid}'
		]),
		// BNB Smart Chain (bep20)
		bep20: Object.freeze([
			'https://bscscan.com/tx/{txid}',
			'https://3xpl.com/bnb/transaction/{txid}',
			'https://bscscan.io/tx/{txid}'
		]),
		// Base (USDC, DAI)
		base: Object.freeze([
			'https://basescan.org/tx/{txid}',
			'https://base.blockscout.com/tx/{txid}',
			'https://3xpl.com/base/transaction/{txid}'
		]),
		// Polygon (USDC, DAI)
		polygon: Object.freeze([
			'https://polygonscan.com/tx/{txid}',
			'https://polygon.blockscout.com/tx/{txid}',
			'https://3xpl.com/polygon/transaction/{txid}'
		]),
		// Arbitrum One (DAI)
		arbitrum: Object.freeze([
			'https://arbiscan.io/tx/{txid}',
			'https://arbitrum.blockscout.com/tx/{txid}',
			'https://3xpl.com/arbitrum-one/transaction/{txid}'
		])
	});

/** Substitute `{txid}` into a template.  Defensive: if the
 *  template doesn't contain `{txid}` (e.g. an operator who
 *  somehow bypassed the validator on the way in), append
 *  `/tx/<txid>` to the origin so at least SOMETHING resolves.
 *  Returns null if the template can't be parsed at all. */
export function substituteTxidIntoTemplate(
	template: string,
	txid: string
): string | null {
	if (template.includes('{txid}')) {
		return template.replace(/\{txid\}/g, txid);
	}
	try {
		const parsed = new URL(template);
		return `${parsed.protocol}//${parsed.host}/tx/${txid}`;
	} catch {
		return null;
	}
}

/** Validate a chat-link URL template.  Same contract as the
 *  ops-cli wizard's parseChatLinkTemplate and the indexer
 *  config's isValidChatLinkTemplate.  Returns true on success,
 *  false on any failure mode.  Used by the frontend store to
 *  defensively reject malformed operator overrides at hydration
 *  (defense-in-depth: the indexer's zod schema is supposed to
 *  catch these, but a hostile or buggy indexer might still
 *  serve garbage). */
export function isValidChatLinkTemplate(s: string): boolean {
	if (typeof s !== 'string') return false;
	if (!s.startsWith('https://')) return false;
	if (!s.includes('{txid}')) return false;
	const sampleTxid =
		'0000000000000000000000000000000000000000000000000000000000000000';
	const filled = s.replace(/\{txid\}/g, sampleTxid);
	try {
		const parsed = new URL(filled);
		if (parsed.protocol !== 'https:') return false;
		if (parsed.username !== '' || parsed.password !== '') return false;
		return true;
	} catch {
		return false;
	}
}
