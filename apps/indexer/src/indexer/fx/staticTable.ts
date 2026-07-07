/**
 * Static USD→fiat fallback table — the FX subsystem's last resort.
 *
 * Used ONLY when every live upstream (Frankfurter, open.er-api,
 * exchangerate.host, …) has failed AND no live table has ever been
 * cached since boot.  Exactly analogous to the price subsystem's
 * `staticFloor` (the $0.002 BLURT / $60k BTC / $200 XMR seeds): a
 * rough, intentionally-stale anchor that keeps the form working
 * (grandma can still post) when the network is unreachable, rather
 * than blocking orders entirely.
 *
 * These figures are ROUGH (~2024–2025 order-of-magnitude) and are
 * NOT kept current — they don't need to be.  In normal operation
 * the static table never surfaces: a live provider answers and its
 * fresh table is cached.  The static table only ever serves during
 * a total FX outage, and an order priced off a slightly-stale
 * fallback rate is vastly better than an order that can't be posted
 * at all.  The values are units of each fiat per 1 USD.
 *
 * Coverage: the ~40 most-traded fiats.  A currency absent from BOTH
 * the live table and this static table makes rate() return null,
 * which the floor treats conservatively (see the order handler).
 *
 * Operators on exotic currencies can extend coverage via the live
 * providers (which return 150+ currencies) — this table is only the
 * outage floor.
 */

import type { FxRateTable } from '$indexer/fx/source';

/** Units of each fiat per 1 USD.  Rough ~2024–2025 levels. */
const STATIC_RATES: Record<string, number> = {
	USD: 1,
	EUR: 0.92,
	GBP: 0.79,
	JPY: 150,
	CNY: 7.2,
	HKD: 7.8,
	AUD: 1.52,
	CAD: 1.36,
	CHF: 0.88,
	SGD: 1.34,
	INR: 83,
	MXN: 17,
	BRL: 5.0,
	ZAR: 18.5,
	RUB: 92,
	KRW: 1330,
	TRY: 32,
	SEK: 10.6,
	NOK: 10.7,
	DKK: 6.9,
	PLN: 4.0,
	CZK: 23,
	HUF: 360,
	RON: 4.6,
	THB: 35,
	IDR: 15700,
	PHP: 56,
	MYR: 4.7,
	VND: 24500,
	NZD: 1.64,
	AED: 3.67,
	SAR: 3.75,
	QAR: 3.64,
	KWD: 0.31,
	ILS: 3.7,
	EGP: 31,
	NGN: 1500,
	ARS: 900,
	CLP: 950,
	COP: 4000,
	PEN: 3.8,
	UAH: 40,
	NTD: 32,
	TWD: 32
};

/** The frozen static fallback table.  `Object.freeze` so a bug
 *  elsewhere can't mutate the outage floor. */
export const STATIC_FX_TABLE: FxRateTable = Object.freeze({
	base: 'USD' as const,
	rates: Object.freeze({ ...STATIC_RATES })
});

/** True if `fiat` (any case) is covered by the static table.
 *  Used by tests + the composite's null logic. */
export function staticTableHas(fiat: string): boolean {
	return Object.prototype.hasOwnProperty.call(STATIC_RATES, fiat.trim().toUpperCase());
}
