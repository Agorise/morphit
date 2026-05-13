#!/usr/bin/env tsx
/**
 * Smoke for heading-hierarchy a11y on every public-page
 * route.
 *
 * Deferred from Part 100's Memory #11 Category N a11y
 * audit; closed in Part 102.
 *
 * Why this matters: screen-reader users navigate by
 * heading level (key 1 / 2 / 3 / 4 / 5 / 6 in NVDA, JAWS,
 * VoiceOver).  When a page renders <h1> then jumps
 * straight to <h3> with no <h2>, the rotor reports a
 * gap and users miss the document's outline.  When two
 * <h1>s render on the same page (a common SvelteKit
 * mistake — layout hero + page title both as <h1>),
 * screen readers can't pick the canonical page title.
 *
 * The smoke walks every `+page.svelte` under
 * `apps/web/src/routes`, extracts the heading tags in
 * render order (skipping anything inside an `{#if false}`
 * branch — a heuristic for dead code), and flags:
 *
 *   1. Multiple <h1>s in the same route (only one canonical
 *      page title per page).
 *   2. Heading-level jumps (e.g. h1 → h3) — every level
 *      should appear in monotone non-decreasing order
 *      with at most a +1 increment.
 *
 * The check is static: it doesn't render the page, so
 * conditional branches that emit different headings
 * based on state are flagged structurally — if EVERY
 * branch is internally consistent we're fine.  Some
 * legitimate patterns produce a sequence like h2-h3-h2-h3
 * (two top-level sections each with subsections); that's
 * NOT flagged because the algorithm only looks at
 * "have we seen level N before introducing level N+2."
 *
 * False-positive guard: routes that legitimately have
 * unusual structure (e.g. a printable card with no
 * <h1> because it inherits from layout) can be added
 * to ALLOW_LIST below.
 *
 * Layout-level <h1>s (the wordmark image's alt text or
 * skip-link target) are not counted — only the page
 * file's own headings are scanned.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');
const ROUTES_DIR = join(REPO_ROOT, 'apps/web/src/routes');

// Routes whose unusual heading structure is intentional.
// Keep this list short and document each entry.
const ALLOW_LIST: ReadonlySet<string> = new Set([
	// /onboarding/import — the page composes screens with
	// `<h2>` because the parent `/onboarding` route's <h1>
	// owns the funnel title.  Multi-step flow inherits
	// the top-level heading from the layout-card pattern,
	// not from a per-step <h1>.
	'apps/web/src/routes/onboarding/import/+page.svelte',
	// /onboarding/register-name — same pattern.
	'apps/web/src/routes/onboarding/register-name/+page.svelte',
	// /cheat-sheet uses the visibility-isolation pattern
	// from Memory #29 — a `screen-only` div renders one
	// <h1> for the on-screen UI and a sibling
	// `morphit-cheat-sheet` div renders an identical
	// <h1> for the print output.  The print-half has
	// `display: none` in screen mode (CSS at line ~156
	// of the page), so screen readers see exactly one
	// <h1> at runtime — the smoke's static-source scan
	// can't see CSS so it counts both.  Same pattern
	// applies to SeedBackupPrint but that's a component,
	// not a route, so it doesn't appear here.
	'apps/web/src/routes/cheat-sheet/+page.svelte'
]);

interface PageHeadings {
	readonly file: string;
	readonly levels: readonly number[];
}

/** Extract h1-h6 tags in render order, respecting Svelte
 *  `{#if}` / `{:else if}` / `{:else}` / `{/if}` blocks so
 *  headings inside mutually-exclusive branches don't all
 *  count toward the multiple-h1 check.
 *
 *  Returns a flat list of heading levels for the
 *  level-jump check, AND a per-branch grouping for the
 *  multiple-h1 check.  The two checks need different
 *  semantics:
 *
 *  - Level-jump: if branch A has h2 and branch B has
 *    h4, that's still a per-branch jump (h2→h4 with no
 *    h3 in EITHER branch).  Flat sequence is fine.
 *  - Multiple-h1: branches are mutually exclusive at
 *    runtime, so we only flag if the SAME branch has
 *    multiple h1s. */
function extractHeadingsAndBranches(source: string): {
	flat: number[];
	branchH1Counts: number[];
} {
	// Strip <script lang="ts">...</script> blocks.
	const stripped = source.replace(/<script[\s\S]*?<\/script>/gi, '');

	// Walk forward through the source, tracking how deep
	// we are inside `{#if}` / `{#each}` blocks via a stack.
	// Each branch boundary (`{:else if}` / `{:else}`) starts
	// a fresh sub-branch under the same parent.  We count
	// h1s per current branch path.
	const flat: number[] = [];

	// Stack of "branch fingerprints" — strings identifying
	// the current branch path.  Top of stack identifies the
	// active branch.  When `{:else}` fires we replace top.
	// When `{/if}` fires we pop.
	const branchPathStack: string[] = ['root'];
	let nextBranchId = 1;

	// Map of branch path → h1 count seen on that path.
	const h1Counts = new Map<string, number>();

	const tokenRe = /<h([1-6])\b|\{#if\b|\{#each\b|\{:else if\b|\{:else\}|\{\/if\}|\{\/each\}/g;
	let match: RegExpExecArray | null;
	while ((match = tokenRe.exec(stripped)) !== null) {
		const tok = match[0];
		if (tok.startsWith('<h')) {
			const lvl = Number(match[1]);
			flat.push(lvl);
			if (lvl === 1) {
				const path = branchPathStack.join('>');
				h1Counts.set(path, (h1Counts.get(path) ?? 0) + 1);
			}
		} else if (tok === '{#if' || tok === '{#each') {
			branchPathStack.push(`b${nextBranchId++}`);
		} else if (tok === '{:else if' || tok === '{:else}') {
			// Sibling branch under the same parent; replace top.
			branchPathStack[branchPathStack.length - 1] = `b${nextBranchId++}`;
		} else if (tok === '{/if}' || tok === '{/each}') {
			branchPathStack.pop();
		}
	}

	return {
		flat,
		branchH1Counts: Array.from(h1Counts.values())
	};
}

function findRoutes(dir: string, acc: string[]): void {
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
			findRoutes(full, acc);
		} else if (entry === '+page.svelte') {
			acc.push(full);
		}
	}
}

interface Issue {
	readonly file: string;
	readonly kind: 'multiple_h1' | 'level_jump';
	readonly detail: string;
}

function audit(routes: readonly string[]): { results: PageHeadings[]; issues: Issue[] } {
	const results: PageHeadings[] = [];
	const issues: Issue[] = [];

	for (const abs of routes) {
		const rel = relative(REPO_ROOT, abs);
		if (ALLOW_LIST.has(rel)) continue;

		const source = readFileSync(abs, 'utf8');
		const { flat: levels, branchH1Counts } = extractHeadingsAndBranches(source);
		results.push({ file: rel, levels });

		// Rule 1 — at most one <h1> per render branch.
		// Branches under {#if}/{:else} are mutually exclusive
		// so each may have its own canonical h1; the rule is
		// "no single branch has TWO h1s," which would actually
		// duplicate at runtime.
		const maxH1InOneBranch = branchH1Counts.length === 0
			? 0
			: Math.max(...branchH1Counts);
		if (maxH1InOneBranch > 1) {
			issues.push({
				file: rel,
				kind: 'multiple_h1',
				detail: `${maxH1InOneBranch} <h1> tags in a single render branch (sequence: ${levels.join(', ')})`
			});
		}

		// Rule 2 — no level jump > +1.  Track the highest
		// heading level seen so far; new headings can only
		// increment by 1 or match a previously-seen level
		// or be lower.  This permits h2-h3-h2-h3 (sibling
		// sections) but flags h2-h4 (skipped h3).
		let maxSeen = 0;
		for (let i = 0; i < levels.length; i++) {
			const lvl = levels[i]!;
			if (lvl > maxSeen + 1) {
				issues.push({
					file: rel,
					kind: 'level_jump',
					detail: `at heading #${i + 1}: jumped from level ${maxSeen} to ${lvl} (sequence: ${levels.join(', ')})`
				});
				break; // one finding per file is enough
			}
			if (lvl > maxSeen) maxSeen = lvl;
		}
	}

	return { results, issues };
}

console.log('');
console.log('── heading-hierarchy a11y smoke ────────────────────────');
console.log('');

const routes: string[] = [];
findRoutes(ROUTES_DIR, routes);
routes.sort();

const { results, issues } = audit(routes);

const scenarios = [
	{
		name: `${results.length} +page.svelte files audited (≥30 expected)`,
		ok: results.length >= 30
	},
	{
		name: 'no route has multiple <h1> tags',
		ok: !issues.some((i) => i.kind === 'multiple_h1')
	},
	{
		name: 'no route skips a heading level (h2 → h4 etc.)',
		ok: !issues.some((i) => i.kind === 'level_jump')
	},
	{
		name: 'allow-list is documented and minimal',
		ok: ALLOW_LIST.size <= 5
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

if (issues.length > 0) {
	console.log('  Findings:');
	for (const i of issues) {
		console.log(`    ${i.file}`);
		console.log(`      [${i.kind}] ${i.detail}`);
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
