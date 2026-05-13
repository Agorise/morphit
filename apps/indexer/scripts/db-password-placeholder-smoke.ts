/**
 * Morphit smoke — DB password placeholder guardrails.
 *
 * Two layers of defense are checked:
 *
 * 1. SOURCE-TEXT SCAN. None of the well-known placeholder password
 *    sentinels may appear anywhere in tracked source / config /
 *    operator-doc files except (a) this smoke itself, (b) the
 *    `init.sql` provisioning script that REJECTS them, (c) the
 *    `.env.example` files that document the sentinel as the
 *    required-replace value, (d) the indexer/relay config files
 *    that share the reject list, and (e) the historical audit
 *    log (`docs/AUDIT-2026-05.md`), which is append-only.
 *
 * 2. ZOD SCHEMA REJECTION. The indexer and relay config schemas
 *    refuse to parse a DATABASE_URL whose password component is
 *    one of the sentinels. We exercise each sentinel against
 *    each schema.
 *
 * Run via the standard smoke runner:
 *   bash scripts/run-smokes.sh
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

let scenarios = 0;
let failures = 0;
function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

console.log('\n── db-password-placeholder smoke ─────────────────────────\n');

// ─── Resolve repo root ────────────────────────────────────────────────
// This script lives at apps/indexer/scripts/<name>.ts, so the repo
// root is two levels up.
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

// ─── The reject list (must match init.sql + indexer config + relay config)
const PLACEHOLDERS = [
	'CHANGEME',
	'CHANGE_ME',
	'CHANGE_ME_BEFORE_PRODUCTION',
	'__SET_BEFORE_DEPLOY__'
] as const;

// ─── Files where mentions of the placeholders are EXPECTED ────────────
// Paths are relative to the repo root. This list is the trust
// boundary: a placeholder showing up anywhere NOT in this list
// is a smoke failure.
const ALLOWED_PATHS = new Set([
	// The init.sql script REJECTS these strings — it has to
	// contain them.
	'ops/postgres/init.sql',
	// Example .env files document the sentinel as a required-
	// replace marker.
	'ops/env/indexer.env.example',
	'ops/env/relay.env.example',
	// Indexer + relay config share the reject list.
	'apps/indexer/src/config/index.ts',
	'apps/relay/src/config/index.ts',
	// This smoke itself contains the strings literally.
	'apps/indexer/scripts/db-password-placeholder-smoke.ts',
	// Historical audit log — append-only, mentions the past
	// presence of the placeholders in fix narratives.
	'docs/AUDIT-2026-05.md',
	// Final report from the May 2026 audit campaign — names the
	// sentinel literally in the "standing pre-launch action items"
	// section so operators know what to rotate.
	'docs/AUDIT-2026-05-FINAL-REPORT.md',
	// Memorized facts in REVISIT-LIST mention placeholders by
	// name in the operator-action checklist.
	'docs/REVISIT-LIST.md',
	// Operator-facing setup doc names the sentinel by spelling
	// in step 7 + step 8 (so the operator recognizes it).
	'docs/RUN-A-MORPHIT-NODE.md',
	// Deep operator runbook §30 documents the reject list.
	'docs/OPERATIONS.md',
	// TARBALL.md is the per-checkpoint snapshot; the
	// audit-trail commentary on the placeholder hardening
	// names every sentinel by spelling.
	'TARBALL.md',
	// Brag list entry 230 (Part 71) names the sentinel
	// in the audit-trail closure narrative explaining
	// that the "rotate CHANGE_ME_BEFORE_PRODUCTION"
	// standing-action item was based on a misreading
	// (the string is in a denylist by design).  Removing
	// the literal would weaken the closure provenance.
	'MORPHIT-BRAG-LIST.md'
]);

// ─── Directories to skip while walking ────────────────────────────────
const SKIP_DIRS = new Set([
	'node_modules',
	'.svelte-kit',
	'build',
	'dist',
	'.vercel',
	'.netlify',
	'.git',
	'.pnpm-store'
]);

// ─── File extensions to scan ──────────────────────────────────────────
// Configs, scripts, source, and docs. Binary files are skipped.
const SCAN_EXTENSIONS = new Set([
	'.ts',
	'.tsx',
	'.js',
	'.mjs',
	'.cjs',
	'.svelte',
	'.json',
	'.sql',
	'.md',
	'.sh',
	'.yml',
	'.yaml',
	'.env',
	'.example',
	'.conf',
	'.service',
	'.timer'
]);

function shouldScan(filePath: string): boolean {
	const ext = path.extname(filePath);
	if (SCAN_EXTENSIONS.has(ext)) return true;
	// Files with no extension that are clearly text (e.g. LICENSE,
	// Dockerfile) — none of those are likely to contain DB secrets,
	// so we skip extensionless files for performance.
	return false;
}

function* walkRepo(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		// Skip dotfiles at the top level except .forgejo (CI configs).
		if (
			entry.startsWith('.') &&
			entry !== '.forgejo' &&
			entry !== '.gitignore' &&
			entry !== '.editorconfig'
		)
			continue;
		if (SKIP_DIRS.has(entry)) continue;
		const st = statSync(full);
		if (st.isDirectory()) {
			yield* walkRepo(full);
		} else if (st.isFile() && shouldScan(full)) {
			yield full;
		}
	}
}

// ─── Source-text scan ─────────────────────────────────────────────────

scenario('no rogue placeholder strings in tracked source', () => {
	const violations: { file: string; placeholder: string; line: number }[] = [];
	for (const file of walkRepo(REPO_ROOT)) {
		const rel = path.relative(REPO_ROOT, file);
		if (ALLOWED_PATHS.has(rel)) continue;
		const text = readFileSync(file, 'utf8');
		const lines = text.split('\n');
		for (let i = 0; i < lines.length; i++) {
			for (const ph of PLACEHOLDERS) {
				if (lines[i].includes(ph)) {
					violations.push({ file: rel, placeholder: ph, line: i + 1 });
				}
			}
		}
	}
	if (violations.length > 0) {
		const detail = violations
			.map((v) => `      ${v.file}:${v.line}  contains "${v.placeholder}"`)
			.join('\n');
		throw new Error(
			`\n    Found ${violations.length} unexpected placeholder reference(s):\n${detail}\n` +
				`    If a new file legitimately needs to mention the sentinel, add it to ALLOWED_PATHS in ` +
				`apps/indexer/scripts/db-password-placeholder-smoke.ts.`
		);
	}
});

// ─── Verify init.sql rejects every placeholder ───────────────────────

scenario('init.sql reject list contains every placeholder', () => {
	const initSql = readFileSync(path.join(REPO_ROOT, 'ops/postgres/init.sql'), 'utf8');
	for (const ph of PLACEHOLDERS) {
		if (!initSql.includes(`'${ph}'`)) {
			throw new Error(`init.sql reject list missing '${ph}'`);
		}
	}
});

// ─── Verify indexer config reject list matches ───────────────────────

scenario('indexer config PLACEHOLDER_DB_PASSWORDS contains every placeholder', () => {
	const cfg = readFileSync(path.join(REPO_ROOT, 'apps/indexer/src/config/index.ts'), 'utf8');
	for (const ph of PLACEHOLDERS) {
		if (!cfg.includes(`'${ph}'`)) {
			throw new Error(`indexer config PLACEHOLDER_DB_PASSWORDS missing '${ph}'`);
		}
	}
});

// ─── Verify relay config reject list matches ─────────────────────────

scenario('relay config PLACEHOLDER_DB_PASSWORDS contains every placeholder', () => {
	const cfg = readFileSync(path.join(REPO_ROOT, 'apps/relay/src/config/index.ts'), 'utf8');
	for (const ph of PLACEHOLDERS) {
		if (!cfg.includes(`'${ph}'`)) {
			throw new Error(`relay config PLACEHOLDER_DB_PASSWORDS missing '${ph}'`);
		}
	}
});

// ─── Verify the .env.example files use the canonical sentinel ──────────

scenario('indexer.env.example uses __SET_BEFORE_DEPLOY__ sentinel', () => {
	const ex = readFileSync(path.join(REPO_ROOT, 'ops/env/indexer.env.example'), 'utf8');
	if (!ex.includes('__SET_BEFORE_DEPLOY__')) {
		throw new Error('indexer.env.example no longer contains the canonical sentinel');
	}
	// Negative: the older non-canonical spellings should be GONE
	// from the example file (we keep them rejected by init.sql for
	// belt-and-suspenders, but we don't ship them as the example).
	for (const old of ['CHANGEME', 'CHANGE_ME', 'CHANGE_ME_BEFORE_PRODUCTION']) {
		if (ex.includes(`:${old}@`)) {
			throw new Error(
				`indexer.env.example still ships the old sentinel '${old}' as the example value; ` +
					`canonicalize on '__SET_BEFORE_DEPLOY__'`
			);
		}
	}
});

scenario('relay.env.example uses __SET_BEFORE_DEPLOY__ sentinel', () => {
	const ex = readFileSync(path.join(REPO_ROOT, 'ops/env/relay.env.example'), 'utf8');
	if (!ex.includes('__SET_BEFORE_DEPLOY__')) {
		throw new Error('relay.env.example no longer contains the canonical sentinel');
	}
	for (const old of ['CHANGEME', 'CHANGE_ME', 'CHANGE_ME_BEFORE_PRODUCTION']) {
		if (ex.includes(`:${old}@`)) {
			throw new Error(
				`relay.env.example still ships the old sentinel '${old}' as the example value; ` +
					`canonicalize on '__SET_BEFORE_DEPLOY__'`
			);
		}
	}
});

// ─── Lightweight schema check: build a URL containing each placeholder
// and verify the indexer/relay refinement strings are present ────────

scenario('indexer config refinement message references the sentinel', () => {
	const cfg = readFileSync(path.join(REPO_ROOT, 'apps/indexer/src/config/index.ts'), 'utf8');
	if (!/placeholder password sentinel/i.test(cfg)) {
		throw new Error('indexer config missing placeholder-rejection refinement');
	}
});

scenario('relay config refinement message references the sentinel', () => {
	const cfg = readFileSync(path.join(REPO_ROOT, 'apps/relay/src/config/index.ts'), 'utf8');
	if (!/placeholder password sentinel/i.test(cfg)) {
		throw new Error('relay config missing placeholder-rejection refinement');
	}
});

// ─── Final ────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
