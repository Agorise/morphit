/**
 * What THIS instance hides from its own order listings: orders of an asset
 * its operator switched off (MORPHIT_INDEXER_DISABLED_ASSETS), and orders
 * whose every payment method is switched off
 * (MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS).
 *
 * Why on the read side. Before the consensus activation time the order handler
 * refused such an order outright on this node, so its row never existed here
 * — and every later verdict that reads `orders` (a completion, a review, a
 * feature bid) differed from the peers that stored it. From that time the
 * order is stored on every instance alike (handlers/order.ts), and each
 * instance only hides it in what it shows: the orderbook (REST, live stream,
 * RSS / Atom / JSON feeds — orderbookStreamHelpers.buildWhereClauses), the
 * featured strip (featuredVisibility), and the order pages and lists
 * (orders.ts). Hiding applies to every row whatever its block, so an operator
 * who switches an asset off later hides its older orders too.
 *
 * Set once at boot from the config (main.ts). The values are inlined into SQL
 * as literals, so only the config loader's shapes pass: tickers and method
 * keys of letters, digits, `_`, `.` and `-`; anything else is dropped.
 */

const TOKEN_RE = /^[A-Za-z0-9_.-]{1,64}$/;

let hiddenAssets: readonly string[] = [];
let hiddenPaymentMethods: readonly string[] = [];

/** Take this instance's switched-off assets and payment methods (boot). */
export function setLocalOrderHiding(config: {
	readonly disabledAssets: readonly string[];
	readonly disabledPaymentMethods: readonly string[];
}): void {
	hiddenAssets = [
		...new Set(config.disabledAssets.filter((a) => TOKEN_RE.test(a)).map((a) => a.toUpperCase()))
	];
	hiddenPaymentMethods = [
		...new Set(
			config.disabledPaymentMethods.filter((m) => TOKEN_RE.test(m)).map((m) => m.toLowerCase())
		)
	];
}

const literalArray = (xs: readonly string[]): string =>
	`ARRAY[${xs.map((x) => `'${x}'`).join(', ')}]::text[]`;

/**
 * SQL that is true for an order (alias `o`) this instance shows, or null when
 * it hides nothing. Asset compared case-insensitively; an order is hidden for
 * its methods only when EVERY method it offers is switched off (one it still
 * offers keeps it shown, as the order handler used to accept it).
 */
export function locallyShownSql(o = 'o'): string | null {
	const parts: string[] = [];
	if (hiddenAssets.length > 0) {
		parts.push(`NOT (upper(${o}.asset) = ANY (${literalArray(hiddenAssets)}))`);
	}
	if (hiddenPaymentMethods.length > 0) {
		parts.push(
			`NOT COALESCE((SELECT bool_and(lower(m) = ANY (${literalArray(hiddenPaymentMethods)}))
			                 FROM unnest(${o}.payment_methods) AS m), FALSE)`
		);
	}
	return parts.length === 0 ? null : parts.join(' AND ');
}

/** locallyShownSql as an ` AND …` suffix, or '' when nothing is hidden. */
export function andLocallyShown(o = 'o'): string {
	const sql = locallyShownSql(o);
	return sql === null ? '' : ` AND ${sql}`;
}
