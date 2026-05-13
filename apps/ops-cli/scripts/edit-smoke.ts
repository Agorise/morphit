#!/usr/bin/env tsx
/**
 * Smoke for the `morphit-ops edit` subcommand's pure helpers.
 *
 * Tests the parse + apply logic against synthetic config text
 * — no actual file I/O needed.  Confirms:
 *   - existing keys are replaced in place
 *   - null values delete keys
 *   - new keys append a section
 *   - comments and blank lines are preserved
 *   - trailing newline is always present
 */

import { _testApplyUpdates as applyUpdates } from '../src/commands/edit.ts';

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

function assertContains(haystack: string, needle: string, label: string): void {
	if (!haystack.includes(needle)) {
		throw new Error(`${label}: expected to find ${JSON.stringify(needle)} in:\n${haystack}`);
	}
}

function assertNotContains(haystack: string, needle: string, label: string): void {
	if (haystack.includes(needle)) {
		throw new Error(`${label}: expected NOT to find ${JSON.stringify(needle)} in:\n${haystack}`);
	}
}

console.log('\n── morphit-ops edit smoke ───────────────────────────────\n');

scenario('replace existing key in place', () => {
	const before = [
		'# header comment',
		'MORPHIT_INSTANCE_NAME=alice',
		'MORPHIT_INSTANCE_ORIGIN=https://old.example',
		''
	].join('\n');
	const updates = new Map<string, string | null>([
		['MORPHIT_INSTANCE_ORIGIN', 'https://new.example']
	]);
	const after = applyUpdates(before, updates);
	assertContains(after, 'MORPHIT_INSTANCE_ORIGIN=https://new.example', 'new value');
	assertNotContains(after, 'old.example', 'old value gone');
	assertContains(after, 'MORPHIT_INSTANCE_NAME=alice', 'unrelated key preserved');
	assertContains(after, '# header comment', 'comment preserved');
});

scenario('null value removes existing key', () => {
	const before = ['MORPHIT_INSTANCE_NAME=alice', 'MORPHIT_INSTANCE_TOR_ADDRESS=abc.onion', ''].join(
		'\n'
	);
	const updates = new Map<string, string | null>([['MORPHIT_INSTANCE_TOR_ADDRESS', null]]);
	const after = applyUpdates(before, updates);
	assertNotContains(after, 'abc.onion', 'tor line gone');
	assertContains(after, 'MORPHIT_INSTANCE_NAME=alice', 'unrelated preserved');
});

scenario('null value for absent key is no-op', () => {
	const before = ['MORPHIT_INSTANCE_NAME=alice', ''].join('\n');
	const updates = new Map<string, string | null>([['MORPHIT_INSTANCE_TOR_ADDRESS', null]]);
	const after = applyUpdates(before, updates);
	assertContains(after, 'MORPHIT_INSTANCE_NAME=alice', 'preserved');
	assertNotContains(after, 'TOR_ADDRESS', 'no spurious add');
});

scenario('append new section when key did not exist', () => {
	const before = ['# alpha', 'MORPHIT_INSTANCE_NAME=alice', ''].join('\n');
	const updates = new Map<string, string | null>([
		['MORPHIT_INSTANCE_TOR_ADDRESS', 'fresh.onion'],
		['MORPHIT_INSTANCE_LOKINET_ADDRESS', 'fresh.loki']
	]);
	const after = applyUpdates(before, updates);
	assertContains(after, 'MORPHIT_INSTANCE_TOR_ADDRESS=fresh.onion', 'tor appended');
	assertContains(after, 'MORPHIT_INSTANCE_LOKINET_ADDRESS=fresh.loki', 'loki appended');
	assertContains(after, "Added by 'morphit-ops edit'", 'section header present');
	assertContains(after, '# alpha', 'original comment preserved');
});

scenario('SEO copy with spaces gets quoted', () => {
	const before = ['MORPHIT_INSTANCE_NAME=alice', ''].join('\n');
	const updates = new Map<string, string | null>([
		['MORPHIT_INSTANCE_SEO_TITLE', 'My Privacy-First Instance']
	]);
	const after = applyUpdates(before, updates);
	assertContains(after, 'MORPHIT_INSTANCE_SEO_TITLE="My Privacy-First Instance"', 'quoted value');
});

scenario('alphanumeric value emitted bare', () => {
	const before = ['MORPHIT_INSTANCE_NAME=alice', ''].join('\n');
	const updates = new Map<string, string | null>([
		['MORPHIT_INSTANCE_TOR_ADDRESS', 'abc123.onion']
	]);
	const after = applyUpdates(before, updates);
	assertContains(after, 'MORPHIT_INSTANCE_TOR_ADDRESS=abc123.onion', 'bare emit');
	assertNotContains(after, '"abc123', 'no quotes');
});

scenario('ends with single trailing newline', () => {
	const before = 'MORPHIT_INSTANCE_NAME=alice\n';
	const updates = new Map<string, string | null>([['MORPHIT_INSTANCE_NAME', 'bob']]);
	const after = applyUpdates(before, updates);
	if (!after.endsWith('\n')) throw new Error('missing trailing newline');
	if (after.endsWith('\n\n\n')) throw new Error('too many trailing newlines');
});

scenario('preserves blank lines between sections', () => {
	const before = [
		'# section A',
		'MORPHIT_INSTANCE_NAME=alice',
		'',
		'# section B',
		'MORPHIT_INSTANCE_TAGLINE=hello',
		''
	].join('\n');
	const updates = new Map<string, string | null>([['MORPHIT_INSTANCE_NAME', 'bob']]);
	const after = applyUpdates(before, updates);
	assertContains(after, '# section A', 'A header');
	assertContains(after, '# section B', 'B header');
	// Original separator blank line should still be there.
	const idxA = after.indexOf('# section A');
	const idxB = after.indexOf('# section B');
	const between = after.slice(idxA, idxB);
	if (!between.includes('\n\n')) {
		throw new Error('blank line between sections lost');
	}
});

scenario('quoted value in original is read correctly', () => {
	const before = ['MORPHIT_INSTANCE_TAGLINE="quoted tagline"', ''].join('\n');
	// Replace with a different value
	const updates = new Map<string, string | null>([['MORPHIT_INSTANCE_TAGLINE', 'plain']]);
	const after = applyUpdates(before, updates);
	assertContains(after, 'MORPHIT_INSTANCE_TAGLINE=plain', 'replaced');
	assertNotContains(after, '"quoted tagline"', 'old value gone');
});

scenario('multiple edits in one call', () => {
	const before = [
		'MORPHIT_INSTANCE_NAME=alice',
		'MORPHIT_INSTANCE_ORIGIN=https://old.example',
		'MORPHIT_INSTANCE_TOR_ADDRESS=old.onion',
		''
	].join('\n');
	const updates = new Map<string, string | null>([
		['MORPHIT_INSTANCE_ORIGIN', 'https://new.example'],
		['MORPHIT_INSTANCE_TOR_ADDRESS', null],
		['MORPHIT_INSTANCE_LOKINET_ADDRESS', 'fresh.loki']
	]);
	const after = applyUpdates(before, updates);
	assertContains(after, 'MORPHIT_INSTANCE_ORIGIN=https://new.example', 'origin');
	assertNotContains(after, 'old.onion', 'tor removed');
	assertContains(after, 'MORPHIT_INSTANCE_LOKINET_ADDRESS=fresh.loki', 'loki added');
	assertContains(after, 'MORPHIT_INSTANCE_NAME=alice', 'unrelated preserved');
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
