/**
 * Morphit smoke — payments registry / search / match (Batch L).
 *
 * Pure logic, no I/O.  Verifies registry shape invariants, search
 * behavior across name + description fields, asset exclusion, and
 * legacy free-text → canonical key resolution.
 */

import {
	PAYMENT_METHODS,
	PAYMENT_CATEGORIES_ORDERED,
	groupByCategory,
	findPaymentMethod,
	isInstanceKey,
	INSTANCE_KEY_PREFIX,
	type PaymentCategory
} from '../../web/src/lib/payments/registry';
import { searchPaymentMethods } from '../../web/src/lib/payments/search';
import { resolveLegacy, resolveLegacyMany } from '../../web/src/lib/payments/match';

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

console.log('\n── payments smoke ────────────────────────────────────────\n');

// ─── Registry shape invariants ──────────────────────────────────────

scenario('registry not empty', () => {
	if (PAYMENT_METHODS.length === 0) throw new Error('empty');
});

scenario('every key is unique', () => {
	const seen = new Set<string>();
	for (const e of PAYMENT_METHODS) {
		if (seen.has(e.key)) throw new Error(`duplicate key: ${e.key}`);
		seen.add(e.key);
	}
});

scenario('every key matches /^[a-z][a-z0-9_]+$/ and ≤32 chars', () => {
	const re = /^[a-z][a-z0-9_]+$/;
	for (const e of PAYMENT_METHODS) {
		if (!re.test(e.key)) throw new Error(`bad key: ${e.key}`);
		if (e.key.length > 32) throw new Error(`too long: ${e.key}`);
	}
});

scenario('every name is non-empty and ≤64 chars', () => {
	for (const e of PAYMENT_METHODS) {
		if (typeof e.name !== 'string' || e.name.length === 0) {
			throw new Error(`bad name: ${e.key}`);
		}
		if (e.name.length > 64) throw new Error(`name too long: ${e.key}`);
	}
});

scenario('url is null or https://', () => {
	for (const e of PAYMENT_METHODS) {
		if (e.url !== null && !e.url.startsWith('https://')) {
			throw new Error(`bad url for ${e.key}: ${e.url}`);
		}
	}
});

scenario('every category in {crypto, in_person, by_mail, online}', () => {
	// cp120: added 'by_mail' category for asynchronous mail-based
	// payment methods (currently just `cash_by_mail`).
	const valid: ReadonlySet<PaymentCategory> = new Set([
		'crypto',
		'in_person',
		'by_mail',
		'online'
	]);
	for (const e of PAYMENT_METHODS) {
		if (!valid.has(e.category)) throw new Error(`bad category: ${e.key}`);
	}
});

scenario('no key starts with @instance: (canonical reserved)', () => {
	for (const e of PAYMENT_METHODS) {
		if (e.key.startsWith('@instance:')) {
			throw new Error(`canonical entry uses reserved prefix: ${e.key}`);
		}
	}
});

scenario('crypto entries have assetExclusion set', () => {
	const cryptos = PAYMENT_METHODS.filter((e) => e.category === 'crypto');
	if (cryptos.length === 0) throw new Error('expected crypto entries');
	for (const e of cryptos) {
		if (!e.assetExclusion) throw new Error(`crypto entry missing exclusion: ${e.key}`);
	}
});

scenario('non-crypto entries have no assetExclusion', () => {
	for (const e of PAYMENT_METHODS) {
		if (e.category !== 'crypto' && e.assetExclusion !== undefined) {
			throw new Error(`non-crypto with exclusion: ${e.key}`);
		}
	}
});

scenario('PAYMENT_CATEGORIES_ORDERED is in UX-display order', () => {
	// cp120: order is meaningful (UX), not alphabetical.  The
	// canonical order is: crypto → in_person → by_mail → online.
	// This reflects the natural mental hierarchy: same-machine
	// (crypto) → same-room (in_person) → same-country (by_mail)
	// → anywhere (online).
	const expected: readonly PaymentCategory[] = ['crypto', 'in_person', 'by_mail', 'online'];
	if (PAYMENT_CATEGORIES_ORDERED.length !== expected.length) {
		throw new Error(
			`expected ${expected.length} categories, got ${PAYMENT_CATEGORIES_ORDERED.length}`
		);
	}
	for (let i = 0; i < expected.length; i++) {
		if (PAYMENT_CATEGORIES_ORDERED[i] !== expected[i]) {
			throw new Error(
				`mismatch at index ${i}: expected ${expected[i]}, got ${PAYMENT_CATEGORIES_ORDERED[i]}`
			);
		}
	}
});

scenario('within each category, entries alphabetized by name', () => {
	const grouped = groupByCategory();
	for (const [, entries] of grouped) {
		const names = entries.map((e) => e.name.toLowerCase());
		const sorted = [...names].sort();
		for (let i = 0; i < names.length; i++) {
			if (names[i] !== sorted[i]) {
				throw new Error(`category ${entries[0]?.category ?? '?'} not sorted`);
			}
		}
	}
});

scenario('groupByCategory returns all categories', () => {
	const grouped = groupByCategory();
	for (const cat of PAYMENT_CATEGORIES_ORDERED) {
		if (!grouped.has(cat)) throw new Error(`missing ${cat}`);
	}
});

// ─── Lookups ────────────────────────────────────────────────────────

scenario('findPaymentMethod hits canonical key', () => {
	const e = findPaymentMethod('paypal');
	if (!e) throw new Error('paypal not found');
	if (e.name !== 'PayPal') throw new Error(e.name);
});

scenario('findPaymentMethod returns null for unknown', () => {
	if (findPaymentMethod('nope') !== null) throw new Error('expected null');
});

scenario('findPaymentMethod returns null for empty / non-string', () => {
	if (findPaymentMethod('') !== null) throw new Error('empty');
	if (findPaymentMethod(undefined as unknown as string) !== null) {
		throw new Error('undefined');
	}
});

// ─── isInstanceKey ──────────────────────────────────────────────────

scenario('isInstanceKey: namespaced key', () => {
	if (!isInstanceKey('@instance:promptpay')) throw new Error('expected true');
});

scenario('isInstanceKey: canonical key', () => {
	if (isInstanceKey('paypal')) throw new Error('expected false');
});

scenario('isInstanceKey: bogus input', () => {
	if (isInstanceKey('')) throw new Error('empty');
	if (isInstanceKey(123 as unknown as string)) throw new Error('number');
});

scenario('INSTANCE_KEY_PREFIX is the documented value', () => {
	if (INSTANCE_KEY_PREFIX !== '@instance:') throw new Error(INSTANCE_KEY_PREFIX);
});

// ─── searchPaymentMethods ───────────────────────────────────────────

const NO_DESC = (_: string) => null;
const SOME_DESCS = (k: string): string | null => {
	const m: Record<string, string> = {
		paypal: 'Global leader for online payments and cross-border transfers.',
		wise: 'Low-cost international money transfers.',
		mpesa: 'Leading mobile money service in Kenya.',
		cash: 'Physical paper currency exchanged in person.',
		pay_btc: 'Bitcoin — the original peer-to-peer electronic cash.'
	};
	return m[k] ?? null;
};

scenario('search: empty query returns all entries', () => {
	const r = searchPaymentMethods(PAYMENT_METHODS, '', NO_DESC);
	if (r.length !== PAYMENT_METHODS.length) throw new Error(`got ${r.length}`);
});

scenario('search: whitespace-only query returns all entries', () => {
	const r = searchPaymentMethods(PAYMENT_METHODS, '   ', NO_DESC);
	if (r.length !== PAYMENT_METHODS.length) throw new Error(`got ${r.length}`);
});

scenario('search: name match scores higher than desc match', () => {
	// Search "money" — matches "Mercado Pago" via desc, "Mobile Money"
	// not in any name… let me construct a clearer test.
	const customDesc = (k: string): string | null => {
		if (k === 'wise') return 'cross-border money transfers';
		return null;
	};
	const r = searchPaymentMethods(
		[
			{ key: 'wise', name: 'Wise', url: null, category: 'online' },
			{ key: 'paypal', name: 'PayPal Money', url: null, category: 'online' }
		],
		'money',
		customDesc
	);
	if (r.length !== 2) throw new Error(`got ${r.length}`);
	// PayPal Money matches in name (3 pts) > Wise matches in desc (1 pt)
	if (r[0]!.entry.key !== 'paypal') throw new Error('expected paypal first');
});

scenario('search: AND semantics across terms', () => {
	const r = searchPaymentMethods(
		[
			{ key: 'a', name: 'Foo Bar', url: null, category: 'online' },
			{ key: 'b', name: 'Foo Only', url: null, category: 'online' }
		],
		'foo bar',
		NO_DESC
	);
	if (r.length !== 1) throw new Error(`got ${r.length}`);
	if (r[0]!.entry.key !== 'a') throw new Error('expected a');
});

scenario('search: case-insensitive', () => {
	const r = searchPaymentMethods(PAYMENT_METHODS, 'PAYPAL', NO_DESC);
	const found = r.find((x) => x.entry.key === 'paypal');
	if (!found) throw new Error('paypal not found');
});

scenario('search: diacritic-strip matches accented names', () => {
	const entries = [{ key: 'cafe', name: 'Café Pay', url: null, category: 'online' as const }];
	const r = searchPaymentMethods(entries, 'cafe', NO_DESC);
	if (r.length !== 1) throw new Error('expected 1');
});

scenario('search: matches against description tokens', () => {
	const r = searchPaymentMethods(PAYMENT_METHODS, 'Kenya', SOME_DESCS);
	const found = r.find((x) => x.entry.key === 'mpesa');
	if (!found) throw new Error('mpesa not found via Kenya in desc');
});

scenario('search: no-match query returns empty', () => {
	const r = searchPaymentMethods(PAYMENT_METHODS, 'zzzzzzzz', NO_DESC);
	if (r.length !== 0) throw new Error(`got ${r.length}`);
});

scenario('search: excludeForAsset hides matching crypto entry', () => {
	const r = searchPaymentMethods(PAYMENT_METHODS, '', NO_DESC, {
		excludeForAsset: 'BTC'
	});
	const btc = r.find((x) => x.entry.key === 'pay_btc');
	if (btc) throw new Error('pay_btc should be hidden when asset=BTC');
	const xmr = r.find((x) => x.entry.key === 'pay_xmr');
	if (!xmr) throw new Error('pay_xmr should still be visible');
});

scenario('search: results sorted score desc, name asc on tie', () => {
	const entries = [
		{ key: 'a', name: 'Bravo Pay', url: null, category: 'online' as const },
		{ key: 'b', name: 'Alpha Pay', url: null, category: 'online' as const }
	];
	const r = searchPaymentMethods(entries, 'pay', NO_DESC);
	if (r.length !== 2) throw new Error(`got ${r.length}`);
	if (r[0]!.entry.name !== 'Alpha Pay') throw new Error('alpha first on tie');
});

// ─── resolveLegacy ──────────────────────────────────────────────────

scenario('resolveLegacy: canonical key passes through', () => {
	if (resolveLegacy('paypal') !== 'paypal') throw new Error('paypal');
	// cp120: 'cash' was split into 'cash_in_person' + 'cash_by_mail'.
	if (resolveLegacy('cash_in_person') !== 'cash_in_person') throw new Error('cash_in_person');
	if (resolveLegacy('cash_by_mail') !== 'cash_by_mail') throw new Error('cash_by_mail');
});

scenario('resolveLegacy: exact name → canonical key', () => {
	if (resolveLegacy('PayPal') !== 'paypal') throw new Error('PayPal');
	// cp120: 'Cash' (in person) and 'Cash by mail' both resolve.
	if (resolveLegacy('Cash (in person)') !== 'cash_in_person') throw new Error('Cash (in person)');
	if (resolveLegacy('Cash by mail') !== 'cash_by_mail') throw new Error('Cash by mail');
});

scenario('resolveLegacy: case-insensitive name match', () => {
	if (resolveLegacy('PAYPAL') !== 'paypal') throw new Error('PAYPAL');
	if (resolveLegacy('paypal') !== 'paypal') throw new Error('paypal');
});

scenario('resolveLegacy: M-PESA canonical name → mpesa', () => {
	if (resolveLegacy('M-PESA') !== 'mpesa') throw new Error(resolveLegacy('M-PESA'));
});

scenario('resolveLegacy: whitespace-trimmed match', () => {
	if (resolveLegacy('  PayPal  ') !== 'paypal') throw new Error('trim');
});

scenario('resolveLegacy: unknown text passes through', () => {
	// PromptPay isn't canonical (yet); should be preserved verbatim.
	if (resolveLegacy('PromptPay') !== 'PromptPay') throw new Error('PromptPay');
});

scenario('resolveLegacy: empty / whitespace → empty', () => {
	if (resolveLegacy('') !== '') throw new Error('empty');
	if (resolveLegacy('   ') !== '') throw new Error('whitespace');
});

scenario('resolveLegacy: non-string → empty', () => {
	if (resolveLegacy(null as unknown as string) !== '') throw new Error('null');
	if (resolveLegacy(123 as unknown as string) !== '') throw new Error('number');
});

scenario('resolveLegacyMany: deduplicates after canonicalization', () => {
	const r = resolveLegacyMany(['PayPal', 'paypal', 'Cash (in person)']);
	if (r.length !== 2) throw new Error(`got ${r.length}`);
	if (!r.includes('paypal')) throw new Error('paypal');
	if (!r.includes('cash_in_person')) throw new Error('cash_in_person');
});

scenario('resolveLegacyMany: preserves order of first occurrence', () => {
	const r = resolveLegacyMany(['Cash (in person)', 'PayPal']);
	if (r[0] !== 'cash_in_person') throw new Error('cash_in_person first');
	if (r[1] !== 'paypal') throw new Error('paypal second');
});

scenario('resolveLegacyMany: drops empty strings', () => {
	const r = resolveLegacyMany(['', 'PayPal', '   ']);
	if (r.length !== 1) throw new Error(`got ${r.length}`);
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
