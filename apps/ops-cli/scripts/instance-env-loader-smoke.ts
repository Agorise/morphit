#!/usr/bin/env tsx
/**
 * instance-env-loader-smoke — `loadInstanceEnv()` must populate process.env
 * from an instance's on-disk env files for the on-chain commands
 * (payment-method / register / show-key), without overwriting values the
 * operator set explicitly, and without throwing when files are absent.
 *
 * It ALSO covers the DB-command bridge (cp248): the DB-backed commands
 * (status / signups / drain-queue / failed-broadcasts / moderation) resolve
 * their database URL through loadConfig(), which reads process.env.  On a
 * systemd deploy the DB URL lives in morphit.env (unit-sourced only), so
 * `sudo morphit-ops status` failed with "No database URL configured" until
 * main.ts began calling loadInstanceEnv() BEFORE loadConfig().  Scenarios 5
 * + 6 pin that the DB URL bridges through to loadConfig and that main.ts
 * keeps the call ordering.
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
 *   5. a DB URL in morphit.env bridges through to loadConfig().databaseUrl.
 *   6. main.ts calls loadInstanceEnv() BEFORE loadConfig() (static wiring).
 *   7. a DB URL with an unexpanded shell command substitution (`$(…)` or
 *      backticks) fails with a clear, actionable error — not a cryptic
 *      `getaddrinfo ENOTFOUND $(docker inspect …)`.
 *
 * Usage:
 *   tsx apps/ops-cli/scripts/instance-env-loader-smoke.ts
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInstanceEnv } from '../src/lib/instanceEnv.ts';
import { loadConfig } from '../src/config.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
	'MORPHIT_OPERATOR_CONFIG_FILE',
	'MORPHIT_OPS_DATABASE_URL',
	'MORPHIT_INDEXER_DATABASE_URL',
	'DATABASE_URL'
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

	// Scenario 5: a DB URL in morphit.env bridges through to loadConfig() —
	// the exact path that fixes `sudo morphit-ops status` ("No database URL
	// configured") on a systemd deploy.  We clear all three DB-URL env keys
	// first so the only source is the file.
	{
		resetEnv();
		const dir = mkdtempSync(join(tmpdir(), 'ienv-dburl-'));
		writeInfra(dir, 'MORPHIT_INDEXER_DATABASE_URL=postgres://u:p@localhost:5432/morphit\n');
		loadInstanceEnv(dir);
		let threw = false;
		let url: string | undefined;
		try {
			url = loadConfig().databaseUrl;
		} catch {
			threw = true;
		}
		ok(
			'db_url_bridged_to_loadConfig',
			!threw && url === 'postgres://u:p@localhost:5432/morphit',
			threw ? 'loadConfig threw (DB URL not bridged)' : `got ${url}`
		);
		rmSync(dir, { recursive: true, force: true });
	}

	// Scenario 6 (static wiring): main.ts must call loadInstanceEnv() BEFORE
	// loadConfig() — otherwise the bridge never runs for the DB commands and
	// the whole "Check & operate" menu group regresses to the DB-URL error.
	{
		const mainSrc = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf-8');
		const iEnv = mainSrc.indexOf('loadInstanceEnv(');
		const iCfg = mainSrc.indexOf('loadConfig()');
		ok('main_imports_loadInstanceEnv', /import \{ loadInstanceEnv \}/.test(mainSrc));
		ok(
			'main_calls_loadInstanceEnv_before_loadConfig',
			iEnv !== -1 && iCfg !== -1 && iEnv < iCfg,
			`iEnv=${iEnv} iCfg=${iCfg}`
		);
	}

	// Scenario 7 (cp261): a DATABASE_URL whose host is an UNEXPANDED shell
	// command substitution must fail with a CLEAR message, not the cryptic
	// `getaddrinfo ENOTFOUND $(docker inspect …)` an operator hit on a manual
	// deploy.  Env files are read literally — the shell never runs — so a host
	// like `$(docker inspect db | jq … IPAddress)` arrives verbatim; the guard
	// in readDatabaseUrl() catches it before pg ever tries to resolve it.
	{
		resetEnv();
		process.env.MORPHIT_OPS_DATABASE_URL =
			'postgres://u:p@$(docker inspect bunkerweb-db-1 | jq -r ".[].NetworkSettings.Networks[\\"bunkerweb_bunkerweb-net\\"].IPAddress"):5432/morphit';
		let msg = '';
		try {
			loadConfig();
		} catch (e) {
			msg = e instanceof Error ? e.message : String(e);
		}
		ok(
			'unexpanded_command_substitution_clear_error',
			/command substitution/i.test(msg) && msg.includes('read literally'),
			msg === '' ? 'loadConfig did NOT throw on a $(…) host' : `msg: ${msg.slice(0, 70)}`
		);

		// A backtick command substitution is caught the same way.
		resetEnv();
		process.env.MORPHIT_OPS_DATABASE_URL = 'postgres://u:p@`hostname`:5432/morphit';
		let backtickThrew = false;
		try {
			loadConfig();
		} catch {
			backtickThrew = true;
		}
		ok('backtick_command_substitution_caught', backtickThrew, 'backtick host did not throw');

		// Sanity: a normal URL with no substitution is NOT flagged (the guard
		// is not over-eager — scenario 5 proves the happy path through a file).
		resetEnv();
		process.env.MORPHIT_OPS_DATABASE_URL = 'postgres://u:p@db.internal:5432/morphit';
		let cleanThrew = false;
		try {
			loadConfig();
		} catch {
			cleanThrew = true;
		}
		ok('clean_url_not_flagged', !cleanThrew, 'a normal URL was wrongly flagged as a substitution');
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
