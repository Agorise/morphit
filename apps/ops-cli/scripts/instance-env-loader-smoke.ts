#!/usr/bin/env tsx
/**
 * instance-env-loader-smoke — `loadInstanceEnv()` must populate process.env
 * from an instance's on-disk env files for the on-chain commands
 * (payment-method / register / show-key), without overwriting values the
 * operator set explicitly, and without throwing when files are absent.
 *
 * Why: on a systemd deployment morphit.env is sourced only by the unit, so
 * `morphit-ops payment-method` previously failed with
 * "✗ MORPHIT_RELAY_ACCOUNT is not set" even on a healthy instance.
 *
 * Scenarios:
 *   1. infra var (MORPHIT_RELAY_ACCOUNT) is read from morphit.env.
 *   2. OS env wins — a pre-set value is NOT overwritten.
 *   3. no env files present → no throw, both flags false.
 *   4. only morphit.env present (no config) → infraLoaded true, no throw.
 *
 * Usage:
 *   tsx apps/ops-cli/scripts/instance-env-loader-smoke.ts
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadInstanceEnv } from '../src/lib/instanceEnv.ts';

interface R {
	readonly name: string;
	readonly ok: boolean;
	readonly detail?: string;
}
const results: R[] = [];
function ok(name: string, cond: boolean, detail?: string): void {
	results.push({ name, ok: cond, detail });
}

// Env keys this smoke touches — saved and restored so we never leak state.
const TOUCHED = [
	'MORPHIT_RELAY_ACCOUNT',
	'MORPHIT_OPERATOR_POSTING_KEY_FILE',
	'MORPHIT_OPERATOR_CONFIG_FILE'
];
const saved = new Map<string, string | undefined>();
for (const k of TOUCHED) saved.set(k, process.env[k]);
function resetEnv(): void {
	for (const k of TOUCHED) delete process.env[k];
}

function writeInfra(dir: string, body: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'morphit.env'), body);
}

function main(): void {
	// Scenario 1: infra var read from morphit.env.
	{
		resetEnv();
		const dir = mkdtempSync(join(tmpdir(), 'ienv-load-'));
		writeInfra(dir, 'MORPHIT_RELAY_ACCOUNT=test-relay\nMORPHIT_OPERATOR_POSTING_KEY_FILE=/keys/posting.key\n');
		const res = loadInstanceEnv(dir);
		ok('infra_var_loaded', process.env.MORPHIT_RELAY_ACCOUNT === 'test-relay', `got ${process.env.MORPHIT_RELAY_ACCOUNT}`);
		ok('infra_keyfile_loaded', process.env.MORPHIT_OPERATOR_POSTING_KEY_FILE === '/keys/posting.key');
		ok('infra_flag_true', res.infraLoaded === true);
		rmSync(dir, { recursive: true, force: true });
	}

	// Scenario 2: OS env wins — preset value not overwritten.
	{
		resetEnv();
		process.env.MORPHIT_RELAY_ACCOUNT = 'preset-from-shell';
		const dir = mkdtempSync(join(tmpdir(), 'ienv-oswins-'));
		writeInfra(dir, 'MORPHIT_RELAY_ACCOUNT=should-not-win\n');
		loadInstanceEnv(dir);
		ok('os_env_wins', process.env.MORPHIT_RELAY_ACCOUNT === 'preset-from-shell', `got ${process.env.MORPHIT_RELAY_ACCOUNT}`);
		rmSync(dir, { recursive: true, force: true });
	}

	// Scenario 3: no files → no throw, both flags false.
	{
		resetEnv();
		const dir = mkdtempSync(join(tmpdir(), 'ienv-empty-'));
		let threw = false;
		let res = { configLoaded: true, infraLoaded: true } as ReturnType<typeof loadInstanceEnv>;
		try {
			res = loadInstanceEnv(dir);
		} catch {
			threw = true;
		}
		ok('no_files_no_throw', !threw);
		ok('no_files_flags_false', res.infraLoaded === false && res.configLoaded === false);
		rmSync(dir, { recursive: true, force: true });
	}

	// Scenario 4: only morphit.env present → infraLoaded true, no throw.
	{
		resetEnv();
		const dir = mkdtempSync(join(tmpdir(), 'ienv-infraonly-'));
		writeInfra(dir, 'MORPHIT_RELAY_ACCOUNT=infra-only\n');
		let threw = false;
		try {
			const res = loadInstanceEnv(dir);
			ok('infra_only_loaded', res.infraLoaded === true && process.env.MORPHIT_RELAY_ACCOUNT === 'infra-only');
		} catch {
			threw = true;
		}
		ok('infra_only_no_throw', !threw);
		rmSync(dir, { recursive: true, force: true });
	}

	// Restore env.
	resetEnv();
	for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;

	let pass = 0;
	let fail = 0;
	for (const r of results) {
		if (r.ok) {
			pass += 1;
			console.log(`  PASS  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
		} else {
			fail += 1;
			console.error(`  FAIL  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
		}
	}
	if (fail > 0) {
		console.error(`\ninstance-env-loader-smoke: ${pass} pass / ${fail} fail`);
		process.exit(1);
	}
	console.log(`\n✓ all ${pass} instance-env-loader scenarios passed`);
}

main();
