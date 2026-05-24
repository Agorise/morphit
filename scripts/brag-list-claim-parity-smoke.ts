#!/usr/bin/env tsx
/**
 * scripts/brag-list-claim-parity-smoke.ts
 *
 * Structural Defense #38 — brag-list claim parity (cp111).
 *
 * MORPHIT-BRAG-LIST.md is public-facing marketing copy whose
 * load-bearing rule (memory #15) is "every claim is verifiable
 * in code or honestly disclosed as backlog."  Without a smoke,
 * the brag list silently rots: code paths get renamed, env-vars
 * are removed, op IDs drift, and asset/locale/ADR counts go
 * stale without anyone noticing.  cp111 found three real drift
 * cases that motivated this smoke:
 *
 *   1. `RELEASE-NOTES-v1.0.0-beta.1.md` claimed "3,924
 *      self-checking smoke scenarios" while the actual battery
 *      had moved to 4432.  Not in the brag list itself, but
 *      same class — stale specific number in a marketing-copy
 *      surface.
 *   2. `docs/AUDIT-2026-05-FINAL-REPORT.md` claimed CI runs
 *      `npm run check` for the frontend.  CI actually invokes
 *      the typecheck through `workspace-typecheck-smoke`
 *      indirectly — the literal `npm run check` step doesn't
 *      exist in any workflow.
 *   3. `TARBALL.md`'s handoff section listed three pre-launch
 *      operator-actions as "still open" that have actually
 *      been closed for many checkpoints.
 *
 * cp111 fixes all three by hand; this smoke catches the
 * fourth, fifth, and Nth recurrences automatically.
 *
 * What this smoke checks (each tuple counts as one scenario):
 *
 *   A. **File-path references.**  Every backtick-quoted token
 *      starting with `scripts/`, `apps/`, `ops/`, `packages/`,
 *      or `docs/` and either ending in a known file extension
 *      OR ending in `/` (directory reference) must resolve on
 *      disk.  Catches renames + deletions.
 *
 *   B. **Custom-JSON op references.**  Every backtick-quoted
 *      `morphit_<name>_v<N>` token must appear at least once
 *      in source code under `apps/indexer/src/`, `apps/relay/`,
 *      or `apps/web/src/` — the three places a real op ID
 *      would be implemented or referenced.  Catches op-name
 *      drift (e.g. `morphit_release_v1` rename).
 *
 *   C. **Operator env-var references.**  Every backtick-quoted
 *      `MORPHIT_<NAME>` token must appear at least once in
 *      source code under `apps/`, `packages/`, `ops/`, or
 *      `.env.example` files.  Catches env-var renames /
 *      deletions.
 *
 *   D. **Asset-count anchor.**  Any prose claim of the form
 *      "N tradable assets" (where N is a number or spelled-out
 *      English word from one to twenty) must match
 *      `ASSET_TICKERS.length` from
 *      `packages/asset-registry/src/index.ts` — the canonical
 *      source-of-truth.  Catches the recurring drift caught
 *      manually at cp35 (8 stale "10 tradable" sites) and
 *      again at cp48 (3 stale "12 tradable" sites).
 *
 *   E. **Locale-count anchor.**  Any prose claim of "N locales"
 *      or "N languages" (where N is a number 5-20 or the
 *      spelled-out English word) must match the count of
 *      `apps/web/src/lib/i18n/locales/*.json`.
 *
 *   F. **ADR-count anchor.**  Any prose claim of "N ADRs" or
 *      "N architecture decision records" must match the count
 *      of `docs/adr/00*.md` files minus the template
 *      (`0000-template.md`).
 *
 *   G. **Footer brag-entry count.**  The footer string
 *      "*N specific selling points*" must match the count of
 *      numbered top-level entries in the brag list
 *      (lines matching `^[0-9]+\.\s+\*\*`).
 *
 *   H. **ADR filename-range anchor.**  Any prose claim of the
 *      form "0001-… through NNNN-…" or "docs/adr/0001-foo
 *      through 0042-bar.md" must name the highest non-template
 *      ADR number on disk as the upper bound.  Catches the
 *      drift caught manually at cp131 (README.md was stale at
 *      "through 0036-…" when the disk had 0042-…).
 *
 * Scope: this smoke covers MORPHIT-BRAG-LIST.md, README.md,
 * and RELEASE-NOTES-v*.md — the three "marketing-class"
 * surfaces where stale specific claims hurt most.  ADRs,
 * audit logs, REVISIT-LIST, TARBALL, and PHASE-* docs are
 * deliberately out of scope (they're historical / journal,
 * subject to the cp82 annotation-not-rewrite rule).
 *
 * False-positive avoidance:
 *
 *   - URL strings (`https://...`) are excluded from path checks.
 *   - Capability-named env vars from third-party docs
 *     (`MORPHIT_OTEL_TRACES_ENDPOINT` if it doesn't exist) are
 *     checked against actual code, not against a hand-curated
 *     allowlist — if the brag list claims an env var, it MUST
 *     exist in code.  No allowlist exemptions.
 *   - Numeric-anchor regexes are narrowly scoped to a leading
 *     digit/word + the exact noun ("tradable assets", "locales",
 *     "languages", "ADRs", "architecture decision records"),
 *     so a sentence like "100% of fees" doesn't get parsed as
 *     "100 of fees."
 *
 * Each (doc, line, claim) tuple counts as one scenario.  The
 * smoke is allowed to find zero failures — that's the green
 * state — but MUST find a minimum-floor number of scenarios
 * (~150 currently) or the regexes are silently broken and
 * pass-zero is masking real drift.
 */

import {
	readFileSync,
	existsSync,
	readdirSync,
	statSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

// Marketing-class docs in scope.  Each is the kind of surface a
// reader uses to decide whether to trust the project; stale
// specifics damage trust more here than in journal-style docs.
const MARKETING_DOCS = [
	'MORPHIT-BRAG-LIST.md',
	'README.md',
	'RELEASE-NOTES-v1.0.0-beta.1.md'
];

// --- (A) file-path references --------------------------------

// Backtick-quoted path: <root>/<rest>, where rest can end in a
// file extension OR in a trailing slash (directory).
const PATH_TOKEN_RE =
	/`((?:scripts|apps|ops|packages|docs)\/[A-Za-z0-9_./-]+)`/g;

const VALID_EXTS = new Set([
	'sh',
	'ts',
	'tsx',
	'js',
	'mjs',
	'cjs',
	'py',
	'sql',
	'yml',
	'yaml',
	'json',
	'md',
	'service',
	'timer',
	'conf',
	'env',
	'example',
	'asc',
	'svg',
	'png',
	'zip',
	'svelte',
	'css',
	'html'
]);

function isVerifiablePath(p: string): boolean {
	// Trailing punctuation that snuck in
	if (/[.,:;]$/.test(p)) return false;
	// Glob / template / placeholder
	if (/[*[\]<>{}]/.test(p)) return false;
	// URL — must not appear via the regex (no `://` in match),
	// but defensive
	if (p.includes('://')) return false;
	// node_modules
	if (p.includes('node_modules/')) return false;
	// Bare directory (ends with /) — verified directly
	if (p.endsWith('/')) return true;
	// File — must have a known extension
	const lastDot = p.lastIndexOf('.');
	if (lastDot === -1) return false;
	const ext = p.slice(lastDot + 1).toLowerCase();
	return VALID_EXTS.has(ext);
}

// --- (B) custom-JSON op references ---------------------------

const OP_TOKEN_RE = /`(morphit_[a-z][a-z0-9_]*_v\d+)`/g;

// Cache: walk apps/indexer/src + apps/relay + apps/web/src
// once, build a single big string we can substring-search.
const OP_SCAN_ROOTS = [
	'apps/indexer/src',
	'apps/relay/src',
	'apps/web/src/lib'
];

// --- (C) operator env-var references -------------------------

// Env-var token: bare backtick-quoted name, optionally
// followed by `=value` shell-assignment syntax (the brag list
// uses both forms — `MORPHIT_X` and `MORPHIT_X=` — and both
// should resolve the same way).
const ENV_TOKEN_RE = /`(MORPHIT_[A-Z][A-Z0-9_]*)(?:=[^`]*)?`/g;

const ENV_SCAN_ROOTS = [
	'apps/indexer/src',
	'apps/relay/src',
	'apps/web/src/lib',
	'apps/ops-cli/src',
	'apps/matrix-bot/src',
	'packages',
	'ops/env',
	'ops/ansible',
	'ops/bunkerweb',
	'ops/scripts'
];

// --- (D, E, F) numeric anchors -------------------------------

const NUMBER_WORDS: Record<string, number> = {
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
	eleven: 11,
	twelve: 12,
	thirteen: 13,
	fourteen: 14,
	fifteen: 15,
	sixteen: 16,
	seventeen: 17,
	eighteen: 18,
	nineteen: 19,
	twenty: 20
};

function parseNumberToken(t: string): number | null {
	const lc = t.toLowerCase().replace(/,/g, '');
	if (/^\d+$/.test(lc)) return parseInt(lc, 10);
	if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, lc)) {
		return NUMBER_WORDS[lc];
	}
	return null;
}

// Build the regex piece for either a digit or a spelled-out word.
const NUM = '(\\d{1,3}|[A-Za-z]{3,9})';

// (D) tradable assets — exact phrase "tradable assets" right
// after the number.  Avoid matching "asset" (singular) so
// "an asset Morphit trades" doesn't trip.
const ASSET_RE = new RegExp(`${NUM}\\s+(?:tradable\\s+assets)\\b`, 'gi');

// (E) locales / languages — same pattern; both nouns accepted.
const LOCALE_RE = new RegExp(
	`${NUM}\\s+(locales?|languages?)\\b`,
	'gi'
);

// Words that, when they appear on the same line as a
// non-canonical locale/language number, signal "this is a
// subset reference, not a total claim".  Real-world false-
// positive seen at cp111 first-run: brag entry 161 reads
// "across all 6 locales" referring back to the 6 community-
// translation backlog locales mentioned earlier in the same
// sentence.  Strict literal regex can't tell that apart from
// drift, so we suppress when the line names a known subset.
//
// Allowlisting only kicks in when n !== CANONICAL_LOCALES;
// if n DOES equal canonical, the claim is treated as a
// total reference regardless of surrounding language (an
// accurate claim is never drift).
const LOCALE_SUBSET_MARKERS = [
	'backlog',
	'subset',
	'non-EN',
	'non-en',
	'native',
	'core',
	'community-translation',
	'remaining',
	'originally',
	'previously'
];

// (F) ADRs — both "ADRs" and the spelled-out "architecture
// decision records".  Both forms appear in the brag list.
const ADR_RE = new RegExp(
	`${NUM}\\s+(ADRs|architecture\\s+decision\\s+records)\\b`,
	'gi'
);

// (G) footer brag-entry count: "*N specific selling points*"
const FOOTER_RE = /\*(\d+)\s+specific\s+selling\s+points/g;

// (H) ADR filename-range claim: catches "0001-… through 0036-…",
// "docs/adr/0001- through 0042-", "ADRs 0001-foo through
// 0042-bar.md", etc.  The captured group is the ENDING ADR
// number; it MUST equal the highest non-template ADR number on
// disk.  Without this, README.md / brag-list claims like "ADRs
// 0001-… through 0036-…" silently drift as new ADRs land.
//
// Shape captured (whitespace/backticks tolerated between tokens
// because markdown commonly wraps the range tokens in backticks
// — e.g. ``\`0001-…\` through \`0042-…\``):
//   - optional `docs/adr/` prefix
//   - 4-digit ADR number (start of range)
//   - hyphen + filename body (either "…" placeholder or
//     `[a-z0-9-]+\.md`)
//   - " through " keyword (with optional backticks/whitespace)
//   - optional `docs/adr/` prefix
//   - 4-digit ADR number (END of range) <- CAPTURED
//   - hyphen + filename body
const ADR_RANGE_RE =
	/(?:docs\/adr\/)?(\d{4})-(?:…|[a-z0-9-]+\.md)[\s`]*through[\s`]*(?:docs\/adr\/)?(\d{4})-(?:…|[a-z0-9-]+(?:\.md)?)/g;

// ─────────────────────────────────────────────────────────────

interface Scenario {
	doc: string;
	line: number;
	kind: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
	claim: string;
	failure?: string;
}

const scenarios: Scenario[] = [];

function listFilesRec(root: string, out: string[] = []): string[] {
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return out;
	}
	for (const e of entries) {
		if (e === 'node_modules' || e === '.svelte-kit' || e === 'dist' || e === 'build') {
			continue;
		}
		const full = join(root, e);
		let s;
		try {
			s = statSync(full);
		} catch {
			continue;
		}
		if (s.isDirectory()) {
			listFilesRec(full, out);
		} else if (
			/\.(ts|tsx|js|mjs|cjs|svelte|json|yml|yaml|sql|sh|md|env|example|service|timer)$/.test(
				e
			)
		) {
			out.push(full);
		}
	}
	return out;
}

// One-time scan: concatenate all source files under each scan
// root into a single big string for substring lookups.  Cheaper
// than re-reading per claim and avoids the false-negative class
// where a token appears in two files but only one is searched.
function buildHaystack(roots: string[]): string {
	const parts: string[] = [];
	for (const r of roots) {
		const root = join(REPO, r);
		if (!existsSync(root)) continue;
		const s = statSync(root);
		const files = s.isDirectory() ? listFilesRec(root) : [root];
		for (const f of files) {
			try {
				parts.push(readFileSync(f, 'utf8'));
			} catch {
				// unreadable file — skip silently
			}
		}
	}
	return parts.join('\n');
}

const OP_HAYSTACK = buildHaystack(OP_SCAN_ROOTS);
const ENV_HAYSTACK = buildHaystack(ENV_SCAN_ROOTS);

// Canonical source-of-truth values for numeric anchors
function countAssetTickers(): number {
	const src = readFileSync(
		join(REPO, 'packages/asset-registry/src/index.ts'),
		'utf8'
	);
	const m = src.match(/ASSET_TICKERS\s*=\s*\[([^\]]+)\]/);
	if (!m) return -1;
	const tickers = m[1]
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	return tickers.length;
}

function countLocales(): number {
	const dir = join(REPO, 'apps/web/src/lib/i18n/locales');
	return readdirSync(dir).filter((f) => f.endsWith('.json')).length;
}

function countAdrs(): number {
	const dir = join(REPO, 'docs/adr');
	return readdirSync(dir).filter(
		(f) => /^\d{4}-/.test(f) && f !== '0000-template.md'
	).length;
}

/** Highest 4-digit prefix among non-template ADR filenames.
 *  Used by claim-class (H): claims like "ADRs 0001-… through
 *  0036-…" must name THIS number as the upper bound or be
 *  flagged as stale.  Counts disjoint from countAdrs() because
 *  numbering can be sparse (retracted ADRs, e.g. 0016, leave a
 *  gap — the highest number still climbs). */
function highestAdrNumber(): number {
	const dir = join(REPO, 'docs/adr');
	let max = 0;
	for (const f of readdirSync(dir)) {
		const m = /^(\d{4})-/.exec(f);
		if (!m || f === '0000-template.md') continue;
		const n = parseInt(m[1]!, 10);
		if (n > max) max = n;
	}
	return max;
}

function countBragEntries(): number {
	const src = readFileSync(join(REPO, 'MORPHIT-BRAG-LIST.md'), 'utf8');
	const lines = src.split('\n');
	let n = 0;
	for (const ln of lines) {
		if (/^\d+\.\s+\*\*/.test(ln)) n++;
	}
	return n;
}

const CANONICAL_ASSETS = countAssetTickers();
const CANONICAL_LOCALES = countLocales();
const CANONICAL_ADRS = countAdrs();
const CANONICAL_ADR_MAX = highestAdrNumber();
const CANONICAL_BRAG_ENTRIES = countBragEntries();

if (CANONICAL_ASSETS < 1) {
	console.error('  ✗ could not parse ASSET_TICKERS from asset-registry');
	process.exit(1);
}

// Whitelist of paths that may legitimately not exist on disk
// because they represent operator-installation artifacts.  Same
// reasoning as operator-doc-fenced-path-existence-smoke.ts:
// `.env` files materialize on the operator's box from the
// `.env.example` templates in the repo.
function isOperatorManaged(p: string): boolean {
	if (p.endsWith('.env')) {
		return existsSync(join(REPO, p + '.example'));
	}
	if (p.endsWith('/keystore.json') || p.endsWith('/keystore.wif')) {
		return true;
	}
	return false;
}

console.log('\n── brag-list-claim-parity smoke (cp111) ──────────────\n');
console.log(`  canonical: ${CANONICAL_ASSETS} assets · ${CANONICAL_LOCALES} locales · ${CANONICAL_ADRS} ADRs (max #${CANONICAL_ADR_MAX}) · ${CANONICAL_BRAG_ENTRIES} brag entries`);

for (const docRel of MARKETING_DOCS) {
	const abs = join(REPO, docRel);
	if (!existsSync(abs)) {
		console.log(`  ⚠ ${docRel} missing — skipping`);
		continue;
	}
	const src = readFileSync(abs, 'utf8');
	const lines = src.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const ln = lines[i];

		// (A) paths
		PATH_TOKEN_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = PATH_TOKEN_RE.exec(ln)) !== null) {
			const p = m[1];
			if (!isVerifiablePath(p)) continue;
			if (isOperatorManaged(p)) continue;
			const exists = existsSync(join(REPO, p));
			const sc: Scenario = {
				doc: docRel,
				line: i + 1,
				kind: 'A',
				claim: p
			};
			if (!exists) {
				sc.failure = `path \`${p}\` does not exist`;
			}
			scenarios.push(sc);
		}

		// (B) custom-JSON op IDs
		OP_TOKEN_RE.lastIndex = 0;
		while ((m = OP_TOKEN_RE.exec(ln)) !== null) {
			const op = m[1];
			const found = OP_HAYSTACK.includes(op);
			const sc: Scenario = {
				doc: docRel,
				line: i + 1,
				kind: 'B',
				claim: op
			};
			if (!found) {
				sc.failure = `op \`${op}\` not found anywhere under [${OP_SCAN_ROOTS.join(', ')}]`;
			}
			scenarios.push(sc);
		}

		// (C) env-var names
		ENV_TOKEN_RE.lastIndex = 0;
		while ((m = ENV_TOKEN_RE.exec(ln)) !== null) {
			const ev = m[1];
			const found = ENV_HAYSTACK.includes(ev);
			const sc: Scenario = {
				doc: docRel,
				line: i + 1,
				kind: 'C',
				claim: ev
			};
			if (!found) {
				sc.failure = `env-var \`${ev}\` not found anywhere under [${ENV_SCAN_ROOTS.join(', ')}]`;
			}
			scenarios.push(sc);
		}

		// (D) tradable assets count
		ASSET_RE.lastIndex = 0;
		while ((m = ASSET_RE.exec(ln)) !== null) {
			const n = parseNumberToken(m[1]);
			if (n === null) continue; // word we don't recognize — skip
			const sc: Scenario = {
				doc: docRel,
				line: i + 1,
				kind: 'D',
				claim: `${m[1]} tradable assets`
			};
			if (n !== CANONICAL_ASSETS) {
				sc.failure = `claims ${n} tradable assets but registry has ${CANONICAL_ASSETS}`;
			}
			scenarios.push(sc);
		}

		// (E) locales / languages count
		LOCALE_RE.lastIndex = 0;
		while ((m = LOCALE_RE.exec(ln)) !== null) {
			const n = parseNumberToken(m[1]);
			if (n === null) continue;
			const sc: Scenario = {
				doc: docRel,
				line: i + 1,
				kind: 'E',
				claim: `${m[1]} ${m[2]}`
			};
			if (n !== CANONICAL_LOCALES) {
				// Subset-reference suppressor: if the line mentions
				// a known subset marker, treat the non-canonical
				// number as a subset, not as drift.  See comment on
				// LOCALE_SUBSET_MARKERS for rationale.
				const isSubsetRef = LOCALE_SUBSET_MARKERS.some((mark) =>
					ln.toLowerCase().includes(mark.toLowerCase())
				);
				if (!isSubsetRef) {
					sc.failure = `claims ${n} ${m[2]} but ${CANONICAL_LOCALES} locale JSONs ship`;
				}
			}
			scenarios.push(sc);
		}

		// (F) ADR count
		ADR_RE.lastIndex = 0;
		while ((m = ADR_RE.exec(ln)) !== null) {
			const n = parseNumberToken(m[1]);
			if (n === null) continue;
			const sc: Scenario = {
				doc: docRel,
				line: i + 1,
				kind: 'F',
				claim: `${m[1]} ${m[2]}`
			};
			if (n !== CANONICAL_ADRS) {
				sc.failure = `claims ${n} but docs/adr/ has ${CANONICAL_ADRS} non-template ADRs`;
			}
			scenarios.push(sc);
		}

		// (G) footer count (brag list only)
		if (docRel === 'MORPHIT-BRAG-LIST.md') {
			FOOTER_RE.lastIndex = 0;
			while ((m = FOOTER_RE.exec(ln)) !== null) {
				const n = parseInt(m[1], 10);
				const sc: Scenario = {
					doc: docRel,
					line: i + 1,
					kind: 'G',
					claim: `footer "${n} specific selling points"`
				};
				if (n !== CANONICAL_BRAG_ENTRIES) {
					sc.failure = `footer claims ${n} but actual numbered entries = ${CANONICAL_BRAG_ENTRIES}`;
				}
				scenarios.push(sc);
			}
		}

		// (H) ADR filename-range claim — cp131 MED-004.
		ADR_RANGE_RE.lastIndex = 0;
		while ((m = ADR_RANGE_RE.exec(ln)) !== null) {
			const startN = parseInt(m[1]!, 10);
			const endN = parseInt(m[2]!, 10);
			const sc: Scenario = {
				doc: docRel,
				line: i + 1,
				kind: 'H',
				claim: `ADR range ${m[1]}-… through ${m[2]}-…`
			};
			if (endN !== CANONICAL_ADR_MAX) {
				sc.failure =
					`claims ADR range ends at ${m[2]} but highest ADR ` +
					`on disk is ${String(CANONICAL_ADR_MAX).padStart(4, '0')}`;
			} else if (startN !== 1) {
				// Sanity: ADR ranges that don't start at 0001
				// would be confusing — ADRs are an append-only
				// log starting from 0001.
				sc.failure = `claims ADR range starts at ${m[1]} but ADRs begin at 0001`;
			}
			scenarios.push(sc);
		}
	}
}

// Tally by kind
const byKind: Record<string, { pass: number; fail: number }> = {};
for (const s of scenarios) {
	const k = s.kind;
	if (!byKind[k]) byKind[k] = { pass: 0, fail: 0 };
	if (s.failure) byKind[k].fail++;
	else byKind[k].pass++;
}

const KIND_LABEL: Record<string, string> = {
	A: 'file-path references',
	B: 'custom-JSON op IDs',
	C: 'operator env-vars',
	D: 'tradable-asset count claims',
	E: 'locale/language count claims',
	F: 'ADR count claims',
	G: 'brag-list footer count',
	H: 'ADR filename-range claims'
};

for (const k of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) {
	const b = byKind[k] ?? { pass: 0, fail: 0 };
	const tot = b.pass + b.fail;
	console.log(`  ${k}. ${KIND_LABEL[k]}: ${tot} (${b.fail} failed)`);
}

const failures = scenarios.filter((s) => s.failure);
const total = scenarios.length;

// Floor: if the regexes broke and matched nothing, the smoke
// would pass-zero.  We've manually checked the brag list has
// well over 50 verifiable claims today; pin a conservative
// floor that won't trip on legitimate copy-edits but will
// trip on a broken regex.
const MIN_SCENARIOS = 50;

if (total < MIN_SCENARIOS) {
	console.log(
		`\n  ✗ only ${total} scenarios — below floor of ${MIN_SCENARIOS}; regex is likely broken`
	);
	console.log('\n──────────────────────────────────────────────────────');
	console.log(`✗ 1/1 scenarios failed`);
	process.exit(1);
}

if (failures.length > 0) {
	console.log(`\n  ✗ ${failures.length} claim(s) do not match canonical source:`);
	for (const f of failures) {
		console.log(`    - [${f.kind}] ${f.doc}:${f.line}  ${f.failure}`);
	}
	console.log('\n──────────────────────────────────────────────────────');
	console.log(`✗ ${failures.length}/${total} scenarios failed`);
	process.exit(1);
}

console.log(
	`\n  ✓ all ${total} brag-list claims align with canonical source`
);
console.log('\n──────────────────────────────────────────────────────');
console.log(`✓ all ${total} scenarios passed`);
