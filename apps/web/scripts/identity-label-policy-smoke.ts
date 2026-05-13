#!/usr/bin/env tsx
/**
 * Smoke for the IdentityLabel render policy.
 *
 * Project policy (per `apps/web/src/lib/components/IdentityLabel.svelte`):
 * every place a Blurt account name appears in user-facing UI must
 * be rendered through `<IdentityLabel>` so the identicon appears
 * alongside the username.  This protects against display-name
 * spoofing — `@morphit` vs `@morph1t` collide textually but their
 * identicons cannot.
 *
 * Tier 2.6 of the grandma-friendly investigation closed three
 * drift call sites in `apps/web/src/routes/settings/+page.svelte`
 * (Part 97).  This smoke runs a regex sweep over the route +
 * component source to flag any new `@{account}` / `@{author}` /
 * `@{seller}` / `@{buyer}` raw renders that don't live in an
 * accepted-exception file.
 *
 * Accepted exceptions (allow-list):
 *
 *   - `IdentityLabel.svelte` itself (the policy docstring quotes
 *     the pattern, doesn't render it).
 *   - `SeedBackupPrint.svelte` — print-only output of the user's
 *     own seed backup; identicons add no value on paper, and the
 *     user is viewing their OWN identity (no spoofing surface).
 *   - Comment-only references in `.svelte`/`.ts` files (JSDoc
 *     route patterns like `/@{account}/{permlink}`, mention in
 *     publish.ts of a seller-name template that's expanded
 *     elsewhere).
 *
 * The smoke is greedy on detection (false-positive permissive) —
 * any `@\{[a-zA-Z]+\}` pattern outside the allow-list is flagged.
 * If a new genuine exception arises (e.g. a future printable
 * card), add it to the allow-list with a comment justifying why.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCAN_DIRS = ['apps/web/src/routes', 'apps/web/src/lib/components'];

const ACCEPTED_FILES = new Set<string>([
	// The policy doc itself quotes the pattern.
	'apps/web/src/lib/components/IdentityLabel.svelte',
	// Print-only output of the user's OWN seed backup.  No
	// spoofing surface (user viewing self), identicons add no
	// value on paper, the card is intentionally minimal.
	'apps/web/src/lib/components/SeedBackupPrint.svelte',
	// Profile-page hero (already renders a 64px identicon
	// adjacent to the username; would be visually redundant
	// to wrap in IdentityLabel, which has its own avatar).
	'apps/web/src/routes/explorer/account/[name=account]/+page.svelte'
]);

// Ignore comment-context matches.  A real raw render is one that
// appears outside a `*` line, `//` line, or template-literal-only
// JSDoc block.  This is a heuristic, not perfect, but it catches
// the most common comment patterns.
function lineIsCodeRender(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed.startsWith('*')) return false;
	if (trimmed.startsWith('//')) return false;
	if (trimmed.startsWith('/*')) return false;
	// Inside a Svelte <script lang="ts"> block, `*` lines also count
	// as JSDoc-style comments and should be ignored.
	return true;
}

interface Finding {
	readonly file: string;
	readonly line: number;
	readonly text: string;
}

function scanFile(absPath: string, relPath: string, findings: Finding[]): void {
	if (ACCEPTED_FILES.has(relPath)) return;
	if (!absPath.endsWith('.svelte') && !absPath.endsWith('.ts')) return;

	const content = readFileSync(absPath, 'utf8');
	const lines = content.split('\n');
	const PATTERN = /@\{[a-zA-Z][a-zA-Z]*\}/;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!PATTERN.test(line)) continue;
		if (!lineIsCodeRender(line)) continue;
		findings.push({
			file: relPath,
			line: i + 1,
			text: line.trim().slice(0, 120)
		});
	}
}

function walk(dir: string, repoRoot: string, findings: Finding[]): void {
	for (const entry of readdirSync(dir)) {
		const abs = join(dir, entry);
		const rel = abs.slice(repoRoot.length + 1);
		const st = statSync(abs);
		if (st.isDirectory()) {
			if (entry === 'node_modules' || entry === '.svelte-kit' || entry === 'dist') continue;
			walk(abs, repoRoot, findings);
		} else {
			scanFile(abs, rel, findings);
		}
	}
}

console.log('');
console.log('── identity-label-policy smoke ─────────────────────────');
console.log('');

const findings: Finding[] = [];
for (const dir of SCAN_DIRS) {
	walk(join(REPO_ROOT, dir), REPO_ROOT, findings);
}

const scenarios = [
	{
		name: 'no raw @{...} renders outside accepted-exception files',
		ok: findings.length === 0
	},
	{
		name: 'IdentityLabel component imported in settings',
		ok: readFileSync(
			join(REPO_ROOT, 'apps/web/src/routes/settings/+page.svelte'),
			'utf8'
		).includes("import IdentityLabel from '$components/IdentityLabel.svelte'")
	},
	{
		name: 'IdentityLabel renders in hidden-accounts list',
		ok: /\{#each hiddenList[\s\S]*?<IdentityLabel/.test(
			readFileSync(
				join(REPO_ROOT, 'apps/web/src/routes/settings/+page.svelte'),
				'utf8'
			)
		)
	},
	{
		name: 'IdentityLabel renders in blocked-accounts list',
		ok: /\{#each blockedList[\s\S]*?<IdentityLabel/.test(
			readFileSync(
				join(REPO_ROOT, 'apps/web/src/routes/settings/+page.svelte'),
				'utf8'
			)
		)
	},
	{
		name: 'IdentityLabel renders for the user\'s own account in settings',
		ok: /<IdentityLabel\b[\s\S]{0,200}account=\{accountSaved\}/.test(
			readFileSync(
				join(REPO_ROOT, 'apps/web/src/routes/settings/+page.svelte'),
				'utf8'
			)
		)
	},
	{
		name: 'allow-list is non-empty (sanity)',
		ok: ACCEPTED_FILES.size >= 3
	}
];

let passed = 0;
let failed = 0;
for (const s of scenarios) {
	if (s.ok) {
		passed++;
	} else {
		failed++;
		console.log(`  ✗ ${s.name}`);
	}
}

if (findings.length > 0) {
	console.log('');
	console.log('  Findings:');
	for (const f of findings) {
		console.log(`    ${f.file}:${f.line}  ${f.text}`);
	}
}

console.log('');
console.log('────────────────────────────────────────────────────────');
if (failed === 0) {
	console.log(`✓ all ${passed} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failed} of ${passed + failed} scenarios failed`);
	process.exit(1);
}
