/**
 * Pure builder for the `price_feeds` block on /v1/health (verbose).
 *
 * Surfaces, at a glance, the health of the multi-source FX (USD→fiat)
 * and crypto (→USD) feeds added in cp372: for each feed, which
 * providers answered this cycle, how long since each last succeeded,
 * whether the committed value is stale, and whether sources are
 * disagreeing (an outlier was dropped from the average).  This is
 * what the morphit-ops node-health view renders so an operator can
 * tell at a glance that pricing is healthy — or which provider is
 * down / out of line.
 *
 * Extracted from the Hono route so it can be unit-tested without
 * loading `hono` (not installed in the smoke sandbox).  Pure: no I/O,
 * no Date.now() except via the injectable `now`.
 */

import type { BlurtPriceSource } from '$indexer/price/source';
import type { FxRateSource } from '$indexer/fx/source';

export interface SourceHealthRow {
	readonly name: string;
	/** Contributed a usable reading in the most recent refresh. */
	readonly ok: boolean;
	/** Whole seconds since this source last succeeded; null = never. */
	readonly last_ok_age_s: number | null;
	/** This source's last reading (crypto feeds: the asset→USD price it
	 *  reported; null = never succeeded). FX rows are always null — an FX
	 *  source reports a whole currency table, not a single price. Lets the
	 *  morphit-ops view show each provider's own number next to its name. */
	readonly price: number | null;
}

export interface FxFeedHealth {
	readonly enabled: true;
	readonly source: string;
	readonly stale: boolean;
	readonly live_currency_count: number;
	readonly outlier_rejected: boolean;
	/** How many sources contributed to the current averaged table. */
	readonly contributing: number;
	readonly sources: SourceHealthRow[];
}

export interface CryptoFeedHealth {
	readonly source: string;
	readonly stale: boolean;
	readonly outlier_rejected: boolean;
	readonly sources: SourceHealthRow[];
}

export interface PriceFeedsHealth {
	readonly fx: FxFeedHealth | { readonly enabled: false };
	readonly crypto: Record<string, CryptoFeedHealth>;
}

function ageSeconds(at: Date | null, nowMs: number): number | null {
	if (at === null) return null;
	const ms = nowMs - at.getTime();
	return ms < 0 ? 0 : Math.floor(ms / 1000);
}

export function buildPriceFeedsHealth(
	fxSource: FxRateSource | null,
	multiAssetSources: ReadonlyMap<string, BlurtPriceSource>,
	now: () => number = () => Date.now()
): PriceFeedsHealth {
	const nowMs = now();

	// ── FX feed ──
	let fx: FxFeedHealth | { enabled: false };
	if (fxSource === null) {
		fx = { enabled: false };
	} else {
		const d = fxSource.currentDetailed();
		const rows: SourceHealthRow[] = (fxSource.sourceStatus?.() ?? []).map((s) => ({
			name: s.name,
			ok: s.ok,
			last_ok_age_s: ageSeconds(s.lastOkAt, nowMs),
			price: null
		}));
		fx = {
			enabled: true,
			source: d.source,
			stale: d.stale,
			live_currency_count: d.live_currency_count,
			outlier_rejected: d.outlier_rejected,
			contributing: d.contributing_sources.length,
			sources: rows
		};
	}

	// ── Crypto feeds (BLURT/BTC/XMR) ──
	const crypto: Record<string, CryptoFeedHealth> = {};
	for (const [asset, source] of multiAssetSources) {
		const d = source.currentDetailed();
		const rows: SourceHealthRow[] = (source.sourceStatus?.() ?? []).map((s) => ({
			name: s.name,
			ok: s.ok,
			last_ok_age_s: ageSeconds(s.lastOkAt, nowMs),
			price: s.lastValue ?? null
		}));
		crypto[asset] = {
			source: d.source,
			stale: d.stale,
			outlier_rejected: source.outlierRejected?.() ?? false,
			sources: rows
		};
	}

	return { fx, crypto };
}
