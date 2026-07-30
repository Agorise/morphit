/**
 * Morphit smoke — explorer search-input parser (Batch K).
 *
 * Pure logic; verifies all classification branches and edge cases.
 */

import { parseSearchInput } from '../../web/src/lib/explorer/search';

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

console.log('\n── explorer search smoke ─────────────────────────────────\n');

// ─── account ────────────────────────────────────────────────────────

scenario('plain username → account', () => {
	const r = parseSearchInput('alice');
	if (r.kind !== 'account' || r.account !== 'alice') throw new Error(JSON.stringify(r));
});

scenario('@-prefixed username → account', () => {
	const r = parseSearchInput('@alice');
	if (r.kind !== 'account' || r.account !== 'alice') throw new Error(JSON.stringify(r));
});

scenario('username with hyphen and dot → account', () => {
	const r = parseSearchInput('test-user.foo');
	if (r.kind !== 'account' || r.account !== 'test-user.foo') {
		throw new Error(JSON.stringify(r));
	}
});

scenario('username max length 16 → account', () => {
	const r = parseSearchInput('abcdefghij123456');
	if (r.kind !== 'account') throw new Error(JSON.stringify(r));
});

scenario('username one over → unknown', () => {
	const r = parseSearchInput('abcdefghij1234567');
	if (r.kind !== 'unknown') throw new Error(JSON.stringify(r));
});

scenario('uppercase username → unknown', () => {
	const r = parseSearchInput('ALICE');
	if (r.kind !== 'unknown') throw new Error(JSON.stringify(r));
});

scenario('username starts with digit → unknown', () => {
	const r = parseSearchInput('1abc');
	if (r.kind !== 'unknown') throw new Error(JSON.stringify(r));
});

// ─── block number ───────────────────────────────────────────────────

scenario('positive integer → block', () => {
	const r = parseSearchInput('123456');
	if (r.kind !== 'block' || r.blockNumber !== 123456) throw new Error(JSON.stringify(r));
});

scenario('block number with whitespace → block', () => {
	const r = parseSearchInput('  42  ');
	if (r.kind !== 'block' || r.blockNumber !== 42) throw new Error(JSON.stringify(r));
});

scenario('zero → unknown (block 1+ only)', () => {
	const r = parseSearchInput('0');
	if (r.kind !== 'unknown') throw new Error(JSON.stringify(r));
});

scenario('huge integer beyond MAX_SAFE → unknown', () => {
	const r = parseSearchInput('9'.repeat(20));
	if (r.kind !== 'unknown') throw new Error(JSON.stringify(r));
});

scenario('negative-looking → unknown (sign char rejected)', () => {
	const r = parseSearchInput('-5');
	if (r.kind !== 'unknown') throw new Error(JSON.stringify(r));
});

// ─── txid ───────────────────────────────────────────────────────────

scenario('40-hex string → txid', () => {
	const txid = 'a'.repeat(40);
	const r = parseSearchInput(txid);
	if (r.kind !== 'txid' || r.txid !== txid) throw new Error(JSON.stringify(r));
});

scenario('uppercase txid → lowercased', () => {
	const txid = 'A'.repeat(40);
	const r = parseSearchInput(txid);
	if (r.kind !== 'txid' || r.txid !== 'a'.repeat(40)) {
		throw new Error(JSON.stringify(r));
	}
});

scenario('40-char non-hex → unknown', () => {
	const r = parseSearchInput('z'.repeat(40));
	if (r.kind !== 'unknown') throw new Error(JSON.stringify(r));
});

scenario('64-hex (BTC-like) → unknown (not Blurt format)', () => {
	const r = parseSearchInput('a'.repeat(64));
	if (r.kind !== 'unknown') throw new Error(JSON.stringify(r));
});

// ─── unknown ────────────────────────────────────────────────────────

scenario('empty string → unknown', () => {
	const r = parseSearchInput('');
	if (r.kind !== 'unknown') throw new Error(JSON.stringify(r));
});

scenario('whitespace-only → unknown', () => {
	const r = parseSearchInput('   ');
	if (r.kind !== 'unknown') throw new Error(JSON.stringify(r));
});

scenario('garbage with mixed chars → unknown', () => {
	const r = parseSearchInput('hello world!');
	if (r.kind !== 'unknown') throw new Error(JSON.stringify(r));
});

scenario('non-string input → unknown', () => {
	const r = parseSearchInput(123 as unknown as string);
	if (r.kind !== 'unknown') throw new Error(JSON.stringify(r));
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
