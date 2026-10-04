#!/usr/bin/env tsx
/**
 * Smoke for heading-hierarchy a11y on every public-page
 * route.
 *
 * Deferred from the a11y audit, Category N
 * audit; closed.
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

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
	'apps/web/src/routes/[lang]/onboarding/import/+page.svelte',
	// /onboarding/register-name — same pattern.
	'apps/web/src/routes/[lang]/onboarding/register-name/+page.svelte',
	// /cheat-sheet uses the visibility-isolation pattern
	// — a `screen-only` div renders one
	// <h1> for the on-screen UI and a sibling
	// `morphit-cheat-sheet` div renders an identical
	// <h1> for the print output.  The print-half has
	// `display: none` in screen mode (CSS at line ~156
	// of the page), so screen readers see exactly one
	// <h1> at runtime — the smoke's static-source scan
	// can't see CSS so it counts both.  Same pattern
	// applies to SeedBackupPrint but that's a component,
	// not a route, so it doesn't appear here.
	'apps/web/src/routes/[lang]/cheat-sheet/+page.svelte'
]);

interface PageHeadings {
	readonly file: string;
	readonly levels: readonly number[];
}

// ─── Component following (v1.20.0) ────────────────────────────────
//
// A route's outline is not only its own +page.svelte: the homepage renders
// its cards through components (PrioritiesSection, FeaturedOrders → OrderCard).
// Scanning only the page file missed v1.20.0's homepage going h1 → h3 once the
// section heading above the priority cards was removed. So each `<Component`
// tag whose name resolves to a .svelte file — a static
// `import X from '…svelte'`, or a lazy loader `const loadX = () =>
// import('…svelte')` rendered via `{#await loadX() then X}` — is replaced by
// that component's own headings, recursively. `{#snippet}` bodies are inlined
// where they are `{@render}`ed, not where they are defined. A component that is
// a dialog (role="dialog" / <dialog> / aria-modal) is skipped: its heading
// belongs to the dialog's own outline.

const WEB_ROOT = join(REPO_ROOT, 'apps/web');
const ALIASES: ReadonlyArray<readonly [string, string]> = [
	['$components/', 'src/lib/components/'],
	['$lib/', 'src/lib/']
];

function resolveSvelte(spec: string, fromFile: string): string | null {
	if (!spec.endsWith('.svelte')) return null;
	for (const [alias, dir] of ALIASES) {
		if (spec.startsWith(alias)) return join(WEB_ROOT, dir, spec.slice(alias.length));
	}
	if (spec.startsWith('.')) return join(dirname(fromFile), spec);
	return null;
}

/** Component tag name → file, from static imports and lazy `{#await}` loaders. */
function componentMap(source: string, file: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const m of source.matchAll(/import\s+(\w+)\s+from\s+['"]([^'"]+\.svelte)['"]/g)) {
		const f = resolveSvelte(m[2]!, file);
		if (f !== null) map.set(m[1]!, f);
	}
	const loaders = new Map<string, string>();
	for (const m of source.matchAll(/const\s+(\w+)\s*=\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+\.svelte)['"]/g)) {
		const f = resolveSvelte(m[2]!, file);
		if (f !== null) loaders.set(m[1]!, f);
	}
	for (const m of source.matchAll(/\{#await\s+(\w+)\(\)\s+then\s+(\w+)\s*\}/g)) {
		const f = loaders.get(m[1]!);
		if (f !== undefined) map.set(m[2]!, f);
	}
	return map;
}

type Ev = { readonly k: 'h'; readonly lvl: number } | { readonly k: 'open' | 'else' | 'close' };

/** Boolean props a component declares with a literal default:
 *  `let { embedded = false, … } = $props()`. */
function booleanPropDefaults(raw: string): Map<string, boolean> {
	const out = new Map<string, boolean>();
	const m = /let\s*\{([\s\S]*?)\}\s*(?::\s*\w+\s*)?=\s*\$props\(\)/.exec(raw);
	if (m) for (const d of m[1]!.matchAll(/(\w+)\s*=\s*(true|false)\b/g)) out.set(d[1]!, d[2] === 'true');
	return out;
}

/** Boolean props a call site sets on a component tag: `embedded`,
 *  `embedded={true}`, `embedded={false}`. */
function booleanPropsAt(text: string, from: number): Map<string, boolean> {
	const out = new Map<string, boolean>();
	const end = text.indexOf('>', from);
	const tag = text.slice(from, end < 0 ? text.length : end);
	for (const a of tag.matchAll(/\s(\w+)(?:=\{(true|false)\})?(?=[\s/]|$)/g)) {
		out.set(a[1]!, a[2] === undefined ? true : a[2] === 'true');
	}
	return out;
}

/** Heading + branch events of one file, with its components and snippets
 *  inlined. `callerProps` are the boolean props the call site set: an
 *  `{#if prop}` on a boolean prop whose value is known (call site, else the
 *  component's literal default) keeps only the branch that renders — e.g.
 *  FeaturedOrders' `embedded` variant is never what the homepage shows. */
function events(
	file: string,
	depth: number,
	stack: readonly string[],
	callerProps: ReadonlyMap<string, boolean> = new Map()
): Ev[] {
	if (depth > 8 || stack.includes(file)) return [];
	let raw: string;
	try {
		raw = readFileSync(file, 'utf8');
	} catch {
		return [];
	}
	// A dialog (modal) is its own document context: its <h2> titles the dialog,
	// not a section of the page behind it, so it is not part of the page outline.
	if (depth > 0 && /role=["']dialog["']|<dialog\b|aria-modal=/.test(raw)) return [];
	const comps = componentMap(raw, file);
	const known = booleanPropDefaults(raw);
	for (const [k, v] of callerProps) if (known.has(k)) known.set(k, v);
	// Strip <script>/<style> blocks and HTML comments (a comment naming "<h2>"
	// or "<OrderCard" is not markup).
	let src = raw
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '');
	// Lift snippet bodies out; they render where {@render name(…)} appears.
	const snippets = new Map<string, string>();
	for (;;) {
		const open = /\{#snippet\s+(\w+)[^}]*\}/.exec(src);
		if (open === null) break;
		const i = open.index + open[0].length;
		let nest = 1;
		const tok = /\{#snippet\b[^}]*\}|\{\/snippet\}/g;
		tok.lastIndex = i;
		let t: RegExpExecArray | null;
		let end = src.length;
		let close = src.length;
		while ((t = tok.exec(src)) !== null) {
			if (t[0].startsWith('{#')) nest++;
			else if (--nest === 0) {
				end = t.index;
				close = t.index + t[0].length;
				break;
			}
		}
		snippets.set(open[1]!, src.slice(i, end));
		src = src.slice(0, open.index) + src.slice(close);
	}
	const out: Ev[] = [];
	// One frame per open {#if}/{#each}. `known` frames decided a boolean prop:
	// `on` = the current branch renders; `chain` = a later {:else if} turned the
	// rest into an ordinary branch chain (events emitted from there on).
	type Frame = { known: boolean; on: boolean; chain: boolean; taken: boolean };
	const frames: Frame[] = [];
	const emitting = (): boolean => frames.every((f) => !f.known || f.on || f.chain);
	const walk = (text: string, snipDepth: number): void => {
		const tokenRe =
			/<h([1-6])\b|<([A-Z]\w*)\b|\{@render\s+(\w+)\(|\{#if\s+(!?)(\w+)\s*\}|\{#if\b|\{#each\b|\{:else if\b|\{:else\}|\{\/if\}|\{\/each\}/g;
		let m: RegExpExecArray | null;
		while ((m = tokenRe.exec(text)) !== null) {
			const tokText = m[0];
			if (m[1] !== undefined) {
				if (emitting()) out.push({ k: 'h', lvl: Number(m[1]) });
			} else if (m[2] !== undefined) {
				const f = comps.get(m[2]);
				if (f !== undefined && emitting())
					out.push(...events(f, depth + 1, [...stack, file], booleanPropsAt(text, m.index)));
			} else if (m[3] !== undefined) {
				const body = snippets.get(m[3]);
				if (body !== undefined && snipDepth < 4) walk(body, snipDepth + 1);
			} else if (m[5] !== undefined && known.has(m[5])) {
				const v = known.get(m[5])! !== (m[4] === '!');
				frames.push({ known: true, on: v, chain: false, taken: v });
			} else if (tokText.startsWith('{#if') || tokText === '{#each') {
				frames.push({ known: false, on: true, chain: false, taken: false });
				if (emitting()) out.push({ k: 'open' });
			} else if (tokText === '{:else if' || tokText === '{:else}') {
				const f = frames[frames.length - 1];
				if (f !== undefined && f.known) {
					if (f.chain) {
						if (emitting()) out.push({ k: 'else' });
					} else if (f.taken) {
						f.on = false; // the known branch rendered; no later branch does
					} else if (tokText === '{:else if') {
						// The known branch did not render; what follows is a real chain.
						f.chain = true;
						if (emitting()) out.push({ k: 'open' });
					} else {
						f.on = true;
						f.taken = true;
					}
				} else if (emitting()) out.push({ k: 'else' });
			} else {
				const f = frames.pop();
				if (f === undefined) continue;
				if ((!f.known || f.chain) && emitting()) out.push({ k: 'close' });
			}
		}
	};
	walk(src, 0);
	return out;
}

/** Extract h1-h6 tags in render order (components followed), respecting
 *  Svelte `{#if}` / `{:else if}` / `{:else}` / `{/if}` blocks so headings
 *  inside mutually-exclusive branches don't all count toward the
 *  multiple-h1 check.
 *
 *  - Level-jump: if branch A has h2 and branch B has h4, that's still a
 *    per-branch jump (h2→h4 with no h3 in EITHER branch). Flat sequence is fine.
 *  - Multiple-h1: branches are mutually exclusive at runtime, so we only
 *    flag if the SAME branch has multiple h1s. */
function extractHeadingsAndBranches(file: string): {
	flat: number[];
	branchH1Counts: number[];
	evs: Ev[];
} {
	const flat: number[] = [];
	const evs = events(file, 0, []);
	const branchPathStack: string[] = ['root'];
	let nextBranchId = 1;
	const h1Counts = new Map<string, number>();
	for (const ev of evs) {
		if (ev.k === 'h') {
			flat.push(ev.lvl);
			if (ev.lvl === 1) {
				const path = branchPathStack.join('>');
				h1Counts.set(path, (h1Counts.get(path) ?? 0) + 1);
			}
		} else if (ev.k === 'open') {
			branchPathStack.push(`b${nextBranchId++}`);
		} else if (ev.k === 'else') {
			branchPathStack[branchPathStack.length - 1] = `b${nextBranchId++}`;
		} else if (branchPathStack.length > 1) {
			branchPathStack.pop();
		}
	}
	return { flat, branchH1Counts: Array.from(h1Counts.values()), evs };
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

/** First heading that skips a level, following branches (see Rule 2). */
function firstLevelJump(evs: readonly Ev[]): { index: number; from: number; to: number } | null {
	let maxSeen = 0;
	// Per open block: [level at open, highest level reached by any branch so far].
	const blocks: Array<[number, number]> = [];
	let n = 0;
	for (const ev of evs) {
		if (ev.k === 'h') {
			n++;
			if (ev.lvl > maxSeen + 1) return { index: n, from: maxSeen, to: ev.lvl };
			if (ev.lvl > maxSeen) maxSeen = ev.lvl;
		} else if (ev.k === 'open') {
			blocks.push([maxSeen, maxSeen]);
		} else if (ev.k === 'else') {
			const b = blocks[blocks.length - 1];
			if (b !== undefined) {
				b[1] = Math.max(b[1], maxSeen);
				maxSeen = b[0];
			}
		} else {
			const b = blocks.pop();
			if (b !== undefined) maxSeen = Math.max(b[1], maxSeen);
		}
	}
	return null;
}

function audit(routes: readonly string[]): { results: PageHeadings[]; issues: Issue[] } {
	const results: PageHeadings[] = [];
	const issues: Issue[] = [];

	for (const abs of routes) {
		const rel = relative(REPO_ROOT, abs);
		if (ALLOW_LIST.has(rel)) continue;

		const { flat: levels, branchH1Counts, evs } = extractHeadingsAndBranches(abs);
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
		// sections) but flags h2-h4 (skipped h3).  Branch-aware:
		// a sibling `{:else}` branch starts from the level seen
		// before its `{#if}` (the branches never render together),
		// and after `{/if}` the highest level any branch reached
		// carries on.
		const jump = firstLevelJump(evs);
		if (jump !== null) {
			issues.push({
				file: rel,
				kind: 'level_jump',
				detail: `at heading #${jump.index}: jumped from level ${jump.from} to ${jump.to} (sequence: ${levels.join(', ')})`
			});
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

// ── Component following really runs (not only the page file) ─────
const HOME = join(ROUTES_DIR, '[lang]', '+page.svelte');
const homeOwn = (readFileSync(HOME, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, '').match(/<h[1-6]\b/g) ?? []).length;
const homeLevels = extractHeadingsAndBranches(HOME).flat;
const prioritiesLevels = events(join(WEB_ROOT, 'src/lib/components/PrioritiesSection.svelte'), 1, []).filter(
	(e) => e.k === 'h'
);

// ── Self-test on scratch components: the checker catches a component that
// jumps h1 → h3, and keeps only the branch a boolean prop selects. ─────────
function selfTest(): boolean {
	const dir = mkdtempSync(join(tmpdir(), 'heading-smoke-'));
	try {
		writeFileSync(join(dir, 'Cards.svelte'), '<ul>{#each xs as x}<li><h3>{x}</h3></li>{/each}</ul>');
		writeFileSync(
			join(dir, 'Variant.svelte'),
			"<script>let { embedded = false } = $props();</script>{#if embedded}<h3>a</h3>{:else}<h2>b</h2><h3>c</h3>{/if}"
		);
		writeFileSync(
			join(dir, 'Lazy.svelte'),
			"<script>const loadCards = () => import('./Cards.svelte').then((m) => m.default);</script>" +
				'<h1>t</h1>{#await loadCards() then Cards}<Cards />{/await}'
		);
		writeFileSync(join(dir, 'Good.svelte'), "<script>import Variant from './Variant.svelte';</script><h1>t</h1><Variant />");
		writeFileSync(
			join(dir, 'Bad.svelte'),
			"<script>import Variant from './Variant.svelte';</script><h1>t</h1><Variant embedded />"
		);
		const jump = (f: string) => firstLevelJump(events(join(dir, f), 0, []));
		return jump('Lazy.svelte') !== null && jump('Good.svelte') === null && jump('Bad.svelte') !== null;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── v1.20.0: the removed homepage heading stays removed ───────────────
// "What Morphit is built around" was removed (all 10 locales). Its key
// coming back in any locale, or any source referencing it, fails here.
const LOCALES_DIR = join(WEB_ROOT, 'src/lib/i18n/locales');
const localesWithHeading = readdirSync(LOCALES_DIR)
	.filter((f) => f.endsWith('.json'))
	.filter((f) => {
		const j = JSON.parse(readFileSync(join(LOCALES_DIR, f), 'utf8')) as {
			home?: { priorities?: Record<string, unknown> };
		};
		return j.home?.priorities !== undefined && 'heading' in j.home.priorities;
	});
const srcRefs: string[] = [];
(function scan(dir: string): void {
	for (const e of readdirSync(dir)) {
		const full = join(dir, e);
		if (statSync(full).isDirectory()) scan(full);
		else if (/\.(svelte|ts|js)$/.test(e) && /home\.priorities\.heading\b/.test(readFileSync(full, 'utf8')))
			srcRefs.push(relative(REPO_ROOT, full));
	}
})(join(WEB_ROOT, 'src'));

const scenarios = [
	{
		name: `components are followed: the homepage outline has ${homeLevels.length} headings, ${homeOwn} of them in +page.svelte (priority cards: ${prioritiesLevels.map((e) => (e.k === 'h' ? `h${e.lvl}` : '')).join(',')})`,
		ok: homeLevels.length > homeOwn && prioritiesLevels.length > 0
	},
	{
		name: 'self-test: a lazily-loaded component that jumps h1 → h3 is caught; a boolean prop picks the rendered branch',
		ok: selfTest()
	},
	{
		name: 'the removed homepage heading (home.priorities.heading) is in no locale and no source file',
		ok: localesWithHeading.length === 0 && srcRefs.length === 0
	},
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
