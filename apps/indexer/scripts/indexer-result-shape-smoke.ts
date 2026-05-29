/**
 * Static-analysis smoke: Indexer-Result-shape antipattern detector.
 *
 * BATCH19D-result-shape (audit doc Part 19) caught ~16 production
 * code paths reading `result.value` (instead of `result.data`) or
 * `result.error.kind` (instead of `result.code`) on indexer-Result
 * types — undefined at runtime, silent breakage.  The bug shipped
 * because `tsc --noEmit` cannot resolve SvelteKit aliases without
 * a generated `.svelte-kit/tsconfig.json`, and the smoke runner
 * does not run `svelte-kit sync` before tsc.
 *
 * This smoke is the cheap regression guard: it scans every file
 * that imports from `$indexer/client` (or the relative path), and
 * fails if it finds `.value` / `.error.kind` access on a binding
 * that came from one of the indexer-client API functions.
 *
 * False-positive avoidance: we explicitly skip files that
 * additionally import from any of the modules whose Result types
 * legitimately use `.value` (`runWithActiveKey`, release-fetch /
 * release-validate / hash-check, AvatarResult, sanitizeSvg).  We
 * do NOT try to disambiguate per-binding inside a file that has
 * BOTH kinds of Result types — those files should be reviewed
 * manually.  Today there are zero such files; the smoke prints a
 * warning if one appears so the maintainer can add explicit
 * disambiguation.
 *
 * Output: exit-code-0 and a count of clean files; exit-code-1 +
 * concrete findings (file:line:col + offending text) on any hit.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Script is at apps/indexer/scripts/, repo root is 3 up.
const REPO = join(__dirname, '..', '..', '..');
const WEB_SRC = join(REPO, 'apps/web/src');

// Modules whose Result-shaped types legitimately use `.value` —
// files importing from any of these are excluded from the
// `result.value` check (because there's no way to tell, by grep
// alone, which `.value` is on which Result).
const VALUE_LEGITIMATE_IMPORTS = [
	'$crypto/runWithActiveKey',
	'$net/releaseFetch',
	'@morphit/release-schema',
	'$net/releaseHashCheck',
	'$lib/avatar',
	'sanitizeSvg',
	'$avatar/sanitize'
];

// Modules whose Result-shaped types legitimately use `.error` /
// `.kind` discriminator — `r.error.kind` may be valid on these.
const ERROR_KIND_LEGITIMATE_IMPORTS = [
	'$stores/release',
	'$net/releaseFetch',
	'@morphit/release-schema',
	'$net/releaseHashCheck'
];

// Per-binding allowlist.  Some named bindings legitimately carry
// a `.value` field even though their containing file imports from
// $indexer/client.  E.g. `loadDraftWithMeta()` returns
// `{ value: T; meta: DraftMeta }`, so a binding like `saved` /
// `draft` whose value comes from that call has a real `.value`
// property.  When we see `<binding>.value.X` and the same file
// has a call `loadDraftWithMeta(...)` that assigns to
// `<binding>`, we suppress.
//
// The check is a cheap source-text proximity heuristic, not real
// data-flow analysis — but it's sufficient for the codebase's
// idioms: if `loadDraftWithMeta` is called and a binding name
// `saved` / `draft` is `.value`-accessed on a nearby line, it's
// almost certainly the draft API, not an indexer Result.
const PER_BINDING_VALUE_LEGIT_CALLERS: ReadonlyArray<{
	api: string;
	bindings: readonly string[];
}> = [{ api: 'loadDraftWithMeta', bindings: ['saved', 'draft'] }];

// Pattern: ANY identifier . value followed by a property access
// or end-of-token.  We deliberately match all bindings (not just
// `result|res|r`) because real call sites use domain-specific
// names like `received`, `given`, `existing`, etc.  False
// positives are filtered downstream by:
//   1. The file must import from $indexer/client (else skipped).
//   2. The file must NOT import from a $value-legitimate module
//      (runWithActiveKey, releaseFetch, etc.).
//   3. The binding must NOT be in the per-binding allowlist when
//      the file calls a known legitimate-value API.
//   4. The line must NOT match common DOM/state false-positives
//      handled inline (HTMLInputElement.value, $state etc.).
const VALUE_RE = /\b([A-Za-z_$][\w$]*)\.value(?:\b|\.)/g;
const ERROR_KIND_RE = /\b([A-Za-z_$][\w$]*)\.error\.kind\b/g;

// Lines we treat as guaranteed-not-an-indexer-Result.  Cheap
// substring exclusions for the common DOM and Svelte-rune false
// positives.
const FALSE_POSITIVE_SUBSTRINGS: readonly string[] = [
	// DOM input value (e.g. e.target.value, input.value)
	'.target.value',
	'(target as ',
	'currentTarget.value',
	// Svelte 5 runes
	'$state(',
	'$derived(',
	'$props(',
	'$bindable(',
	// Generic patterns where `.value` is a legitimate field name
	// of a non-Result type — these are ones we've already audited.
	'fetchResult.value', // ReleaseFetchResult — checked
	'sanitizeSvg' // Returns { ok, value } — checked
];

// Pattern that says "this file imports from indexer/client".  We
// match the alias forms ($indexer/client and $lib/indexer/client)
// and the relative form.  $ is a regex metachar so we escape it.
const INDEXER_IMPORT_RE =
	/from\s+['"](?:\$indexer\/client|\$lib\/indexer\/client|\.\.?\/[^'"]*indexer\/client)['"]/;

interface Finding {
	file: string;
	line: number;
	col: number;
	kind: 'value' | 'error_kind';
	excerpt: string;
}

async function* walk(dir: string): AsyncGenerator<string> {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const e of entries) {
		const full = join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === 'node_modules' || e.name === '.svelte-kit' || e.name === '.git') continue;
			yield* walk(full);
		} else if (e.isFile()) {
			if (full.endsWith('.ts') || full.endsWith('.svelte')) yield full;
		}
	}
}

async function main(): Promise<void> {
	const findings: Finding[] = [];
	const ambiguousFiles: string[] = [];
	let scanned = 0;
	let candidate = 0;

	for await (const file of walk(WEB_SRC)) {
		if (file.endsWith('.test.ts') || file.endsWith('.spec.ts')) continue;
		const src = await readFile(file, 'utf8');
		scanned++;
		if (!INDEXER_IMPORT_RE.test(src)) continue;
		candidate++;

		const importsLegitValue = VALUE_LEGITIMATE_IMPORTS.some((m) => src.includes(m));
		const importsLegitErrorKind = ERROR_KIND_LEGITIMATE_IMPORTS.some((m) => src.includes(m));

		if (importsLegitValue && importsLegitErrorKind) {
			ambiguousFiles.push(file);
			// Skip — can't disambiguate with grep alone; the
			// maintainer must either split this file or add
			// explicit type annotations on the offending bindings.
			continue;
		}

		// Build the per-file binding-allowlist.  If the file calls
		// a legitimate-`.value` API, suppress matches on the
		// associated bindings.  We check `api(` and `api<` to handle
		// generic call forms like `loadDraftWithMeta<T>(...)`.
		const allowedValueBindings = new Set<string>();
		for (const { api, bindings } of PER_BINDING_VALUE_LEGIT_CALLERS) {
			if (src.includes(api + '(') || src.includes(api + '<')) {
				for (const b of bindings) allowedValueBindings.add(b);
			}
		}

		const lines = src.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? '';

			// Cheap line-level false-positive filter.  Avoids running
			// the regex on lines that obviously aren't indexer-Result
			// access.
			const skipLine = FALSE_POSITIVE_SUBSTRINGS.some((s) => line.includes(s));

			if (!importsLegitValue && !skipLine) {
				let m: RegExpExecArray | null;
				VALUE_RE.lastIndex = 0;
				while ((m = VALUE_RE.exec(line))) {
					const binding = m[1] ?? '';
					if (allowedValueBindings.has(binding)) continue;
					findings.push({
						file: file.replace(REPO, ''),
						line: i + 1,
						col: m.index + 1,
						kind: 'value',
						excerpt: line.trim().slice(0, 120)
					});
				}
			}

			if (!importsLegitErrorKind) {
				let m: RegExpExecArray | null;
				ERROR_KIND_RE.lastIndex = 0;
				while ((m = ERROR_KIND_RE.exec(line))) {
					findings.push({
						file: file.replace(REPO, ''),
						line: i + 1,
						col: m.index + 1,
						kind: 'error_kind',
						excerpt: line.trim().slice(0, 120)
					});
				}
			}
		}
	}

	console.log(`Scanned ${scanned} files, ${candidate} import from $indexer/client.`);
	if (ambiguousFiles.length > 0) {
		console.warn(
			`WARNING: ${ambiguousFiles.length} file(s) import BOTH indexer-client and a $value-Result module — manual review required:`
		);
		for (const f of ambiguousFiles) console.warn('  - ' + f.replace(REPO, ''));
	}
	if (findings.length > 0) {
		console.error(`\nFAIL: ${findings.length} indexer-Result shape misuse(s):\n`);
		for (const f of findings) {
			const want = f.kind === 'value' ? '.data' : '.code';
			console.error(`  ${f.file}:${f.line}:${f.col}  →  use ${want} instead`);
			console.error(`    ${f.excerpt}`);
		}
		console.error(
			'\nIndexer-client Result type is `{ ok:true, data:T } | { ok:false, code, message }`.\n' +
				'Read `data` on success, `code`/`message` on failure.\n'
		);
		process.exit(1);
	}
	console.log(`OK: 0 indexer-Result-shape misuses across ${candidate} candidate file(s).`);
	// Runner protocol: scenario count signaled via `✓ all N`.  Each
	// candidate file scanned counts as one scenario.
	console.log(`✓ all ${candidate} scenarios passed`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
