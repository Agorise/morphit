#!/usr/bin/env tsx
/**
 * Smoke for the supply-chain audit gate's baseline allowlist.
 *
 * The gate itself (scripts/audit-gate.mjs) needs network (npm audit) and runs
 * in CI. This smoke runs OFFLINE in the battery and guards the allowlist file's
 * structural integrity, so a malformed or under-documented allowlist can't
 * silently neuter the gate (e.g. an entry with no category/rationale, or a
 * category the gate/humans don't recognise).
 *
 * Coverage:
 *   - .audit-allowlist.json exists and is valid JSON
 *   - has an `allow` object and a `_categories` map
 *   - every entry has package + severity + a recognised category
 *   - every category used is documented in `_categories`
 *   - the gate script exists (so the smoke fails loudly if it's deleted)
 */
import { readFileSync, existsSync } from 'node:fs';

let failures = 0;
let scenarios = 0;
function check(name: string, fn: () => void): void {
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
function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(msg);
}

const ALLOWLIST = '.audit-allowlist.json';
const GATE = 'scripts/audit-gate.mjs';
const VALID_SEVERITIES = new Set(['info', 'low', 'moderate', 'high', 'critical']);

console.log('audit-allowlist smoke:\n');

let parsed: {
	allow?: Record<string, { package?: string; severity?: string; category?: string }>;
	_categories?: Record<string, string>;
} = {};

check('.audit-allowlist.json exists and is valid JSON', () => {
	assert(existsSync(ALLOWLIST), `${ALLOWLIST} not found`);
	parsed = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
	assert(typeof parsed === 'object' && parsed !== null, 'not an object');
});

check('has an `allow` object and a `_categories` map', () => {
	assert(parsed.allow && typeof parsed.allow === 'object', 'missing `allow` object');
	assert(parsed._categories && typeof parsed._categories === 'object', 'missing `_categories` map');
	assert(Object.keys(parsed.allow).length > 0, '`allow` is empty');
});

check('every allow entry has package + valid severity + a category', () => {
	for (const [ghsa, e] of Object.entries(parsed.allow ?? {})) {
		assert(ghsa.startsWith('GHSA'), `key is not a GHSA id: ${ghsa}`);
		assert(typeof e.package === 'string' && e.package.length > 0, `${ghsa}: missing package`);
		assert(VALID_SEVERITIES.has(e.severity ?? ''), `${ghsa}: invalid severity "${e.severity}"`);
		assert(typeof e.category === 'string' && e.category.length > 0, `${ghsa}: missing category`);
	}
});

check('every category used is documented in `_categories`', () => {
	const documented = new Set(Object.keys(parsed._categories ?? {}));
	for (const [ghsa, e] of Object.entries(parsed.allow ?? {})) {
		assert(documented.has(e.category ?? ''), `${ghsa}: category "${e.category}" not in _categories`);
	}
});

check('the gate script exists', () => {
	assert(existsSync(GATE), `${GATE} not found — the CI gate would be missing`);
});

console.log(
	`\n${failures === 0 ? '✓ all' : '✗'} ${scenarios - failures}${failures === 0 ? '' : '/' + scenarios} audit-allowlist scenarios passed`
);
process.exit(failures === 0 ? 0 : 1);
