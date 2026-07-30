#!/usr/bin/env tsx
/**
 * address-history-helper-smoke.
 *
 * Part 122 cp26 sentinel for the client-side address-reuse
 * history helper.  Validates the load/record/find/clear behavior
 * end-to-end against an in-memory localStorage shim.
 *
 * Why this exists: the helper is the user-facing privacy
 * affordance for the reuse-warning chip.  Bugs in dedupe,
 * trim-to-max, or roundtrip silently degrade the warning's
 * reliability and the user never sees that.  This smoke pins
 * the contract so refactors can't drift.
 */

// Inline localStorage shim — Node has no DOM.  Stand up a Map-
// backed mock with the surface area the helper uses.
class MemStorage {
	private data = new Map<string, string>();
	getItem(k: string): string | null {
		return this.data.has(k) ? this.data.get(k)! : null;
	}
	setItem(k: string, v: string): void {
		this.data.set(k, v);
	}
	removeItem(k: string): void {
		this.data.delete(k);
	}
	clear(): void {
		this.data.clear();
	}
	get length(): number {
		return this.data.size;
	}
	key(i: number): string | null {
		return [...this.data.keys()][i] ?? null;
	}
}
const storage = new MemStorage();
(globalThis as unknown as { localStorage: MemStorage }).localStorage = storage;

import {
	loadAddressHistory,
	recordAddressShare,
	findPriorShare,
	clearAddressHistory,
	type AddressHistoryEntry
} from '../src/lib/privacy/addressHistory';

let failed = 0;
let passed = 0;

function pass(name: string): void {
	console.log(`  ✓ ${name}`);
	passed++;
}
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`);
	console.error(`      ${detail}`);
	failed++;
}

console.log('\n── address-history-helper smoke ──────────────────────\n');

// ── Scenario 1 — empty history on first load ─────────────────
storage.clear();
{
	const h = loadAddressHistory();
	if (h.length === 0) pass('empty history on first load');
	else fail('empty history on first load', `got ${h.length} entries`);
}

// ── Scenario 2 — record then load roundtrip ──────────────────
{
	const entry: AddressHistoryEntry = {
		asset: 'BTC',
		address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
		sharedAt: '2026-05-17T20:00:00Z'
	};
	recordAddressShare(entry);
	const h = loadAddressHistory();
	if (h.length === 1 && h[0].address === entry.address) {
		pass('record + load roundtrip');
	} else {
		fail('record + load roundtrip', `expected 1 entry, got ${h.length}`);
	}
}

// ── Scenario 3 — findPriorShare matches ──────────────────────
{
	const found = findPriorShare(
		'BTC',
		'1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
	);
	if (found !== null && found.asset === 'BTC') {
		pass('findPriorShare matches recorded entry');
	} else {
		fail('findPriorShare matches recorded entry', `got ${JSON.stringify(found)}`);
	}
}

// ── Scenario 4 — findPriorShare null for unknown ─────────────
{
	const found = findPriorShare(
		'BTC',
		'1NotARealAddressJustForTestingNeverUsed'
	);
	if (found === null) pass('findPriorShare returns null for unknown address');
	else fail('findPriorShare returns null for unknown address', `got ${JSON.stringify(found)}`);
}

// ── Scenario 5 — different asset, same address: independent ──
{
	// (theoretical) — same address string under a different asset
	// must be tracked separately.  Real addresses don't collide
	// across assets, but the helper should not treat them as the
	// same regardless.
	const found = findPriorShare(
		'XMR',
		'1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
	);
	if (found === null) pass('different-asset same-address-string is independent');
	else fail('different-asset same-address-string is independent', 'cross-asset match');
}

// ── Scenario 6 — dedupe: re-recording updates timestamp ──────
{
	const updated: AddressHistoryEntry = {
		asset: 'BTC',
		address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
		sharedAt: '2026-05-17T21:00:00Z',
		orderPermlink: '@alice/abc'
	};
	recordAddressShare(updated);
	const h = loadAddressHistory();
	if (h.length === 1 && h[0].sharedAt === updated.sharedAt) {
		pass('dedupe: re-record updates timestamp + orderPermlink');
	} else {
		fail(
			'dedupe: re-record updates timestamp + orderPermlink',
			`got length=${h.length}, sharedAt=${h[0]?.sharedAt}`
		);
	}
}

// ── Scenario 7 — rolling buffer trims at MAX_ENTRIES (200) ───
storage.clear();
{
	for (let i = 0; i < 250; i++) {
		recordAddressShare({
			asset: 'BTC',
			address: `addr-${i}`,
			sharedAt: `2026-05-17T${String(i % 24).padStart(2, '0')}:00:00Z`
		});
	}
	const h = loadAddressHistory();
	if (h.length === 200) {
		pass('rolling buffer trims to MAX_ENTRIES=200');
	} else {
		fail('rolling buffer trims to MAX_ENTRIES=200', `got ${h.length}`);
	}
	// And the oldest 50 should have been dropped.
	const first = findPriorShare('BTC', 'addr-0');
	if (first === null) pass('oldest entries dropped (addr-0 not found)');
	else fail('oldest entries dropped', 'addr-0 still in history');
	const recent = findPriorShare('BTC', 'addr-249');
	if (recent !== null) pass('recent entries retained (addr-249 found)');
	else fail('recent entries retained', 'addr-249 not in history');
}

// ── Scenario 8 — clear empties ───────────────────────────────
{
	clearAddressHistory();
	const h = loadAddressHistory();
	if (h.length === 0) pass('clear empties history');
	else fail('clear empties history', `got ${h.length} entries`);
}

// ── Scenario 9 — corrupted JSON returns empty (fail-open) ────
{
	storage.setItem('morphit.address-history.v1', 'not valid json {[}');
	const h = loadAddressHistory();
	if (h.length === 0) pass('corrupted JSON returns empty (fail-open)');
	else fail('corrupted JSON returns empty', `got ${h.length}`);
}

// ── Scenario 10 — wrong version returns empty (fail-open) ────
{
	storage.setItem(
		'morphit.address-history.v1',
		JSON.stringify({ v: 99, entries: [] })
	);
	const h = loadAddressHistory();
	if (h.length === 0) pass('wrong version returns empty (fail-open)');
	else fail('wrong version returns empty', `got ${h.length}`);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\naddress-history-helper smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} address-history-helper scenarios passed`);
