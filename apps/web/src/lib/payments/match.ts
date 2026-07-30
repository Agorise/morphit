/**
 * Morphit — payment-method matcher (Batch L).
 *
 * Pure: maps a free-text string (legacy free-form payment-method
 * value from pre-Batch-L orders) to a canonical key when the text
 * unambiguously matches one canonical name.  Returns the original
 * string unchanged if no match.
 *
 * This is the migration glue: orderbook filters and order-detail
 * displays should run free-text values through `resolveLegacy`
 * so old orders with text "PayPal" filter alongside new orders
 * with key "paypal."  The chain stores whatever was posted; this
 * module is read-side normalization only.
 *
 * Match rules (most specific first):
 *
 *   1. Exact key match → already canonical, return as-is.
 *   2. Exact name match (case-folded, diacritic-stripped) →
 *      return canonical key.
 *   3. Otherwise → return original string unchanged (the order
 *      keeps its free-text value, displayed verbatim).
 *
 * We DELIBERATELY do NOT do fuzzy matching here.  A user typed
 * "Pay-Pal" and we don't pretend it's "PayPal" — too many false
 * positives.  Fuzzy matching belongs in the search-input
 * helper (where the user is actively driving), not in passive
 * legacy resolution.
 */

import { PAYMENT_METHODS, findPaymentMethod } from './registry';

/** Build the case-folded name → key map at module load.  Keys
 *  are also indexed so `resolveLegacy('paypal')` is a no-op
 *  return, and `resolveLegacy('PayPal')` resolves to the same
 *  canonical key. */
const NAME_TO_KEY: ReadonlyMap<string, string> = (() => {
	const m = new Map<string, string>();
	for (const e of PAYMENT_METHODS) {
		m.set(fold(e.name), e.key);
	}
	return m;
})();

function fold(s: string): string {
	if (typeof s !== 'string') return '';
	return s
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.trim();
}

/** Resolve a free-text payment method to its canonical key,
 *  if possible.  Returns the input unchanged when no canonical
 *  match exists.
 *
 *  Examples (canonical):
 *    "paypal"   → "paypal"
 *    "PayPal"   → "paypal"
 *    "Pay Pal"  → "Pay Pal" (no match — falsy intent unclear)
 *    "Cash (in person)" → "cash_in_person"  // cp120
 *    "Cash by mail"     → "cash_by_mail"    // cp120
 *    "M-PESA"   → "mpesa"
 *    "promptpay"→ "promptpay" (unknown — passes through)
 */
export function resolveLegacy(text: string): string {
	if (typeof text !== 'string') return '';
	const trimmed = text.trim();
	if (trimmed.length === 0) return '';
	// Already a known canonical key?  Return as-is.
	if (findPaymentMethod(trimmed) !== null) return trimmed;
	// Folded name match?
	const byName = NAME_TO_KEY.get(fold(trimmed));
	if (byName) return byName;
	// No match — preserve original.
	return trimmed;
}

/** Convenience: normalize an array of payment-method values
 *  for display or filter comparison.  Preserves order and
 *  drops duplicates that resolved to the same canonical key. */
export function resolveLegacyMany(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const v of values) {
		const r = resolveLegacy(v);
		if (r.length === 0) continue;
		if (seen.has(r)) continue;
		seen.add(r);
		out.push(r);
	}
	return out;
}
