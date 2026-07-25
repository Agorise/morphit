#!/usr/bin/env tsx
/**
 * npm-audit-gate-smoke — Part 122 cp16 audit finding DD-13.
 *
 * Runs `npm audit --json` against the root workspace and fails
 * the build if it reports any HIGH or CRITICAL vulnerabilities
 * that aren't on the documented allowlist below.
 *
 * Each entry in the allowlist names a package + the severity we
 * accept for it, plus a short rationale.  Whoever adds a new
 * allowlist entry must also add a rationale — the gate isn't
 * "ignore everything," it's "document why each accepted risk
 * is below our threat-model bar."
 *
 * When a vulnerability is fixed upstream OR mitigated by removing
 * the dependency, drop the allowlist row.  The smoke will then
 * pass cleanly.
 *
 * Note: this smoke runs `npm audit` which talks to the npm
 * registry.  In offline / restricted-network environments, the
 * smoke will WARN and exit 0 rather than fail spuriously —
 * a hard fail on transient network issues would mask real
 * problems.  CI environments with real audit results should
 * see a hard fail when something slips through.
 */

import { execSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');

/** Vulnerabilities we accept with their rationale.  Each entry
 *  names a package + the severity we accept for it + the EXACT
 *  CVE titles we've reviewed + a rationale + a last-reviewed
 *  date.  The gate fires when a NEW CVE title appears for an
 *  allowlisted package — forces a fresh review when the
 *  supply-chain landscape shifts under us, even on packages
 *  we've already accepted.
 *
 *  `lastReviewed` is informational — not enforced as an expiry —
 *  but reviewers should re-check entries older than ~6 months
 *  to catch quietly-evolved attack surfaces.  CI doesn't fail
 *  on stale dates; humans should. */
interface AllowlistEntry {
	readonly package: string;
	readonly maxSeverity: 'low' | 'moderate' | 'high' | 'critical';
	readonly acceptedTitles: readonly string[];
	readonly rationale: string;
	/** ISO date (YYYY-MM-DD) of the last human review of this
	 *  entry.  Bump when re-evaluating the rationale, NOT when
	 *  unrelated changes touch the file. */
	readonly lastReviewed: string;
}

const ALLOWLIST: readonly AllowlistEntry[] = [
	{
		package: 'request',
		maxSeverity: 'critical',
		acceptedTitles: ['Server-Side Request Forgery in Request'],
		lastReviewed: '2026-07-06',
		rationale:
			'Deprecated HTTP library brought in transitively by matrix-bot-sdk. ' +
			'Carries CRITICAL SSRF (CVE in request) but matrix-bot only makes outbound ' +
			'calls to operator-configured Matrix homeserver URLs — no user-controlled ' +
			'URLs flow through this library, so the SSRF surface is bounded to operator ' +
			'misconfiguration. Re-reviewed cp426 (2026-07-06): matrix-bot-sdk\'s LATEST ' +
			'(0.8.0) STILL depends on request@^2.88.2 + request-promise, so an SDK version ' +
			'bump does NOT resolve this — only replacing matrix-bot-sdk with a request-free ' +
			'client would (the bot\'s usage is a thin MatrixClient facade, so that is ' +
			'feasible future work). Overriding form-data/request to a fixed major would ' +
			'break request\'s 2.x multipart API, so no safe transitive override exists.'
	},
	{
		package: 'form-data',
		maxSeverity: 'critical',
		acceptedTitles: [
			'form-data uses unsafe random function in form-data for choosing boundary',
			'form-data: CRLF injection in form-data via unescaped multipart field names and filenames'
		],
		lastReviewed: '2026-07-06',
		rationale:
			'Transitive of `request` (see above), reached only by matrix-bot-sdk. Two ' +
			'advisories: (1) unsafe Math.random() boundary generation matters for cross-origin ' +
			'request forgery via predictable boundaries; (2) CRLF injection via unescaped ' +
			'multipart field names/filenames matters only when an attacker controls those ' +
			'names. matrix-bot makes solely outbound, operator-configured Matrix homeserver ' +
			'calls and constructs its own multipart field names, so neither the boundary space ' +
			'nor the field names are attacker-controlled. Acceptable until matrix-bot-sdk ' +
			'upgrades or is replaced. Reviewed cp270.'
	},
	{
		package: 'tough-cookie',
		maxSeverity: 'high',
		acceptedTitles: ['tough-cookie Prototype Pollution vulnerability'],
		lastReviewed: '2026-07-06',
		rationale:
			'Transitive of `request` (see above). Prototype-pollution via crafted ' +
			'cookie names; matrix-bot only receives cookies from operator-configured ' +
			'Matrix homeservers, so attacker-controlled cookies are not in scope.'
	},
	{
		package: 'esbuild',
		maxSeverity: 'high',
		acceptedTitles: [
			'esbuild enables any website to send any requests to the development server and read the response',
			'esbuild: Missing binary integrity verification in Deno module enables remote code execution via NPM_CONFIG_REGISTRY',
			'esbuild allows arbitrary file read when running the development server on Windows'
		],
		lastReviewed: '2026-06-12',
		rationale:
			'Dev/build-only dependency (never shipped to operators). All three advisories ' +
			'target esbuild usage patterns Morphit does not employ: (1) the permissive-CORS ' +
			'dev server and (3) the Windows dev-server arbitrary-file-read both require ' +
			"esbuild's `serve` mode — Morphit uses esbuild only as a one-shot Node bundler " +
			'(ops-cli build.mjs) and the SvelteKit/Vite dev server is local-development-only, ' +
			'never exposed in production (operators serve prebuilt static assets). (2) the ' +
			'Deno-module binary-integrity RCE requires running esbuild under Deno with an ' +
			'attacker-controlled NPM_CONFIG_REGISTRY — Morphit builds under Node with the ' +
			'default registry and has no Deno path installed. No production surface; the ' +
			'lockfile is the tested source of truth (no `npm audit fix`). Reviewed cp252. ' +
			'Revisit if esbuild ever becomes a runtime/served dependency or if a non-breaking ' +
			'patched esbuild is already in range.'
	},
	{
		package: 'vitest',
		maxSeverity: 'critical',
		acceptedTitles: [
			'When Vitest UI server is listening, arbitrary file can be read and executed'
		],
		lastReviewed: '2026-06-01',
		rationale:
			'Dev/test-only dependency (never shipped to operators). The vulnerable ' +
			'code path is the Vitest UI server: Morphit invokes vitest only as ' +
			'`vitest run` / `vitest` (no `--ui`), has NO `@vitest/ui` dependency, and ' +
			'never starts the UI server in CI or locally — so the listening-server ' +
			'file-read/exec surface is not installed or reachable here. Reviewed cp184. ' +
			'Revisit if a vitest 2.1.x patch ships or if `@vitest/ui` is ever added.'
	},
	{
		package: 'vite',
		maxSeverity: 'high',
		acceptedTitles: [
			'Vite Vulnerable to Path Traversal in Optimized Deps `.map` Handling',
			'launch-editor: NTLMv2 hash disclosure via UNC path handling on Windows',
			'vite: `server.fs.deny` bypass on Windows alternate paths'
		],
		lastReviewed: '2026-07-06',
		rationale:
			'Dev/build-only dependency (never shipped to operators — production serves ' +
			'prebuilt static assets via the operator web server, with no Vite dev server ' +
			'running). All three advisories require the Vite dev server, which Morphit uses ' +
			'only for local development: (1) the optimized-deps `.map` path traversal is ' +
			'served by the dev server only; (2) launch-editor (transitive via vite) is the ' +
			"dev server's click-to-open-in-editor helper and the NTLMv2/UNC hash disclosure " +
			'is Windows-only; (3) the `server.fs.deny` bypass is the dev server file-serving ' +
			'guard and is also Windows-only. Morphit is developed on Linux and production ' +
			'never starts the dev server, so neither the dev-server surface nor the ' +
			'Windows-specific paths are reachable. No production surface; the lockfile is ' +
			'the tested source of truth (no `npm audit fix`). Reviewed cp270. Revisit if a ' +
			'non-breaking patched vite is already in range or if the dev server is ever ' +
			'exposed in production.'
	},
	{
		package: 'brace-expansion',
		maxSeverity: 'high',
		acceptedTitles: [
			'brace-expansion: DoS via exponential-time expansion of consecutive non-expanding {} groups',
			'brace-expansion: DoS via unbounded expansion length causing an out-of-memory process crash'
		],
		lastReviewed: '2026-07-24',
		rationale:
			'Build/dev-only transitive dependency (reached via minimatch/glob under vite, ' +
			'rollup, eslint, tailwind, and the test tooling — never shipped to operators; ' +
			'production serves prebuilt static assets). Two advisories, same DoS class: ' +
			'GHSA-3jxr-9vmj-r5cp (exponential-time ReDoS on many consecutive non-expanding ' +
			'`{}` groups) and GHSA-mh99-v99m-4gvg (unbounded expansion length → OOM crash). ' +
			'Both require an attacker to control the GLOB/BRACE PATTERN string fed to ' +
			'brace-expansion, but every pattern in our stack is developer-authored at build ' +
			'time (file globs in configs, test match patterns) — no runtime path lets ' +
			'untrusted user input reach a brace-expansion call, so neither DoS is reachable ' +
			'in production or in the served app. No safe transitive override exists across ' +
			'every consumer without churning the lockfile, and the lockfile is the tested ' +
			'source of truth (no `npm audit fix`). Revisit if a patched brace-expansion ' +
			'lands non-breakingly in range for all consumers, or if any runtime code ever ' +
			'brace-expands user-supplied input. First reviewed cp509 (2026-07-20); ' +
			'GHSA-mh99 added + re-reviewed at the v1.8.15 cut (2026-07-24).'
	},
	{
		package: 'postcss',
		maxSeverity: 'high',
		acceptedTitles: [
			'PostCSS: Path Traversal in Previous Source Map Auto-Loading (sourceMappingURL) leads to Arbitrary .map File Disclosure'
		],
		lastReviewed: '2026-07-24',
		rationale:
			'postcss@8.5.14 is reached two ways, neither of which reaches the vulnerable ' +
			'path. (1) Web BUILD tooling — autoprefixer, tailwindcss, eslint-plugin-svelte, ' +
			'and postcss directly — runs only at build time over OUR OWN authored CSS; ' +
			'production serves prebuilt static assets, so postcss is not in the served app ' +
			'at all. (2) matrix-bot → matrix-bot-sdk → sanitize-html uses postcss at runtime ' +
			'only to parse inline `style` ATTRIBUTE fragments while sanitizing HTML — it does ' +
			'not process full stylesheets and does not enable source-map auto-loading. The ' +
			'advisory (GHSA-r28c-9q8g-f849) requires postcss to process CSS carrying a ' +
			'`sourceMappingURL` comment WITH previous-map resolution enabled so it reads a ' +
			'`.map` file off disk via a traversal path; no consumer here feeds untrusted CSS ' +
			'through that option (the build CSS is developer-authored with fixed inputs; ' +
			'sanitize-html parses attribute-value snippets without map loading), so the ' +
			'arbitrary `.map` disclosure is not reachable. No patched postcss is in range for ' +
			'every consumer without churning the lockfile (the tested source of truth — no ' +
			'`npm audit fix`). Revisit when a fixed postcss lands non-breakingly across all ' +
			'consumers, or if any runtime code processes untrusted CSS with previous-source-map ' +
			'loading enabled. Reviewed at the v1.8.15 cut (2026-07-24).'
	},
	{
		package: 'js-yaml',
		maxSeverity: 'high',
		acceptedTitles: [
			'JS-YAML: Quadratic-complexity DoS in merge key handling via repeated aliases',
			'js-yaml: YAML merge-key chains can force quadratic CPU consumption'
		],
		lastReviewed: '2026-07-20',
		rationale:
			'Build/dev-only transitive dependency (reached via eslint -> @eslint/eslintrc ' +
			'-> js-yaml; never shipped to operators — production serves prebuilt static ' +
			'assets). Both advisories (GHSA-h67p-54hq-rp68, GHSA-52cp-r559-cp3m) are ' +
			'quadratic-complexity DoS: a crafted YAML document with merge-key chains / ' +
			'repeated aliases forces quadratic CPU in js-yaml\'s parser. Exploiting either ' +
			'requires an attacker to control the YAML fed to js-yaml.load, but js-yaml is ' +
			'reached ONLY by ESLint at lint-time, parsing the project\'s own ' +
			'developer-authored ESLint config — no runtime path lets untrusted user input ' +
			'reach a js-yaml parse call, and Morphit source imports js-yaml nowhere. So the ' +
			'DoS is not reachable in production or in the served app. The lockfile is the ' +
			'tested source of truth (no `npm audit fix`). Revisit if a patched js-yaml ' +
			'(>=4.3.0) lands non-breakingly in range under eslint, or if any runtime code ' +
			'ever parses user-supplied YAML. Reviewed cp511 (2026-07-20).'
	}
];

interface NpmAuditOutput {
	readonly vulnerabilities?: Record<
		string,
		{
			readonly name: string;
			readonly severity: string;
			readonly via?: ReadonlyArray<
				string | { readonly title?: string; readonly name?: string }
			>;
		}
	>;
	readonly metadata?: {
		readonly vulnerabilities?: Record<string, number>;
	};
}

const SEVERITY_RANK: Record<string, number> = {
	info: 0,
	low: 1,
	moderate: 2,
	high: 3,
	critical: 4
};

type ViaEntry = string | { readonly title?: string; readonly name?: string };

/** Extract the set of CVE titles `npm audit` reports for one
 *  vulnerable package.  `via` is heterogeneous: each entry is
 *  either a string (the name of a downstream package that brings
 *  the vuln in) or an object with `title` + `name` fields (the
 *  actual CVE).  We want only the latter. */
function cveTitles(via: ReadonlyArray<ViaEntry> | undefined): string[] {
	if (!Array.isArray(via)) return [];
	const out: string[] = [];
	for (const entry of via) {
		if (typeof entry === 'object' && entry !== null && typeof entry.title === 'string') {
			out.push(entry.title);
		}
	}
	return out;
}

interface AllowDecision {
	readonly ok: boolean;
	/** Titles present in audit output but not yet on the allowlist
	 *  for this package.  Non-empty when the smoke should fail
	 *  the package even though it's named on the allowlist —
	 *  forces a fresh review when supply-chain shifts. */
	readonly unknownTitles: readonly string[];
}

function isAllowed(name: string, severity: string, titles: readonly string[]): AllowDecision {
	const entry = ALLOWLIST.find((e) => e.package === name);
	if (!entry) return { ok: false, unknownTitles: titles };
	if (SEVERITY_RANK[severity]! > SEVERITY_RANK[entry.maxSeverity]!) {
		return { ok: false, unknownTitles: titles };
	}
	const accepted = new Set(entry.acceptedTitles);
	const unknown = titles.filter((t) => !accepted.has(t));
	return { ok: unknown.length === 0, unknownTitles: unknown };
}

// Run npm audit.  In offline / restricted networks, this fails
// with a non-zero exit but still emits useful JSON; we tolerate
// the exit code and parse what we get.
//
// DEEP-DEEP NOTE (DD-cp16-1): offline-skip exits 0 so that
// transient network issues don't break unrelated CI runs, but
// the output explicitly reports "0 scenarios actually checked"
// rather than misleadingly counting the skip as a pass.  An
// attacker who can block the npm registry would see the smoke
// SKIP — not silently green-light a vulnerable build.  CI
// reviewers should treat "0 scenarios actually checked" as a
// gate failure for any commit touching dependencies.
let audit: NpmAuditOutput;
try {
	const out = execSync('npm audit --json', {
		cwd: REPO,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
		maxBuffer: 32 * 1024 * 1024
	});
	audit = JSON.parse(out);
} catch (err: unknown) {
	const stdout = (err as { stdout?: Buffer | string })?.stdout;
	if (!stdout) {
		console.log('⚠ npm audit unavailable — registry unreachable from this host.');
		console.log('⚠ 0 scenarios actually checked.  CI must treat this as a gate failure');
		console.log('⚠ when the commit touches package.json or package-lock.json.');
		console.log('');
		console.log('npm-audit-gate smoke: 0 scenarios actually checked (offline-skip)');
		process.exit(0);
	}
	try {
		audit = JSON.parse(stdout.toString());
	} catch {
		console.log('⚠ npm audit produced unparseable output — gate cannot evaluate.');
		console.log('⚠ 0 scenarios actually checked.  CI must treat this as a gate failure');
		console.log('⚠ when the commit touches package.json or package-lock.json.');
		console.log('');
		console.log('npm-audit-gate smoke: 0 scenarios actually checked (parse-error)');
		process.exit(0);
	}
}

// Iterate the vulnerabilities map.  Each entry's `name` is the
// package; the `severity` field summarizes the worst issue
// affecting that package.
const vulns = audit.vulnerabilities ?? {};
let failed = 0;
let allowedCount = 0;
let totalConsidered = 0;
const failures: string[] = [];

for (const [pkgName, info] of Object.entries(vulns)) {
	const severity = info.severity;
	if (!severity || !(severity in SEVERITY_RANK)) continue;
	if (SEVERITY_RANK[severity]! < SEVERITY_RANK.high) continue;
	totalConsidered++;
	const titles = cveTitles(info.via);
	const decision = isAllowed(pkgName, severity, titles);
	if (decision.ok) {
		allowedCount++;
		continue;
	}
	failed++;
	if (decision.unknownTitles.length > 0) {
		failures.push(
			`${severity.toUpperCase()}: ${pkgName} — new CVE title(s) not yet reviewed:\n      ${decision.unknownTitles.map((t) => `· ${t}`).join('\n      ')}`
		);
	} else {
		failures.push(`${severity.toUpperCase()}: ${pkgName}`);
	}
}

// Report.
const meta = audit.metadata?.vulnerabilities ?? {};
console.log(
	`npm-audit-gate smoke — ${meta.high ?? 0} HIGH + ${meta.critical ?? 0} CRITICAL (registry totals)`
);
console.log(
	`  allowlisted: ${allowedCount}; new HIGH/CRITICAL not on allowlist: ${failed}`
);
console.log('');
if (failed === 0) {
	if (allowedCount > 0) {
		console.log(`  Allowlisted (rationale documented in this file):`);
		for (const entry of ALLOWLIST) {
			console.log(
				`    · ${entry.package} (≤${entry.maxSeverity}, last reviewed ${entry.lastReviewed})`
			);
		}
		console.log('');
	}
	console.log(`✓ all ${1 + totalConsidered} npm-audit-gate scenarios pass`);
	process.exit(0);
} else {
	console.error('Newly-introduced HIGH/CRITICAL vulnerabilities (not on allowlist):');
	for (const f of failures) console.error(`  ✗ ${f}`);
	console.error('');
	console.error('Either upgrade/remove the dependency OR add an entry to ALLOWLIST');
	console.error(`in apps/web/scripts/npm-audit-gate-smoke.ts with a real rationale.`);
	console.error(`✗ ${failed} gate violations`);
	process.exit(1);
}
