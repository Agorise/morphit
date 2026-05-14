/**
 * Per-network metadata for multi-network assets.  Today only
 * USDT exercises this surface (USDT is the same asset on
 * ERC-20, TRC-20, SPL, BEP-20 — same ticker, different
 * underlying chains).
 *
 * Why a separate module:
 *   - The canonical `@morphit/asset-registry` lives in a
 *     framework-agnostic package and stays pure data
 *     (regexes, decimals, capability flags).  Per-network
 *     metadata (explorer URLs, fee hints, display copy) is
 *     frontend-only concern.
 *   - Operators override explorer URLs at runtime via the
 *     instance store's `chat_link_urls.usdt` sub-map; the
 *     bundled defaults in this file are the fallback.
 *
 * Adding a new USDT network is a single-entry addition to
 * USDT_NETWORKS plus a matching i18n key triplet
 * (assets.usdt.network.<key>.{displayName,feeHint,warning}).
 *
 * Per Ken's design decision (Part 121 USDT step):
 *   - NATIVE USDT ONLY on each network.  Bridged versions
 *     (USDT.e on Avalanche L2, etc.) are excluded.
 *   - Omni Layer USDT is excluded.  Tether deprecated it;
 *     we shouldn't endorse it as a choice.
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
	// Normalize to lowercase for hex-encoded txids; SPL
	// (base58) is case-sensitive so we preserve as-is for SPL.
	const normalized = network === 'spl' ? txid : txid.toLowerCase();
	return md.bundledExplorerUrl.replace('{txid}', normalized);
}
