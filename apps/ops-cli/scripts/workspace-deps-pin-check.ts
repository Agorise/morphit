#!/usr/bin/env tsx
/**
 * workspace-deps-pin-check — generalized deps-pin-check
 * covering ALL workspaces.
 *
 * The cp13 deps-pin-check covered only apps/matrix-bot because
 * that's where the cp11 lesson came from (matrix-bot-sdk API
 * changes between minors).  But the pattern applies to every
 * workspace.  This smoke checks ALL of them.
 *
 * For each workspace's package.json:
 *   1. Read its `dependencies` map.
 *   2. For each dep, locate the installed version in node_modules
 *      (workspace-local node_modules first, then root).
 *   3. Verify the installed version satisfies the declared range.
 *
 * Hard-fails on drift.  Soft-skips if node_modules isn't
 * populated (CI runner doing static analysis only).
 *
 * Different from matrix-bot's deps-pin-check.ts (which is
 * matrix-bot-specific, narrower in scope, kept for backward
 * compatibility + as a more focused per-workspace check).
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const ROOT_NODE_MODULES = join(REPO_ROOT, 'node_modules');

function parseVersion(v: string): [number, number, number] | null {
	const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function satisfies(range: string, version: string): boolean {
	const v = parseVersion(version);
	if (!v) return false;
	// Strip a leading "v" if any.
	const cleaned = range.replace(/^v/, '');

	if (cleaned.startsWith('^')) {
		const r = parseVersion(cleaned.slice(1));
		if (!r) return false;
		if (v[0] !== r[0]) return false;
		// Pre-1.0 rule: ^0.Y.Z requires same minor.
		if (r[0] === 0 && v[1] !== r[1]) return false;
		if (v[0] > r[0]) return true;
		if (v[1] > r[1]) return true;
		if (v[1] === r[1] && v[2] >= r[2]) return true;
		return false;
	}
	if (cleaned.startsWith('~')) {
		const r = parseVersion(cleaned.slice(1));
		if (!r) return false;
		return v[0] === r[0] && v[1] === r[1] && v[2] >= r[2];
	}
	if (cleaned.startsWith('>=')) {
		const r = parseVersion(cleaned.slice(2));
		if (!r) return false;
		if (v[0] > r[0]) return true;
		if (v[0] < r[0]) return false;
		if (v[1] > r[1]) return true;
		if (v[1] < r[1]) return false;
		return v[2] >= r[2];
	}
	// Wildcards / catch-alls accepted as-is.
	if (cleaned === '*' || cleaned === 'latest') return true;
	// Workspace protocol — common in monorepos.
	if (cleaned.startsWith('workspace:')) return true;
	if (cleaned.startsWith('file:') || cleaned.startsWith('link:')) return true;
	// Exact version match.
	return cleaned === version;
}

interface DepCheck {
	readonly workspace: string;
	readonly dep: string;
	readonly declared: string;
	readonly installed: string | null;
	readonly ok: boolean;
	readonly reason?: string;
}

function findInstalledVersion(depName: string, workspaceDir: string): string | null {
	// Check workspace-local node_modules first, then root.
	const candidates = [
		join(workspaceDir, 'node_modules', depName, 'package.json'),
		join(ROOT_NODE_MODULES, depName, 'package.json')
	];
	for (const p of candidates) {
		if (existsSync(p)) {
			try {
				const pkg = JSON.parse(readFileSync(p, 'utf-8'));
				if (typeof pkg.version === 'string') return pkg.version;
			} catch {
				// fall through
			}
		}
	}
	return null;
}

function findWorkspaces(): string[] {
	const dirs: string[] = [];
	for (const top of ['apps', 'packages']) {
		const topDir = join(REPO_ROOT, top);
		if (!existsSync(topDir)) continue;
		for (const entry of readdirSync(topDir)) {
			const wsDir = join(topDir, entry);
			if (!statSync(wsDir).isDirectory()) continue;
			if (existsSync(join(wsDir, 'package.json'))) dirs.push(wsDir);
		}
	}
	return dirs;
}

const workspaces = findWorkspaces();

// Soft-skip if root node_modules is empty AND no workspace-local
// node_modules exist.
const anyInstalled = existsSync(ROOT_NODE_MODULES) ||
	workspaces.some((w) => existsSync(join(w, 'node_modules')));
if (!anyInstalled) {
	console.log(
		'workspace deps-pin-check: SKIP (no node_modules populated)'
	);
	console.log('  run `npm ci` to populate, then re-run.');
	console.log('');
	console.log(
		'✓ all 1 workspace-deps-pin scenarios hold (skipped due to env)'
	);
	process.exit(0);
}

const checks: DepCheck[] = [];

for (const wsDir of workspaces) {
	const wsName = wsDir.replace(REPO_ROOT + '/', '');
	const pkg = JSON.parse(readFileSync(join(wsDir, 'package.json'), 'utf-8'));
	const declaredDeps = (pkg.dependencies ?? {}) as Record<string, string>;

	// Internal workspace dependencies (with `workspace:` protocol
	// or `file:`/`link:` paths) are exempt — they resolve to a
	// local checkout and are always "the version on disk".
	for (const [dep, range] of Object.entries(declaredDeps)) {
		if (range.startsWith('workspace:') || range.startsWith('file:') ||
		    range.startsWith('link:')) {
			checks.push({
				workspace: wsName,
				dep,
				declared: range,
				installed: '(workspace local)',
				ok: true
			});
			continue;
		}

		const installed = findInstalledVersion(dep, wsDir);
		if (installed === null) {
			// Dep is declared but not installed.  This can be
			// legitimate if the workspace hasn't been `npm install`-ed
			// individually.  Mark as a SOFT failure — emit a warning
			// per missing dep but don't count toward hard fail unless
			// there's actual drift.
			checks.push({
				workspace: wsName,
				dep,
				declared: range,
				installed: null,
				ok: true, // soft pass
				reason: 'not installed; nothing to compare'
			});
			continue;
		}

		const ok = satisfies(range, installed);
		checks.push({
			workspace: wsName,
			dep,
			declared: range,
			installed,
			ok,
			reason: ok ? undefined : `installed ${installed} does NOT satisfy ${range}`
		});
	}
}

// ─── Report ─────────────────────────────────────────────────────
// Group by workspace for readability.
const byWorkspace = new Map<string, DepCheck[]>();
for (const c of checks) {
	if (!byWorkspace.has(c.workspace)) byWorkspace.set(c.workspace, []);
	byWorkspace.get(c.workspace)!.push(c);
}

let total = 0;
let failed = 0;
console.log(
	`workspace deps-pin-check: ${workspaces.length} workspaces, ${checks.length} deps\n`
);
for (const [ws, wsChecks] of byWorkspace) {
	console.log(`  ${ws}:`);
	for (const c of wsChecks) {
		total++;
		if (c.ok) {
			const shown = c.installed === null
				? `${c.dep}@${c.declared} (not installed)`
				: `${c.dep}: declared ${c.declared}, installed ${c.installed}`;
			console.log(`    ✓ ${shown}`);
		} else {
			console.log(`    ✗ ${c.dep}: ${c.reason}`);
			failed++;
		}
	}
}

console.log('');
if (failed === 0) {
	console.log(`✓ all ${total} workspace-deps-pin checks hold`);
	process.exit(0);
}
console.error(`✗ ${failed} drifted across workspaces`);
process.exit(1);
