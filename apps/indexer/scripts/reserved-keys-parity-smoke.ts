/**
 * Morphit smoke — RESERVED_CANONICAL_KEYS parity (Batch L).
 *
 * The indexer's operatorPaymentMethod handler hardcodes a list of
 * canonical keys it refuses to accept as instance-addition keys.
 * That list is duplicated from the frontend's
 * apps/web/src/lib/payments/registry.ts following the codebase's
 * "duplicate constants across independently-deployable apps"
 * convention.
 *
 * If the two lists drift, an operator could broadcast an
 * addition that silently shadows a canonical entry on their
 * instance.  This smoke asserts they match exactly.
 */

import { readFileSync } from 'node:fs';
import { PAYMENT_METHODS } from '../../web/src/lib/payments/registry';

let scenarios = 0;
let failures = 0;
function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

console.log('\n── reserved-keys parity smoke ────────────────────────────\n');

scenario('indexer RESERVED_CANONICAL_KEYS matches frontend registry exactly', () => {
	// Read the indexer handler's source and extract the
	// RESERVED_CANONICAL_KEYS array literal.  We intentionally
	// don't import it (the indexer module has runtime deps that
	// don't load in this standalone smoke); a string-extract is
	// brittle but adequate — the smoke fires on any drift.
	const handlerSrc = readFileSync(
		new URL('../src/indexer/handlers/operatorPaymentMethod.ts', import.meta.url),
		'utf8'
	);
	const m = handlerSrc.match(
		/RESERVED_CANONICAL_KEYS:\s*ReadonlySet<string>\s*=\s*new Set\(\[([\s\S]+?)\]\);/
	);
	if (!m) throw new Error('could not find RESERVED_CANONICAL_KEYS in handler source');
	const indexerKeys = new Set<string>();
	for (const line of m[1]!.split('\n')) {
		const t = line.trim();
		const km = t.match(/^'([a-z][a-z0-9_]+)'/);
		if (km) indexerKeys.add(km[1]!);
	}
	const frontendKeys = new Set(PAYMENT_METHODS.map((e) => e.key));
	const missingInIndexer: string[] = [];
	for (const k of frontendKeys) {
		if (!indexerKeys.has(k)) missingInIndexer.push(k);
	}
	const extraInIndexer: string[] = [];
	for (const k of indexerKeys) {
		if (!frontendKeys.has(k)) extraInIndexer.push(k);
	}
	if (missingInIndexer.length > 0 || extraInIndexer.length > 0) {
		throw new Error(
			`drift detected — indexer missing: [${missingInIndexer.join(', ')}], indexer extra: [${extraInIndexer.join(', ')}]`
		);
	}
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
