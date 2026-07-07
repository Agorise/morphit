#!/usr/bin/env tsx
/**
 * non-zod-env-example-consumer-parity-smoke.
 *
 * Part 122 cp61 STRUCTURAL DEFENSE (LL #65 / O-15) — sibling of cp61-O14.
 *
 * Closes the cp57-O11 generalization gap: cp57-O11 covers env-
 * example files backed by a Zod schema (indexer, relay, matrix-
 * bot — all three with `loadConfig()` Zod parsers).  Two
 * remaining env-example files in the repo aren't Zod-backed:
 *
 *   - ops/bunkerweb/bunkerweb.env.example — consumed by the
 *     BunkerWeb container via `env_file:` directive in
 *     docker-compose.yml.  BunkerWeb itself parses the vars
 *     into its nginx + ModSecurity runtime.
 *
 *   - ops/backup/backup.env.example — consumed by morphit-backup.sh
 *     via shell-script `. "$BACKUP_ENV"` sourcing.  Vars referenced
 *     in the script with `$VAR` / `${VAR}` expansion.
 *
 * Parity model differs per mechanism:
 *
 * env_file_directive: verify the docker-compose.yml `env_file:`
 *   line points at the canonical example filename.  All vars get
 *   consumed by the container automatically (BunkerWeb's runtime
 *   reads them); no per-var check is needed beyond the directive.
 *
 * shell_script_sourcing: verify every var in the env-example is
 *   referenced in at least one consumer script via `$VAR` or
 *   `${VAR}` expansion.  Reverse-direction check is skipped
 *   because shell scripts have locals + shell builtins that
 *   wouldn't be in the env-example (e.g. BACKUP_ENV is sourced
 *   FROM as part of the script setup, not a configurable knob).
 *
 * Bug history at cp61: both files are CURRENTLY clean — this is
 * a preventive smoke.  Without the gate, the next checkpoint that
 * adds a phantom var to bunkerweb.env.example (forgetting to
 * delete the corresponding feature wiring) or that removes a
 * consumer script reference (without cleaning up the example)
 * accumulates drift silently.
 *
 * Recurring class scope progression (14 defenses across 14 checkpoints):
 *   cp48-O1 through cp60-O13 (as listed in REVISIT)
 *   cp61-O14: bunkerweb CIDR cross-reference
 *   cp61-O15: non-Zod env-example consumer parity (THIS)
 *
 * Mutation tests:
 *   M-128: remove `env_file: ./bunkerweb.env` line from docker-
 *          compose.yml.  Smoke fires:
 *          "bunkerweb: env_file: ./bunkerweb.env directive missing
 *           from ops/bunkerweb/docker-compose.yml."
 *   M-129: add `PHANTOM_VAR=test` to backup.env.example.  Smoke
 *          fires: "backup: example var PHANTOM_VAR is not
 *          referenced in any consumer script."
 */

import { readFileSync } from 'fs';
import { join, dirname, basename } from 'path';
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

console.log('\n── non-zod-env-example-consumer-parity smoke (cp61 LL #65 / O-15) ──\n');

type EnvFileDirective = {
	mechanism: 'env_file_directive';
	composeFile: string; // path to docker-compose.yml that should reference the example
	expectedOccurrences: number; // every service that needs the env vars must have its own env_file: directive
};
type ShellScriptSourcing = {
	mechanism: 'shell_script_sourcing';
	scriptFiles: string[]; // paths to scripts that consume the env file
};

interface NonZodService {
	name: string;
	examplePath: string;
	consumer: EnvFileDirective | ShellScriptSourcing;
}

const SERVICES: NonZodService[] = [
	{
		name: 'bunkerweb',
		examplePath: 'ops/bunkerweb/bunkerweb.env.example',
		consumer: {
			mechanism: 'env_file_directive',
			composeFile: 'ops/bunkerweb/docker-compose.yml',
			// BunkerWeb's compose has 2 services that BOTH need the env vars:
			// `bunkerweb` (the WAF runtime) and `bunkerweb-scheduler` (the
			// config-management agent that applies BunkerWeb settings).
			// Both must have their own `env_file:` directive — partial
			// removal silently misconfigures one of them.
			expectedOccurrences: 2
		}
	},
	{
		name: 'backup',
		examplePath: 'ops/backup/backup.env.example',
		consumer: {
			mechanism: 'shell_script_sourcing',
			scriptFiles: ['ops/backup/morphit-backup.sh']
		}
	}
];

function parseEnvVars(content: string): Set<string> {
	// Same regex as cp57-O11: match `MORPHIT_X=` or `# MORPHIT_X=` or
	// `# X=` for bunkerweb-style non-MORPHIT-prefixed vars.  Allow
	// trailing whitespace between the var name and `=`.
	const vars = new Set<string>();
	const re = /^\s*#?\s*([A-Z][A-Z_0-9]*)\s*=/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) {
		vars.add(m[1]);
	}
	return vars;
}

for (const svc of SERVICES) {
	const examplePath = join(REPO_ROOT, svc.examplePath);
	let exampleContent: string;
	try {
		exampleContent = readFileSync(examplePath, 'utf-8');
	} catch (e) {
		fail(svc.name, `cannot read ${svc.examplePath}: ${(e as Error).message}`);
		continue;
	}

	const exampleVars = parseEnvVars(exampleContent);
	console.log(`${svc.name}: example=${exampleVars.size} vars · mechanism=${svc.consumer.mechanism}`);

	if (svc.consumer.mechanism === 'env_file_directive') {
		const composePath = join(REPO_ROOT, svc.consumer.composeFile);
		let composeContent: string;
		try {
			composeContent = readFileSync(composePath, 'utf-8');
		} catch (e) {
			fail(`${svc.name}: compose file readable`, `cannot read ${svc.consumer.composeFile}: ${(e as Error).message}`);
			continue;
		}

		const expectedFilename = basename(svc.examplePath).replace(/\.example$/, '');
		// docker-compose loads env_file at runtime; the file name in
		// the directive is the deploy-side filename without `.example`.
		// Count occurrences — every service that needs the env vars
		// must have its own directive.  Pinning EXACT count catches
		// partial-removal mutations (e.g. one service loses the
		// directive while a sibling keeps it) that a presence-only
		// check would miss.
		const directiveRe = new RegExp(`env_file:[\\s\\S]{0,80}?\\b${expectedFilename}\\b`, 'gm');
		const occurrences = (composeContent.match(directiveRe) || []).length;
		if (occurrences === svc.consumer.expectedOccurrences) {
			pass(
				`${svc.name}: docker-compose.yml has exactly ${occurrences} env_file: directive(s) pointing at ${expectedFilename}`
			);
		} else {
			fail(
				`${svc.name}: docker-compose env_file: directive count`,
				`expected ${svc.consumer.expectedOccurrences} occurrence(s) of "env_file: ... ${expectedFilename}", found ${occurrences} in ${svc.consumer.composeFile}.  ` +
					`If a service was intentionally removed, update expectedOccurrences in this smoke.  ` +
					`If a directive was accidentally deleted, restore it — without it the corresponding container silently uses defaults instead of the configured env vars.`
			);
		}
	} else if (svc.consumer.mechanism === 'shell_script_sourcing') {
		let combinedScript = '';
		for (const sf of svc.consumer.scriptFiles) {
			const sp = join(REPO_ROOT, sf);
			try {
				combinedScript += '\n' + readFileSync(sp, 'utf-8');
			} catch (e) {
				fail(`${svc.name}: script readable`, `cannot read ${sf}: ${(e as Error).message}`);
			}
		}

		// Find all $VAR / ${VAR} references in the script.
		const scriptRefs = new Set<string>();
		const refRe = /\$\{?([A-Z][A-Z_0-9]*)\}?/g;
		let m: RegExpExecArray | null;
		while ((m = refRe.exec(combinedScript)) !== null) {
			scriptRefs.add(m[1]);
		}

		const orphans: string[] = [];
		for (const v of exampleVars) {
			if (!scriptRefs.has(v)) orphans.push(v);
		}

		if (orphans.length === 0) {
			pass(`${svc.name}: every example var (${exampleVars.size}) is referenced in at least one consumer script`);
		} else {
			fail(
				`${svc.name}: every example var has at least one script consumer`,
				`${orphans.length} phantom var(s): ${orphans.join(', ')}.  ` +
					`Either the var is no longer used (remove from example) or the script reference was deleted (restore it).`
			);
		}
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\nnon-zod-env-example-consumer-parity smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} non-Zod env-example consumer-parity checks pass`);
