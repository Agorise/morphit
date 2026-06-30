/**
 * Morphit frontend — USD→fiat FX fetch + pure conversion helpers
 * (cp372).
 *
 * The first-trade minimum is "$1 USD-equivalent" of BLURT, and
 * grandma enters her order amounts in HER local fiat.  To (a) seed
 * the Min-value field with a sensible default in her currency and
 * (b) check her entered minimum against $1 before she submits, the
 * client needs to know how much of her fiat equals $1 USD.  That
 * comes from the indexer's `/v1/fx` table — the SAME data the
 * indexer's authoritative floor uses, so the pre-submit check and
 * the on-chain check agree.
 *
 * Privacy: the indexer serves the WHOLE table; we pick the user's
 * currency locally here.  The browser never calls an FX provider
 * and the indexer never learns which fiat the user picked.
 *
 * The conversion helpers are PURE + total (never throw) so they're
 * trivially unit-testable; only the fetch touches the network.
 */

import { FIRST_ORDER_MIN_USD } from '@morphit/asset-registry';
import type { FxResponse } from '@morphit/indexer-client';

export type FxFetchResult =
	| { kind: 'ok'; table: FxResponse }
	| { kind: 'error'; message: string };

/** Fetch the indexer's USD→fiat table.  Never throws; a disabled
 *  feed (404) or any failure returns `error`, and the caller falls
 *  back to treating amounts as already-USD (the indexer's own floor
 *  still applies authoritatively). */
export async function fetchFxRates(
	indexerOrigin: string,
	fetchImpl: typeof fetch = fetch
): Promise<FxFetchResult> {
	let res: Response;
	try {
		res = await fetchImpl(`${indexerOrigin}/v1/fx`, {
			method: 'GET',
			headers: { accept: 'application/json' }
		});
	} catch (err) {
		return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
	}
	if (!res.ok) {
		return { kind: 'error', message: `indexer /v1/fx returned ${res.status}` };
	}
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return { kind: 'error', message: 'indexer /v1/fx returned non-JSON' };
	}
	const b = body as Partial<FxResponse> | null;
	if (
		b === null ||
		b.base !== 'USD' ||
		typeof b.rates !== 'object' ||
		b.rates === null
	) {
		return { kind: 'error', message: 'indexer /v1/fx returned an unexpected shape' };
	}
	return { kind: 'ok', table: b as FxResponse };
}

/** Units of `fiat` per 1 USD from a table.  Returns 1 for USD,
 *  null for an unknown/garbage fiat.  Pure + total. */
export function fxRate(table: FxResponse | null, fiat: string): number | null {
	if (table === null) return null;
	const code = fiat.trim().toUpperCase();
	if (code === 'USD') return 1;
	const r = table.rates[code];
	if (typeof r !== 'number' || !Number.isFinite(r) || r <= 0) return null;
	return r;
}

/** Convert a USD amount into `fiat`.  null for an unknown fiat. */
export function usdToFiat(table: FxResponse | null, usd: number, fiat: string): number | null {
	const r = fxRate(table, fiat);
	if (r === null || !Number.isFinite(usd)) return null;
	return usd * r;
}

/** Convert a `fiat` amount into USD — the floor's hot path
 *  ("is the entered minimum ≥ $1?").  null for an unknown fiat. */
export function fiatToUsd(table: FxResponse | null, amount: number, fiat: string): number | null {
	const r = fxRate(table, fiat);
	if (r === null || r === 0 || !Number.isFinite(amount)) return null;
	return amount / r;
}

/** A USD amount expressed in `fiat`, rounded UP to a clean,
 *  grandma-friendly step (never below the true equivalent) for seeding
 *  a fiat amount field.  null when the fiat is unknown.  Pure + total.
 *
 *  Rounding: keep it readable but never below the true equivalent
 *  (rounding DOWN could seed a value the floor then rejects).  Round UP
 *  to a sensible step: ≥100 → nearest 10; ≥10 → nearest whole; ≥1 →
 *  nearest 0.5; otherwise two decimals (rounded up). */
export function usdMinInFiat(table: FxResponse | null, usd: number, fiat: string): number | null {
	const raw = usdToFiat(table, usd, fiat);
	if (raw === null) return null;
	const ceilTo = (x: number, step: number): number => Math.ceil(x / step) * step;
	if (raw >= 100) return ceilTo(raw, 10);
	if (raw >= 10) return ceilTo(raw, 1);
	if (raw >= 1) return ceilTo(raw, 0.5);
	return Math.ceil(raw * 100) / 100;
}

/** The first-order minimum ($1 USD-equivalent) expressed in `fiat`,
 *  rounded to a clean, grandma-friendly value for seeding the
 *  Min-value field.  null when the fiat is unknown (caller seeds the
 *  raw USD figure / leaves the field blank).  Pure + total. */
export function firstOrderMinInFiat(table: FxResponse | null, fiat: string): number | null {
	return usdMinInFiat(table, FIRST_ORDER_MIN_USD, fiat);
}
