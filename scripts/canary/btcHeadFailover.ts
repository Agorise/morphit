/**
 * scripts/canary/btcHeadFailover.ts
 *
 * Pure, side-effect-free core for the warrant canary's Bitcoin chain-head
 * fetch. Kept separate from the CLI entry (fetch-btc-head.ts) so the failover
 * walk AND the per-provider response parsing are unit-testable with NO network
 * — the smoke injects a `fetchOne` that fails the first N sources, and feeds
 * canned response bodies to `parseBtcSourceBody`.
 *
 * why this exists: the canary used to `curl` blockstream.info alone
 * for its Bitcoin freshness proof, with no fallback and a fatal `set -e`
 * abort. A single timeout there stopped the ENTIRE canary refresh.
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
 * Ask every source at once and take the FIRST valid answer — the fastest
 * hidden explorer (v1.21.15). With `agree` > 1, the first answer that many
 * sources gave (same height AND hash), so one lying explorer cannot choose
 * what the canary signs; its source is the fastest of those that agreed. Null
 * when every source failed or no answer reached `agree`. `fetchOne` is
 * injected (no network in tests).
 */
export async function fetchBtcHeadFastest(
	sources: readonly CanaryBtcSource[],
	fetchOne: (source: CanaryBtcSource) => Promise<BtcHead | null>,
	agree = 1
): Promise<{ head: BtcHead; source: CanaryBtcSource } | null> {
	if (sources.length === 0) return null;
	return new Promise((resolve) => {
		let pending = sources.length;
		let done = false;
		const seen = new Map<string, { count: number; source: CanaryBtcSource }>();
		for (const source of sources) {
			fetchOne(source)
				.catch(() => null)
				.then((head) => {
					pending--;
					if (done) return;
					if (head) {
						const key = `${head.height}:${head.hash}`;
						const entry = seen.get(key) ?? { count: 0, source };
						entry.count++;
						seen.set(key, entry);
						if (entry.count >= agree) {
							done = true;
							resolve({ head, source: entry.source });
							return;
						}
					}
					if (pending === 0) {
						done = true;
						resolve(null);
					}
				});
		}
	});
}

/** How many hidden explorers must give the same head before the canary signs
 *  it (v1.21.15); fewer when the list itself is shorter. */
export const CANARY_BTC_HIDDEN_AGREE = 2;

/** One step of the canary's Bitcoin fetch: walk sources in order, or race
 *  them and take the fastest. */
export interface CanaryBtcPhase {
	readonly mode: 'walk' | 'race';
	readonly sources: readonly CanaryBtcSource[];
}

/**
 * The order the canary asks for the Bitcoin head (v1.21.15):
 *   - an operator override (MORPHIT_CANARY_BTC_EXPLORER): that one only;
 *   - a Tor-only node: the hidden explorers first, all at once (the first
 *     head two of them agree on wins), then the clearnet ones through Tor, in
 *     order;
 *   - a clearnet node: the clearnet ones in order, and only when every one of
 *     them failed, the hidden explorers all at once (two must agree) through
 *     the local Tor / I2P proxy.
 */
export function planCanaryBtcPhases(opts: {
	readonly override: string | undefined;
	readonly torOnly: boolean;
	readonly clearnet: readonly CanaryBtcSource[];
	readonly hidden: readonly CanaryBtcSource[];
}): CanaryBtcPhase[] {
	const pinned = resolveCanaryBtcSources(opts.override, opts.clearnet);
	if (opts.override?.trim()) return [{ mode: 'walk', sources: pinned }];
	const clearnet: CanaryBtcPhase = { mode: 'walk', sources: [...opts.clearnet] };
	const hidden: CanaryBtcPhase = { mode: 'race', sources: [...opts.hidden] };
	const phases = opts.torOnly ? [hidden, clearnet] : [clearnet, hidden];
	return phases.filter((p) => p.sources.length > 0);
}

/** Run the phases in order; the first phase that yields a head wins. */
export async function fetchBtcHeadPhased(
	phases: readonly CanaryBtcPhase[],
	fetchOne: (source: CanaryBtcSource) => Promise<BtcHead | null>
): Promise<{ head: BtcHead; source: CanaryBtcSource } | null> {
	for (const phase of phases) {
		const got =
			phase.mode === 'race'
				? await fetchBtcHeadFastest(
						phase.sources,
						fetchOne,
						Math.min(CANARY_BTC_HIDDEN_AGREE, phase.sources.length)
					)
				: await fetchBtcHeadWithFailover(phase.sources, fetchOne);
		if (got) return got;
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
	// v1.21.15: a Bitcoin block hash shows its proof of work — every block for
	// years starts with 19+ zero hex digits. Fewer than 16 is not a recent
	// block's hash (it would take about 2^64 tries to make one that passes).
	if (!hash.startsWith('0'.repeat(16))) return null;
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
