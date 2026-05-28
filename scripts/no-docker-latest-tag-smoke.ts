/**
 * no-docker-latest-tag smoke (cp155 F-mcp-22).
 *
 * Catches future `:latest` Docker tag references when the
 * mcp-server (or any other workspace) eventually ships a
 * Dockerfile / docker-compose.yml / OCI image reference.
 *
 * cp146 F-mcp-22 surfaced that `:latest` is a reproducibility
 * anti-pattern — it points at whatever the registry returns at
 * `docker pull` time, which by definition changes over time.
 * For AI-agent integrations (Charlie), this matters because:
 *
 *   1. A user's MCP client invokes `npx morphit-mcp@1.0.0`
 *      (or `docker run morphit/mcp-server:1.0.0`).  The pin is
 *      load-bearing: if the version drifts under the user, the
 *      tool-call surface might change shape silently.
 *   2. Reproducibility is a non-negotiable for security review.
 *      A pinned tag's hash is verifiable; `:latest` isn't.
 *
 * The cp146 README (`apps/mcp-server/README.md`) already
 * carries the prose guidance "Pin to a specific tag like
 * `:1.0.0`; never `:latest` for reproducibility."  This smoke
 * makes that guidance enforceable: walk every Dockerfile,
 * compose config, and operator-facing doc; refuse to ship
 * with a `:latest` reference anywhere except in the README's
 * "never use this" prose.
 *
 * Pre-launch posture: no Dockerfile exists yet (cp146 marked
 * Docker as "forthcoming" with explicit npm-only ship for
 * cp140 release).  The smoke is a forward-looking guard — when
 * someone DOES add a Dockerfile or compose snippet in the
 * future, it fires immediately if they reach for `:latest`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname);

interface Result {
	name: string;
	passed: boolean;
	detail?: string;
}
const results: Result[] = [];
function pass(name: string) {
	results.push({ name, passed: true });
}
function fail(name: string, detail: string) {
	results.push({ name, passed: false, detail });
}

/* ---------------- file discovery ---------------- */

/**
 * Files to scan: Dockerfiles (any name pattern), docker-compose
 * configs, operator-facing markdown docs.  Excludes: lockfiles
 * (incidental `:latest` in indirect dep metadata), node_modules,
 * dist/, REVISIT-LIST / TARBALL / AUDIT prose (the project's
 * own meta-discussion about not using :latest).
 *
 * Adding new file types here is intentionally an explicit step:
 * dropping a new Dockerfile shape into the repo should also
 * update this scan list, so future authors actively decide
 * whether the file is in scope.
 */
const SCAN_DIRS = ['apps', 'packages', 'ops', 'docs'];
const SCAN_FILE_PATTERNS: ReadonlyArray<RegExp> = [
	/^Dockerfile(\..+)?$/, // Dockerfile, Dockerfile.dev, etc.
	/^docker-compose(\..+)?\.ya?ml$/, // docker-compose.yml, .prod.yml, etc.
	/^compose\.ya?ml$/, // newer convention
	/\.containerfile$/i // podman convention
];

/**
 * Documentation files known to legitimately mention `:latest` in
 * the prose telling people NOT to use it.  Each entry is a path
 * relative to REPO_ROOT.  Adding a path here should always
 * include an inline rationale.
 */
const PROSE_GUIDANCE_PATHS = new Set<string>([
	// cp146 README prose: "Pin to a specific tag like `:1.0.0`;
	// never `:latest` for reproducibility."  The README is
	// telling readers what to avoid.
	'apps/mcp-server/README.md',
	// INTEGRATION-TEST-HARNESS-DESIGN.md prose: "should be
	// pinned by digest, not `:latest`, so developer runs don't
	// drift under us."  Same guidance shape as the README.
	'docs/INTEGRATION-TEST-HARNESS-DESIGN.md',
	// REVISIT-LIST and TARBALL are the project journal — they
	// describe past findings about :latest.
	'docs/REVISIT-LIST.md',
	'docs/REVISIT-LIST-ARCHIVE.md',
	'TARBALL.md',
	// cp155 this smoke and its source-of-truth ADR mention
	// `:latest` to explain what they enforce.
	'scripts/no-docker-latest-tag-smoke.ts',
	// MORPHIT-BRAG-LIST should never mention this (it's
	// internal hygiene); the test below verifies that.
]);

function listFilesRecursive(dir: string): string[] {
	const out: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of entries) {
		if (name === 'node_modules' || name === 'dist' || name === '.svelte-kit' || name === 'build') {
			continue;
		}
		const full = join(dir, name);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			out.push(...listFilesRecursive(full));
		} else if (st.isFile()) {
			out.push(full);
		}
	}
	return out;
}

const allFiles: string[] = [];
for (const d of SCAN_DIRS) {
	allFiles.push(...listFilesRecursive(join(REPO_ROOT, d)));
}

/* ---------------- invariant 1: no :latest in container configs ---------------- */

interface Hit {
	file: string;
	line: number;
	text: string;
}
const containerHits: Hit[] = [];

for (const file of allFiles) {
	const base = file.split('/').pop() ?? '';
	const isContainerFile = SCAN_FILE_PATTERNS.some((pat) => pat.test(base));
	if (!isContainerFile) continue;
	const rel = relative(REPO_ROOT, file);
	const lines = readFileSync(file, 'utf8').split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		// Strip line comments before testing — `# pinned, not :latest` is
		// a valid comment that shouldn't trip the smoke.  YAML uses `#`,
		// Dockerfile also uses `#`.
		const code = line.replace(/#.*$/, '');
		if (/:latest\b/i.test(code)) {
			containerHits.push({ file: rel, line: i + 1, text: line.trim() });
		}
	}
}

if (containerHits.length === 0) {
	pass(
		`no \`:latest\` Docker tag references in any container config across ${SCAN_DIRS.join(', ')}`
	);
} else {
	const detail = containerHits
		.map(
			(h) =>
				`${h.file}:${h.line}  ${h.text.slice(0, 100)}`
		)
		.join('\n      ');
	fail(
		`no \`:latest\` Docker tag references in container configs`,
		`Found ${containerHits.length} occurrence(s).  Pin to a specific tag like ":1.0.0" for reproducibility; see apps/mcp-server/README.md.\n      ${detail}`
	);
}

/* ---------------- invariant 2: no :latest in operator-facing docs except guidance prose ---------------- */

interface DocHit {
	file: string;
	line: number;
	text: string;
}
const docHits: DocHit[] = [];

for (const file of allFiles) {
	if (!file.endsWith('.md')) continue;
	const rel = relative(REPO_ROOT, file);
	if (PROSE_GUIDANCE_PATHS.has(rel)) continue;
	const lines = readFileSync(file, 'utf8').split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		// Backtick-quoted text is prose, not code.  A markdown line
		// like "never use `:latest`" is guidance telling readers
		// what to avoid, not an actual image-tag reference.  Strip
		// backtick spans before matching so the smoke catches REAL
		// uses (in a fenced ```yaml block where an image: directive
		// reaches for :latest) but not prose mentions.
		const stripped = line.replace(/`[^`]*`/g, '');
		if (/:latest\b/i.test(stripped)) {
			docHits.push({ file: rel, line: i + 1, text: line.trim() });
		}
	}
}

if (docHits.length === 0) {
	pass(
		`no \`:latest\` Docker tag references in operator-facing markdown (outside documented guidance prose)`
	);
} else {
	const detail = docHits
		.map((h) => `${h.file}:${h.line}  ${h.text.slice(0, 100)}`)
		.join('\n      ');
	fail(
		`no \`:latest\` Docker tag references in operator-facing markdown`,
		`Found ${docHits.length} occurrence(s).  If a doc legitimately needs to mention :latest (e.g. to tell readers NOT to use it), add the file path to PROSE_GUIDANCE_PATHS in this smoke with an inline rationale.\n      ${detail}`
	);
}

/* ---------------- invariant 3: guidance allowlist is non-empty and pinned ---------------- */

// Sanity: if a future refactor accidentally empties PROSE_GUIDANCE_PATHS,
// the smoke becomes meaningless — every operator doc would suddenly
// flag a :latest mention as a violation.  Pin the expected entries.

if (PROSE_GUIDANCE_PATHS.size === 0) {
	fail(
		'PROSE_GUIDANCE_PATHS is non-empty',
		'cp155 smoke is meaningless with no documented guidance paths'
	);
} else if (!PROSE_GUIDANCE_PATHS.has('apps/mcp-server/README.md')) {
	fail(
		'PROSE_GUIDANCE_PATHS pins apps/mcp-server/README.md',
		'the cp146 README guidance prose was the canonical "never use :latest" reference; removing it from the allowlist would cause the smoke to flag the README itself'
	);
} else {
	pass(`PROSE_GUIDANCE_PATHS has ${PROSE_GUIDANCE_PATHS.size} entries including apps/mcp-server/README.md`);
}

/* ---------------- report ---------------- */

let failed = 0;
for (const r of results) {
	if (r.passed) {
		console.log('  ' + ANSI_GREEN + '✓' + ANSI_RESET + ' ' + r.name);
	} else {
		console.log('  ' + ANSI_RED + '✗' + ANSI_RESET + ' ' + r.name);
		if (r.detail) console.log('      ' + r.detail);
		failed++;
	}
}

console.log();
console.log('──────────────────────────────────────────────────────');
if (failed > 0) {
	console.log('✗ ' + failed + ' of ' + results.length + ' scenarios failed');
	process.exit(1);
} else {
	console.log('✓ all ' + results.length + ' scenarios passed');
}
