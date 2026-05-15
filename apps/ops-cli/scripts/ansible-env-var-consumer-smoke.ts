#!/usr/bin/env tsx
/**
 * ansible-env-var-consumer-smoke — verify that every env var
 * declared in an Ansible `*.env.j2` template has a real consumer
 * somewhere in the code or sidecar scripts.
 *
 * Pre-Part-122-cp5 the relay.env.j2 template shipped a
 * `MORPHIT_RELAY_PASSPHRASE={{ morphit_relay_keystore_passphrase }}`
 * line that NO code path consumed.  The placeholder value
 * (`CHANGE-ME-PASSPHRASE`) invited operators to leak their real
 * passphrase to a 0640 disk file out of misplaced template-
 * completionism — the encrypted-envelope design (ADR-0010 §4)
 * had been silently bypassed.  F13 fixed that one instance;
 * this smoke prevents the class from recurring.
 *
 * Rule: for every LITERAL `MORPHIT_X=...` line in a template
 * (i.e. one where the variable NAME isn't Jinja-templated), the
 * exact var name MUST appear somewhere in:
 *
 *   - apps/<workspace>/src/**\/*.ts (production code)
 *   - apps/<workspace>/scripts/**\/*.ts (smoke + tooling)
 *   - ops/scripts/*.sh (sidecar scripts)
 *   - ops/scripts/lib/*.sh (shared sidecar helpers)
 *
 * Template lines where the var NAME itself is Jinja-templated
 * (e.g. `MORPHIT_FAIL2BAN_{{ var_jail }}_CRITICAL=...`) are
 * SKIPPED — we can't resolve dynamic names statically.  These
 * are documented dynamic-dispatch patterns; the consumer reads
 * them via pattern construction.
 *
 * Comment lines in templates (starting with `#`) are skipped.
 *
 * Scenarios:
 *   1. For every literal template var: a consumer reference exists.
 *   2. Sanity meta-check: at least one template was scanned.
 *   3. Sanity meta-check: at least one consumer file was scanned.
 *
 * Usage:
 *   tsx apps/ops-cli/scripts/ansible-env-var-consumer-smoke.ts
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const ANSIBLE_ROLES_DIR = join(REPO_ROOT, 'ops', 'ansible', 'roles');
const APPS_DIR = join(REPO_ROOT, 'apps');
const OPS_SCRIPTS_DIR = join(REPO_ROOT, 'ops', 'scripts');

interface ScenarioResult {
	readonly name: string;
	readonly ok: boolean;
	readonly detail?: string;
}
const results: ScenarioResult[] = [];

/** Recursively walk a directory and yield files matching the
 *  predicate.  Skips node_modules and any dotted dir at the root. */
function walkFiles(root: string, pred: (path: string) => boolean): string[] {
	if (!existsSync(root)) return [];
	const out: string[] = [];
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			if (ent.isDirectory()) {
				if (ent.name === 'node_modules') continue;
				if (ent.name.startsWith('.')) continue;
				stack.push(join(dir, ent.name));
			} else if (ent.isFile()) {
				const full = join(dir, ent.name);
				if (pred(full)) out.push(full);
			}
		}
	}
	return out;
}

/** Find every literal `MORPHIT_X=...` line in *.env.j2 templates.
 *  Returns a list of (templatePath, varName) pairs. */
function collectTemplateVars(): Array<{ template: string; varName: string }> {
	const out: Array<{ template: string; varName: string }> = [];
	const templates = walkFiles(ANSIBLE_ROLES_DIR, (p) => p.endsWith('.env.j2'));
	for (const t of templates) {
		const src = readFileSync(t, 'utf-8');
		for (const rawLine of src.split('\n')) {
			const line = rawLine.trim();
			// Skip comments + blank lines.
			if (line.length === 0 || line.startsWith('#')) continue;
			// Match `MORPHIT_X_Y_Z=...` where the LHS is purely
			// literal (no Jinja).  If the LHS contains `{{`, the
			// var name is dynamic — skip.
			const m = /^([A-Z][A-Z0-9_]*)\s*=/.exec(line);
			if (!m) continue;
			const varName = m[1]!;
			if (!varName.startsWith('MORPHIT_')) continue;
			// Sanity: did the LHS include Jinja?  Our regex
			// already rejected that because Jinja delimiters
			// aren't in [A-Z0-9_].  Double-check defensively.
			if (varName.includes('{{') || varName.includes('}}')) continue;
			out.push({ template: t.replace(REPO_ROOT + '/', ''), varName });
		}
	}
	return out;
}

/** Build the consumer-surface: union of every `MORPHIT_X_Y_Z`
 *  substring appearing in production code, scripts, or sidecars.
 *  Returns the set of var names found. */
function collectConsumerSurface(): { names: Set<string>; fileCount: number } {
	const names = new Set<string>();
	const tsPred = (p: string): boolean =>
		(p.endsWith('.ts') || p.endsWith('.tsx') || p.endsWith('.js') || p.endsWith('.mjs')) &&
		!p.includes('.d.ts');
	const shPred = (p: string): boolean => p.endsWith('.sh');
	const consumerFiles = [
		...walkFiles(APPS_DIR, tsPred),
		...walkFiles(OPS_SCRIPTS_DIR, shPred)
	];
	const re = /MORPHIT_[A-Z][A-Z0-9_]*/g;
	for (const f of consumerFiles) {
		const src = readFileSync(f, 'utf-8');
		for (const m of src.matchAll(re)) {
			names.add(m[0]);
		}
	}
	return { names, fileCount: consumerFiles.length };
}

// ─── Collect ──
const templateVars = collectTemplateVars();
const { names: consumerNames, fileCount: consumerFileCount } =
	collectConsumerSurface();

// ─── Scenario 1: every literal template var has a consumer ──
const literalsByVar = new Map<string, string[]>();
for (const { template, varName } of templateVars) {
	const list = literalsByVar.get(varName) ?? [];
	list.push(template);
	literalsByVar.set(varName, list);
}
// Sort for deterministic output.
const sortedVars = [...literalsByVar.keys()].sort();
for (const varName of sortedVars) {
	const templates = literalsByVar.get(varName)!;
	const hasConsumer = consumerNames.has(varName);
	results.push({
		name: `${varName} has a consumer in apps/ or ops/scripts/`,
		ok: hasConsumer,
		detail: hasConsumer
			? undefined
			: `${varName} is declared in template(s) ` +
			  `[${templates.join(', ')}] but no file under apps/ or ` +
			  `ops/scripts/ references it.  Either remove the dead ` +
			  `template line, or add a consumer (e.g. zod schema in ` +
			  `apps/<workspace>/src/config/index.ts, bash variable in ` +
			  `ops/scripts/morphit-*.sh).  Dead template lines are a ` +
			  `security trap: operators may fill in real secrets ` +
			  `expecting them to be used (cp5 F13).`
	});
}

// ─── Scenario 2: at least one template was scanned ──
results.push({
	name: 'at least one *.env.j2 template scanned (sanity vs repo restructure)',
	ok: templateVars.length > 0,
	detail:
		templateVars.length === 0
			? `no *.env.j2 templates found under ${ANSIBLE_ROLES_DIR} (did the repo layout change?)`
			: undefined
});

// ─── Scenario 3: at least some consumer files were scanned ──
results.push({
	name: 'at least one consumer file scanned (sanity vs repo restructure)',
	ok: consumerFileCount > 0,
	detail:
		consumerFileCount === 0
			? `no consumer files found under apps/ or ops/scripts/ (did the repo layout change?)`
			: undefined
});

// ─── Report ──
console.log(
	`ansible env-var consumer smoke: ${results.length} scenarios ` +
		`(${sortedVars.length} unique template vars, ${consumerNames.size} consumer-surface vars, ` +
		`${consumerFileCount} consumer files scanned)\n`
);
let failed = 0;
for (const r of results) {
	if (r.ok) {
		console.log(`  ✓ ${r.name}`);
	} else {
		console.log(`  ✗ ${r.name}`);
		if (r.detail) {
			for (const line of r.detail.split('\n')) {
				console.log(`      ${line}`);
			}
		}
		failed++;
	}
}
console.log('');
if (failed === 0) {
	console.log(`✓ all ${results.length} env-var consumer checks hold`);
	process.exit(0);
} else {
	console.error(`✗ ${failed} failed, ${results.length - failed} passed`);
	process.exit(1);
}
