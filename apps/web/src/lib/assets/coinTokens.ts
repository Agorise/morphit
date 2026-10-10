/**
 * Morphit — the coins THIS instance accepts, in copy (v1.21.5).
 *
 * An operator can switch tradable assets off (MORPHIT_INDEXER_DISABLED_ASSETS,
 * served as /v1/instance `disabled_assets`). Copy that names the coins traded
 * here — the FAQ's "what is Morphit", "where to buy Blurt", the welcome-bonus
 * and privacy pages — must name THIS site's coins, not every coin the software
 * knows. Those strings carry a token instead of a hard-coded list, and the
 * token is replaced TEXTUALLY when a locale bundle loads (and again whenever
 * the instance's list arrives or changes), exactly as `{brand}` is — see
 * src/lib/i18n/index.ts. ICU never sees a token and no call site passes one.
 *
 * Tokens:
 *   {coins}                 every coin this site accepts, "BTC, XMR and ETH"
 *   {coins|or}              the same, "BTC, XMR or ETH"
 *   {coins|list}            the same, a plain list: "BTC, XMR, ETH"
 *   {coins:-blurt}          all but these (comma-separated, each with "-")
 *   {coins:btc,ltc|or}      only these, of the ones this site accepts
 *   {coin_count}            how many coins this site accepts, as a numeral
 *
 * "Coins" are the tradable crypto assets — not barter (goods and services),
 * which the copy names separately. Tickers come in registry order; the list
 * words ("and", "or", the separator) are the language's own (Intl.ListFormat).
 *
 * PURE: no stores, no DOM — unit-tested directly, and mirrored for the static
 * llms-full.txt in scripts/build-llms-full.mjs (where every coin is listed).
 */
import { ASSETS } from './registry';

/** One token: `{coins[:filter][|mode]}` or `{coin_count}`. */
export const COIN_TOKEN_RE = /\{coins(?::([a-z0-9,-]+))?(?:\|(and|or|list))?\}|\{coin_count\}/g;

/** True when a string carries at least one coin token. */
export function hasCoinToken(s: string): boolean {
	COIN_TOKEN_RE.lastIndex = 0;
	const hit = COIN_TOKEN_RE.test(s);
	COIN_TOKEN_RE.lastIndex = 0;
	return hit;
}

/** The tradable crypto assets this site accepts, as display tickers, in
 *  registry order. `disabled` is /v1/instance `disabled_assets` (any case). */
export function acceptedCoinTickers(disabled: readonly string[]): string[] {
	const off = new Set(disabled.map((t) => t.toUpperCase()));
	return ASSETS.filter(
		(a) => a.canBeTraded && a.ticker !== 'barter' && !off.has(a.displayTicker.toUpperCase())
	).map((a) => a.displayTicker);
}

/** The separator a plain list uses in this language. */
function listSeparator(locale: string): string {
	if (locale.startsWith('zh')) return '、';
	if (locale.startsWith('fa')) return '، ';
	return ', ';
}

/** Join tickers the way the language does ("A, B and C"; "A、B和C"). Falls
 *  back to a plain list where Intl.ListFormat is missing. */
export function joinCoins(
	tickers: readonly string[],
	locale: string,
	mode: 'and' | 'or' | 'list'
): string {
	if (mode === 'list' || tickers.length < 2) return tickers.join(listSeparator(locale));
	try {
		const LF = (
			Intl as unknown as {
				ListFormat?: new (l: string, o: object) => { format(x: readonly string[]): string };
			}
		).ListFormat;
		if (LF !== undefined) {
			return new LF(locale, {
				style: 'long',
				type: mode === 'or' ? 'disjunction' : 'conjunction'
			}).format(tickers);
		}
	} catch {
		/* an unknown locale tag — fall through */
	}
	return tickers.join(listSeparator(locale));
}

/** Apply a filter spec ("-blurt" / "btc,ltc" / "-usdt,-usdc") to the accepted
 *  tickers: names without "-" keep only those; names with "-" drop those. */
function filtered(tickers: readonly string[], spec: string | undefined): string[] {
	if (spec === undefined || spec === '') return [...tickers];
	const names = spec.split(',').filter((x) => x.length > 0);
	const drop = new Set(names.filter((n) => n.startsWith('-')).map((n) => n.slice(1).toUpperCase()));
	const keep = new Set(names.filter((n) => !n.startsWith('-')).map((n) => n.toUpperCase()));
	return tickers.filter((t) => !drop.has(t) && (keep.size === 0 || keep.has(t)));
}

/** Replace every coin token in `s`. Strings without one come back unchanged
 *  (the same string), so this is cheap to run over a whole bundle. */
export function applyCoinTokens(s: string, locale: string, disabled: readonly string[]): string {
	if (!s.includes('{coin')) return s;
	const accepted = acceptedCoinTickers(disabled);
	return s.replace(COIN_TOKEN_RE, (whole: string, spec?: string, mode?: string) => {
		if (whole === '{coin_count}') {
			try {
				return new Intl.NumberFormat(locale).format(accepted.length);
			} catch {
				return String(accepted.length);
			}
		}
		return joinCoins(
			filtered(accepted, spec),
			locale,
			(mode as 'and' | 'or' | 'list' | undefined) ?? 'and'
		);
	});
}

/** A locale dictionary (nested objects of strings) with every coin token
 *  replaced. Unchanged branches keep their identity. */
export function applyCoinTokensToMessages<T>(
	dict: T,
	locale: string,
	disabled: readonly string[]
): T {
	if (typeof dict === 'string') return applyCoinTokens(dict, locale, disabled) as T;
	if (dict === null || typeof dict !== 'object' || Array.isArray(dict)) return dict;
	let out: Record<string, unknown> | null = null;
	for (const [k, v] of Object.entries(dict as Record<string, unknown>)) {
		const next = applyCoinTokensToMessages(v, locale, disabled);
		if (next !== v) {
			out ??= { ...(dict as Record<string, unknown>) };
			out[k] = next;
		}
	}
	return (out ?? dict) as T;
}
