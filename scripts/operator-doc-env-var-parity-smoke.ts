#!/usr/bin/env tsx
/**
 * scripts/operator-doc-env-var-parity-smoke.ts
 *
 * Structural Defense — operator-doc env-var parity (cp308, F-006).
 *
 * Sibling of operator-doc-fenced-path-existence-smoke: that gate
 * checks fenced PATHS resolve; this one checks fenced ENV-VAR
 * NAMES are real. It catches the drift class that cp308 found
 * manually as F-007: the OPERATIONS.md docker-compose example
 * prescribed `MORPHIT_RELAY_KEYSTORE_PATH` / `MORPHIT_RELAY_PASSPHRASE_FILE`,
 * neither of which the relay reads (it reads `MORPHIT_RELAY_ACTIVE_KEY_FILE`
 * / `MORPHIT_RELAY_ACTIVE_KEY_PASSPHRASE_FILE`). An operator copying
 * the example would set ignored vars, omit the required one, and the
 * relay would fail to boot. No gate caught it; this is that gate.
 *
 * What it does:
 *   1. Extract every `MORPHIT_*` token that appears INSIDE a fenced
 *      code block (```…```) of the operator docs. Fenced-only is
 *      deliberate — it captures PRESCRIPTIVE vars (compose env:,
 *      shell `MORPHIT_X=…`, env-file lines) and skips prose mentions
 *      (e.g. the F-007 caveat that NAMES the wrong vars precisely to
 *      warn against them; requiring those to exist would be wrong).
 *   2. Build the known-var universe from every consumption site:
 *      MORPHIT_* tokens across apps/ packages/ ops/ scripts/.
 *   3. Assert each fenced doc var is either (a) in the known universe,
 *      (b) matches a documented DYNAMIC-construction pattern, or
 *      (c) is on the small DOCUMENTED-BUT-UNIMPLEMENTED allowlist.
 *
 * Scope: operator-facing docs only (RUN-A-MORPHIT-NODE.md,
 * OPERATIONS.md) — the docs an operator follows literally. Design /
 * roadmap prose (e.g. OPERATIONS.md "What it costs" proposing future
 * vars) lives outside fenced blocks and is correctly ignored.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const DOC_FILES = ['docs/RUN-A-MORPHIT-NODE.md', 'docs/OPERATIONS.md'];

/** Source roots where env vars are actually consumed. */
const SOURCE_ROOTS = ['apps', 'packages', 'ops', 'scripts'];
const SOURCE_EXTS = new Set([
	'.ts',
	'.js',
	'.mjs',
	'.sh',
	'.sql',
	'.j2',
	'.yml',
	'.yaml',
	'.service',
	'.conf',
	'.example'
]);

/** Vars built at RUNTIME from a dynamic suffix, so they never appear
 *  literally in source. Each entry is a regex over the full var name.
 *  - fail2ban per-jail overrides: morphit-fail2ban-monitor.sh builds
 *    `MORPHIT_FAIL2BAN_<UPPERCASE-JAIL>_CRITICAL` / `_WARN` from the
 *    live jail name (line ~84), so e.g. MORPHIT_FAIL2BAN_SSHD_CRITICAL
 *    is a valid sshd-jail override the docs legitimately prescribe. */
const DYNAMIC_PATTERNS: RegExp[] = [/^MORPHIT_FAIL2BAN_[A-Z0-9]+_(CRITICAL|WARN)$/];

/** Vars documented in fenced examples that are intentionally NOT yet
 *  read by code — each must carry a live rationale. Keep this list
 *  SHORT; a new entry is a smell unless it's genuinely a documented
 *  forward-looking value. */
const DOCUMENTED_BUT_UNIMPLEMENTED: Record<string, string> = {
	// The docker-compose `*_FILE` DB-secret pattern is documented with
	// an explicit "not yet implemented" caveat (OPERATIONS.md Compose
	// example, cp308 audit). The services read the password directly
	// from the DATABASE_URL today; these names are placeholders for the
	// pattern when it lands. (The relay KEY *_FILE vars in the same
	// example ARE implemented — see F-007 — so they are NOT here.)
	MORPHIT_INDEXER_DB_PASSWORD_FILE: 'compose *_FILE DB-secret pattern, documented-not-yet-implemented',
	MORPHIT_RELAY_DB_PASSWORD_FILE: 'compose *_FILE DB-secret pattern, documented-not-yet-implemented'
};

const VAR_RE = /MORPHIT_[A-Z][A-Z0-9_]+/g;
/** Trailing-underscore tokens are prose glob artifacts (e.g.
 *  "MORPHIT_RELAY_*" rendered as MORPHIT_RELAY_), never real names. */
const isArtifact = (v: string): boolean => v.endsWith('_');

/** Pull MORPHIT_* tokens that occur inside ```…``` fenced blocks. */
function fencedVars(md: string): Set<string> {
	const out = new Set<string>();
	const fence = /```[^\n]*\n([\s\S]*?)```/g;
	let m: RegExpExecArray | null;
	while ((m = fence.exec(md)) !== null) {
		for (const tok of m[1].match(VAR_RE) ?? []) {
			if (!isArtifact(tok)) out.add(tok);
		}
	}
	return out;
}

/** Recursively collect MORPHIT_* tokens from all source files. */
function collectKnownVars(dir: string, acc: Set<string>): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'build') continue;
		const full = join(dir, name);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			collectKnownVars(full, acc);
		} else if (SOURCE_EXTS.has(extname(name)) || name.endsWith('.env.example')) {
			let text: string;
			try {
				text = readFileSync(full, 'utf-8');
			} catch {
				continue;
			}
			for (const tok of text.match(VAR_RE) ?? []) {
				if (!isArtifact(tok)) acc.add(tok);
			}
		}
	}
}

// ─── Build the known-var universe ──────────────────────────────────
const known = new Set<string>();
for (const root of SOURCE_ROOTS) collectKnownVars(join(ROOT, root), known);

// ─── Collect fenced doc vars ───────────────────────────────────────
const docVars = new Set<string>();
for (const rel of DOC_FILES) {
	for (const v of fencedVars(readFileSync(join(ROOT, rel), 'utf-8'))) docVars.add(v);
}

// ─── Classify ──────────────────────────────────────────────────────
const isKnown = (v: string): boolean =>
	known.has(v) ||
	DYNAMIC_PATTERNS.some((re) => re.test(v)) ||
	Object.prototype.hasOwnProperty.call(DOCUMENTED_BUT_UNIMPLEMENTED, v);

const orphans = [...docVars].filter((v) => !isKnown(v)).sort();

console.log('operator-doc env-var parity');
console.log(`  fenced doc vars: ${docVars.size}`);
console.log(`  known-universe vars: ${known.size}`);
console.log(
	`  dynamic-pattern + allowlist exemptions: ${DYNAMIC_PATTERNS.length} pattern(s), ${Object.keys(DOCUMENTED_BUT_UNIMPLEMENTED).length} allowlisted`
);

if (docVars.size === 0) {
	console.log('\n  ✗ no fenced env vars found — extractor is broken');
	console.log('\n──────────────────────────────────────────────────────');
	console.log('✗ 1/1 scenarios failed');
	process.exit(1);
}

if (orphans.length > 0) {
	console.log(`\n  ✗ ${orphans.length} doc env var(s) not read by any code:`);
	for (const o of orphans) console.log(`    - ${o}`);
	console.log(
		'\n  Either the code reads a different name (fix the doc),\n' +
			'  the var is dynamically built (add a DYNAMIC_PATTERNS entry),\n' +
			'  or it is documented-but-unimplemented (add to the allowlist\n' +
			'  WITH a rationale).'
	);
	console.log('\n──────────────────────────────────────────────────────');
	console.log(`✗ ${orphans.length}/${docVars.size} scenarios failed`);
	process.exit(1);
}

console.log(`  ✓ all ${docVars.size} fenced doc env vars are read by code (or justified)`);
console.log('\n──────────────────────────────────────────────────────');
console.log(`✓ all ${docVars.size} scenarios passed`);
