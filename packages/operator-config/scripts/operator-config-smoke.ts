/**
 * Operator-config loader — tsx smoke runner.
 *
 * Exercises loadOperatorConfig() against temp files. Tests
 * the contract that the indexer + relay rely on:
 *
 *   - Missing file is a no-op.
 *   - Override env var pointing to nothing throws (operator
 *     intent was clear).
 *   - Allowlisted keys land in process.env.
 *   - Pre-existing process.env values win over the file.
 *   - Non-allowlisted keys cause a hard boot error, naming
 *     the offending keys.
 *
 * Usage (from packages/operator-config):
 *   tsx scripts/operator-config-smoke.ts
 */

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	loadOperatorConfig,
	getAllowlist
} from '../src/index.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void | Promise<void>): Promise<void> {
	scenarios++;
	return Promise.resolve()
		.then(fn)
		.then(
			() => {
				console.log(`  ✓ ${name}`);
			},
			(err) => {
				failures++;
				console.log(`  ✗ ${name}`);
				console.log(`      ${err instanceof Error ? err.message : String(err)}`);
			}
		);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${label}: expected ${e}, got ${a}`);
	}
}

function assertThrows(fn: () => void, includeMsg: string, label: string): void {
	let threw = false;
	let msg = '';
	try {
		fn();
	} catch (err) {
		threw = true;
		msg = err instanceof Error ? err.message : String(err);
	}
	if (!threw) {
		throw new Error(`${label}: expected throw, no throw`);
	}
	if (!msg.includes(includeMsg)) {
		throw new Error(
			`${label}: expected throw to include ${JSON.stringify(includeMsg)}, got ${JSON.stringify(msg)}`
		);
	}
}

/** A representative allowlisted key (the BLURT price fallback,
 *  which is the canonical use case). */
const KEY = 'MORPHIT_INDEXER_FEE_BASE_BLURT';
/** Another allowlisted key for multi-key scenarios. */
const KEY2 = 'MORPHIT_RELAY_SIGNUP_ENABLED';

/** Reset process.env between scenarios so they don't leak. */
function clearKeys(): void {
	delete process.env[KEY];
	delete process.env[KEY2];
	delete process.env.MORPHIT_OPERATOR_CONFIG_FILE;
}

/** Create a fresh temp dir and return its path. Caller is
 *  responsible for cleanup if they want to avoid /tmp clutter,
 *  but the OS will eventually GC it anyway. */
function mkTempDir(): string {
	return mkdtempSync(join(tmpdir(), 'morphit-cfg-'));
}

console.log('\n── Operator-config loader ──────────────────────────');

// ─── Allowlist sanity ────────────────────────────────────────

await scenario('allowlist contains the documented operator keys', () => {
	const a = getAllowlist();
	const expected = [
		'MORPHIT_RELAY_SIGNUP_ENABLED',
		'MORPHIT_INDEXER_FEE_BASE_BLURT',
		'MORPHIT_INDEXER_BTC_FEE_SATOSHIS',
		'MORPHIT_INDEXER_XMR_FEE_PICONERO',
		'MORPHIT_INDEXER_FEATURE_FEE_BLURT_PER_HOUR',
		'MORPHIT_INDEXER_PRICE_FEED_ENABLED',
		'MORPHIT_INDEXER_VERBOSE_HEALTH',
		'MORPHIT_INDEXER_OPERATOR_BALANCE_RELAY_THRESHOLD_BLURT',
		'MORPHIT_INDEXER_OPERATOR_BALANCE_FEES_THRESHOLD_BLURT',
		// §F.37 — operator-tunable account-creation-fee fallback.
		'MORPHIT_INDEXER_ACCOUNT_CREATION_FEE_BLURT',
		// Phase D — per-instance branding.
		'MORPHIT_INSTANCE_NAME',
		'MORPHIT_INSTANCE_TAGLINE',
		'MORPHIT_INSTANCE_CONTACT_URL',
		'MORPHIT_INSTANCE_TOR_ADDRESS',
		'MORPHIT_INSTANCE_LOKINET_ADDRESS',
		'MORPHIT_INSTANCE_I2P_ADDRESS',
		'MORPHIT_INSTANCE_I2P_B32_ADDRESS',
		'MORPHIT_INSTANCE_I2P_NAME_ADDRESS',
		'MORPHIT_INSTANCE_NOSTR_PUBKEY',
		'MORPHIT_INSTANCE_ORIGIN'
	];
	for (const k of expected) {
		if (!a.has(k)) {
			throw new Error(`allowlist missing expected key: ${k}`);
		}
	}
});

await scenario('allowlist deliberately excludes spam-economic constants', () => {
	const a = getAllowlist();
	const mustNotBeAllowed = [
		'STRANGER_FEE_BASE_BLURT',
		'STRANGER_FEE_MAX_DOUBLINGS',
		'STRANGER_FEE_WINDOW_MINUTES',
		// Federation-uniformity invariant: these stay in code.
		'MORPHIT_INDEXER_DATABASE_URL',
		'MORPHIT_INDEXER_CHAIN_ID',
		'MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY',
		// Phase D — fees account is critical infra (typo →
		// fees flow to wrong account).  Set via OS env, not
		// the allowlist.
		'MORPHIT_INDEXER_FEE_RECIPIENT',
		// Same for relay account name — typo here misroutes
		// signup chain ops.
		'MORPHIT_INDEXER_RELAY_ACCOUNT',
		'MORPHIT_RELAY_ACCOUNT'
	];
	for (const k of mustNotBeAllowed) {
		if (a.has(k)) {
			throw new Error(`allowlist must NOT contain ${k} but it does`);
		}
	}
});

// ─── Missing file ────────────────────────────────────────────

await scenario('returns no-op when no file exists in search paths', () => {
	clearKeys();
	const dir = mkTempDir();
	const result = loadOperatorConfig({ searchPaths: [dir] });
	assertEqual(result.file, null, 'file');
	assertEqual(result.applied, 0, 'applied');
	assertEqual(result.skipped, [], 'skipped');
	rmSync(dir, { recursive: true });
});

await scenario('throws when override env var points to nonexistent file', () => {
	clearKeys();
	process.env.MORPHIT_OPERATOR_CONFIG_FILE = '/tmp/morphit-does-not-exist-' +
		Math.random().toString(36).slice(2);
	assertThrows(
		() => loadOperatorConfig({ searchPaths: [] }),
		'no file exists there',
		'override-throws'
	);
	clearKeys();
});

// ─── Allowlisted-key application ─────────────────────────────

await scenario('applies allowlisted key when not already in env', () => {
	clearKeys();
	const dir = mkTempDir();
	writeFileSync(join(dir, 'morphit.config.env'), `${KEY}=0.005\n`);
	const result = loadOperatorConfig({ searchPaths: [dir] });
	assertEqual(result.applied, 1, 'applied');
	assertEqual(result.skipped, [], 'skipped');
	assertEqual(process.env[KEY], '0.005', 'process.env value');
	rmSync(dir, { recursive: true });
	clearKeys();
});

await scenario('skips key already set in env (OS wins)', () => {
	clearKeys();
	process.env[KEY] = '0.002'; // already set by "OS"
	const dir = mkTempDir();
	writeFileSync(join(dir, 'morphit.config.env'), `${KEY}=0.005\n`);
	const result = loadOperatorConfig({ searchPaths: [dir] });
	assertEqual(result.applied, 0, 'applied');
	assertEqual(result.skipped, [KEY], 'skipped');
	assertEqual(process.env[KEY], '0.002', 'unchanged');
	rmSync(dir, { recursive: true });
	clearKeys();
});

await scenario('treats empty-string env value as not set', () => {
	clearKeys();
	process.env[KEY] = ''; // some shells set empty rather than unset
	const dir = mkTempDir();
	writeFileSync(join(dir, 'morphit.config.env'), `${KEY}=0.005\n`);
	const result = loadOperatorConfig({ searchPaths: [dir] });
	assertEqual(result.applied, 1, 'applied');
	assertEqual(process.env[KEY], '0.005', 'value applied');
	rmSync(dir, { recursive: true });
	clearKeys();
});

// ─── Non-allowlisted keys ────────────────────────────────────

await scenario('throws on non-allowlisted key, naming the offender', () => {
	clearKeys();
	const dir = mkTempDir();
	writeFileSync(
		join(dir, 'morphit.config.env'),
		`${KEY}=0.005\nMORPHIT_INDEXER_DATABASE_URL=postgres://hax/y\n`
	);
	assertThrows(
		() => loadOperatorConfig({ searchPaths: [dir] }),
		'MORPHIT_INDEXER_DATABASE_URL',
		'rejects-database-url'
	);
	rmSync(dir, { recursive: true });
	clearKeys();
});

await scenario('rejects entire file (not partial-apply) when offender present', () => {
	// If we partial-applied, an operator who pasted a bad file
	// could end up with some keys taking effect and others not —
	// hard to debug. Atomic rejection is the better failure mode.
	clearKeys();
	const dir = mkTempDir();
	writeFileSync(
		join(dir, 'morphit.config.env'),
		`${KEY}=0.005\nUNKNOWN_KEY=whatever\n`
	);
	try {
		loadOperatorConfig({ searchPaths: [dir] });
		throw new Error('expected throw but got success');
	} catch {
		// expected
	}
	// KEY must NOT have been applied because the load failed.
	assertEqual(process.env[KEY], undefined, 'no partial apply');
	rmSync(dir, { recursive: true });
	clearKeys();
});

// ─── Mixed apply + skip ──────────────────────────────────────

await scenario('mixes applied + skipped correctly', () => {
	clearKeys();
	process.env[KEY] = '0.002'; // pre-set, will be skipped
	const dir = mkTempDir();
	writeFileSync(
		join(dir, 'morphit.config.env'),
		`${KEY}=0.005\n${KEY2}=false\n`
	);
	const result = loadOperatorConfig({ searchPaths: [dir] });
	assertEqual(result.applied, 1, 'applied count');
	assertEqual(result.skipped, [KEY], 'skipped list');
	assertEqual(process.env[KEY], '0.002', 'KEY unchanged');
	assertEqual(process.env[KEY2], 'false', 'KEY2 applied');
	rmSync(dir, { recursive: true });
	clearKeys();
});

// ─── Search-path order ───────────────────────────────────────

await scenario('uses first matching dir when multiple search paths given', () => {
	clearKeys();
	const dirA = mkTempDir();
	const dirB = mkTempDir();
	// Only dirB has a file. dirA is searched first but missing.
	writeFileSync(join(dirB, 'morphit.config.env'), `${KEY}=0.007\n`);
	const result = loadOperatorConfig({ searchPaths: [dirA, dirB] });
	assertEqual(result.applied, 1, 'applied');
	assertEqual(process.env[KEY], '0.007', 'value');
	rmSync(dirA, { recursive: true });
	rmSync(dirB, { recursive: true });
	clearKeys();
});

await scenario('comments and blank lines are ignored', () => {
	clearKeys();
	const dir = mkTempDir();
	writeFileSync(
		join(dir, 'morphit.config.env'),
		[
			'# This is a comment',
			'',
			'# Another one',
			`${KEY}=0.009`,
			'',
			''
		].join('\n')
	);
	const result = loadOperatorConfig({ searchPaths: [dir] });
	assertEqual(result.applied, 1, 'applied');
	assertEqual(process.env[KEY], '0.009', 'value');
	rmSync(dir, { recursive: true });
	clearKeys();
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
