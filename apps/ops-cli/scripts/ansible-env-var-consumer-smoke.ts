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
 * cp131 HIGH-002 fix: pre-cp131 the smoke gated on `MORPHIT_*`
 * prefix on both the template-side AND consumer-side regex.
 * That let backup.env.j2 ship 5 dead env vars (AGE_RECIPIENT,
 * REMOTE_DESTINATION, SSH_KEY, DB_HOST, DB_PORT) — exactly the
 * F13 bug-class the smoke was supposed to catch.  cp131 drops
 * the prefix gate and widens the consumer scan to include
 * ops/backup/*.sh, so any uppercase env-var declared in a
 * template MUST appear in some consumer file.
 *
 * Rule: for every LITERAL `[A-Z][A-Z0-9_]+=...` line in a template
 * (i.e. one where the variable NAME isn't Jinja-templated), the
 * exact var name MUST appear somewhere in:
 *
 *   - apps/<workspace>/src/**\/*.ts (production code)
 *   - apps/<workspace>/scripts/**\/*.ts (smoke + tooling)
 *   - ops/scripts/*.sh (sidecar scripts)
 *   - ops/scripts/lib/*.sh (shared sidecar helpers)
 *   - ops/backup/*.sh (backup script)
 *   - ops/ipfs/*.sh (IPFS release-hosting pin + setup scripts, v1.9.0)
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

/** Templates whose env-vars are consumed by an EXTERNAL process
 *  (e.g. a third-party container, vendored upstream binary) rather
 *  than by Morphit's own code.  Vars from these templates are
 *  exempted from the "must have a consumer in apps/ or ops/scripts/"
 *  rule because the consumer literally isn't in our codebase — it's
 *  in the upstream image / binary we deploy.
 *
 *  This keeps the smoke honest about Morphit's own surface (catches
 *  AGE_RECIPIENT-class dead vars in OUR scripts) without
 *  false-positiving on legitimate upstream-vendored env vars.
 *
 *  Each entry MUST cite the consumer it documents — adding to this
 *  list without naming the upstream is a smell.
 */
const EXTERNAL_CONSUMER_TEMPLATES: ReadonlyMap<string, string> = new Map([
	// BunkerWeb (bunkerity/bunkerweb container) consumes its env
	// vars directly via the container's nginx-builder runtime.
	// See https://docs.bunkerweb.io/latest/settings/
	[
		'ops/ansible/roles/bunkerweb/templates/bunkerweb.env.j2',
		'bunkerity/bunkerweb container (upstream nginx-builder reads env directly)'
	]
]);

/** Find every literal `[A-Z][A-Z0-9_]+=...` line in *.env.j2 templates.
 *  Returns a list of (templatePath, varName) pairs. */
function collectTemplateVars(): Array<{ template: string; varName: string; externallyConsumed: boolean }> {
	const out: Array<{ template: string; varName: string; externallyConsumed: boolean }> = [];
	const templates = walkFiles(ANSIBLE_ROLES_DIR, (p) => p.endsWith('.env.j2'));
	for (const t of templates) {
		const relPath = t.replace(REPO_ROOT + '/', '');
		const externallyConsumed = EXTERNAL_CONSUMER_TEMPLATES.has(relPath);
		const src = readFileSync(t, 'utf-8');
		for (const rawLine of src.split('\n')) {
			const line = rawLine.trim();
			// Skip comments + blank lines.
			if (line.length === 0 || line.startsWith('#')) continue;
			// Match `X_Y_Z=...` where the LHS is purely literal
			// (no Jinja).  If the LHS contains `{{`, the var name
			// is dynamic — skip.
			//
			// cp131 HIGH-002 fix: previously hard-gated on
			// MORPHIT_* prefix, which silently let non-prefixed
			// vars (AGE_RECIPIENT, REMOTE_DESTINATION, SSH_KEY,
			// DB_HOST, DB_PORT, BACKUP_DIR, RETAIN_DAYS, DB_NAME,
			// DB_USER, ...) through unchecked — exactly the F13
			// bug-class this smoke was created to prevent.
			const m = /^([A-Z][A-Z0-9_]*)\s*=/.exec(line);
			if (!m) continue;
			const varName = m[1]!;
			// Sanity: did the LHS include Jinja?  Our regex
			// already rejected that because Jinja delimiters
			// aren't in [A-Z0-9_].  Double-check defensively.
			if (varName.includes('{{') || varName.includes('}}')) continue;
			out.push({ template: relPath, varName, externallyConsumed });
		}
	}
	return out;
}

/** Build the consumer-surface: union of every uppercase env-var
 *  token appearing in production code, scripts, or sidecars.
 *  Returns the set of var names found.
 *
 *  cp131: widened from `MORPHIT_*` to all `[A-Z][A-Z0-9_]+` so
 *  non-prefixed vars (AGE_RECIPIENT, DB_HOST, RSYNC_ARGS, ...)
 *  are caught. */
function collectConsumerSurface(): { names: Set<string>; fileCount: number } {
	const names = new Set<string>();
	const tsPred = (p: string): boolean =>
		(p.endsWith('.ts') || p.endsWith('.tsx') || p.endsWith('.js') || p.endsWith('.mjs')) &&
		!p.includes('.d.ts');
	const shPred = (p: string): boolean => p.endsWith('.sh');
	const consumerFiles = [
		...walkFiles(APPS_DIR, tsPred),
		// ops/scripts/ — sidecar shell scripts.
		...walkFiles(OPS_SCRIPTS_DIR, shPred),
		// ops/backup/ — backup script (cp131 added; previously
		// skipped, which let AGE_RECIPIENT et al. slip past).
		...walkFiles(join(REPO_ROOT, 'ops', 'backup'), shPred),
		// ops/ipfs/ — IPFS release-hosting scripts (v1.9.0). The pin +
		// setup scripts are real consumers of the release-hosting env vars
		// that the ipfs Ansible role's env templates declare; before this
		// directory was scanned those vars had no discoverable consumer.
		...walkFiles(join(REPO_ROOT, 'ops', 'ipfs'), shPred)
	];
	// Match uppercase env-var tokens.  Require at least 3 chars
	// total so we don't false-positive on every accidental
	// uppercase pair in source (e.g. `OK`, `IO`, `JS`).
	const re = /[A-Z][A-Z0-9_]{2,}/g;
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
// EXCEPT for templates listed in EXTERNAL_CONSUMER_TEMPLATES,
// which document an upstream consumer outside Morphit's
// codebase (e.g. BunkerWeb container).
const literalsByVar = new Map<string, { templates: string[]; externallyConsumed: boolean }>();
for (const { template, varName, externallyConsumed } of templateVars) {
	const entry = literalsByVar.get(varName) ?? { templates: [], externallyConsumed: true };
	entry.templates.push(template);
	// If ANY occurrence is internally-consumed, we still expect
	// a Morphit-side consumer.  The flag is true only when EVERY
	// declaring template is in the EXTERNAL_CONSUMER list.
	entry.externallyConsumed = entry.externallyConsumed && externallyConsumed;
	literalsByVar.set(varName, entry);
}
// Sort for deterministic output.
const sortedVars = [...literalsByVar.keys()].sort();
for (const varName of sortedVars) {
	const { templates, externallyConsumed } = literalsByVar.get(varName)!;
	if (externallyConsumed) {
		// Scenario reframed: var lives only in an externally-
		// consumed template, so we expect NO Morphit-side
		// consumer.  Still emit a passing scenario for
		// visibility — operators see the var is intentionally
		// upstream-consumed.
		const upstream = EXTERNAL_CONSUMER_TEMPLATES.get(templates[0]!) ?? 'external process';
		results.push({
			name: `${varName} is upstream-consumed (template marked external): ${upstream}`,
			ok: true
		});
		continue;
	}
	const hasConsumer = consumerNames.has(varName);
	results.push({
		name: `${varName} has a consumer in apps/, ops/scripts/, ops/backup/, or ops/ipfs/`,
		ok: hasConsumer,
		detail: hasConsumer
			? undefined
			: `${varName} is declared in template(s) ` +
			  `[${templates.join(', ')}] but no file under apps/, ` +
			  `ops/scripts/, ops/backup/, or ops/ipfs/ references it.  Either ` +
			  `remove the dead template line, or add a consumer (e.g. ` +
			  `zod schema in apps/<workspace>/src/config/index.ts, ` +
			  `bash variable in ops/scripts/morphit-*.sh, ops/backup/*.sh, or ops/ipfs/*.sh).  ` +
			  `Dead template lines are a security trap: operators ` +
			  `may fill in real secrets expecting them to be used ` +
			  `(cp5 F13, cp131 HIGH-001 / HIGH-002).`
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
			? `no consumer files found under apps/, ops/scripts/, ops/backup/, or ops/ipfs/ (did the repo layout change?)`
			: undefined
});

// ─── Scenario 4: every entry in EXTERNAL_CONSUMER_TEMPLATES
//     points at an actually-existing template file.  Guards
//     against drift: if a template gets renamed or deleted, the
//     allowlist entry pointing at the old path silently lets
//     new (real-consumer-required) drift slip through.
for (const [tplPath, upstream] of EXTERNAL_CONSUMER_TEMPLATES) {
	const abs = join(REPO_ROOT, tplPath);
	results.push({
		name: `EXTERNAL_CONSUMER_TEMPLATES entry "${tplPath}" still exists (upstream: ${upstream})`,
		ok: existsSync(abs),
		detail: existsSync(abs)
			? undefined
			: `EXTERNAL_CONSUMER_TEMPLATES lists ${tplPath} but the file ` +
			  `does not exist.  Either restore the template or remove the ` +
			  `stale entry from the allowlist.  Stale allowlist entries ` +
			  `silently mask new drift.`
	});
}

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
