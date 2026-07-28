#!/usr/bin/env tsx
/**
 * Smoke for the Forgejo-not-Gitea naming policy (Memory
 * fact #16, 2026-05-09).
 *
 * The repo at git.agorise.net runs **Forgejo**.  We have
 * never used Gitea and never will.  Every doc mention,
 * locale string, and code comment must say "Forgejo" —
 * including phrases like "the always-working Forgejo
 * releases page" or "self-hosted Forgejo."  This smoke
 * walks every textual file in the repo (excluding read-
 * only transcript snapshots and node_modules) for any
 * "gitea" / "Gitea" mention.
 *
 * Why a smoke and not a one-shot fix: a Claude session
 * that hasn't read Memory fact #16 might re-introduce
 * "Gitea" while writing a release blurb, an integration-
 * test plan, or a CI doc.  The smoke fails fast at CI
 * time so the drift is caught before tarball.
 *
 * False-positive guard: this smoke runs against the
 * working tree only.  If a file ships in the repo that
 * legitimately needs to mention Gitea (e.g. a
 * comparison-with-other-forges doc), it can be added to
 * `ALLOW_LIST` below with an explanatory comment.  As of
 * Part 102 the allow-list is empty.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

// Files that legitimately mention Gitea — kept minimal.
// `scripts/run-smokes.sh` is allow-listed because the smoke
// registration line literally contains "forgejo-not-gitea-smoke"
// which trips a substring match on "gitea".  The registration
// is the smoke's own identity, not a project mention of Gitea.
//
// `TARBALL.md` and `docs/REVISIT-LIST.md` are allow-listed
// because they are META-DOCUMENTATION about the policy — they
// explain what was changed FROM (Gitea) and TO (Forgejo) in
// past parts.  Erasing the historical context would make future
// sessions unable to reconstruct why entries reference "Forgejo
// cleanup."  These files describe past Gitea mentions in the
// context of fixing them; that's the right place for the word
// to appear.
//
// `MORPHIT-BRAG-LIST.md` is NOT allow-listed — the brag list
// is public-facing marketing and must use "Forgejo" cleanly,
// even when describing past fixes.  If a "Gitea" mention
// appears there, it's a real bug to fix.
//
// v1.9.6 (Ken) — gitea.com is now a legitimate THIRD-PARTY release
// MIRROR (like GitHub / GitLab / Codeberg).  Naming that mirror is
// NOT a policy violation — the policy is about never mis-naming OUR
// host (git.agorise.net = Forgejo).  Two allowances encode this:
//   1. Any line containing `gitea.com` (the mirror URL) is allowed —
//      a "name: 'Gitea'" applied to our Forgejo host would NOT carry
//      the mirror domain, so it is still caught.
//   2. `apps/web/src/lib/mirrorLogos.ts` is allow-listed: it is pure
//      brand-glyph DATA keyed by mirror id, so its `gitea:` map key +
//      the glyph comments are the Gitea *mirror's* mark, never a claim
//      about our host (the Forgejo glyph there is keyed `forgejo:`).
const ALLOW_LIST: ReadonlySet<string> = new Set([
	'scripts/run-smokes.sh',
	'TARBALL.md',
	'docs/REVISIT-LIST.md',
	'apps/web/src/lib/mirrorLogos.ts'
]);

const SCAN_EXTENSIONS = new Set([
	'.md',
	'.ts',
	'.tsx',
	'.svelte',
	'.json',
	'.yml',
	'.yaml',
	'.sh',
	'.txt',
	'.html',
	'.sql',
	'.js',
	'.mjs'
]);

const IGNORE_DIRS = new Set([
	'node_modules',
	'.svelte-kit',
	'dist',
	'build',
	'.next',
	'.git',
	'__pycache__',
	'transcripts'
]);

interface Hit {
	readonly file: string;
	readonly line: number;
	readonly text: string;
}

function fileExtMatch(name: string): boolean {
	const dot = name.lastIndexOf('.');
	if (dot < 0) return false;
	return SCAN_EXTENSIONS.has(name.slice(dot));
}

function walk(dir: string, hits: Hit[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			if (IGNORE_DIRS.has(entry)) continue;
			walk(full, hits);
		} else if (st.isFile() && fileExtMatch(entry)) {
			const rel = relative(REPO_ROOT, full);
			if (ALLOW_LIST.has(rel)) continue;
			// The smoke file itself contains the word "Gitea"
			// to document the policy — skip it.
			if (rel === 'apps/web/scripts/forgejo-not-gitea-smoke.ts') continue;
			let content: string;
			try {
				content = readFileSync(full, 'utf8');
			} catch {
				continue;
			}
			if (!/gitea/i.test(content)) continue;
			const lines = content.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]!;
				if (/gitea/i.test(line)) {
					// v1.9.6 — the gitea.com release mirror is legitimate; allow any line
					// carrying its domain. A "Gitea" mis-applied to OUR Forgejo host
					// (git.agorise.net) would not carry the mirror domain — still caught.
					if (/gitea\.com/i.test(line)) continue;
					hits.push({
						file: rel,
						line: i + 1,
						text: line.trim().slice(0, 120)
					});
				}
			}
		}
	}
}

console.log('');
console.log('── forgejo-not-gitea smoke ─────────────────────────────');
console.log('');

const hits: Hit[] = [];
walk(REPO_ROOT, hits);

const scenarios = [
	{
		name: 'no "gitea" mentions in repo (case-insensitive, allow-list-aware)',
		ok: hits.length === 0
	},
	{
		name: 'allow-list contains the documented self-references, meta-docs, and mirror-glyph data',
		ok: ALLOW_LIST.size === 4 &&
			ALLOW_LIST.has('scripts/run-smokes.sh') &&
			ALLOW_LIST.has('TARBALL.md') &&
			ALLOW_LIST.has('docs/REVISIT-LIST.md') &&
			ALLOW_LIST.has('apps/web/src/lib/mirrorLogos.ts')
	},
	{
		name: 'this smoke file scans the right extensions',
		ok: SCAN_EXTENSIONS.has('.md') &&
			SCAN_EXTENSIONS.has('.ts') &&
			SCAN_EXTENSIONS.has('.svelte')
	}
];

let passed = 0;
let failed = 0;
const failures: string[] = [];
for (const s of scenarios) {
	if (s.ok) {
		passed++;
	} else {
		failed++;
		failures.push(`  ✗ ${s.name}`);
	}
}

if (hits.length > 0) {
	console.log('  Found "gitea" mentions:');
	for (const h of hits.slice(0, 20)) {
		console.log(`    ${h.file}:${h.line}  ${h.text}`);
	}
	if (hits.length > 20) {
		console.log(`    ... and ${hits.length - 20} more`);
	}
	console.log('');
}
if (failures.length > 0) {
	console.log(failures.join('\n'));
	console.log('');
}

console.log('────────────────────────────────────────────────────────');
if (failed === 0) {
	console.log(`✓ all ${passed} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failed} of ${passed + failed} scenarios failed`);
	process.exit(1);
}
