#!/usr/bin/env tsx
/**
 * upgrade-rebuilds-dist-workspaces smoke — cp296.
 *
 * THE GAP THIS GUARDS. `morphit-ops upgrade` always rebuilds the static
 * web frontend, but it used to leave the TWO compiled workspaces stale:
 *   • morphit-mcp — `bin` → `dist/main.js` (runs the bundle directly).
 *   • morphit-ops — bin launcher PREFERS `dist/main.js` when present.
 * `dist/` is gitignored and not in the tarball, and `npm ci` doesn't
 * build it, so an upgrade left the OLD-version dist on disk — the MCP
 * server ran stale code and `morphit-ops` preferred its own stale bundle
 * over the freshly-extracted source. cp296 adds a rebuild step after
 * `npm ci` for both workspaces.
 *
 * Invariants (over apps/ops-cli/src/commands/upgrade.ts):
 *   1. runUpgrade rebuilds BOTH dist-shipping workspaces — a loop over
 *      ['ops-cli', 'mcp-server'] that runs `npm run build` in each.
 *   2. The rebuild happens AFTER the `npm ci` step (deps first).
 *   3. The step is non-fatal (warns; no rollback) — the ops launcher
 *      self-heals to source, so a build hiccup must not roll back an
 *      already-built frontend.
 *
 * Tamper tests (each must flip a check red):
 *   - Remove 'mcp-server' from the rebuild loop → fails invariant 1.
 *   - Move the rebuild before `npm ci` → fails invariant 2.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const UPGRADE = join(REPO, 'apps', 'ops-cli', 'src', 'commands', 'upgrade.ts');

let pass = 0;
let fail = 0;
const ok = (m: string): void => {
	console.log(`  \u2713 ${m}`);
	pass++;
};
const bad = (m: string): void => {
	console.error(`  \u2717 ${m}`);
	fail++;
};

/** Invariant 1: a loop rebuilds both dist-shipping workspaces. */
function rebuildsBothWorkspaces(src: string): boolean {
	return (
		/for \(const wsDir of \[['"]ops-cli['"], ['"]mcp-server['"]\]/.test(src) &&
		/runOrThrow\('npm', \['run', 'build'\], \{ cwd: join\(installDir, 'apps', wsDir\) \}\)/.test(src)
	);
}

/** Invariant 2: the rebuild loop is positioned AFTER the npm ci call. */
function rebuildAfterNpmCi(src: string): boolean {
	const ci = src.indexOf("runOrThrow('npm', ['ci'");
	const loop = src.indexOf("for (const wsDir of ['ops-cli', 'mcp-server']");
	return ci !== -1 && loop !== -1 && ci < loop;
}

/** Invariant 3: the rebuild failure path warns rather than rolls back. */
function rebuildNonFatal(src: string): boolean {
	// Grab the loop body and confirm its catch warns and does NOT return
	// rollback (which is what the FATAL frontend-build catch does).
	const m = src.match(
		/for \(const wsDir of \['ops-cli', 'mcp-server'\][\s\S]*?\n\t\}\n/
	);
	if (!m) return false;
	const body = m[0];
	return /warn\(/.test(body) && !/rollback\(/.test(body);
}

const src = readFileSync(UPGRADE, 'utf8');

if (rebuildsBothWorkspaces(src)) ok('upgrade rebuilds both dist-shipping workspaces (ops-cli + mcp-server)');
else bad('upgrade does NOT rebuild both dist-shipping workspaces');

if (rebuildAfterNpmCi(src)) ok('the dist rebuild runs AFTER npm ci (deps installed first)');
else bad('the dist rebuild is not positioned after npm ci');

if (rebuildNonFatal(src)) ok('a dist rebuild failure warns (non-fatal) instead of rolling back');
else bad('a dist rebuild failure is not handled non-fatally');

// ── Tamper tests ──
{
	const mutated = src.replace("['ops-cli', 'mcp-server']", "['ops-cli']");
	if (mutated === src) bad('tamper wiring error: could not drop mcp-server from the loop');
	else if (rebuildsBothWorkspaces(mutated)) bad('tamper NOT caught: dropping mcp-server still passes (toothless)');
	else ok('tamper caught: dropping mcp-server from the rebuild loop turns invariant 1 red');
}
{
	// Simulate moving the rebuild before npm ci by deleting the npm ci call
	// that precedes it — invariant 2 must then fail.
	const mutated = src.replace("runOrThrow('npm', ['ci', '--no-audit', '--no-fund'], { cwd: installDir });", '');
	if (mutated === src) bad('tamper wiring error: could not remove the npm ci call');
	else if (rebuildAfterNpmCi(mutated)) bad('tamper NOT caught: removing npm ci still passes invariant 2 (toothless)');
	else ok('tamper caught: removing the npm ci step turns invariant 2 red');
}

console.log(`\n${pass} ok, ${fail} failing`);
if (fail > 0) process.exit(1);
console.log(`\u2713 all ${pass} scenarios passed`);
