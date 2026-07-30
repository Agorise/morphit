/**
 * Morphit — payment-methods display helper (Batch L).
 *
 * Pure: takes an array of stored payment-method values from a
 * chain order (canonical keys, instance-namespaced keys, or
 * legacy free-text), and a display-name lookup callback for
 * instance additions, returns the array of display strings to
 * render in the UI.
 *
 * Resolution order:
 *   1. Canonical key  → registry entry's `name`.
 *   2. @instance:foo  → looked up via `instanceLookup` callback
 *                       (returns a name or undefined).  If the
 *                       lookup returns undefined, we render
 *                       `foo (this instance only)` as a
 *                       reasonable fallback.
 *   3. Legacy text    → run through `resolveLegacy`; if it
 *                       resolves to a canonical key, use that
 *                       entry's name; otherwise display the
 *                       original text verbatim.
 *
 * The legacy-text branch handles the migration case: pre-Batch-L
 * orders carry strings like "PayPal" or "M-PESA" — these resolve
 * to canonical keys via the matcher and render as the same
 * display name as new orders.
 */

import { findPaymentMethod, isInstanceKey, INSTANCE_KEY_PREFIX } from './registry';
import { resolveLegacy } from './match';

/** Resolve one stored payment-method value to its display name.
 *  See module-level doc for resolution order. */
export function displayNameForMethod(
	value: string,
	instanceLookup?: (key: string) => string | undefined
): string {
	if (typeof value !== 'string' || value.length === 0) return '';

	if (isInstanceKey(value)) {
		const looked = instanceLookup?.(value);
		if (typeof looked === 'string' && looked.length > 0) return looked;
		// Fallback: strip the prefix.
		return value.slice(INSTANCE_KEY_PREFIX.length);
	}

	const canonical = findPaymentMethod(value);
	if (canonical) return canonical.name;

	// Legacy free-text: try canonical resolution.
	const resolved = resolveLegacy(value);
	const r2 = findPaymentMethod(resolved);
	if (r2) return r2.name;

	// Truly unknown — display verbatim (the original free-text).
	return value;
}

/** Resolve a list of stored values to display names.  Order
 *  preserved.  Empty values dropped. */
export function displayNamesForMethods(
	values: readonly string[],
	instanceLookup?: (key: string) => string | undefined
): string[] {
	const out: string[] = [];
	for (const v of values) {
		const name = displayNameForMethod(v, instanceLookup);
		if (name.length > 0) out.push(name);
	}
	return out;
}
