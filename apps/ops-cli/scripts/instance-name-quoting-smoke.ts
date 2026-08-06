/**
 * instance-name-quoting-smoke (cp664) — guards still-open(b): a multi-word
 * marketplace NAME / TAGLINE / CONTACT must be DOUBLE-QUOTED in the env
 * templates so it survives the indexer & relay unit's `. "$f"` shell-source.
 *
 * The bug: an unquoted `MORPHIT_INSTANCE_NAME=Morphit Latino` sourced by bash
 * sets NAME=Morphit and tries to run `Latino` as a command → /v1/instance shows
 * a truncated name. Quoting fixes it, and every reader already strips the
 * quotes: bash `. file`, Node `parseEnv` (ops-cli loadInstanceEnv /
 * loadOperatorConfig), and first-online's register sed-extract
 * (`s/^"//; s/"$//`). This smoke locks BOTH halves:
 *
 *   STATIC  — the two templates quote NAME/TAGLINE/CONTACT (a future edit that
 *             drops the quotes fails here).
 *   ROUND-TRIP — a spaced value (with an ampersand + apostrophe, both harmless
 *             inside double quotes) is recovered intact by all three readers.
 *   NEGATIVE — the SAME value UNQUOTED is truncated by shell-source, proving the
 *             quoting is what fixes it (guards against a false-positive smoke).
 */

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv } from 'node:util';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const TPL_DIR = join(REPO_ROOT, 'ops', 'ansible', 'roles', 'morphit', 'templates');
const CONFIG_TPL = join(TPL_DIR, 'morphit.config.env.j2');
const INDEXER_TPL = join(TPL_DIR, 'indexer.env.j2');

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';
interface Result {
	name: string;
	passed: boolean;
	detail?: string;
}
const results: Result[] = [];
const pass = (name: string) => results.push({ name, passed: true });
const fail = (name: string, detail: string) => results.push({ name, passed: false, detail });

// A deliberately awkward-but-realistic value: spaces, an ampersand, and an
// apostrophe. All three are literal inside double quotes for bash AND parseEnv.
const SAMPLE = "Morphit Latino & Bob's Market";

/* ---- STATIC: templates double-quote the free-text fields ---- */
for (const [label, path, keys] of [
	['morphit.config.env.j2', CONFIG_TPL, ['MORPHIT_INSTANCE_NAME', 'MORPHIT_INSTANCE_TAGLINE', 'MORPHIT_INSTANCE_CONTACT_URL']],
	['indexer.env.j2', INDEXER_TPL, ['MORPHIT_INSTANCE_NAME', 'MORPHIT_INSTANCE_TAGLINE', 'MORPHIT_INSTANCE_CONTACT_URL']]
] as const) {
	const text = readFileSync(path, 'utf-8');
	for (const key of keys) {
		// Must appear as KEY="{{ … }}" (quoted) somewhere, and never as the bare
		// KEY={{ … }} (the bug). Not anchored at line start — in morphit.config.env.j2
		// the tagline/contact lines are prefixed with an inline `{% if … %}`.
		const quoted = new RegExp(`${key}="\\{\\{`).test(text);
		const bareUnquoted = new RegExp(`${key}=\\{\\{`).test(text);
		if (quoted && !bareUnquoted) {
			pass(`${label}: ${key} is double-quoted`);
		} else {
			fail(`${label}: ${key} is double-quoted`, `quoted=${quoted} bareUnquoted=${bareUnquoted}`);
		}
	}
}

/* ---- ROUND-TRIP: quoted value survives all three readers ---- */
{
	const dir = mkdtempSync(join(tmpdir(), 'morphit-quote-'));
	const envFile = join(dir, 'morphit.config.env');
	writeFileSync(envFile, `MORPHIT_INSTANCE_NAME="${SAMPLE}"\n`);

	// (a) bash `. "$f"` — the exact mechanism the units use.
	let shellVal = '';
	try {
		shellVal = execFileSync(
			'bash',
			['-c', `set -a; . "$1"; set +a; printf '%s' "$MORPHIT_INSTANCE_NAME"`, 'bash', envFile],
			{ encoding: 'utf-8' }
		);
	} catch (err) {
		shellVal = `<error: ${String(err)}>`;
	}
	if (shellVal === SAMPLE) {
		pass('quoted value survives bash shell-source (the units path)');
	} else {
		fail('quoted value survives bash shell-source', `got [${shellVal}] expected [${SAMPLE}]`);
	}

	// (b) Node parseEnv — the ops-cli loadInstanceEnv / loadOperatorConfig path.
	const parsedVal = parseEnv(readFileSync(envFile, 'utf-8')).MORPHIT_INSTANCE_NAME;
	if (parsedVal === SAMPLE) {
		pass('quoted value survives Node parseEnv (ops-cli register path)');
	} else {
		fail('quoted value survives Node parseEnv', `got [${parsedVal}] expected [${SAMPLE}]`);
	}

	// (c) first-online's _get_env sed-extract — the auto-register path.
	let sedVal = '';
	try {
		sedVal = execFileSync(
			'bash',
			[
				'-c',
				`sed -n "s/^[[:space:]]*MORPHIT_INSTANCE_NAME=//p" "$1" | tail -n1 | sed 's/^"//; s/"$//'`,
				'bash',
				envFile
			],
			{ encoding: 'utf-8' }
		).replace(/\n$/, '');
	} catch (err) {
		sedVal = `<error: ${String(err)}>`;
	}
	if (sedVal === SAMPLE) {
		pass('quoted value survives first-online sed-extract (auto-register path)');
	} else {
		fail('quoted value survives first-online sed-extract', `got [${sedVal}] expected [${SAMPLE}]`);
	}

	/* ---- NEGATIVE control: UNQUOTED spaced value IS truncated by shell-source ---- */
	const bareFile = join(dir, 'bare.config.env');
	writeFileSync(bareFile, `MORPHIT_INSTANCE_NAME=${SAMPLE}\n`);
	let bareShellVal = '';
	try {
		bareShellVal = execFileSync(
			'bash',
			['-c', `set -a; . "$1" 2>/dev/null; set +a; printf '%s' "$MORPHIT_INSTANCE_NAME"`, 'bash', bareFile],
			{ encoding: 'utf-8' }
		);
	} catch {
		bareShellVal = '';
	}
	if (bareShellVal !== SAMPLE) {
		pass(`negative control: UNQUOTED spaced value truncates under shell-source (got [${bareShellVal}]) — quoting is load-bearing`);
	} else {
		fail('negative control: unquoted spaced value truncates', `unexpectedly got full value [${bareShellVal}]`);
	}
}

/* ---------------- report ---------------- */
let failed = 0;
for (const r of results) {
	if (r.passed) {
		console.log('  ' + ANSI_GREEN + '✓' + ANSI_RESET + ' ' + r.name);
	} else {
		console.log('  ' + ANSI_RED + '✗' + ANSI_RESET + ' ' + r.name);
		if (r.detail) console.log('      ' + r.detail);
		failed++;
	}
}
console.log();
console.log('──────────────────────────────────────────────────────');
if (failed > 0) {
	console.log('✗ ' + failed + ' of ' + results.length + ' scenarios failed');
	process.exit(1);
} else {
	console.log('✓ all ' + results.length + ' instance-name-quoting scenarios passed');
}
