/**
 * scripts/canary/btcHeadFailover.ts
 *
 * Pure, side-effect-free core for the warrant canary's Bitcoin chain-head
 * fetch. Kept separate from the CLI entry (fetch-btc-head.ts) so the failover
 * walk AND the per-provider response parsing are unit-testable with NO network
 * — the smoke injects a `fetchOne` that fails the first N sources, and feeds
 * canned response bodies to `parseBtcSourceBody`.
 *
 * cp613 — why this exists: the canary used to `curl` blockstream.info alone
 * for its Bitcoin freshness proof, with no fallback and a fatal `set -e`
 * abort. A single timeout there stopped the ENTIRE canary refresh. cp614 —
 * widened to hop across FIVE independent providers (Blockstream, mempool.space,
 * Blockchain.com, Blockchair, BlockCypher), each with its own HTTP shape, so a
 * provider outage / region block / Cloudflare 403 can't stall the refresh.
 * Because the BTC head is SECONDARY to the Blurt head, the caller degrades
 * gracefully when every source is unreachable rather than killing the canary.
 */

import type { CanaryBtcSource, CanaryBtcSourceKind } from '@morphit/operator-config';

export interface BtcHead {
	/** Chain tip height (positive finite integer). */
	readonly height: number;
	/** Chain tip block hash (64 lowercase hex chars). */
	readonly hash: string;
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/**
 * Resolve the ORDERED list of sources to try. An explicit
 * `MORPHIT_CANARY_BTC_EXPLORER` override is honoured EXCLUSIVELY — the operator
 * named an Esplora base on purpose (e.g. their own bitcoind/Esplora), the same
 * rule the Blurt head fetch applies to MORPHIT_CANARY_BLURT_RPC. With no
 * override we walk the full canonical provider list.
 */
export function resolveCanaryBtcSources(
	override: string | undefined,
	defaultSources: readonly CanaryBtcSource[]
): CanaryBtcSource[] {
	const trimmed = override?.trim();
	if (trimmed) return [{ kind: 'esplora', url: trimmed, label: hostOf(trimmed) }];
	return [...defaultSources];
}

/**
 * Walk `sources` in order, returning the first that yields a valid tip (and
 * which source answered), or null when every source failed. `fetchOne` is
 * injected so this is exhaustively testable without a network.
 */
export async function fetchBtcHeadWithFailover(
	sources: readonly CanaryBtcSource[],
	fetchOne: (source: CanaryBtcSource) => Promise<BtcHead | null>
): Promise<{ head: BtcHead; source: CanaryBtcSource } | null> {
	for (const source of sources) {
		const head = await fetchOne(source);
		if (head) return { head, source };
	}
	return null;
}

/**
 * Validate a raw (height, hash) pair into a BtcHead, or null if either is
 * missing/malformed. The shared shape guard behind every provider adapter — a
 * source that answers 200 with junk (an HTML error page, a truncated hash) is
 * treated as a failure and the walk moves on.
 */
export function parseBtcTip(heightRaw: string, hashRaw: string): BtcHead | null {
	const h = (heightRaw ?? '').trim();
	const hash = (hashRaw ?? '').trim().toLowerCase();
	if (!/^[0-9]+$/.test(h)) return null;
	const height = Number(h);
	if (!Number.isFinite(height) || height <= 0) return null;
	if (!/^[0-9a-f]{64}$/.test(hash)) return null;
	return { height, hash };
}

function asRecord(v: unknown): Record<string, unknown> | null {
	return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function field(obj: unknown, key: string): string {
	const rec = asRecord(obj);
	const v = rec ? rec[key] : undefined;
	return v === undefined || v === null ? '' : String(v);
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * Extract a BtcHead from a provider's raw response body(ies) by shape, or null
 * on anything malformed. Pure — the smoke feeds it canned bodies for every
 * `kind`, and the live adapter (fetch-btc-head.ts) feeds it real ones.
 *   - esplora:         primary = /blocks/tip/height text, secondary = /blocks/tip/hash text
 *   - blockchain_info: primary = JSON { height, hash }
 *   - blockchair:      primary = JSON { data: { best_block_height, best_block_hash } }
 *   - blockcypher:     primary = JSON { height, hash }
 */
export function parseBtcSourceBody(
	kind: CanaryBtcSourceKind,
	primary: string,
	secondary?: string
): BtcHead | null {
	switch (kind) {
		case 'esplora':
			return parseBtcTip(primary, secondary ?? '');
		case 'blockchain_info': {
			const j = safeJson(primary);
			return parseBtcTip(field(j, 'height'), field(j, 'hash'));
		}
		case 'blockchair': {
			const data = asRecord(safeJson(primary))?.data;
			return parseBtcTip(field(data, 'best_block_height'), field(data, 'best_block_hash'));
		}
		case 'blockcypher': {
			const j = safeJson(primary);
			return parseBtcTip(field(j, 'height'), field(j, 'hash'));
		}
		default:
			return null;
	}
}
