#!/usr/bin/env tsx
/**
 * env-example-schema-parity-smoke.
 *
 * Part 122 cp57 STRUCTURAL DEFENSE (LL #61 / O-11).
 *
 * BIDIRECTIONAL canonical-example ↔ Zod-schema parity for the
 * indexer and relay services.  Catches the cp57-D1/D2 drift class
 * where the Zod schema (source of truth) ships an env var that
 * never makes it into the operator-facing canonical example.
 *
 * Two checks per service:
 *
 *   DIRECTION A — every Zod-schema env var MUST be in the canonical
 *   example.  This is the primary catch: if you add a new knob to
 *   the Zod schema (via .default() or .optional()), this smoke
 *   fires until you also document it in ops/env/<service>.env.example.
 *
 *   DIRECTION B — every canonical-example env var MUST be EITHER in
 *   the Zod schema OR consumed by a sibling script (apps/<svc>/scripts/).
 *   The script-consumed exception exists because some env vars are
 *   read by helper scripts (e.g. apps/relay/scripts/mint-acts.ts reads
 *   MORPHIT_RELAY_WEEKLY_ACT_COUNT for the unattended ACT-minting
 *   ceremony) and are legitimately not part of the main server
 *   Zod schema.  Without this exception, the smoke would false-fire
 *   on WEEKLY_ACT_COUNT.
 *
 * Drift surfaced at cp57:
 *   - Indexer: 13 vars in schema but not in ops/env/indexer.env.example
 *     (cp57-D1 MEDIUM) — mostly MORPHIT_INSTANCE_* metadata vars +
 *     MORPHIT_INDEXER_COINGECKO_API_KEY + MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM.
 *   - Relay: 17 vars in schema but not in ops/env/relay.env.example
 *     (cp57-D2 HIGH) — includes SECURITY-CRITICAL VAPID Web Push
 *     keys, TRUSTED_PROXY_IPS, and SEQUENTIAL_* squatter-defense
 *     knobs that operators couldn't tune through canonical docs.
 *   - Relay: 1 var (MORPHIT_RELAY_WEEKLY_ACT_COUNT) in example but
 *     not in schema → false-positive Direction-B candidate.  Smoke
 *     verifies it's consumed by apps/relay/scripts/mint-acts.ts
 *     (it is) and allows it.
 *
 * Recurring class scope progression (11 defenses across 10 checkpoints):
 *   cp48-O1: standalone smoke scripts
 *   cp49-O2: vitest unit tests
 *   cp50-O3: HTTP route handler regex
 *   cp51-O4: ops-cli per-ticker tables
 *   cp51-O5: per-asset i18n FAQ key coverage
 *   cp52-O6: Ansible env-template required-vars (different surface!)
 *   cp53-O7: operator doc per-asset coverage ("totally absent")
 *   cp54-O8: what_is_<asset> FAQ native-locale floor
 *   cp55-O9: multi-family per-asset native-locale floor (registry)
 *   cp56-O10: operator doc per-asset CONFIG EXAMPLE coverage (shallow)
 *   cp57-O11: env-example ↔ schema parity (bidirectional) (THIS)
 *
 * Relation to cp52-O6:
 *   cp52-O6 checks REQUIRED-only parity between the Zod schema and
 *   the Ansible Jinja2 TEMPLATE (apps/<svc>/...).env.j2.  It catches
 *   "REQUIRED schema var not in Ansible template".  Cp57-O11 checks
 *   FULL-SURFACE parity between the Zod schema and the canonical
 *   EXAMPLE (ops/env/<svc>.env.example).  Different surfaces, different
 *   scopes; both needed.
 *
 * Mutation test verification: M-125 — deleting the
 * MORPHIT_INSTANCE_NAME documentation block from indexer.env.example
 * fires:
 *   "env-example-schema-parity FAILED:
 *    indexer: 1 schema var(s) missing from canonical example:
 *      MORPHIT_INSTANCE_NAME"
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

let failed = 0;
let passed = 0;
function pass(name: string): void { console.log(`  ✓ ${name}`); passed++; }
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`); console.error(`      ${detail}`); failed++;
}

console.log('\n── env-example-schema-parity smoke (cp57 LL #61 / O-11) ──\n');

interface Service {
	name: string;
	schemaPath: string;
	examplePath: string;
	scriptsDir: string;
}

const SERVICES: Service[] = [
	{
		name: 'indexer',
		schemaPath: 'apps/indexer/src/config/index.ts',
		examplePath: 'ops/env/indexer.env.example',
		scriptsDir: 'apps/indexer/scripts'
	},
	{
		name: 'relay',
		schemaPath: 'apps/relay/src/config/index.ts',
		examplePath: 'ops/env/relay.env.example',
		scriptsDir: 'apps/relay/scripts'
	},
	{
		// Added cp58 — matrix-bot got a canonical example for the
		// first time at cp58.  Schema lives in `config.ts` directly
		// (not under `src/config/`).
		name: 'matrix-bot',
		schemaPath: 'apps/matrix-bot/src/config.ts',
		examplePath: 'ops/env/matrix-bot.env.example',
		scriptsDir: 'apps/matrix-bot/scripts'
	}
];

/**
 * Extract every MORPHIT_<NAME>: key from the envSchema z.object({...})
 * block in a config file.  Skips strings, // line comments, /* block
 * comments, and template literals.
 */
function parseSchemaVars(schemaPath: string): Set<string> {
	const src = readFileSync(join(REPO_ROOT, schemaPath), 'utf-8');
	// Try multiple conventional schema variable names.  Indexer
	// and relay use `envSchema`; matrix-bot uses `SCHEMA`.
	let startIdx = src.indexOf('const envSchema = z.object({');
	if (startIdx === -1) startIdx = src.indexOf('const SCHEMA = z.object({');
	if (startIdx === -1) {
		throw new Error(
			`No 'const envSchema = z.object({' or 'const SCHEMA = z.object({' found in ${schemaPath}`
		);
	}
	let i = src.indexOf('{', startIdx);
	let depth = 0;
	let inStr: string | false = false;
	let inLC = false;
	let inBC = false;
	let end = i;
	while (i < src.length) {
		const ch = src[i];
		const nxt = src[i + 1] ?? '';
		if (inLC) {
			if (ch === '\n') inLC = false;
			i++;
			continue;
		}
		if (inBC) {
			if (ch === '*' && nxt === '/') {
				inBC = false;
				i += 2;
				continue;
			}
			i++;
			continue;
		}
		if (inStr) {
			if (ch === '\\') {
				i += 2;
				continue;
			}
			if (ch === inStr) inStr = false;
			i++;
			continue;
		}
		if (ch === '/' && nxt === '/') {
			inLC = true;
			i += 2;
			continue;
		}
		if (ch === '/' && nxt === '*') {
			inBC = true;
			i += 2;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === '`') {
			inStr = ch;
			i++;
			continue;
		}
		if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) {
				end = i + 1;
				break;
			}
		}
		i++;
	}
	const block = src.slice(src.indexOf('{', startIdx), end);
	const result = new Set<string>();
	const re = /^\s*(MORPHIT_[A-Z_]+):/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(block)) !== null) {
		result.add(m[1]);
	}
	return result;
}

/** Parse every MORPHIT_<NAME>= line (commented or not) from a .env file. */
function parseExampleVars(examplePath: string): Set<string> {
	const src = readFileSync(join(REPO_ROOT, examplePath), 'utf-8');
	const result = new Set<string>();
	// Match: optional `#` + `MORPHIT_NAME=` at line start
	const re = /^#?\s*(MORPHIT_[A-Z_]+)=/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(src)) !== null) {
		result.add(m[1]);
	}
	return result;
}

/**
 * Scan apps/<svc>/scripts/ for any env var references.  Returns a
 * set of MORPHIT_<NAME> names referenced via process.env.
 */
function parseScriptEnvRefs(scriptsDir: string): Set<string> {
	const fullDir = join(REPO_ROOT, scriptsDir);
	const result = new Set<string>();
	let entries: string[];
	try {
		entries = readdirSync(fullDir);
	} catch {
		// No scripts directory; empty set
		return result;
	}
	for (const entry of entries) {
		const full = join(fullDir, entry);
		try {
			const s = statSync(full);
			if (!s.isFile() || !entry.endsWith('.ts')) continue;
			const src = readFileSync(full, 'utf-8');
			const re = /process\.env\.(MORPHIT_[A-Z_]+)/g;
			let m: RegExpExecArray | null;
			while ((m = re.exec(src)) !== null) {
				result.add(m[1]);
			}
		} catch {
			// skip unreadable file
		}
	}
	return result;
}

for (const svc of SERVICES) {
	const schemaVars = parseSchemaVars(svc.schemaPath);
	const exampleVars = parseExampleVars(svc.examplePath);
	const scriptVars = parseScriptEnvRefs(svc.scriptsDir);

	// Direction A: every schema var must be in example
	const missingInExample: string[] = [];
	for (const v of schemaVars) {
		if (!exampleVars.has(v)) missingInExample.push(v);
	}

	// Direction B: every example var must be in schema OR script-consumed
	const orphansInExample: string[] = [];
	for (const v of exampleVars) {
		if (!schemaVars.has(v) && !scriptVars.has(v)) orphansInExample.push(v);
	}

	console.log(
		`${svc.name}: schema=${schemaVars.size} vars · example=${exampleVars.size} vars · scripts=${scriptVars.size} refs`
	);

	if (missingInExample.length === 0) {
		pass(`${svc.name}: every schema var (${schemaVars.size}) appears in canonical example`);
	} else {
		fail(
			`${svc.name}: schema → example parity`,
			`${missingInExample.length} schema var(s) missing from canonical example:\n      ${missingInExample.sort().join('\n      ')}`
		);
	}

	if (orphansInExample.length === 0) {
		const scriptAllowed = [...exampleVars].filter((v) => !schemaVars.has(v) && scriptVars.has(v));
		pass(
			`${svc.name}: every example var is either in schema or script-consumed (${scriptAllowed.length} script-consumed allowed: ${scriptAllowed.length > 0 ? scriptAllowed.join(', ') : 'none'})`
		);
	} else {
		fail(
			`${svc.name}: example → schema parity`,
			`${orphansInExample.length} example var(s) neither in schema nor script-referenced (phantom):\n      ${orphansInExample.sort().join('\n      ')}`
		);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\nenv-example-schema-parity smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} parity scenarios passed`);
