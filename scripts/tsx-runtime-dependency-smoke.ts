/**
 * tsx-runtime-dependency smoke.
 *
 * Locks a cross-workspace install invariant: EVERY workspace whose
 * service launches `tsx` at RUNTIME must declare `tsx` in
 * `dependencies` (not `devDependencies`).
 *
 * WHY THIS MATTERS (the footgun this guard closes):
 *   The indexer, relay, matrix-bot, and mcp-server are launched via
 *   `tsx src/main.ts` (systemd `ExecStart=` for the long-running
 *   services; `npm start` for the isolated MCP deploy), and ops-cli's
 *   bin shim falls back to running its TS source via tsx when no
 *   compiled `dist/` is present.  If `tsx` is only a devDependency,
 *   any production-shaped install — `npm install --omit=dev`,
 *   `npm ci --omit=dev`, or `NODE_ENV=production` — STRIPS it, and
 *   every one of those services dies at launch with
 *   `Cannot find module '.../tsx/...'` (MODULE_NOT_FOUND).
 *
 *   ops-cli already enforces this for itself (cp161,
 *   apps/ops-cli/scripts/install-invariants-smoke.ts), because an
 *   operator actually hit "command not found" from exactly this
 *   cause.  The long-running services are even MORE exposed: they run
 *   tsx DIRECTLY from systemd with no compiled-dist fallback, so a
 *   `--omit=dev` deploy takes the whole node down silently.  This
 *   smoke extends the same invariant to every tsx-at-runtime
 *   workspace so a future package.json edit that demotes tsx back to
 *   devDependencies fails CI here, not on an operator's box.
 *
 * DRIFT-PROOF (orphan detection):
 *   Each workspace's tsx requirement is gated on EVIDENCE that the
 *   workspace still launches tsx at runtime (the systemd ExecStart, or
 *   the package.json `start` script).  If a workspace is migrated to a
 *   compiled `node dist/main.js` launch and genuinely no longer needs
 *   tsx at runtime, the evidence check fails LOUDLY with a pointer to
 *   update this list — so the requirement can neither silently rot
 *   into a dead exemption nor outlive the thing it guards.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

// repo root is one level up from scripts/
const REPO = resolve(new URL('..', import.meta.url).pathname);

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

function readText(rel: string): string {
	return readFileSync(resolve(REPO, rel), 'utf8');
}
function readJson(rel: string): Record<string, unknown> {
	return JSON.parse(readText(rel)) as Record<string, unknown>;
}

/**
 * Pure helper (self-tested below): classify a workspace's tsx
 * declaration into one of four states from its deps/devDeps maps.
 */
type TsxState = 'dependency-only' | 'devDependency-only' | 'both' | 'absent';
function classifyTsx(
	deps: Record<string, string>,
	devDeps: Record<string, string>
): TsxState {
	const inDeps = deps.tsx !== undefined;
	const inDev = devDeps.tsx !== undefined;
	if (inDeps && inDev) return 'both';
	if (inDeps) return 'dependency-only';
	if (inDev) return 'devDependency-only';
	return 'absent';
}

/* ---------------- self-tests for the classifier ---------------- */

{
	const cases: Array<[Record<string, string>, Record<string, string>, TsxState]> = [
		[{ tsx: '^4' }, {}, 'dependency-only'],
		[{}, { tsx: '^4' }, 'devDependency-only'],
		[{ tsx: '^4' }, { tsx: '^4' }, 'both'],
		[{}, {}, 'absent']
	];
	let ok = true;
	for (const [d, dd, want] of cases) {
		if (classifyTsx(d, dd) !== want) ok = false;
	}
	if (ok) pass('classifyTsx self-test (dependency-only / devDependency-only / both / absent)');
	else fail('classifyTsx self-test', 'the tsx classifier returned an unexpected state');
}

/* ---------------- the runtime-tsx workspace contract ---------------- */

interface RuntimeTsx {
	/** human-readable workspace id */
	workspace: string;
	/** package.json to read tsx out of */
	pkg: string;
	/** file that proves this workspace launches tsx at runtime */
	evidenceFile: string;
	/** substring that must appear in evidenceFile (the tsx launch) */
	evidencePattern: string;
	/** why it runs tsx (for the failure message) */
	why: string;
}

const RUNTIME_TSX: RuntimeTsx[] = [
	{
		workspace: 'apps/indexer',
		pkg: 'apps/indexer/package.json',
		evidenceFile: 'ops/systemd/morphit-indexer.service',
		evidencePattern: 'tsx src/main.ts',
		why: 'morphit-indexer.service ExecStart launches `tsx src/main.ts`'
	},
	{
		workspace: 'apps/relay',
		pkg: 'apps/relay/package.json',
		evidenceFile: 'ops/systemd/morphit-relay.service',
		evidencePattern: 'tsx src/main.ts',
		why: 'morphit-relay.service ExecStart launches `tsx src/main.ts`'
	},
	{
		workspace: 'apps/matrix-bot',
		pkg: 'apps/matrix-bot/package.json',
		evidenceFile: 'ops/systemd/morphit-matrix-bot.service',
		evidencePattern: 'tsx/dist/cli.mjs',
		why: 'morphit-matrix-bot.service ExecStart launches tsx via `node .../tsx/dist/cli.mjs src/main.ts`'
	},
	{
		workspace: 'apps/mcp-server',
		pkg: 'apps/mcp-server/package.json',
		evidenceFile: 'apps/mcp-server/package.json',
		evidencePattern: '"start": "tsx src/main.ts"',
		why: 'morphit-mcp.service runs `npm start` = `tsx src/main.ts` (the isolated deploy keeps tsx as a runtime dep)'
	},
	{
		workspace: 'apps/ops-cli',
		pkg: 'apps/ops-cli/package.json',
		evidenceFile: 'apps/ops-cli/bin/morphit-ops.mjs',
		evidencePattern: 'tsx',
		why: 'the bin shim falls back to running the TS source via tsx when no compiled dist/ is present'
	}
];

for (const rt of RUNTIME_TSX) {
	// 1) Evidence: this workspace still launches tsx at runtime.
	const evidence = readText(rt.evidenceFile);
	if (evidence.includes(rt.evidencePattern)) {
		pass(`${rt.workspace}: still launches tsx at runtime (${rt.why})`);
	} else {
		fail(
			`${rt.workspace}: launches tsx at runtime`,
			`expected ${JSON.stringify(rt.evidencePattern)} in ${rt.evidenceFile} but it is gone. ` +
				`If this workspace was migrated to a compiled (node dist/main.js) launch and genuinely ` +
				`no longer runs tsx at runtime, REMOVE it from RUNTIME_TSX in this smoke (you may then ` +
				`move tsx back to devDependencies). Do NOT leave a stale entry — that would mask a real regression.`
		);
		continue;
	}

	// 2) tsx must be a production dependency (and not also a devDependency).
	const pkg = readJson(rt.pkg);
	const deps = (pkg.dependencies ?? {}) as Record<string, string>;
	const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
	const state = classifyTsx(deps, devDeps);

	if (state === 'dependency-only') {
		pass(`${rt.workspace}: tsx is a production dependency (survives --omit=dev)`);
	} else if (state === 'both') {
		fail(
			`${rt.workspace}: tsx in dependencies ONLY`,
			'tsx appears in BOTH dependencies and devDependencies — remove the devDependencies entry to keep one source of truth.'
		);
	} else if (state === 'devDependency-only') {
		fail(
			`${rt.workspace}: tsx must be in dependencies, not devDependencies`,
			`this workspace launches tsx at runtime (${rt.why}), but tsx is a devDependency — ` +
				`a production install (npm install --omit=dev / npm ci --omit=dev / NODE_ENV=production) ` +
				`would strip it and the service would die at launch with MODULE_NOT_FOUND. ` +
				`Move tsx to "dependencies" (see apps/ops-cli for the established precedent, cp161).`
		);
	} else {
		fail(
			`${rt.workspace}: tsx must be declared`,
			'this workspace launches tsx at runtime but does not declare tsx in dependencies or devDependencies.'
		);
	}
}

/* ---------------- guard the MCP isolated-deploy promotion ---------------- */

// The MCP server runs from its OWN isolated tree (deploy-mcp.sh),
// installed with `npm install --omit=dev`.  Even though the source
// package.json now declares tsx in dependencies, the deploy script
// must keep tsx in the deployed package.json's `dependencies` (it
// deletes devDependencies for a lean runtime tree).  Pin that so a
// future deploy-script edit can't reintroduce the strip-on-omit-dev
// bug for the most-exposed service.
{
	const deployMcp = readText('ops/scripts/deploy-mcp.sh');
	const setsTsxDep = /pkg\.dependencies\.tsx\s*=/.test(deployMcp);
	const omitsDev = /npm install --omit=dev/.test(deployMcp);
	if (setsTsxDep && omitsDev) {
		pass('deploy-mcp.sh keeps tsx in the deployed dependencies before its --omit=dev install');
	} else {
		fail(
			'deploy-mcp.sh keeps tsx a runtime dep across its --omit=dev install',
			`setsTsxDep=${setsTsxDep} omitsDev=${omitsDev} — the isolated MCP deploy installs with ` +
				`--omit=dev, so the deployed package.json must declare tsx in dependencies (it does this ` +
				`via the package.json rewrite step). Without it the MCP unit breaks at launch.`
		);
	}
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
