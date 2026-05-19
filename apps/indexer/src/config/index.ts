/**
 * Morphit indexer — configuration loader.
 *
 * All configuration comes from environment variables. Validated
 * with zod at boot time; any violation is fatal. The loaded Config
 * is passed explicitly through call sites — no global.
 *
 * See ops/env/indexer.env.example for the full schema with comments.
 */

import { z } from 'zod';

/**
 * Sentinels that have appeared in this repo's example .env files.
 * Boot is refused if MORPHIT_INDEXER_DATABASE_URL still contains
 * any of them as the password component, which catches the
 * "operator copied the example file and never edited it" mistake.
 *
 * Keep in sync with ops/postgres/init.sql's reject list and with
 * apps/relay/src/config/index.ts.
 */
const PLACEHOLDER_DB_PASSWORDS = [
	'CHANGEME',
	'CHANGE_ME',
	'CHANGE_ME_BEFORE_PRODUCTION',
	'__SET_BEFORE_DEPLOY__',
	'password',
	'postgres'
] as const;

/** Validate a chat-link URL template (Part 109).  Must start
 *  with https://, contain literal `{txid}`, and parse as a
 *  URL after substitution with a placeholder txid.  Mirrors
 *  the ops-cli wizard's parseChatLinkTemplate so the
 *  validation reasoning is identical at config-write time
 *  and config-load time. */
function isValidChatLinkTemplate(s: string): boolean {
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

/** Trimmed, unambiguous config consumed by the rest of the service. */
export interface Config {
	/** Postgres connection string. Sensitive — never log or expose. */
	readonly databaseUrl: string;
	/** Maximum number of pg pool connections.  Default 10 is fine
	 *  for a small instance; larger deployments (or instances that
	 *  also share the DB with another service) may want to raise
	 *  this.  Bound by Postgres `max_connections` server setting
	 *  (typically 100).  Operator knob: MORPHIT_INDEXER_DB_POOL_MAX. */
	readonly databasePoolMax: number;
	/** Which Blurt chain are we indexing? Pinned at first run so we
	 *  can't accidentally switch networks and corrupt state. */
	readonly chainId: string;
	/** Array of Blurt RPC endpoints we'll rotate between. */
	readonly blurtRpcEndpoints: readonly string[];
	/** Block number at which to start indexing if the database is
	 *  empty. Used once per deployment; subsequent restarts resume
	 *  from `indexer_state.last_applied_block`. */
	readonly startBlock: number;
	/** How long to sleep between polling the chain head. Blurt blocks
	 *  are ~3 seconds; this is the ceiling on indexer freshness. */
	readonly blockIntervalMs: number;
	/** Backoff on transient chain errors (network failure, RPC
	 *  500). Does not apply to structural errors in op payloads —
	 *  those are rejected and logged without retry. */
	readonly errorBackoffMs: number;
	/** Lag (blocks behind chain head) above which /v1/health reports
	 *  `stale: true`. Informational; no hard behavior change. */
	readonly staleLagThreshold: number;

	/** HTTP listen host/port. Typically 127.0.0.1:8081 with nginx
	 *  fronting it. */
	readonly listenHost: string;
	readonly listenPort: number;
	/** Public origin — what the frontend puts in
	 *  PUBLIC_MORPHIT_INDEXER_ORIGIN. Used for self-reference and
	 *  logging; doesn't affect routing. */
	readonly publicOrigin: string;
	/** Exact-match allowed origins for CORS. */
	readonly allowedOrigins: readonly string[];
	/** Per-IP rate limits. */
	readonly listRatePerMin: number;
	readonly resourceRatePerMin: number;
	/** Hard cap on request body size. Indexer has no POSTs currently
	 *  but the middleware runs anyway; tiny limit reflects that. */
	readonly maxRequestBodyBytes: number;

	/** Morphit's official posting pubkey, used to verify release ops.
	 *  Must match MORPHIT_OFFICIAL_POSTING_PUBKEY on the frontend. */
	readonly officialPostingPubkey: string;
	/** The Blurt account name associated with the pinned posting
	 *  pubkey. Release ops are only honored if signed by this
	 *  account. Default: 'morphit'. This is a federation-wide
	 *  trust anchor — all instances agree on the same value. */
	readonly officialAccountName: string;

	/** The Blurt account name of THIS instance's operator. Used to
	 *  gate per-instance moderation ops (operator-block, operator-
	 *  payment-method-addition). Defaults to officialAccountName for
	 *  back-compat with the canonical morphit.io deployment, but
	 *  community operators set this to their own account so they
	 *  can curate their own instance without losing federation-wide
	 *  release verification. See B3 audit note + ADR-0018 §3. */
	readonly operatorAccountName: string;

	/** The Blurt account that collects listing fees. Frontend
	 *  sends fee transfers here; indexer looks for matching
	 *  transfers when verifying orders. Default: 'morphit-fees'.
	 *  MUST match FEE_RECIPIENT on the frontend. */
	readonly feeRecipient: string;
	/** Base BLURT fee per listing (pre-multiplier). Default: 60 BLURT.
	 *
	 *  After Morphit's BLURT-native fee refactor, listing fees are
	 *  denominated directly in BLURT rather than translated from a
	 *  USD anchor at verification time. This eliminates the price-
	 *  oracle attack surface (S1/S2/S3/F11 from the §F.10 fees audit)
	 *  and the static-vs-dynamic fee divergence (F6/F17). The fee
	 *  is what the operator picks; no live price affects whether
	 *  a transfer verifies.  MUST match BASE_FEE_BLURT on the
	 *  frontend. */
	readonly feeBaseBlurt: number;
	/** Operator-level instance-wide asset disable list (Part 121,
	 *  Memory #25).  Uppercase tickers — orders posted with a
	 *  disabled asset are rejected at handler-time.  Default
	 *  empty (everything in the canonical registry is enabled).
	 *  Federation: cross-instance read-only visibility is
	 *  preserved; the operator just refuses to accept NEW orders
	 *  from their own users for the disabled assets. */
	readonly disabledAssets: readonly string[];
	/** Part 121 cp9 — public Matrix room alias for user→operator
	 *  contact, exposed via /v1/instance.operator_matrix_room.
	 *  Parsed and validated as `#room:server` at config load
	 *  time by parseRoomAlias from @morphit/operator-config.
	 *  null when not configured (frontend hides the link). */
	readonly operatorMatrixRoom: string | null;
	/** Tolerance band for fee-amount verification — fee transfers
	 *  within ±feeTolerance of the expected amount are accepted.
	 *  Default: 0.001 (0.1%). After the BLURT-native refactor this
	 *  band only absorbs floating-point rounding (Graphene serializes
	 *  BLURT amounts to 3 decimals; multiplication and division can
	 *  introduce sub-millibBLURT drift). Must match FEE_TOLERANCE on
	 *  frontend. */
	readonly feeTolerance: number;
	/** Operator-tunable fallback for the chain's
	 *  account_creation_fee, in BLURT.  Used by /v1/chain-fee
	 *  when condenser_api.get_chain_properties is unreachable.
	 *  Set this to the current witness-consensus value (default
	 *  100 BLURT).  The relay maintains its own copy of the same
	 *  knob for signup-time fallback; both should be updated
	 *  together when witnesses change the chain fee. */
	readonly accountCreationFeeBlurtFallback: number;
	/** Attestation-quorum gating phase (Finding I mitigation).
	 *  'launch' — attestor needs loyalty ≥ 100 BLURT OR age ≥ 30
	 *             days (OR gate). Used during ecosystem bootstrap.
	 *  'steady' — attestor needs loyalty AND age (AND gate). Flip
	 *             when either 90 days have elapsed since ADR-0011
	 *             activation OR ≥500 accounts already satisfy
	 *             both gates.
	 *  Default: 'launch'. Operator flips via env var when the
	 *  transition trigger is reached; no redeploy required. */
	readonly attestationPhase: 'launch' | 'steady';
	/** Whether to run the optional BLURT/USD price feed.
	 *
	 *  Default: false. When false, the indexer makes ZERO outbound
	 *  HTTP calls for pricing; fee verification doesn't need it.
	 *
	 *  When true, the price source (Klingex → Coingecko → static
	 *  floor) is initialized at boot and the /v1/listing-fee endpoint
	 *  surfaces an optional `base_fee_usd` echo. This is purely a
	 *  display courtesy for frontends that want to show users an
	 *  approximate USD equivalent next to BLURT amounts. Disabled
	 *  by default because most operators don't need it and we'd
	 *  rather not phone home to third-party price APIs without
	 *  explicit opt-in. */
	readonly priceFeedEnabled: boolean;
	/** Static floor BLURT/USD price. Only used when
	 *  `priceFeedEnabled === true` AND every live upstream has failed
	 *  AND no value has ever cached successfully. Default 0.002. */
	readonly priceFeedStaticFloor: number;
	/** How often the composite price source refreshes from
	 *  upstreams, in ms. Only relevant when `priceFeedEnabled` is
	 *  true. Default 5 minutes. */
	readonly priceRefreshIntervalMs: number;
	/** Klingex public API base URL (without trailing slash). Only
	 *  used when `priceFeedEnabled` is true. */
	readonly klingexBaseUrl: string;
	/** Coingecko API base URL. Default is the free-tier host; set
	 *  to https://pro-api.coingecko.com/api/v3 with an API key to
	 *  use the paid tier. Only used when `priceFeedEnabled` is true. */
	readonly coingeckoBaseUrl: string;
	/** Optional Coingecko API key. Free tier works without one. */
	readonly coingeckoApiKey?: string;

	/** Featured-slot auction: BLURT cost per
	 *  hour of featured-slot time. Users pay this (× hours
	 *  requested) to bid on a featured slot. Default 50 BLURT.
	 *  Operator-tunable: raise to
	 *  keep featured slots exclusive; lower to encourage more
	 *  organic bidding traffic. */
	readonly featureFeeBlurtPerHour: number;

	/** ADR-0011 sub-phase 4b: Bitcoin fee-collection address.
	 *  Orders with fee_method='btc' are verified by checking an
	 *  output on the payer's tx pays this address. Empty string
	 *  disables BTC fee acceptance. */
	readonly btcFeeAddress: string;
	/** Bitcoin listing fee in satoshis. ADR-0011 §2 says BTC/XMR
	 *  pay tier-1 flat. We store satoshis (integer) to avoid
	 *  float pitfalls at verification time. Default: 0 until
	 *  operator configures. */
	readonly btcFeeSatoshis: number;
	/** Explorer URLs for Bitcoin verification. Comma-separated.
	 *  Empty list disables verification (rejects all BTC fees as
	 *  pending_external immediately). */
	readonly btcExplorerUrls: readonly string[];

	/** ADR-0011 sub-phase 4b: Monero fee-collection address.
	 *  Paired with btcFeeAddress for the XMR path. */
	readonly xmrFeeAddress: string;
	/** Monero listing fee in piconero. Same rationale as
	 *  btcFeeSatoshis; Monero's smallest unit is 1e-12 XMR. */
	readonly xmrFeePiconero: bigint;
	/** Explorer URLs for Monero verification. */
	readonly xmrExplorerUrls: readonly string[];

	/** Part 109 quorum gate.  Minimum number of BTC explorers
	 *  that must return a successful response before a fee
	 *  verification promotes to `verified`.  When fewer responding
	 *  explorers agree (degraded outage), the verifier returns
	 *  `pending_external`.  Default 1 preserves pre-Part-109
	 *  behavior; operators with 3+ configured explorers should
	 *  raise to 2.  Bounded: >= 1, <= btcExplorerUrls.length. */
	readonly btcMinSuccessfulResponses: number;
	/** Part 109 quorum gate for XMR.  Same semantics as the BTC
	 *  field above.  With the default 5-explorer list, operators
	 *  can set this to 2-3 for true cross-source verification. */
	readonly xmrMinSuccessfulResponses: number;

	/** ADR-0010 §3: low-balance auto-refill settings. */
	readonly lowBalanceRefillIntervalMs: number;
	readonly lowBalanceThresholdBlurt: number;
	readonly lowBalanceActivityWindowDays: number;
	readonly lowBalanceRefillCooldownDays: number;
	readonly lowBalanceRefillAmountBlurt: number;
	readonly lowBalanceMaxBatch: number;

	/** Name of the relay's Blurt account. Used by the low-balance
	 *  scanner to skip the relay itself, and by future ADR-0010
	 *  features (welcome bonus, loyalty BP) that queue transfers
	 *  in the relay_pending_transfers table. */
	readonly relayAccount: string;

	/** Operator-account balance monitoring. Alerts the instance
	 *  admin when the relay or fees account drops below the
	 *  configured threshold. Thresholds of 0 disable monitoring
	 *  for that account (opt-in default). */
	readonly operatorBalanceIntervalMs: number;
	readonly operatorBalanceRelayThresholdBlurt: number;
	readonly operatorBalanceFeesThresholdBlurt: number;
	readonly operatorBalanceFailureAlertThreshold: number;
	/** URL the operator-balance scanner probes for signup stats
	 *  when a LOW_BALANCE alert fires on the relay account.
	 *  Empty string disables the probe. See
	 *  indexer/signupAnomalyProbe.ts. */
	readonly relayHealthUrl: string;

	/** Verbose mode adds more detail to /v1/health responses. Off by
	 *  default in production; useful for operator troubleshooting. */
	readonly verboseHealth: boolean;

	/** Per-instance branding (Phase D).  Optional — frontend falls
	 *  back to "Morphit" / "A Morphit instance" / no contact when
	 *  unset.  Surfaced via /v1/instance for the frontend to
	 *  display in title bar, footer, and homepage. */
	readonly instanceName: string | undefined;
	readonly instanceTagline: string | undefined;
	readonly instanceContactUrl: string | undefined;
	readonly instanceTorAddress: string | undefined;
	readonly instanceLokinetAddress: string | undefined;
	/** I2P long-form b32 address — `<52-char-base32>.b32.i2p`.
	 *  This is the canonical, always-resolvable form (derived
	 *  from the destination's hash, no naming-service required).
	 *  Many operators ALSO have a human-readable `.i2p` alias
	 *  registered with i2pd's address book or a public name
	 *  service — that goes in `instanceI2pNameAddress`.  Both
	 *  may be set; the UI shows both when present. */
	readonly instanceI2pB32Address: string | undefined;
	/** I2P human-readable name — `something.i2p`.  Optional; an
	 *  operator can have only the b32 form, or only the name,
	 *  or both.  Resolution depends on the user's i2p router
	 *  having the same address-book mapping; the b32 form is
	 *  the safer fallback. */
	readonly instanceI2pNameAddress: string | undefined;
	readonly instanceNostrPubkey: string | undefined;
	readonly instanceOrigin: string | undefined;

	/** Frontend chat-link URL template for BTC txids (Part 109).
	 *  When undefined, frontend uses its bundled default
	 *  (`https://mempool.space/tx/{txid}`).  When set, frontend
	 *  uses this template instead.  See validator above for the
	 *  shape contract: https://, contains `{txid}`, parses as URL. */
	readonly frontendBtcChatLinkUrl: string | undefined;
	/** Frontend chat-link URL template for XMR txids (Part 109).
	 *  When undefined, frontend uses its bundled default
	 *  (`https://xmrchain.net/tx/{txid}`). */
	readonly frontendXmrChatLinkUrl: string | undefined;
	/** Frontend chat-link URL template for BCH txids (Part 122
	 *  cp21).  When undefined, frontend uses its bundled default
	 *  (`https://blockchair.com/bitcoin-cash/transaction/{txid}`).
	 *  Same shape contract as BTC/XMR: https://, contains `{txid}`,
	 *  parses as URL.  Operators wanting a different BCH explorer
	 *  set MORPHIT_FRONTEND_BCH_CHAT_LINK_URL; candidates Ken
	 *  surveyed at addition time included blockchair.com,
	 *  blockchain.com/explorer, bitinfocharts.com, bchexplorer.info,
	 *  oklink.com/bch, bch.tokenview.io, blockexplorer.one, and
	 *  explorer.cloverpool.com. */
	readonly frontendBchChatLinkUrl: string | undefined;

	/** Per-instance LTC chat-link explorer URL template (Part 122
	 *  cp24).  When undefined, frontend uses its bundled default
	 *  (`https://litecoinspace.org/tx/{txid}`).  Same shape
	 *  contract as BTC/XMR/BCH: https://, contains `{txid}`,
	 *  parses as URL.  Operators wanting a different LTC explorer
	 *  set MORPHIT_FRONTEND_LTC_CHAT_LINK_URL; candidates Ken
	 *  surveyed at addition time included blockchair.com/litecoin,
	 *  oklink.com/litecoin, bitinfocharts.com/litecoin/explorer/,
	 *  chain.so/LTC, litecoinspace.org, blockexplorer.one/litecoin/mainnet,
	 *  and ltc.tokenview.io. */
	readonly frontendLtcChatLinkUrl: string | undefined;

	/** Per-instance DASH chat-link explorer URL template (Part 122
	 *  cp27).  When undefined, frontend uses its bundled default
	 *  (`https://insight.dash.org/insight/tx/{txid}`).  Same shape
	 *  contract as BTC/XMR/BCH/LTC: https://, contains `{txid}`,
	 *  parses as URL.  Operators wanting a different DASH explorer
	 *  set MORPHIT_FRONTEND_DASH_CHAT_LINK_URL; candidates Ken
	 *  surveyed at addition time included blockchair.com/dash,
	 *  explorer.dash.org/insight/, chainz.cryptoid.info/dash/,
	 *  oklink.com/dash, bitinfocharts.com/dash/explorer/,
	 *  insight.dash.org/insight/, blockexplorer.one/dash/mainnet,
	 *  blockchain.com/explorer/assets/dash, and dash.tokenview.io. */
	readonly frontendDashChatLinkUrl: string | undefined;

	/** Per-instance DOGE chat-link explorer URL template (Part 122
	 *  cp33).  When undefined, frontend uses its bundled default
	 *  (`https://blockchair.com/dogecoin/transaction/{txid}`).
	 *  Same shape contract as BTC/XMR/BCH/LTC/DASH: https://,
	 *  contains `{txid}`, parses as URL.  Operators wanting a
	 *  different DOGE explorer set MORPHIT_FRONTEND_DOGE_CHAT_LINK_URL;
	 *  candidates Ken surveyed at addition time (2026-05-19):
	 *  dogechain.info, blockchair.com/dogecoin (chosen as
	 *  bundled default), bitinfocharts.com/dogecoin/explorer,
	 *  live.blockcypher.com/doge, blockexplorer.one/dogecoin/mainnet,
	 *  blockchain.com/explorer/assets/doge (exchange-affiliated;
	 *  declined), sochain.com/DOGE, chain.so/DOGE, oklink.com
	 *  (exchange-adjacent; declined). */
	readonly frontendDogeChatLinkUrl: string | undefined;

	/** Per-instance ZEC chat-link explorer URL template (Part 122
	 *  cp39).  Same shape as BTC/XMR/BCH/LTC/DASH/DOGE (single
	 *  field, single-network mainnet).  When unset, the frontend
	 *  uses the bundled default `mainnet.zcashexplorer.app`.
	 *  Validation: https:// scheme, contains `{txid}` placeholder,
	 *  parses as URL after substitution.  Privacy/decentralization
	 *  rationale: community-run/project-aligned explorers preferred
	 *  over third-party aggregators or exchange-affiliated
	 *  services.  Candidates Ken surveyed at addition time
	 *  (2026-05-19): mainnet.zcashexplorer.app (chosen as bundled
	 *  default — community-run, official-style pointer),
	 *  blockchair.com/zcash, zcashinfo.com, 3xpl.com/zcash,
	 *  blockexplorer.one/zcash/mainnet, zcash.tokenview.io,
	 *  cipherscan.app. */
	readonly frontendZecChatLinkUrl: string | undefined;

	/** ARRR (Pirate Chain) chat-link explorer URL template (Part
	 *  122 cp41).  When set, the frontend uses this template
	 *  instead of the bundled `explorer.piratechain.com/tx/{txid}`
	 *  default.  Must contain `{txid}` placeholder; checked at
	 *  config load.
	 *
	 *  Operator's 3-explorer survey at addition time
	 *  (2026-05-19): explorer.piratechain.com (chosen as bundled
	 *  default — official project explorer, project-aligned, no
	 *  third-party tracking), pirate.explorer.dexstats.info
	 *  (community-run, Komodo-ecosystem multi-coin),
	 *  blockchain.com/explorer/assets/arrr (third-party
	 *  aggregator). */
	readonly frontendArrrChatLinkUrl: string | undefined;

	/** DCR (Decred) chat-link explorer URL template (Part 122
	 *  cp43).  When set, the frontend uses this template instead
	 *  of the bundled `dcrdata.decred.org/tx/{txid}` default.
	 *  Must contain `{txid}` placeholder; checked at config load.
	 *
	 *  Operator's 4-explorer survey at addition time
	 *  (2026-05-19): dcrdata.decred.org (chosen as bundled
	 *  default — official project explorer, project-aligned, no
	 *  third-party tracking), blockchain.com/explorer/assets/dcr
	 *  (third-party aggregator), dcr.tokenview.io (multi-chain
	 *  Tokenview), bitinfocharts.com/decred/ (community
	 *  analytics + block explorer). */
	readonly frontendDcrChatLinkUrl: string | undefined;

	/** SOL (Solana) chat-link explorer URL template (Part 122
	 *  cp45).  When set, the frontend uses this template instead
	 *  of the bundled `explorer.solana.com/tx/{txid}` default.
	 *  Must contain `{txid}` placeholder; checked at config load.
	 *
	 *  Operator's 5-explorer survey at addition time
	 *  (2026-05-19): explorer.solana.com (chosen as bundled
	 *  default — official project explorer), solscan.io
	 *  (third-party aggregator, most popular), solanabeach.io
	 *  (validator-focused), oklink.com/solana (OKX-affiliated),
	 *  solana.fm (community-run, unreachable at survey time). */
	readonly frontendSolChatLinkUrl: string | undefined;

	/** ETH (Ethereum) chat-link explorer URL template (Part 122
	 *  cp47).  When set, the frontend uses this template instead
	 *  of the bundled `eth.blockscout.com/tx/{txid}` default.
	 *  Must contain `{txid}` placeholder; checked at config load.
	 *
	 *  Operator's 9-explorer survey at addition time
	 *  (2026-05-19): eth.blockscout.com (chosen as bundled
	 *  default — open-source Blockscout instance, project-aligned),
	 *  etherscan.io (most popular but third-party closed-source),
	 *  blockchair.com/ethereum, ethplorer.io,
	 *  oklink.com/ethereum (OKX-affiliated),
	 *  blockchain.com/explorer/assets/eth (multi-asset),
	 *  blockexplorer.one/ethereum/mainnet, routescan.io,
	 *  beaconcha.in (consensus-layer only, not suitable for
	 *  regular tx lookups). */
	readonly frontendEthChatLinkUrl: string | undefined;

	/** Per-instance per-network USDT chat-link explorer URL
	 *  templates (Part 122 cp30 — DD-11 closure; the multi-network
	 *  USDT explorer override has never actually worked on the
	 *  public API since Part 121 cp3 because the indexer never
	 *  declared these fields.  Frontend defensive-fallback hid the
	 *  breakage).  Each field independently undefined→bundled
	 *  default; when set, the frontend uses this template for the
	 *  matching USDT network.  Bundled defaults:
	 *    erc20 → https://etherscan.io/tx/{txid}
	 *    trc20 → https://tronscan.org/#/transaction/{txid}
	 *    spl   → https://solscan.io/tx/{txid}
	 *    bep20 → https://bscscan.com/tx/{txid}
	 *  Validation: same shape contract as the single-network
	 *  variants; https://, contains `{txid}`, parses as URL after
	 *  substitution. */
	readonly frontendUsdtErc20ChatLinkUrl: string | undefined;
	readonly frontendUsdtTrc20ChatLinkUrl: string | undefined;
	readonly frontendUsdtSplChatLinkUrl: string | undefined;
	readonly frontendUsdtBep20ChatLinkUrl: string | undefined;

	/** Per-instance per-network USDC chat-link explorer URL
	 *  templates (Part 122 cp30 — DD-10 closure).  Same shape
	 *  contract as USDT above.  Bundled defaults:
	 *    erc20   → https://etherscan.io/tx/{txid}
	 *    spl     → https://solscan.io/tx/{txid}
	 *    base    → https://basescan.org/tx/{txid}
	 *    polygon → https://polygonscan.com/tx/{txid}
	 *  BEP-20 is intentionally NOT supported (ADR-0028 §1) — that
	 *  variant is Binance-Peg, not Circle-native, and uses 18-decimal
	 *  precision vs 6-decimal on every supported USDC network. */
	readonly frontendUsdcErc20ChatLinkUrl: string | undefined;
	readonly frontendUsdcSplChatLinkUrl: string | undefined;
	readonly frontendUsdcBaseChatLinkUrl: string | undefined;
	readonly frontendUsdcPolygonChatLinkUrl: string | undefined;

	/** Per-instance per-network DAI chat-link explorer URL
	 *  templates (Part 122 cp31).  4 networks, all EVM-family.
	 *  Bundled defaults:
	 *    erc20    → https://etherscan.io/tx/{txid}
	 *    polygon  → https://polygonscan.com/tx/{txid}
	 *    base     → https://basescan.org/tx/{txid}
	 *    arbitrum → https://arbiscan.io/tx/{txid}
	 *  SPL/TRC-20/BEP-20 intentionally NOT supported (ADR-0029 §1)
	 *  — no canonical Maker-issued DAI on those chains. */
	readonly frontendDaiErc20ChatLinkUrl: string | undefined;
	readonly frontendDaiPolygonChatLinkUrl: string | undefined;
	readonly frontendDaiBaseChatLinkUrl: string | undefined;
	readonly frontendDaiArbitrumChatLinkUrl: string | undefined;

	/** The operator's registered tag (matching their
	 *  `morphit_operator_register_v1` op).  When set, the
	 *  /v1/instance endpoint returns this so the frontend can
	 *  include it in every order op as `operator_tag`.  Each
	 *  attributed order credits 90% of the BLURT listing fee
	 *  to this operator.  When unset, orders go out without
	 *  attribution and the treasury keeps 100%.
	 *
	 *  REVISIT-LIST item 5 — operator earnings pipeline. */
	readonly instanceOperatorTag: string | undefined;

	/** Per-instance SEO copy override.  When set, frontend uses
	 *  these for the homepage <title>, meta description, and
	 *  meta keywords instead of the bundled svelte-i18n values.
	 *  Operators with niche audiences (e.g. a Persian-speaking
	 *  community) can swap copy without forking the frontend. */
	readonly instanceSeoTitle: string | undefined;
	readonly instanceSeoDescription: string | undefined;
	readonly instanceSeoKeywords: string | undefined;
}

const envSchema = z.object({
	MORPHIT_INDEXER_DATABASE_URL: z
		.string()
		.min(1, 'MORPHIT_INDEXER_DATABASE_URL is required')
		.refine(
			(s) => s.startsWith('postgres://') || s.startsWith('postgresql://'),
			'database URL must start with postgres:// or postgresql://'
		)
		.refine(
			// Refuse to boot if the example placeholder is still present.
			// The set of rejected sentinels matches ops/postgres/init.sql so
			// that one operator-side mistake produces consistent failures
			// at both provisioning and runtime.
			(s) => !PLACEHOLDER_DB_PASSWORDS.some((p) => s.includes(`:${p}@`)),
			'database URL still contains a placeholder password sentinel; ' +
				'set a real password in ops/env/indexer.env (see ' +
				'docs/RUN-A-MORPHIT-NODE.md step 7)'
		),
	MORPHIT_INDEXER_CHAIN_ID: z.string().length(64, 'chain ID must be 64-char hex'),
	MORPHIT_INDEXER_RPC_ENDPOINTS: z
		.string()
		.min(1)
		.transform((s) =>
			s
				.split(',')
				.map((u) => u.trim())
				.filter(Boolean)
		)
		.refine(
			(arr) => arr.length > 0 && arr.every((u) => u.startsWith('https://')),
			'all RPC endpoints must be https:// URLs'
		),
	MORPHIT_INDEXER_START_BLOCK: z.coerce.number().int().nonnegative().default(0),
	MORPHIT_INDEXER_BLOCK_INTERVAL_MS: z.coerce.number().int().positive().default(3000),
	MORPHIT_INDEXER_ERROR_BACKOFF_MS: z.coerce.number().int().positive().default(5000),
	MORPHIT_INDEXER_STALE_LAG_THRESHOLD: z.coerce.number().int().positive().default(30),

	MORPHIT_INDEXER_LISTEN_HOST: z.string().default('127.0.0.1'),
	MORPHIT_INDEXER_LISTEN_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
	MORPHIT_INDEXER_PUBLIC_ORIGIN: z.string().url(),
	MORPHIT_INDEXER_ALLOWED_ORIGINS: z
		.string()
		.default('')
		.transform((s) =>
			s
				.split(',')
				.map((o) => o.trim())
				.filter(Boolean)
		),
	MORPHIT_INDEXER_LIST_RATE_PER_MIN: z.coerce.number().int().positive().default(120),
	MORPHIT_INDEXER_RESOURCE_RATE_PER_MIN: z.coerce.number().int().positive().default(600),
	MORPHIT_INDEXER_MAX_BODY_BYTES: z.coerce.number().int().positive().default(4096),
	MORPHIT_INDEXER_DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

	MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY: z
		.string()
		.startsWith('BLT', 'official posting pubkey must be a BLT-prefixed key'),

	MORPHIT_INDEXER_OFFICIAL_ACCOUNT_NAME: z.string().min(3).max(16).default('morphit'),

	/** Per-instance operator's Blurt account.  Defaults to empty
	 *  string here in the schema; the loader below substitutes the
	 *  officialAccountName value if the operator hasn't set this
	 *  explicitly.  Lets the canonical deployment work without any
	 *  config change while community operators get a dedicated knob. */
	MORPHIT_INDEXER_OPERATOR_ACCOUNT_NAME: z.string().max(16).default(''),

	MORPHIT_INDEXER_FEE_RECIPIENT: z.string().min(3).max(16).default('morphit-fees'),
	MORPHIT_INDEXER_FEE_BASE_BLURT: z.coerce.number().positive().default(60),
	MORPHIT_INDEXER_FEE_TOLERANCE: z.coerce.number().positive().max(0.5).default(0.001),

	/** Operator-level instance-wide asset disable list (Part 121,
	 *  Memory #25).  Comma-separated uppercase tickers from the
	 *  canonical registry — e.g. `MORPHIT_INDEXER_DISABLED_ASSETS="USDT"`
	 *  to refuse all USDT orders on this instance.  The indexer's
	 *  order handler rejects orders posted with a disabled asset;
	 *  the frontend's asset picker hides the asset.  Default empty
	 *  (everything in the registry is enabled).
	 *
	 *  Use cases:
	 *  - Operators with philosophical objections to a specific
	 *    asset (USDT centralization, future stablecoin freezes)
	 *  - Operators in jurisdictions where a specific asset has
	 *    regulatory constraints they don't want to take on
	 *  - Operators running a private instance for a specific
	 *    community that only wants BTC+XMR
	 *
	 *  Memory #23 invariant separately blocks USDT from paying
	 *  fees regardless of this knob.  This knob blocks USDT from
	 *  being TRADED at all on the instance.
	 *
	 *  Per-asset opt-out is OPERATOR-LEVEL not user-level —
	 *  individual users who object to an asset pick a different
	 *  Morphit instance.  Federation rules: orders for an asset
	 *  disabled on instance A but enabled on instance B still
	 *  appear in B's orderbook (the asset's chain history is
	 *  shared); A simply refuses to ACCEPT new orders for that
	 *  asset from its own users.  Cross-instance read-only
	 *  visibility is preserved. */
	MORPHIT_INDEXER_DISABLED_ASSETS: z
		.string()
		.default('')
		.transform((s) =>
			s
				.split(',')
				.map((t) => t.trim().toUpperCase())
				.filter((t) => t.length > 0)
		),

	/** Part 121 cp9 — public Matrix room alias for user→operator
	 *  contact.  EXPOSED via /v1/instance.operator_matrix_room.
	 *  Rendered on /support, /about-this-instance, and footer.
	 *
	 *  Must be a well-formed Matrix room alias (`#room:server`).
	 *  Validation via parseRoomAlias() from
	 *  @morphit/operator-config — single source of truth shared
	 *  with the ops-cli wizard, matrix-bot, and persona
	 *  sentinels.
	 *
	 *  Empty string (default) = no Matrix contact surface; the
	 *  frontend hides the "Contact via Matrix" link entirely.
	 *
	 *  This is INTENTIONALLY a separate variable from
	 *  MORPHIT_MATRIX_BOT_ALERT_MXID (the bot's private alert
	 *  destination).  The two NEVER cross-pollinate:
	 *    - alert MXID:  PRIVATE, @user:server, bot-only,
	 *                   NEVER exposed via /v1/instance.
	 *    - matrix_room: PUBLIC,  #room:server, API-exposed,
	 *                   rendered by frontend.
	 *
	 *  Memory's @user:server vs #room:server rule: blanket
	 *  @→# replacement would route security alerts to a public
	 *  room.  The validator below refuses to load an @-prefixed
	 *  value into this slot; persona sentinels independently
	 *  verify the rule. */
	MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM: z
		.string()
		.default('')
		.transform((s, ctx) => {
			const trimmed = s.trim();
			if (trimmed === '') return null;
			// Lazy import to avoid circular-dep risk at module load
			// time.  Reuses the same parser as the wizard + bot.
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const { parseRoomAlias } = require('@morphit/operator-config');
			const parsed = parseRoomAlias(trimmed);
			if (parsed === null) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message:
						`MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM must be a valid Matrix room ` +
						`alias (#room:server).  Got: ${JSON.stringify(trimmed)}.  ` +
						`If you meant a private MXID (@user:server) — that goes in ` +
						`MORPHIT_MATRIX_BOT_ALERT_MXID, NOT here.  /v1/instance is a ` +
						`public API; an MXID exposed here would leak the operator's ` +
						`private Matrix identity to every visitor.`
				});
				return z.NEVER;
			}
			return parsed;
		}),

	// Account-creation fee fallback — used by /v1/chain-fee
	// when condenser_api.get_chain_properties is unreachable.
	// Set to the current witness-consensus value (default 100).
	// The relay has its own copy of this knob for the same
	// purpose at signup time; both should track the same value.
	MORPHIT_INDEXER_ACCOUNT_CREATION_FEE_BLURT: z.coerce.number().positive().default(100),
	MORPHIT_INDEXER_ATTESTATION_PHASE: z.enum(['launch', 'steady']).default('launch'),

	// Optional BLURT/USD price feed.  Off by default: fee
	// verification doesn't need it after the BLURT-native refactor.
	// Turn on if your frontend wants to surface USD echoes next to
	// BLURT amounts.
	MORPHIT_INDEXER_PRICE_FEED_ENABLED: z
		.enum(['true', 'false'])
		.default('false')
		.transform((s) => s === 'true'),
	MORPHIT_INDEXER_PRICE_FEED_STATIC_FLOOR: z.coerce.number().positive().default(0.002),
	MORPHIT_INDEXER_PRICE_REFRESH_INTERVAL_MS: z.coerce
		.number()
		.int()
		.positive()
		.default(5 * 60 * 1000),
	MORPHIT_INDEXER_KLINGEX_BASE_URL: z.string().default('https://klingex.io/api/v1'),
	MORPHIT_INDEXER_COINGECKO_BASE_URL: z.string().default('https://api.coingecko.com/api/v3'),
	MORPHIT_INDEXER_COINGECKO_API_KEY: z.string().optional(),

	// Featured-slot auction.
	MORPHIT_INDEXER_FEATURE_FEE_BLURT_PER_HOUR: z.coerce.number().positive().default(50),

	// BTC fee verification.  Default amount targets ~$0.25 USD at
	// $60K BTC; operator can recompute via
	//   tsx apps/indexer/scripts/recommend-fee-amounts.ts
	// when prices drift significantly.  An empty fee ADDRESS keeps
	// the feature disabled regardless of the SATOSHIS value.
	MORPHIT_INDEXER_BTC_FEE_ADDRESS: z.string().default(''),
	MORPHIT_INDEXER_BTC_FEE_SATOSHIS: z.coerce.number().int().min(0).default(416),
	MORPHIT_INDEXER_BTC_EXPLORER_URLS: z
		.string()
		.default('https://blockstream.info/api,https://mempool.space/api')
		.refine(
			(s) =>
				s
					.split(',')
					.map((u) => u.trim())
					.filter((u) => u.length > 0)
					.every((u) => u.startsWith('https://')),
			'all BTC explorer URLs must be https:// (cleartext exposes the txid+address)'
		),

	// XMR fee verification.
	//
	// Part 109: the `MORPHIT_INDEXER_XMR_FEE_VIEWKEY` env var that
	// existed during the Part 107/108 transition has been removed
	// entirely.  No code path reads it.  No verification flow uses
	// it.  If your `indexer.env` still has a line for it, the line
	// is harmless (zod ignores unknown env vars) — you can safely
	// delete it next time you touch the file.  See ADR-0011
	// Part 108++ amendment for the design rationale (per-payment
	// proofs eliminate the need for any indexer to hold a view
	// key).
	//
	// Default piconero amount targets ~$0.25 USD at $320 XMR;
	// see the recommend-fee-amounts CLI for live recomputation.
	MORPHIT_INDEXER_XMR_FEE_ADDRESS: z.string().default(''),
	MORPHIT_INDEXER_XMR_FEE_PICONERO: z
		.string()
		.default('781250000')
		.refine((s) => /^\d+$/.test(s), 'piconero must be a non-negative integer string'),
	MORPHIT_INDEXER_XMR_EXPLORER_URLS: z
		.string()
		.default(
			// Default ships with five verified-compatible explorers
			// running the `moneroexamples/onion-monero-blockchain-explorer`
			// reference codebase.  All five expose the same
			// `/api/outputs?txprove=1` endpoint used for per-payment
			// proof verification.  Multi-explorer cross-check means
			// a single compromised explorer cannot lie about a
			// verification — all responding explorers must agree.
			// See docs/OPERATIONS.md §40.4 for explorer choice
			// rationale and self-hosted-monerod option (priority #2
			// maximum independence).
			[
				'https://xmrchain.net',
				'https://localmonero.co/blocks',
				'https://monerohash.com/explorer',
				'https://exploremonero.com',
				'https://moneroexplorer.org'
			].join(',')
		)
		.refine(
			(s) =>
				s
					.split(',')
					.map((u) => u.trim())
					.filter((u) => u.length > 0)
					.every((u) => u.startsWith('https://')),
			'all XMR explorer URLs must be https:// — cleartext would leak the proof string'
		),

	// Part 109 quorum gates (BTC + XMR).  Minimum number of
	// explorers that must return a successful response before
	// the fee verifier promotes a payment to `verified`.  Default
	// 1 preserves pre-Part-109 behavior (any single agreeing
	// response is enough).  Operators with 3+ configured explorers
	// should raise to 2 (or higher) for true cross-source check on
	// every payment.  Bounded server-side: must be >= 1 and <=
	// the count of configured explorer URLs (cross-validated below).
	MORPHIT_INDEXER_BTC_MIN_SUCCESSFUL_RESPONSES: z.coerce
		.number()
		.int()
		.positive()
		.default(1),
	MORPHIT_INDEXER_XMR_MIN_SUCCESSFUL_RESPONSES: z.coerce
		.number()
		.int()
		.positive()
		.default(1),

	// ADR-0010 §3 low-balance auto-refill.
	// The relay's account name — used to exclude it from the
	// scanner's candidate list (the relay isn't a Morphit user,
	// and would in any case self-refund via recurrent_transfer).
	MORPHIT_INDEXER_RELAY_ACCOUNT: z.string().min(3).max(16).default('morphit-relay'),
	// Poll cadence — how often we scan for users below the threshold.
	// Default every 6 hours; the refill isn't time-critical.
	MORPHIT_INDEXER_LOW_BALANCE_REFILL_INTERVAL_MS: z.coerce
		.number()
		.int()
		.positive()
		.default(6 * 60 * 60_000),
	// Balance below which we consider the user needs a dust top-up.
	// Default 0.5 BLURT — enough for a few ops but running thin.
	MORPHIT_INDEXER_LOW_BALANCE_THRESHOLD_BLURT: z.coerce.number().positive().default(0.5),
	// How recently must the user have had a Morphit op to count as
	// active? Default 7 days — a user who hasn't touched Morphit in
	// a week doesn't need a dust refill from us.
	MORPHIT_INDEXER_LOW_BALANCE_ACTIVITY_WINDOW_DAYS: z.coerce.number().int().positive().default(7),
	// Cooldown after a refill before we'll consider the same account
	// again. Default 3 days — stops a user who burns through dust
	// in a day from becoming a refill treadmill.
	MORPHIT_INDEXER_LOW_BALANCE_REFILL_COOLDOWN_DAYS: z.coerce.number().int().positive().default(3),
	// Amount per refill. Default 1 BLURT — matches the signup dust,
	// keeps per-refill cost at $0.002 or so.
	MORPHIT_INDEXER_LOW_BALANCE_REFILL_AMOUNT_BLURT: z.coerce.number().positive().default(1),
	// Max accounts to process per scan. Hard cap to bound RPC load
	// and damage if a bug sends refills to everyone. Default 50;
	// at 6h intervals that's 200/day max.
	MORPHIT_INDEXER_LOW_BALANCE_MAX_BATCH: z.coerce.number().int().positive().max(500).default(50),

	// ─── Operator-account balance monitoring ─────────────────────
	// Distinct from ADR-0010 §3 above, which refills USER accounts.
	// These fields alert the instance admin when the OPERATOR's own
	// service accounts (relay, fees) cross below thresholds, so
	// they can top up before the relay starves or notice if fees
	// are being swept unexpectedly.
	//
	// Defaults are 0 (= disabled) so an operator upgrading without
	// reading release notes gets no surprise alerts. Thresholds
	// must be set explicitly to opt in.
	MORPHIT_INDEXER_OPERATOR_BALANCE_INTERVAL_MS: z.coerce
		.number()
		.int()
		.positive()
		.default(15 * 60_000), // 15 min — operational urgency
	MORPHIT_INDEXER_OPERATOR_BALANCE_RELAY_THRESHOLD_BLURT: z.coerce
		.number()
		.nonnegative()
		.default(0),
	MORPHIT_INDEXER_OPERATOR_BALANCE_FEES_THRESHOLD_BLURT: z.coerce.number().nonnegative().default(0),
	MORPHIT_INDEXER_OPERATOR_BALANCE_FAILURE_ALERT_THRESHOLD: z.coerce
		.number()
		.int()
		.positive()
		.default(3),

	/** When a LOW_BALANCE alert fires on the relay account, the
	 *  scanner fetches this URL to check for anomalous signup
	 *  volume and attaches a kill-switch recommendation to the
	 *  alert if a drain looks likely. Typical colocated
	 *  deployment has this as http://127.0.0.1:8080/v1/health?verbose=1.
	 *  Leave empty to disable the anomaly probe entirely. */
	MORPHIT_INDEXER_RELAY_HEALTH_URL: z.string().default(''),

	MORPHIT_INDEXER_VERBOSE_HEALTH: z
		.enum(['true', 'false', '1', '0'])
		.default('false')
		.transform((s) => s === 'true' || s === '1'),

	// ── Per-instance branding (Phase D) ──
	// All optional.  /v1/instance falls back to defaults when
	// any of these is unset, so an unbranded instance still
	// works.
	MORPHIT_INSTANCE_NAME: z.string().max(64).optional(),
	MORPHIT_INSTANCE_TAGLINE: z.string().max(200).optional(),
	MORPHIT_INSTANCE_CONTACT_URL: z.string().url().optional(),
	MORPHIT_INSTANCE_TOR_ADDRESS: z.string().max(80).optional(),
	MORPHIT_INSTANCE_LOKINET_ADDRESS: z.string().max(80).optional(),
	/** I2P long-form b32 address (`<52-char-base32>.b32.i2p`).  This
	 *  is the canonical, always-resolvable form.  Recommended for
	 *  every i2p-hosted instance — works on any i2p router with no
	 *  address-book setup. */
	MORPHIT_INSTANCE_I2P_B32_ADDRESS: z.string().max(80).optional(),
	/** I2P human-readable name (`something.i2p`).  Optional.  Only
	 *  resolves on routers whose address book has the mapping;
	 *  many operators publish both. */
	MORPHIT_INSTANCE_I2P_NAME_ADDRESS: z.string().max(80).optional(),
	/** Legacy single-field I2P (pre-2026-05).  If set and neither
	 *  _B32_ nor _NAME_ is set, the loader routes the value to
	 *  the appropriate new field based on the `.b32.i2p` suffix.
	 *  New deployments should use the explicit two-field form. */
	MORPHIT_INSTANCE_I2P_ADDRESS: z.string().max(80).optional(),
	MORPHIT_INSTANCE_NOSTR_PUBKEY: z.string().max(80).optional(),
	MORPHIT_INSTANCE_ORIGIN: z.string().url().optional(),
	/** Frontend chat-link external explorer URL templates (Part 109).
	 *  When a counterparty sends a BTC or XMR txid in chat, the
	 *  frontend renders it as a clickable link substituting `{txid}`
	 *  into this template.  Operators can point these at their own
	 *  self-hosted explorers (or different third-party ones) to keep
	 *  user IPs off whichever third party the operator distrusts.
	 *
	 *  Validation: must be https://, must contain literal `{txid}`,
	 *  must parse as a URL after substitution (defense against URL-
	 *  injection via a hostile env-var write).  When unset, the
	 *  frontend falls back to its bundled defaults (mempool.space
	 *  and xmrchain.net). */
	MORPHIT_FRONTEND_BTC_CHAT_LINK_URL: z
		.string()
		.max(512)
		.optional()
		.refine(
			(s) => s === undefined || isValidChatLinkTemplate(s),
			'must be https://, contain {txid}, and parse as URL'
		),
	MORPHIT_FRONTEND_XMR_CHAT_LINK_URL: z
		.string()
		.max(512)
		.optional()
		.refine(
			(s) => s === undefined || isValidChatLinkTemplate(s),
			'must be https://, contain {txid}, and parse as URL'
		),
	// Part 122 cp21 — BCH chat-link explorer URL.  Same shape
	// contract as BTC/XMR; when unset, frontend falls back to the
	// bundled blockchair.com/bitcoin-cash default.
	MORPHIT_FRONTEND_BCH_CHAT_LINK_URL: z
		.string()
		.max(512)
		.optional()
		.refine(
			(s) => s === undefined || isValidChatLinkTemplate(s),
			'must be https://, contain {txid}, and parse as URL'
		),
	// Part 122 cp24 — LTC chat-link explorer URL.  Same shape
	// contract as BTC/XMR/BCH; when unset, frontend falls back to
	// the bundled litecoinspace.org default.
	MORPHIT_FRONTEND_LTC_CHAT_LINK_URL: z
		.string()
		.max(512)
		.optional()
		.refine(
			(s) => s === undefined || isValidChatLinkTemplate(s),
			'must be https://, contain {txid}, and parse as URL'
		),
	// Part 122 cp27 — DASH chat-link explorer URL.  Same shape
	// contract as BTC/XMR/BCH/LTC; when unset, frontend falls
	// back to the bundled insight.dash.org default.
	MORPHIT_FRONTEND_DASH_CHAT_LINK_URL: z
		.string()
		.max(512)
		.optional()
		.refine(
			(s) => s === undefined || isValidChatLinkTemplate(s),
			'must be https://, contain {txid}, and parse as URL'
		),
	// Part 122 cp33 — DOGE chat-link explorer URL.  Same shape
	// contract as BTC/XMR/BCH/LTC/DASH; when unset, frontend
	// falls back to the bundled blockchair.com/dogecoin default.
	MORPHIT_FRONTEND_DOGE_CHAT_LINK_URL: z
		.string()
		.max(512)
		.optional()
		.refine(
			(s) => s === undefined || isValidChatLinkTemplate(s),
			'must be https://, contain {txid}, and parse as URL'
		),
	// Part 122 cp39 — ZEC chat-link explorer URL override.
	// Single-network like BTC/XMR/BCH/LTC/DASH/DOGE.  When unset,
	// falls back to the bundled mainnet.zcashexplorer.app default.
	MORPHIT_FRONTEND_ZEC_CHAT_LINK_URL: z
		.string()
		.max(512)
		.optional()
		.refine(
			(s) => s === undefined || isValidChatLinkTemplate(s),
			'must be https://, contain {txid}, and parse as URL'
		),
	// Part 122 cp41 — ARRR (Pirate Chain) chat-link explorer URL
	// override.  Single-network like BTC/XMR/BCH/LTC/DASH/DOGE/ZEC.
	// When unset, falls back to the bundled
	// explorer.piratechain.com default.
	MORPHIT_FRONTEND_ARRR_CHAT_LINK_URL: z
		.string()
		.max(512)
		.optional()
		.refine(
			(s) => s === undefined || isValidChatLinkTemplate(s),
			'must be https://, contain {txid}, and parse as URL'
		),
	// Part 122 cp43 — DCR (Decred) chat-link explorer URL
	// override.  Single-network like BTC/XMR/BCH/LTC/DASH/DOGE/
	// ZEC/ARRR.  When unset, falls back to the bundled
	// dcrdata.decred.org default.
	MORPHIT_FRONTEND_DCR_CHAT_LINK_URL: z
		.string()
		.max(512)
		.optional()
		.refine(
			(s) => s === undefined || isValidChatLinkTemplate(s),
			'must be https://, contain {txid}, and parse as URL'
		),
	// Part 122 cp45 — SOL (Solana) chat-link explorer URL
	// override.  Single-network like all the other tradable
	// assets.  When unset, falls back to the bundled
	// explorer.solana.com default.
	MORPHIT_FRONTEND_SOL_CHAT_LINK_URL: z
		.string()
		.max(512)
		.optional()
		.refine(
			(s) => s === undefined || isValidChatLinkTemplate(s),
			'must be https://, contain {txid}, and parse as URL'
		),
	// Part 122 cp47 — ETH (Ethereum) chat-link explorer URL
	// override.  Single-network like all the other tradable
	// assets.  When unset, falls back to the bundled
	// eth.blockscout.com default.
	MORPHIT_FRONTEND_ETH_CHAT_LINK_URL: z
		.string()
		.max(512)
		.optional()
		.refine(
			(s) => s === undefined || isValidChatLinkTemplate(s),
			'must be https://, contain {txid}, and parse as URL'
		),
	// Part 122 cp30 — USDT per-network chat-link explorer URLs.
	// DD-11 closure: these were missing since Part 121 cp3 so the
	// public-API per-network override never worked.  Frontend
	// defensive-fallback hid the breakage.  Each undefined →
	// frontend uses bundled default for that network.
	MORPHIT_FRONTEND_USDT_ERC20_CHAT_LINK_URL: z
		.string()
		.max(512)
		.optional()
		.refine(
			(s) => s === undefined || isValidChatLinkTemplate(s),
			'must be https://, contain {txid}, and parse as URL'
		),
	MORPHIT_FRONTEND_USDT_TRC20_CHAT_LINK_URL: z
		.string()
		.max(512)
		.optional()
		.refine(
			(s) => s === undefined || isValidChatLinkTemplate(s),
			'must be https://, contain {txid}, and parse as URL'
		),
	MORPHIT_FRONTEND_USDT_SPL_CHAT_LINK_URL: z
		.string()
		.max(512)
		.optional()
		.refine(
			(s) => s === undefined || isValidChatLinkTemplate(s),
			'must be https://, contain {txid}, and parse as URL'
		),
	MORPHIT_FRONTEND_USDT_BEP20_CHAT_LINK_URL: z
		.string()
		.max(512)
		.optional()
		.refine(
			(s) => s === undefined || isValidChatLinkTemplate(s),
			'must be https://, contain {txid}, and parse as URL'
		),
	// Part 122 cp30 — USDC per-network chat-link explorer URLs.
	// DD-10 closure.  4 networks: erc20, spl, base, polygon.
	// BEP-20 intentionally not supported (ADR-0028 §1, Binance-Peg
	// + 18-decimal divergence).
	MORPHIT_FRONTEND_USDC_ERC20_CHAT_LINK_URL: z
		.string()
		.max(512)
		.optional()
		.refine(
			(s) => s === undefined || isValidChatLinkTemplate(s),
			'must be https://, contain {txid}, and parse as URL'
		),
	MORPHIT_FRONTEND_USDC_SPL_CHAT_LINK_URL: z
		.string()
		.max(512)
		.optional()
		.refine(
			(s) => s === undefined || isValidChatLinkTemplate(s),
			'must be https://, contain {txid}, and parse as URL'
		),
	MORPHIT_FRONTEND_USDC_BASE_CHAT_LINK_URL: z
		.string()
		.max(512)
		.optional()
		.refine(
			(s) => s === undefined || isValidChatLinkTemplate(s),
			'must be https://, contain {txid}, and parse as URL'
		),
	MORPHIT_FRONTEND_USDC_POLYGON_CHAT_LINK_URL: z
		.string()
		.max(512)
		.optional()
		.refine(
			(s) => s === undefined || isValidChatLinkTemplate(s),
			'must be https://, contain {txid}, and parse as URL'
		),
	// Part 122 cp31 — DAI per-network chat-link explorer URLs.
	// 4 networks: ERC-20 (Ethereum), Polygon, Base, Arbitrum.
	// SPL/TRC-20/BEP-20 intentionally NOT supported per ADR-0029 §1
	// (no canonical Maker-issued DAI on those chains).
	MORPHIT_FRONTEND_DAI_ERC20_CHAT_LINK_URL: z
		.string()
		.max(512)
		.optional()
		.refine(
			(s) => s === undefined || isValidChatLinkTemplate(s),
			'must be https://, contain {txid}, and parse as URL'
		),
	MORPHIT_FRONTEND_DAI_POLYGON_CHAT_LINK_URL: z
		.string()
		.max(512)
		.optional()
		.refine(
			(s) => s === undefined || isValidChatLinkTemplate(s),
			'must be https://, contain {txid}, and parse as URL'
		),
	MORPHIT_FRONTEND_DAI_BASE_CHAT_LINK_URL: z
		.string()
		.max(512)
		.optional()
		.refine(
			(s) => s === undefined || isValidChatLinkTemplate(s),
			'must be https://, contain {txid}, and parse as URL'
		),
	MORPHIT_FRONTEND_DAI_ARBITRUM_CHAT_LINK_URL: z
		.string()
		.max(512)
		.optional()
		.refine(
			(s) => s === undefined || isValidChatLinkTemplate(s),
			'must be https://, contain {txid}, and parse as URL'
		),
	// REVISIT-LIST item 5 — operator earnings pipeline.
	// Charset matches the operator-register handler's TAG_PATTERN
	// (a-z, 0-9, ., _, -; 1..64 chars).  Validated here so a
	// misconfigured operator-config fails to start the indexer
	// rather than silently shipping malformed tags in order ops.
	MORPHIT_INSTANCE_OPERATOR_TAG: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-z0-9._-]+$/, 'operator_tag must be [a-z0-9._-]+')
		.optional(),
	// SEO override knobs — task #4. Operators with non-default
	// homepages (curated communities, language-specific instances)
	// can swap the title/description/keywords without forking.
	MORPHIT_INSTANCE_SEO_TITLE: z.string().max(200).optional(),
	MORPHIT_INSTANCE_SEO_DESCRIPTION: z.string().max(500).optional(),
	MORPHIT_INSTANCE_SEO_KEYWORDS: z.string().max(500).optional()
});

export function loadConfig(): Config {
	const parsed = envSchema.safeParse(process.env);
	if (!parsed.success) {
		const issues = parsed.error.issues
			.map((i) => `  - ${i.path.join('.')}: ${i.message}`)
			.join('\n');
		throw new Error(`config validation failed:\n${issues}`);
	}
	const e = parsed.data;
	return {
		databaseUrl: e.MORPHIT_INDEXER_DATABASE_URL,
		databasePoolMax: e.MORPHIT_INDEXER_DB_POOL_MAX,
		chainId: e.MORPHIT_INDEXER_CHAIN_ID,
		blurtRpcEndpoints: e.MORPHIT_INDEXER_RPC_ENDPOINTS,
		startBlock: e.MORPHIT_INDEXER_START_BLOCK,
		blockIntervalMs: e.MORPHIT_INDEXER_BLOCK_INTERVAL_MS,
		errorBackoffMs: e.MORPHIT_INDEXER_ERROR_BACKOFF_MS,
		staleLagThreshold: e.MORPHIT_INDEXER_STALE_LAG_THRESHOLD,

		listenHost: e.MORPHIT_INDEXER_LISTEN_HOST,
		listenPort: e.MORPHIT_INDEXER_LISTEN_PORT,
		publicOrigin: e.MORPHIT_INDEXER_PUBLIC_ORIGIN,
		allowedOrigins: e.MORPHIT_INDEXER_ALLOWED_ORIGINS,
		listRatePerMin: e.MORPHIT_INDEXER_LIST_RATE_PER_MIN,
		resourceRatePerMin: e.MORPHIT_INDEXER_RESOURCE_RATE_PER_MIN,
		maxRequestBodyBytes: e.MORPHIT_INDEXER_MAX_BODY_BYTES,

		officialPostingPubkey: e.MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY,
		officialAccountName: e.MORPHIT_INDEXER_OFFICIAL_ACCOUNT_NAME,
		// B3 fix — per-instance operator account.  Falls back to
		// officialAccountName for back-compat with the canonical
		// deployment that has no need to distinguish them.
		operatorAccountName:
			e.MORPHIT_INDEXER_OPERATOR_ACCOUNT_NAME.length > 0
				? e.MORPHIT_INDEXER_OPERATOR_ACCOUNT_NAME
				: e.MORPHIT_INDEXER_OFFICIAL_ACCOUNT_NAME,

		feeRecipient: e.MORPHIT_INDEXER_FEE_RECIPIENT,
		feeBaseBlurt: e.MORPHIT_INDEXER_FEE_BASE_BLURT,
		disabledAssets: e.MORPHIT_INDEXER_DISABLED_ASSETS,
		operatorMatrixRoom: e.MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM,
		feeTolerance: e.MORPHIT_INDEXER_FEE_TOLERANCE,
		accountCreationFeeBlurtFallback: e.MORPHIT_INDEXER_ACCOUNT_CREATION_FEE_BLURT,
		attestationPhase: e.MORPHIT_INDEXER_ATTESTATION_PHASE,
		priceFeedEnabled: e.MORPHIT_INDEXER_PRICE_FEED_ENABLED,
		priceFeedStaticFloor: e.MORPHIT_INDEXER_PRICE_FEED_STATIC_FLOOR,
		priceRefreshIntervalMs: e.MORPHIT_INDEXER_PRICE_REFRESH_INTERVAL_MS,
		klingexBaseUrl: e.MORPHIT_INDEXER_KLINGEX_BASE_URL,
		coingeckoBaseUrl: e.MORPHIT_INDEXER_COINGECKO_BASE_URL,
		coingeckoApiKey: e.MORPHIT_INDEXER_COINGECKO_API_KEY,

		featureFeeBlurtPerHour: e.MORPHIT_INDEXER_FEATURE_FEE_BLURT_PER_HOUR,

		btcFeeAddress: e.MORPHIT_INDEXER_BTC_FEE_ADDRESS,
		btcFeeSatoshis: e.MORPHIT_INDEXER_BTC_FEE_SATOSHIS,
		btcExplorerUrls: (() => {
			const list = e.MORPHIT_INDEXER_BTC_EXPLORER_URLS.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			if (e.MORPHIT_INDEXER_BTC_MIN_SUCCESSFUL_RESPONSES > list.length && list.length > 0) {
				throw new Error(
					`MORPHIT_INDEXER_BTC_MIN_SUCCESSFUL_RESPONSES=${e.MORPHIT_INDEXER_BTC_MIN_SUCCESSFUL_RESPONSES} ` +
						`exceeds configured BTC explorer URL count (${list.length}). ` +
						`Quorum can never be met. Reduce the threshold or add more URLs.`
				);
			}
			return list;
		})(),
		btcMinSuccessfulResponses: e.MORPHIT_INDEXER_BTC_MIN_SUCCESSFUL_RESPONSES,

		xmrFeeAddress: e.MORPHIT_INDEXER_XMR_FEE_ADDRESS,
		xmrFeePiconero: BigInt(e.MORPHIT_INDEXER_XMR_FEE_PICONERO),
		xmrExplorerUrls: (() => {
			const list = e.MORPHIT_INDEXER_XMR_EXPLORER_URLS.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			if (e.MORPHIT_INDEXER_XMR_MIN_SUCCESSFUL_RESPONSES > list.length && list.length > 0) {
				throw new Error(
					`MORPHIT_INDEXER_XMR_MIN_SUCCESSFUL_RESPONSES=${e.MORPHIT_INDEXER_XMR_MIN_SUCCESSFUL_RESPONSES} ` +
						`exceeds configured XMR explorer URL count (${list.length}). ` +
						`Quorum can never be met. Reduce the threshold or add more URLs.`
				);
			}
			return list;
		})(),
		xmrMinSuccessfulResponses: e.MORPHIT_INDEXER_XMR_MIN_SUCCESSFUL_RESPONSES,

		lowBalanceRefillIntervalMs: e.MORPHIT_INDEXER_LOW_BALANCE_REFILL_INTERVAL_MS,
		lowBalanceThresholdBlurt: e.MORPHIT_INDEXER_LOW_BALANCE_THRESHOLD_BLURT,
		lowBalanceActivityWindowDays: e.MORPHIT_INDEXER_LOW_BALANCE_ACTIVITY_WINDOW_DAYS,
		lowBalanceRefillCooldownDays: e.MORPHIT_INDEXER_LOW_BALANCE_REFILL_COOLDOWN_DAYS,
		lowBalanceRefillAmountBlurt: e.MORPHIT_INDEXER_LOW_BALANCE_REFILL_AMOUNT_BLURT,
		lowBalanceMaxBatch: e.MORPHIT_INDEXER_LOW_BALANCE_MAX_BATCH,

		relayAccount: e.MORPHIT_INDEXER_RELAY_ACCOUNT,

		operatorBalanceIntervalMs: e.MORPHIT_INDEXER_OPERATOR_BALANCE_INTERVAL_MS,
		operatorBalanceRelayThresholdBlurt: e.MORPHIT_INDEXER_OPERATOR_BALANCE_RELAY_THRESHOLD_BLURT,
		operatorBalanceFeesThresholdBlurt: e.MORPHIT_INDEXER_OPERATOR_BALANCE_FEES_THRESHOLD_BLURT,
		operatorBalanceFailureAlertThreshold:
			e.MORPHIT_INDEXER_OPERATOR_BALANCE_FAILURE_ALERT_THRESHOLD,
		relayHealthUrl: e.MORPHIT_INDEXER_RELAY_HEALTH_URL,

		verboseHealth: e.MORPHIT_INDEXER_VERBOSE_HEALTH,
		instanceName: e.MORPHIT_INSTANCE_NAME,
		instanceTagline: e.MORPHIT_INSTANCE_TAGLINE,
		instanceContactUrl: e.MORPHIT_INSTANCE_CONTACT_URL,
		instanceTorAddress: e.MORPHIT_INSTANCE_TOR_ADDRESS,
		instanceLokinetAddress: e.MORPHIT_INSTANCE_LOKINET_ADDRESS,
		// I2P: support new (B32 + NAME) and legacy (single ADDRESS).
		// If both new fields are set, use them as-is.  If only the
		// legacy field is set, route by suffix:
		//   - `.b32.i2p` → instanceI2pB32Address
		//   - anything else `.i2p` → instanceI2pNameAddress
		// This preserves backwards-compat for operators who haven't
		// migrated their env files yet, while letting new operators
		// publish both forms.
		instanceI2pB32Address: ((): string | undefined => {
			if (e.MORPHIT_INSTANCE_I2P_B32_ADDRESS) {
				return e.MORPHIT_INSTANCE_I2P_B32_ADDRESS;
			}
			const legacy = e.MORPHIT_INSTANCE_I2P_ADDRESS;
			if (legacy && legacy.toLowerCase().endsWith('.b32.i2p')) {
				return legacy;
			}
			return undefined;
		})(),
		instanceI2pNameAddress: ((): string | undefined => {
			if (e.MORPHIT_INSTANCE_I2P_NAME_ADDRESS) {
				return e.MORPHIT_INSTANCE_I2P_NAME_ADDRESS;
			}
			const legacy = e.MORPHIT_INSTANCE_I2P_ADDRESS;
			if (
				legacy &&
				!legacy.toLowerCase().endsWith('.b32.i2p') &&
				legacy.toLowerCase().endsWith('.i2p')
			) {
				return legacy;
			}
			return undefined;
		})(),
		instanceNostrPubkey: e.MORPHIT_INSTANCE_NOSTR_PUBKEY,
		instanceOrigin: e.MORPHIT_INSTANCE_ORIGIN,
		instanceOperatorTag: e.MORPHIT_INSTANCE_OPERATOR_TAG,
		instanceSeoTitle: e.MORPHIT_INSTANCE_SEO_TITLE,
		instanceSeoDescription: e.MORPHIT_INSTANCE_SEO_DESCRIPTION,
		instanceSeoKeywords: e.MORPHIT_INSTANCE_SEO_KEYWORDS,
		frontendBtcChatLinkUrl: e.MORPHIT_FRONTEND_BTC_CHAT_LINK_URL,
		frontendXmrChatLinkUrl: e.MORPHIT_FRONTEND_XMR_CHAT_LINK_URL,
		frontendBchChatLinkUrl: e.MORPHIT_FRONTEND_BCH_CHAT_LINK_URL,
		frontendLtcChatLinkUrl: e.MORPHIT_FRONTEND_LTC_CHAT_LINK_URL,
		frontendDashChatLinkUrl: e.MORPHIT_FRONTEND_DASH_CHAT_LINK_URL,
		frontendDogeChatLinkUrl: e.MORPHIT_FRONTEND_DOGE_CHAT_LINK_URL,
		frontendZecChatLinkUrl: e.MORPHIT_FRONTEND_ZEC_CHAT_LINK_URL,
		frontendArrrChatLinkUrl: e.MORPHIT_FRONTEND_ARRR_CHAT_LINK_URL,
		frontendDcrChatLinkUrl: e.MORPHIT_FRONTEND_DCR_CHAT_LINK_URL,
		frontendSolChatLinkUrl: e.MORPHIT_FRONTEND_SOL_CHAT_LINK_URL,
		frontendEthChatLinkUrl: e.MORPHIT_FRONTEND_ETH_CHAT_LINK_URL,
		// Part 122 cp30 — multi-network USDT + USDC chat-link
		// overrides.  Independent fields per (asset, network) since
		// the underlying explorers vary per chain and an operator's
		// trust-posture can differ per chain too.
		frontendUsdtErc20ChatLinkUrl: e.MORPHIT_FRONTEND_USDT_ERC20_CHAT_LINK_URL,
		frontendUsdtTrc20ChatLinkUrl: e.MORPHIT_FRONTEND_USDT_TRC20_CHAT_LINK_URL,
		frontendUsdtSplChatLinkUrl: e.MORPHIT_FRONTEND_USDT_SPL_CHAT_LINK_URL,
		frontendUsdtBep20ChatLinkUrl: e.MORPHIT_FRONTEND_USDT_BEP20_CHAT_LINK_URL,
		frontendUsdcErc20ChatLinkUrl: e.MORPHIT_FRONTEND_USDC_ERC20_CHAT_LINK_URL,
		frontendUsdcSplChatLinkUrl: e.MORPHIT_FRONTEND_USDC_SPL_CHAT_LINK_URL,
		frontendUsdcBaseChatLinkUrl: e.MORPHIT_FRONTEND_USDC_BASE_CHAT_LINK_URL,
		frontendUsdcPolygonChatLinkUrl: e.MORPHIT_FRONTEND_USDC_POLYGON_CHAT_LINK_URL,
		// Part 122 cp31 — DAI per-network env vars.
		frontendDaiErc20ChatLinkUrl: e.MORPHIT_FRONTEND_DAI_ERC20_CHAT_LINK_URL,
		frontendDaiPolygonChatLinkUrl: e.MORPHIT_FRONTEND_DAI_POLYGON_CHAT_LINK_URL,
		frontendDaiBaseChatLinkUrl: e.MORPHIT_FRONTEND_DAI_BASE_CHAT_LINK_URL,
		frontendDaiArbitrumChatLinkUrl: e.MORPHIT_FRONTEND_DAI_ARBITRUM_CHAT_LINK_URL
	};
}
