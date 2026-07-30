/**
 * Federation instances-stream — tsx smoke runner.
 *
 * Covers the pure helpers that decide what counts as an
 * "interesting change" worth emitting an SSE event for.
 * Misclassifying changes here either spams subscribers
 * (irrelevant changes emitted) or hides them (real changes
 * silently dropped).
 *
 * Usage (from apps/indexer):
 *   tsx scripts/instances-stream-smoke.ts
 */

import { rowToEntry, rowSignature, type DirectoryRow } from '../src/api/instancesStreamHelpers.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${label}: expected ${e}, got ${a}`);
	}
}

function makeRow(overrides: Partial<DirectoryRow> = {}): DirectoryRow {
	return {
		origin: 'https://test.example',
		operator_account: 'alice',
		operator_tag: 'alice',
		operator_display_name: 'Alice in Berlin',
		cached_name: 'test-instance',
		cached_tagline: 'A test',
		cached_contact_url: null,
		cached_alt_networks: { tor: null, lokinet: null, i2p: null, nostr: null },
		last_probe_status: 'good',
		registered_at_time: new Date('2026-04-01T00:00:00Z'),
		last_probed_at: new Date('2026-04-26T12:00:00Z'),
		cached_indexed_block: 100_000,
		cached_chain_lag_sec: 3,
		consecutive_failures: 0,
		...overrides
	};
}

console.log('\n── Instances stream helpers ────────────────────────────');

// ─── rowToEntry shape ────────────────────────────────────────────

scenario('rowToEntry: produces the InstanceDirectoryEntry shape', () => {
	const r = makeRow();
	const e = rowToEntry(r);
	assertEqual(e.origin, 'https://test.example', 'origin');
	assertEqual(e.operator_account, 'alice', 'operator_account');
	assertEqual(e.operator_tag, 'alice', 'operator_tag');
	assertEqual(e.name, 'test-instance', 'name');
	assertEqual(e.status, 'good', 'status');
	assertEqual(e.indexed_block, 100_000, 'indexed_block');
	assertEqual(e.chain_lag_sec, 3, 'chain_lag_sec');
	assertEqual(e.registered_at, '2026-04-01T00:00:00.000Z', 'registered_at iso');
	assertEqual(e.last_probed_at, '2026-04-26T12:00:00.000Z', 'last_probed_at iso');
});

scenario('rowToEntry: null cached fields → null in entry', () => {
	const r = makeRow({
		cached_name: null,
		cached_tagline: null,
		cached_contact_url: null,
		cached_alt_networks: null,
		cached_indexed_block: null,
		cached_chain_lag_sec: null,
		last_probed_at: null,
		last_probe_status: null
	});
	const e = rowToEntry(r);
	assertEqual(e.name, null, 'name');
	assertEqual(e.tagline, null, 'tagline');
	assertEqual(e.contact_url, null, 'contact_url');
	assertEqual(e.alt_networks, null, 'alt_networks');
	assertEqual(e.indexed_block, null, 'indexed_block');
	assertEqual(e.chain_lag_sec, null, 'chain_lag_sec');
	assertEqual(e.last_probed_at, null, 'last_probed_at');
	assertEqual(e.status, 'never', 'status defaults to never');
});

scenario('rowToEntry: BIGINT-as-string indexed_block converts to number', () => {
	// pg returns BIGINT as a string by default.  rowToEntry must
	// coerce so subscribers don't have to think about wire types.
	const r = makeRow({ cached_indexed_block: '999999999999' });
	const e = rowToEntry(r);
	assertEqual(e.indexed_block, 999_999_999_999, 'indexed_block as number');
});

// ─── rowSignature semantics ──────────────────────────────────────

scenario('rowSignature: identical rows → identical signatures', () => {
	const a = rowToEntry(makeRow());
	const b = rowToEntry(makeRow());
	assertEqual(rowSignature(a), rowSignature(b), 'sig equality');
});

scenario('rowSignature: different status → different signatures', () => {
	const a = rowToEntry(makeRow({ last_probe_status: 'good' }));
	const b = rowToEntry(makeRow({ last_probe_status: 'stale' }));
	if (rowSignature(a) === rowSignature(b)) {
		throw new Error('expected different signatures for different status');
	}
});

scenario('rowSignature: different cached_name → different signatures', () => {
	const a = rowToEntry(makeRow({ cached_name: 'old-name' }));
	const b = rowToEntry(makeRow({ cached_name: 'new-name' }));
	if (rowSignature(a) === rowSignature(b)) {
		throw new Error('expected different signatures for different name');
	}
});

scenario('rowSignature: different chain_lag_sec → different signatures', () => {
	const a = rowToEntry(makeRow({ cached_chain_lag_sec: 3 }));
	const b = rowToEntry(makeRow({ cached_chain_lag_sec: 60 }));
	if (rowSignature(a) === rowSignature(b)) {
		throw new Error('expected different signatures for different lag');
	}
});

scenario(
	'rowSignature: different last_probed_at → DIFFERENT signature (UI shows the timestamp)',
	() => {
		const a = rowToEntry(makeRow({ last_probed_at: new Date('2026-04-26T12:00:00Z') }));
		const b = rowToEntry(makeRow({ last_probed_at: new Date('2026-04-26T12:10:00Z') }));
		if (rowSignature(a) === rowSignature(b)) {
			throw new Error('expected different signatures when last_probed_at changes');
		}
	}
);

scenario('rowSignature: different operator_display_name → DIFFERENT signature', () => {
	const a = rowToEntry(makeRow({ operator_display_name: 'Alice in Berlin' }));
	const b = rowToEntry(makeRow({ operator_display_name: 'Alice (renamed)' }));
	if (rowSignature(a) === rowSignature(b)) {
		throw new Error('expected different signatures when operator_display_name changes');
	}
});

scenario('rowSignature: different operator_tag → DIFFERENT signature', () => {
	const a = rowToEntry(makeRow({ operator_tag: 'alice' }));
	const b = rowToEntry(makeRow({ operator_tag: 'alice-v2' }));
	if (rowSignature(a) === rowSignature(b)) {
		throw new Error('expected different signatures when operator_tag changes');
	}
});

scenario('rowSignature: different consecutive_failures → SAME signature (internal metric)', () => {
	const a = rowToEntry(makeRow({ consecutive_failures: 0 }));
	const b = rowToEntry(makeRow({ consecutive_failures: 3 }));
	assertEqual(rowSignature(a), rowSignature(b), 'sig should ignore failure counter');
});

scenario('rowSignature: different alt_networks → different signatures', () => {
	const a = rowToEntry(
		makeRow({
			cached_alt_networks: { tor: null, lokinet: null, i2p: null, nostr: null }
		})
	);
	const b = rowToEntry(
		makeRow({
			cached_alt_networks: { tor: 'abc.onion', lokinet: null, i2p: null, nostr: null }
		})
	);
	if (rowSignature(a) === rowSignature(b)) {
		throw new Error('expected different signatures when tor address added');
	}
});

scenario('rowSignature: cached_indexed_block as string vs number → SAME signature', () => {
	// rowToEntry coerces both to number; rowSignature gets a
	// number either way.
	const a = rowToEntry(makeRow({ cached_indexed_block: 100_000 }));
	const b = rowToEntry(makeRow({ cached_indexed_block: '100000' }));
	assertEqual(rowSignature(a), rowSignature(b), 'sig stable across wire-type');
});

scenario('P7-12: pipe-containing fields do not collide across boundaries', () => {
	// Pre-fix the pipe-joined signature would collide because
	// boundaries were ambiguous when content contained pipes.
	const a = rowToEntry(makeRow({ cached_name: 'A | B', cached_tagline: 'C' }));
	const b = rowToEntry(makeRow({ cached_name: 'A', cached_tagline: ' B|C' }));
	if (rowSignature(a) === rowSignature(b)) {
		throw new Error('expected different signatures');
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
