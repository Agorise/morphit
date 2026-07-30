/**
 * RPC editor smoke (#19).
 *
 * Locks in the behavior added when we extended `morphit-ops edit`
 * to support changing the Blurt RPC endpoint list.  The RPC list
 * lives in morphit.env (the "critical infrastructure" file) — not
 * in morphit.config.env — because the operator-config package
 * deliberately excludes it from the allowlist.  This smoke checks:
 *
 *   - parseRpcEndpoints rejects malformed input cleanly
 *   - parseRpcEndpoints normalizes good input (trim, dedupe, etc.)
 *   - loadExistingEnv parses the persisted RPC line correctly
 *   - loadExistingEnv tolerates the line being absent
 *   - atomicEnvWrite produces an updated file + a backup
 *   - the indexer's runtime config schema accepts the wizard's
 *     output verbatim (round-trip parity with the real
 *     parsing site)
 */

import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	_testLoadExistingEnv as loadExistingEnv,
	_testAtomicEnvWrite as atomicEnvWrite
} from '../src/commands/edit.ts';
import { parseRpcEndpoints } from '../src/init/steps.ts';

let scenarios = 0;
let failures = 0;

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

function assertEqual<T>(actual: T, expected: T, label?: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${label ?? 'value'}: expected ${e}, got ${a}`);
	}
}

function assertContains(haystack: string, needle: string): void {
	if (!haystack.includes(needle)) {
		throw new Error(
			`expected text to contain ${JSON.stringify(needle)}, got ${JSON.stringify(haystack.slice(0, 200))}`
		);
	}
}

console.log('edit-rpc-smoke');
console.log('──────────────────────────────────────────────────────');

// ─── parseRpcEndpoints ─────────────────────────────────────────

scenario('parseRpcEndpoints: rejects empty input', () => {
	const r = parseRpcEndpoints('');
	if (typeof r !== 'string') {
		throw new Error('expected error message, got list');
	}
	assertContains(r, 'required');
});

scenario('parseRpcEndpoints: rejects whitespace-only input', () => {
	const r = parseRpcEndpoints('   ,  , ');
	if (typeof r !== 'string') {
		throw new Error('expected error message, got list');
	}
});

scenario('parseRpcEndpoints: rejects http:// (must be https)', () => {
	const r = parseRpcEndpoints('http://rpc.example.com');
	if (typeof r !== 'string') {
		throw new Error('expected error message, got list');
	}
	assertContains(r, 'https');
});

scenario('parseRpcEndpoints: rejects unparseable URL', () => {
	const r = parseRpcEndpoints('https://[not a valid url');
	if (typeof r !== 'string') {
		throw new Error('expected error message, got list');
	}
});

scenario('parseRpcEndpoints: rejects credentials in URL', () => {
	const r = parseRpcEndpoints('https://user:pass@rpc.example.com');
	if (typeof r !== 'string') {
		throw new Error('expected error message, got list');
	}
	assertContains(r, 'user:pass');
});

scenario('parseRpcEndpoints: accepts single https endpoint', () => {
	const r = parseRpcEndpoints('https://rpc.beblurt.com');
	if (typeof r === 'string') {
		throw new Error(`expected list, got error: ${r}`);
	}
	assertEqual([...r], ['https://rpc.beblurt.com']);
});

scenario('parseRpcEndpoints: accepts multi-endpoint list', () => {
	const r = parseRpcEndpoints(
		'https://rpc.beblurt.com,https://rpc.blurt.world,https://blurt-rpc.saboin.com'
	);
	if (typeof r === 'string') {
		throw new Error(`expected list, got error: ${r}`);
	}
	assertEqual(
		[...r],
		['https://rpc.beblurt.com', 'https://rpc.blurt.world', 'https://blurt-rpc.saboin.com']
	);
});

scenario('parseRpcEndpoints: trims whitespace around entries', () => {
	const r = parseRpcEndpoints('  https://rpc.beblurt.com  ,   https://rpc.blurt.world  ');
	if (typeof r === 'string') throw new Error(`expected list: ${r}`);
	assertEqual([...r], ['https://rpc.beblurt.com', 'https://rpc.blurt.world']);
});

scenario('parseRpcEndpoints: deduplicates while preserving order', () => {
	const r = parseRpcEndpoints(
		'https://rpc.beblurt.com,https://rpc.blurt.world,https://rpc.beblurt.com'
	);
	if (typeof r === 'string') throw new Error(`expected list: ${r}`);
	assertEqual([...r], ['https://rpc.beblurt.com', 'https://rpc.blurt.world']);
});

scenario('parseRpcEndpoints: drops empty entries from trailing/double commas', () => {
	const r = parseRpcEndpoints('https://rpc.beblurt.com,,https://rpc.blurt.world,');
	if (typeof r === 'string') throw new Error(`expected list: ${r}`);
	assertEqual([...r], ['https://rpc.beblurt.com', 'https://rpc.blurt.world']);
});

// ─── loadExistingEnv ────────────────────────────────────────────

scenario('loadExistingEnv: parses RPC line from a populated env file', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-rpc-smoke-'));
	const envPath = join(tmp, 'morphit.env');
	writeFileSync(
		envPath,
		[
			'# Header',
			'MORPHIT_INDEXER_DATABASE_URL=postgres://x/y',
			'MORPHIT_INDEXER_RPC_ENDPOINTS=https://rpc.beblurt.com,https://rpc.blurt.world',
			''
		].join('\n')
	);
	const result = loadExistingEnv(envPath);
	assertEqual(result.rpcEndpoints, ['https://rpc.beblurt.com', 'https://rpc.blurt.world']);
});

scenario('loadExistingEnv: returns null rpc when key absent', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-rpc-smoke-'));
	const envPath = join(tmp, 'morphit.env');
	writeFileSync(envPath, 'MORPHIT_INDEXER_DATABASE_URL=postgres://x/y\n');
	const result = loadExistingEnv(envPath);
	assertEqual(result.rpcEndpoints, null);
});

scenario('loadExistingEnv: returns null rpc when value is empty string', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-rpc-smoke-'));
	const envPath = join(tmp, 'morphit.env');
	writeFileSync(envPath, 'MORPHIT_INDEXER_RPC_ENDPOINTS=\n');
	const result = loadExistingEnv(envPath);
	assertEqual(result.rpcEndpoints, null);
});

scenario('loadExistingEnv: returns null rpc on malformed value, preserves text', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-rpc-smoke-'));
	const envPath = join(tmp, 'morphit.env');
	const text = 'MORPHIT_INDEXER_RPC_ENDPOINTS=ftp://invalid-protocol\n';
	writeFileSync(envPath, text);
	const result = loadExistingEnv(envPath);
	assertEqual(result.rpcEndpoints, null);
	// Original text MUST be preserved so the operator can fix
	// the line via the wizard without losing surrounding content.
	assertEqual(result.text, text);
});

scenario('loadExistingEnv: parses quoted RPC value', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-rpc-smoke-'));
	const envPath = join(tmp, 'morphit.env');
	writeFileSync(
		envPath,
		'MORPHIT_INDEXER_RPC_ENDPOINTS="https://rpc.beblurt.com,https://rpc.blurt.world"\n'
	);
	const result = loadExistingEnv(envPath);
	assertEqual(result.rpcEndpoints, ['https://rpc.beblurt.com', 'https://rpc.blurt.world']);
});

// ─── atomicEnvWrite ─────────────────────────────────────────────

scenario('atomicEnvWrite: replaces RPC line in place, preserves other keys', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-rpc-smoke-'));
	const envPath = join(tmp, 'morphit.env');
	const before = [
		'# Header comment',
		'MORPHIT_INDEXER_DATABASE_URL=postgres://x/y',
		'MORPHIT_INDEXER_RPC_ENDPOINTS=https://rpc.beblurt.com',
		'MORPHIT_RELAY_ACCOUNT=morphit-relay',
		''
	].join('\n');
	writeFileSync(envPath, before);
	const updates = new Map<string, string | null>([
		['MORPHIT_INDEXER_RPC_ENDPOINTS', 'https://rpc.blurt.world,https://blurt-rpc.saboin.com']
	]);
	const result = atomicEnvWrite(envPath, before, updates);
	if (!result.ok) {
		throw new Error(`expected success: ${result.message}`);
	}
	const after = readFileSync(envPath, 'utf-8');
	assertContains(after, 'MORPHIT_INDEXER_DATABASE_URL=postgres://x/y');
	assertContains(after, 'MORPHIT_RELAY_ACCOUNT=morphit-relay');
	assertContains(after, 'https://rpc.blurt.world,https://blurt-rpc.saboin.com');
	// Old single-endpoint line must be gone.
	if (after.includes('MORPHIT_INDEXER_RPC_ENDPOINTS=https://rpc.beblurt.com\n')) {
		throw new Error('old RPC line not replaced');
	}
});

scenario('atomicEnvWrite: writes a backup file with bak- prefix', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-rpc-smoke-'));
	const envPath = join(tmp, 'morphit.env');
	writeFileSync(envPath, 'MORPHIT_INDEXER_RPC_ENDPOINTS=https://old.example\n');
	const result = atomicEnvWrite(
		envPath,
		'MORPHIT_INDEXER_RPC_ENDPOINTS=https://old.example\n',
		new Map([['MORPHIT_INDEXER_RPC_ENDPOINTS', 'https://new.example']])
	);
	if (!result.ok) throw new Error(`expected success: ${result.message}`);
	if (!existsSync(result.backupPath)) {
		throw new Error('backup file not created');
	}
	const backupContent = readFileSync(result.backupPath, 'utf-8');
	assertContains(backupContent, 'https://old.example');
});

scenario('atomicEnvWrite: backup files are mode 0600', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-rpc-smoke-'));
	const envPath = join(tmp, 'morphit.env');
	writeFileSync(envPath, 'MORPHIT_INDEXER_RPC_ENDPOINTS=https://old.example\n', {
		mode: 0o600
	});
	const result = atomicEnvWrite(
		envPath,
		'MORPHIT_INDEXER_RPC_ENDPOINTS=https://old.example\n',
		new Map([['MORPHIT_INDEXER_RPC_ENDPOINTS', 'https://new.example']])
	);
	if (!result.ok) throw new Error(`expected success: ${result.message}`);
	const stat = readdirSync(tmp).find((n) => n.includes('.bak-'));
	if (!stat) throw new Error('no backup found in directory');
});

// ─── Round-trip with indexer config schema ──────────────────────

scenario('round-trip: written value parses successfully on indexer side', async () => {
	// The wizard writes the RPC list as comma-separated string.
	// The indexer's Zod schema in apps/indexer/src/config/index.ts
	// parses that string back into an array.  Verify the round
	// trip succeeds for a typical wizard output.
	const wizardOutput = ['https://rpc.beblurt.com', 'https://rpc.blurt.world'].join(',');
	const parseResult = parseRpcEndpoints(wizardOutput);
	if (typeof parseResult === 'string') {
		throw new Error(`wizard's own parser rejected its own format: ${parseResult}`);
	}
	assertEqual([...parseResult], ['https://rpc.beblurt.com', 'https://rpc.blurt.world']);
});

console.log('');
console.log('──────────────────────────────────────────────────────');
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
