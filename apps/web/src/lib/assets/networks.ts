/**
 * Per-network metadata for multi-network assets.  Today USDT
 * and USDC both exercise this surface (each is the same asset
 * on multiple underlying chains — same ticker, different
 * chains, INCOMPATIBLE address formats across chain families).
 *
 * Why a separate module:
 *   - The canonical `@morphit/asset-registry` lives in a
 *     framework-agnostic package and stays pure data
 *     (regexes, decimals, capability flags).  Per-network
 *     metadata (explorer URLs, fee hints, display copy) is
 *     frontend-only concern.
 *   - Operators override explorer URLs at runtime via the
 *     instance store's `chat_link_urls.{usdt,usdc,dai}` sub-maps;
 *     the bundled defaults in this file are the fallback.
 *
 * Adding a new USDT, USDC, or DAI network is a single-entry
 * addition to {USDT,USDC,DAI}_NETWORKS plus a matching i18n key
 * triplet (assets.{usdt,usdc,dai}.network.<key>.{displayName,feeHint,warning}).
 *
 * Per Ken's design decisions:
 *   - USDT (Part 121): NATIVE USDT ONLY on each network.
 *     Bridged versions (USDT.e on Avalanche L2, etc.) are
 *     excluded.  Omni Layer USDT is excluded — Tether deprecated
 *     it.
 *   - USDC (Part 122 cp30): NATIVE USDC ONLY on each network.
 *     Bridged versions (USDC.e on Avalanche, USDbC, etc.) are
 *     excluded for the same footgun-minimization reason.  The
 *     four shipped networks (ERC-20, SPL, Base, Polygon) follow
 *     the operator's canonical list at the time of addition.
 *     Notably no TRC-20 (Circle has formally distanced from
 *     Tron) and no BEP-20 (excluded from the initial set; see
 *     ADR-0028 for the rationale and the non-breaking add path).
 */

/** The set of networks we ship USDT support for at launch. */
export const USDT_NETWORKS = ['erc20', 'trc20', 'spl', 'bep20'] as const;

export type UsdtNetwork = (typeof USDT_NETWORKS)[number];

/** Per-network metadata for USDT. */
export interface UsdtNetworkMetadata {
	/** Wire-format network identifier (lowercase, used in chain
	 *  payloads and DB columns). */
	readonly key: UsdtNetwork;
	/** i18n key for the display name (e.g. "Ethereum (ERC-20)"). */
	readonly displayNameKey: string;
	/** i18n key for the one-line fee hint (e.g. "fee ~$5–20,
	 *  slow"). */
	readonly feeHintKey: string;
	/** Per-network address shape regex.  STRICTER than the
	 *  canonical registry's combined regex — this one is what
	 *  the address-share modal uses to validate the SPECIFIC
	 *  network the user picked. */
	readonly addressShape: RegExp;
	/** Per-network txid shape regex.  STRICTER than a
	 *  permissive any-hex check — the funds-sent modal
	 *  validates the txid against this when the user pastes
	 *  it.  Wrong-network txids get rejected at form time. */
	readonly txidShape: RegExp;
	/** Bundled default explorer URL template.  `{txid}` is
	 *  substituted with the lowercased transaction ID.  The
	 *  operator can override via the instance store's
	 *  `chat_link_urls.usdt.<key>` field at runtime. */
	readonly bundledExplorerUrl: string;
}

export const USDT_NETWORK_METADATA: Readonly<Record<UsdtNetwork, UsdtNetworkMetadata>> =
	Object.freeze({
		erc20: Object.freeze({
			key: 'erc20',
			displayNameKey: 'assets.usdt.network.erc20.displayName',
			feeHintKey: 'assets.usdt.network.erc20.feeHint',
			// Ethereum address: 0x + 40 hex chars
			addressShape: /^0x[a-fA-F0-9]{40}$/,
			// Ethereum txid: 0x + 64 hex chars (canonical),
			// or 64 hex without 0x (some wallets strip it)
			txidShape: /^(0x)?[a-fA-F0-9]{64}$/,
			// Etherscan — the canonical Ethereum explorer.  Per
			// Ken's list 2026-05-13.
			bundledExplorerUrl: 'https://etherscan.io/tx/{txid}'
		}),
		trc20: Object.freeze({
			key: 'trc20',
			displayNameKey: 'assets.usdt.network.trc20.displayName',
			feeHintKey: 'assets.usdt.network.trc20.feeHint',
			// Tron address: T + 33 base58 chars (no 0OIl).
			// Total length 34 chars.
			addressShape: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
			// Tron txid: 64 hex chars, no 0x prefix.
			txidShape: /^[a-fA-F0-9]{64}$/,
			// Tronscan — per Ken's list.
			bundledExplorerUrl: 'https://tronscan.org/#/transaction/{txid}'
		}),
		spl: Object.freeze({
			key: 'spl',
			displayNameKey: 'assets.usdt.network.spl.displayName',
			feeHintKey: 'assets.usdt.network.spl.feeHint',
			// Solana address: base58, 32-44 chars (Ed25519 pubkey,
			// 32 raw bytes → 43-44 base58 chars; some derived
			// addresses are 32-43 chars).
			addressShape: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
			// Solana txid: base58, 87-88 chars (Ed25519 signature,
			// 64 raw bytes → 87-88 base58 chars).
			txidShape: /^[1-9A-HJ-NP-Za-km-z]{87,88}$/,
			// Solscan — per Ken's list.
			bundledExplorerUrl: 'https://solscan.io/tx/{txid}'
		}),
		bep20: Object.freeze({
			key: 'bep20',
			displayNameKey: 'assets.usdt.network.bep20.displayName',
			feeHintKey: 'assets.usdt.network.bep20.feeHint',
			// BSC address: same shape as Ethereum (EVM-compatible).
			addressShape: /^0x[a-fA-F0-9]{40}$/,
			// BSC txid: same shape as Ethereum.
			txidShape: /^(0x)?[a-fA-F0-9]{64}$/,
			// BscScan — per Ken's list.
			bundledExplorerUrl: 'https://bscscan.com/tx/{txid}'
		})
	});

/** Type guard: is `s` a registered USDT network key? */
export function isUsdtNetwork(s: unknown): s is UsdtNetwork {
	return typeof s === 'string' && (USDT_NETWORKS as readonly string[]).includes(s);
}

/** Look up the metadata for a USDT network.  Throws on miss —
 *  callers should pass a UsdtNetwork (type-checked). */
export function getUsdtNetworkMetadata(network: UsdtNetwork): UsdtNetworkMetadata {
	const md = USDT_NETWORK_METADATA[network];
	if (md === undefined) {
		throw new Error(
			`networks.ts: USDT network '${network}' is not registered.  Add it to USDT_NETWORK_METADATA.`
		);
	}
	return md;
}

/** Validate a USDT address against the specific network's
 *  regex.  Returns true if shape-valid, false otherwise.  Does
 *  NOT verify the address exists on-chain — that's the
 *  counterparty's wallet's job.  We catch form typos. */
export function validateUsdtAddress(network: UsdtNetwork, address: string): boolean {
	if (typeof address !== 'string') return false;
	return getUsdtNetworkMetadata(network).addressShape.test(address);
}

/** Validate a USDT txid against the specific network's regex.
 *  Returns true if shape-valid, false otherwise. */
export function validateUsdtTxid(network: UsdtNetwork, txid: string): boolean {
	if (typeof txid !== 'string') return false;
	return getUsdtNetworkMetadata(network).txidShape.test(txid);
}

/** Build the bundled-default explorer URL for a USDT
 *  transaction.  Operators override per-instance via the
 *  instance store; this is the fallback. */
export function bundledUsdtExplorerUrl(network: UsdtNetwork, txid: string): string | null {
	if (!validateUsdtTxid(network, txid)) return null;
	const md = getUsdtNetworkMetadata(network);
	// cp30-DD-DD SEC-4 — normalize txids per-network so the resulting
	// URL actually resolves on the target explorer:
	//   - EVM family (erc20, bep20): lowercase + REQUIRE leading 0x.
	//     Our regex accepts both `0x...` and bare 64-hex (some
	//     wallets strip it) but Etherscan / BscScan respond with
	//     404 to bare-hex paths.  Always emit with 0x.
	//   - TRC-20 (Tron): lowercase, no prefix.  Tronscan accepts
	//     case-insensitive hex with no prefix.
	//   - SPL (Solana): base58 — CASE-SENSITIVE; do NOT lowercase.
	//     Solscan would return 404 to a lowercased Solana signature.
	let normalized: string;
	if (network === 'spl') {
		normalized = txid;
	} else if (network === 'erc20' || network === 'bep20') {
		const lc = txid.toLowerCase();
		normalized = lc.startsWith('0x') ? lc : `0x${lc}`;
	} else {
		// trc20 — no prefix conversion needed
		normalized = txid.toLowerCase();
	}
	return md.bundledExplorerUrl.replace('{txid}', normalized);
}

// ──────────────────────────────────────────────────────────────
// USDC (added Part 122 cp30)
// ──────────────────────────────────────────────────────────────

/** The set of networks we ship USDC support for at launch.
 *  Four chains, drawn from the operator's canonical block-
 *  explorer survey: Ethereum mainnet (ERC-20), Solana (SPL),
 *  Base (Coinbase L2), and Polygon PoS.  No TRC-20 (Circle
 *  doesn't issue on Tron) and no BEP-20 in this initial set
 *  (file as REVISIT to add non-breaking later if demand
 *  materializes). */
export const USDC_NETWORKS = ['erc20', 'spl', 'base', 'polygon'] as const;

export type UsdcNetwork = (typeof USDC_NETWORKS)[number];

/** Per-network metadata for USDC.  Identical shape to
 *  UsdtNetworkMetadata — kept as a separate interface for
 *  type-discrimination clarity at call sites. */
export interface UsdcNetworkMetadata {
	/** Wire-format network identifier (lowercase, used in chain
	 *  payloads and DB columns). */
	readonly key: UsdcNetwork;
	/** i18n key for the display name (e.g. "Ethereum (ERC-20)"). */
	readonly displayNameKey: string;
	/** i18n key for the one-line fee hint (e.g. "fee ~$5–20,
	 *  slow"). */
	readonly feeHintKey: string;
	/** Per-network address shape regex.  STRICTER than the
	 *  canonical registry's combined regex.  Note that ERC-20,
	 *  Base, and Polygon all share the EVM `0x[40 hex]` shape —
	 *  the network picker is what disambiguates them at form
	 *  time. */
	readonly addressShape: RegExp;
	/** Per-network txid shape regex. */
	readonly txidShape: RegExp;
	/** Bundled default explorer URL template.  `{txid}` is
	 *  substituted with the lowercased transaction ID (or the
	 *  preserved-case base58 txid for SPL).  Operators can
	 *  override via the instance store's
	 *  `chat_link_urls.usdc.<key>` field at runtime. */
	readonly bundledExplorerUrl: string;
}

export const USDC_NETWORK_METADATA: Readonly<Record<UsdcNetwork, UsdcNetworkMetadata>> =
	Object.freeze({
		erc20: Object.freeze({
			key: 'erc20',
			displayNameKey: 'assets.usdc.network.erc20.displayName',
			feeHintKey: 'assets.usdc.network.erc20.feeHint',
			// Ethereum address: 0x + 40 hex chars
			addressShape: /^0x[a-fA-F0-9]{40}$/,
			// Ethereum txid: 0x + 64 hex chars (canonical),
			// or 64 hex without 0x (some wallets strip it)
			txidShape: /^(0x)?[a-fA-F0-9]{64}$/,
			// Etherscan — the canonical Ethereum explorer.  Per
			// Ken's USDC URL list 2026-05-17.
			bundledExplorerUrl: 'https://etherscan.io/tx/{txid}'
		}),
		spl: Object.freeze({
			key: 'spl',
			displayNameKey: 'assets.usdc.network.spl.displayName',
			feeHintKey: 'assets.usdc.network.spl.feeHint',
			// Solana pubkey: base58, 32-44 chars (no prefix).
			// Excludes the base58 ambiguous chars 0OIl.
			addressShape: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
			// Solana transaction signature: base58, 64-90 chars
			// (typically 87-88).  Case-sensitive — Solscan won't
			// resolve a lowercased copy.
			txidShape: /^[1-9A-HJ-NP-Za-km-z]{64,90}$/,
			// Solscan — most widely-used Solana explorer.
			// Per Ken's URL list 2026-05-17.
			bundledExplorerUrl: 'https://solscan.io/tx/{txid}'
		}),
		base: Object.freeze({
			key: 'base',
			displayNameKey: 'assets.usdc.network.base.displayName',
			feeHintKey: 'assets.usdc.network.base.feeHint',
			// Base address: 0x + 40 hex chars (EVM).  IDENTICAL
			// shape to ERC-20 and Polygon — the network picker
			// is what disambiguates.
			addressShape: /^0x[a-fA-F0-9]{40}$/,
			// Base txid: 0x + 64 hex (EVM).
			txidShape: /^(0x)?[a-fA-F0-9]{64}$/,
			// Basescan — the canonical Base explorer.  Per
			// Ken's URL list 2026-05-17.
			bundledExplorerUrl: 'https://basescan.org/tx/{txid}'
		}),
		polygon: Object.freeze({
			key: 'polygon',
			displayNameKey: 'assets.usdc.network.polygon.displayName',
			feeHintKey: 'assets.usdc.network.polygon.feeHint',
			// Polygon address: 0x + 40 hex chars (EVM-compatible).
			// IDENTICAL shape to ERC-20 and Base.
			addressShape: /^0x[a-fA-F0-9]{40}$/,
			// Polygon txid: 0x + 64 hex (EVM).
			txidShape: /^(0x)?[a-fA-F0-9]{64}$/,
			// Polygonscan — the canonical Polygon explorer.
			// Per Ken's URL list 2026-05-17.
			bundledExplorerUrl: 'https://polygonscan.com/tx/{txid}'
		})
	});

/** Type guard: is `s` a registered USDC network key? */
export function isUsdcNetwork(s: unknown): s is UsdcNetwork {
	return typeof s === 'string' && (USDC_NETWORKS as readonly string[]).includes(s);
}

/** Look up the metadata for a USDC network.  Throws on miss —
 *  callers should pass a UsdcNetwork (type-checked). */
export function getUsdcNetworkMetadata(network: UsdcNetwork): UsdcNetworkMetadata {
	const md = USDC_NETWORK_METADATA[network];
	if (md === undefined) {
		throw new Error(
			`networks.ts: USDC network '${network}' is not registered.  Add it to USDC_NETWORK_METADATA.`
		);
	}
	return md;
}

/** Validate a USDC address against the specific network's
 *  regex.  Returns true if shape-valid, false otherwise. */
export function validateUsdcAddress(network: UsdcNetwork, address: string): boolean {
	if (typeof address !== 'string') return false;
	return getUsdcNetworkMetadata(network).addressShape.test(address);
}

/** Validate a USDC txid against the specific network's regex. */
export function validateUsdcTxid(network: UsdcNetwork, txid: string): boolean {
	if (typeof txid !== 'string') return false;
	return getUsdcNetworkMetadata(network).txidShape.test(txid);
}

/** Build the bundled-default explorer URL for a USDC
 *  transaction.  Operators override per-instance via the
 *  instance store; this is the fallback. */
export function bundledUsdcExplorerUrl(network: UsdcNetwork, txid: string): string | null {
	if (!validateUsdcTxid(network, txid)) return null;
	const md = getUsdcNetworkMetadata(network);
	// cp30-DD-DD SEC-4 — normalize txids per-network so the resulting
	// URL resolves on the target explorer (same logic as
	// bundledUsdtExplorerUrl above):
	//   - EVM family (erc20, base, polygon): lowercase + REQUIRE
	//     leading 0x.  Etherscan/Basescan/Polygonscan return 404 to
	//     bare-hex paths; our regex accepts both forms but the
	//     emitted URL must be canonical.
	//   - SPL (Solana): base58, CASE-SENSITIVE; do NOT lowercase.
	let normalized: string;
	if (network === 'spl') {
		normalized = txid;
	} else {
		// erc20, base, polygon — all EVM-family
		const lc = txid.toLowerCase();
		normalized = lc.startsWith('0x') ? lc : `0x${lc}`;
	}
	return md.bundledExplorerUrl.replace('{txid}', normalized);
}

// ──────────────────────────────────────────────────────────────
// DAI (added Part 122 cp31)
// ──────────────────────────────────────────────────────────────

/** The set of networks we ship DAI support for at launch.
 *  Four chains, all canonical MakerDAO-issued deployments:
 *  Ethereum mainnet (ERC-20, native), Polygon PoS, Base, and
 *  Arbitrum One.  Notable exclusions per ADR-0029 §1: no SPL
 *  (no native Maker DAI on Solana — only third-party wrapped
 *  variants which would defeat the decentralization rationale),
 *  no TRC-20 (same), no BEP-20 (Binance-Peg wrapped, same
 *  rationale as USDC's BEP-20 exclusion).  All four are EVM-
 *  format addresses — DAI has the highest cross-network
 *  visual-confusion surface of any asset on Morphit. */
export const DAI_NETWORKS = ['erc20', 'polygon', 'base', 'arbitrum'] as const;

export type DaiNetwork = (typeof DAI_NETWORKS)[number];

/** Per-network metadata for DAI.  Identical shape to
 *  UsdcNetworkMetadata — kept as a separate interface for
 *  type-discrimination clarity at call sites. */
export interface DaiNetworkMetadata {
	/** Wire-format network identifier (lowercase, used in chain
	 *  payloads and DB columns). */
	readonly key: DaiNetwork;
	/** i18n key for the display name (e.g. "Ethereum (ERC-20)"). */
	readonly displayNameKey: string;
	/** i18n key for the one-line fee hint. */
	readonly feeHintKey: string;
	/** Per-network address shape regex.  All four DAI networks
	 *  share the EVM `0x[40 hex]` shape — the network picker is
	 *  what disambiguates them at form time.  This is the highest
	 *  cross-network-mis-send risk surface on Morphit (4-way
	 *  EVM identity vs USDC's 3-way). */
	readonly addressShape: RegExp;
	/** Per-network txid shape regex. */
	readonly txidShape: RegExp;
	/** Bundled default explorer URL template.  `{txid}` is
	 *  substituted with the lowercased + 0x-prefixed transaction
	 *  ID.  Operators can override via the instance store's
	 *  `chat_link_urls.dai.<key>` field at runtime. */
	readonly bundledExplorerUrl: string;
}

export const DAI_NETWORK_METADATA: Readonly<Record<DaiNetwork, DaiNetworkMetadata>> =
	Object.freeze({
		erc20: Object.freeze({
			key: 'erc20',
			displayNameKey: 'assets.dai.network.erc20.displayName',
			feeHintKey: 'assets.dai.network.erc20.feeHint',
			// Ethereum address: 0x + 40 hex chars
			addressShape: /^0x[a-fA-F0-9]{40}$/,
			// Ethereum txid: 0x + 64 hex (canonical), or 64 hex
			// without prefix (some wallets strip it)
			txidShape: /^(0x)?[a-fA-F0-9]{64}$/,
			// Etherscan — canonical Ethereum explorer.  Per Ken's
			// DAI URL list 2026-05-18.
			bundledExplorerUrl: 'https://etherscan.io/tx/{txid}'
		}),
		polygon: Object.freeze({
			key: 'polygon',
			displayNameKey: 'assets.dai.network.polygon.displayName',
			feeHintKey: 'assets.dai.network.polygon.feeHint',
			// Polygon address: EVM 0x + 40 hex.  IDENTICAL to ERC-20.
			addressShape: /^0x[a-fA-F0-9]{40}$/,
			// Polygon txid: EVM 0x + 64 hex.
			txidShape: /^(0x)?[a-fA-F0-9]{64}$/,
			// Polygonscan — canonical Polygon explorer.  Per Ken's
			// DAI URL list 2026-05-18.
			bundledExplorerUrl: 'https://polygonscan.com/tx/{txid}'
		}),
		base: Object.freeze({
			key: 'base',
			displayNameKey: 'assets.dai.network.base.displayName',
			feeHintKey: 'assets.dai.network.base.feeHint',
			// Base address: EVM 0x + 40 hex.  IDENTICAL to ERC-20.
			addressShape: /^0x[a-fA-F0-9]{40}$/,
			// Base txid: EVM 0x + 64 hex.
			txidShape: /^(0x)?[a-fA-F0-9]{64}$/,
			// Basescan — canonical Base explorer.  Per Ken's DAI
			// URL list 2026-05-18.
			bundledExplorerUrl: 'https://basescan.org/tx/{txid}'
		}),
		arbitrum: Object.freeze({
			key: 'arbitrum',
			displayNameKey: 'assets.dai.network.arbitrum.displayName',
			feeHintKey: 'assets.dai.network.arbitrum.feeHint',
			// Arbitrum address: EVM 0x + 40 hex.  IDENTICAL to ERC-20.
			addressShape: /^0x[a-fA-F0-9]{40}$/,
			// Arbitrum txid: EVM 0x + 64 hex.
			txidShape: /^(0x)?[a-fA-F0-9]{64}$/,
			// Arbiscan — canonical Arbitrum explorer.  Per Ken's
			// DAI URL list 2026-05-18.
			bundledExplorerUrl: 'https://arbiscan.io/tx/{txid}'
		})
	});

/** Type guard: is `s` a registered DAI network key? */
export function isDaiNetwork(s: unknown): s is DaiNetwork {
	return typeof s === 'string' && (DAI_NETWORKS as readonly string[]).includes(s);
}

/** Look up the metadata for a DAI network.  Throws on miss —
 *  callers should pass a DaiNetwork (type-checked). */
export function getDaiNetworkMetadata(network: DaiNetwork): DaiNetworkMetadata {
	const md = DAI_NETWORK_METADATA[network];
	if (md === undefined) {
		throw new Error(
			`networks.ts: DAI network '${network}' is not registered.  Add it to DAI_NETWORK_METADATA.`
		);
	}
	return md;
}

/** Validate a DAI address against the specific network's regex.
 *  Returns true if shape-valid, false otherwise.  Note: because
 *  all 4 DAI networks share the EVM 0x[40 hex] shape, this
 *  per-network validator behaves identically across networks at
 *  the shape level.  Its purpose is to ENFORCE that callers
 *  passed a valid DaiNetwork value (compile-time + runtime), not
 *  to disambiguate the shape. */
export function validateDaiAddress(network: DaiNetwork, address: string): boolean {
	if (typeof address !== 'string') return false;
	return getDaiNetworkMetadata(network).addressShape.test(address);
}

/** Validate a DAI txid against the specific network's regex. */
export function validateDaiTxid(network: DaiNetwork, txid: string): boolean {
	if (typeof txid !== 'string') return false;
	return getDaiNetworkMetadata(network).txidShape.test(txid);
}

/** Build the bundled-default explorer URL for a DAI transaction.
 *  Operators override per-instance via the instance store; this
 *  is the fallback.  All 4 DAI networks are EVM-family so the
 *  txid normalization (lowercase + 0x prefix) is uniform — no
 *  SPL branch needed. */
export function bundledDaiExplorerUrl(network: DaiNetwork, txid: string): string | null {
	if (!validateDaiTxid(network, txid)) return null;
	const md = getDaiNetworkMetadata(network);
	// cp30-DD-DD SEC-4 — normalize txids: lowercase + REQUIRE
	// leading 0x.  Every explorer for the 4 DAI networks
	// (Etherscan, Polygonscan, Basescan, Arbiscan) returns 404
	// to bare-hex paths; our regex accepts both forms but the
	// emitted URL must be canonical.  No SPL case to handle.
	const lc = txid.toLowerCase();
	const normalized = lc.startsWith('0x') ? lc : `0x${lc}`;
	return md.bundledExplorerUrl.replace('{txid}', normalized);
}
