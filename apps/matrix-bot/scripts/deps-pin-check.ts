#!/usr/bin/env tsx
/**
 * matrix-bot-deps-pin-check — verify the matrix-bot's declared
 * dep versions in apps/matrix-bot/package.json are compatible
 * with what's actually installed in node_modules.
 *
 * Catches the "we tested on 0.7.1 but the deploy box pulled
 * 0.8.0 which has breaking changes" class of bug.  Most relevant
 * for matrix-bot-sdk (the API changes between minors) and
 * better-sqlite3 (native ABI changes between majors).
 *
 * Soft-skips if node_modules isn't populated (e.g. CI runner
 * doing only static analysis).  Hard-fails if the installed
 * version doesn't satisfy the declared semver range.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const MATRIX_BOT_PKG = join(REPO_ROOT, 'apps', 'matrix-bot', 'package.json');
const NODE_MODULES = join(REPO_ROOT, 'node_modules');

interface DepCheck {
	readonly name: string;
	readonly declaredRange: string;
	readonly installedVersion: string | null;
}

/** Minimal semver-range satisfaction.  Supports `^X.Y.Z`,
 *  `~X.Y.Z`, `>=X.Y.Z`, exact `X.Y.Z`.  Not a full semver impl,
 *  but enough for this smoke's purpose: catch obvious drift
 *  (e.g. declared `^0.7.1`, installed `0.8.0`). */
function parseVersion(v: string): [number, number, number] | null {
	const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function satisfies(range: string, version: string): boolean {
	const v = parseVersion(version);
	if (!v) return false;

	// ^X.Y.Z = compatible with X.Y.Z (same major; for 0.Y.Z
	// pre-1.0 same minor too — npm semver convention).
	if (range.startsWith('^')) {
		const r = parseVersion(range.slice(1));
		if (!r) return false;
		if (v[0] !== r[0]) return false;
		// pre-1.0: ^0.7.x means same minor too
		if (r[0] === 0 && v[1] !== r[1]) return false;
		// compare full version >= range
		if (v[0] > r[0]) return true;
		if (v[1] > r[1]) return true;
		if (v[1] === r[1] && v[2] >= r[2]) return true;
		return false;
	}
	// ~X.Y.Z = same major + minor
	if (range.startsWith('~')) {
		const r = parseVersion(range.slice(1));
		if (!r) return false;
		return v[0] === r[0] && v[1] === r[1] && v[2] >= r[2];
	}
	// >=X.Y.Z
	if (range.startsWith('>=')) {
		const r = parseVersion(range.slice(2));
		if (!r) return false;
		if (v[0] > r[0]) return true;
		if (v[0] < r[0]) return false;
		if (v[1] > r[1]) return true;
		if (v[1] < r[1]) return false;
		return v[2] >= r[2];
	}
	// Exact match
	return range === version;
}

function readPkg(path: string): Record<string, unknown> | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, 'utf-8'));
	} catch {
		return null;
	}
}

const botPkg = readPkg(MATRIX_BOT_PKG);
if (!botPkg) {
	console.error(`FAIL: ${MATRIX_BOT_PKG} not found or unparseable`);
	process.exit(1);
}

const declaredDeps = (botPkg.dependencies ?? {}) as Record<string, string>;

// Only check deps where version drift matters most.
const TRACKED_DEPS = ['matrix-bot-sdk', 'better-sqlite3', 'zod'];

const checks: DepCheck[] = TRACKED_DEPS.map((name) => {
	const declaredRange = declaredDeps[name];
	if (!declaredRange) {
		return { name, declaredRange: '<NOT DECLARED>', installedVersion: null };
	}
	const installedPkgPath = join(NODE_MODULES, name, 'package.json');
	const installedPkg = readPkg(installedPkgPath);
	const installedVersion = installedPkg
		? (installedPkg.version as string) ?? null
		: null;
	return { name, declaredRange, installedVersion };
});

// Soft-skip if node_modules isn't populated.
const anyInstalled = checks.some((c) => c.installedVersion !== null);
if (!anyInstalled) {
	console.log(
		'matrix-bot deps-pin-check: SKIP (node_modules not populated)'
	);
	console.log(
		'  run `npm ci` to populate, then this smoke will verify version compatibility.'
	);
	console.log('');
	console.log('✓ all 1 deps-pin-check scenarios hold (skipped due to env)');
	process.exit(0);
}

console.log('matrix-bot deps-pin-check:\n');
let failed = 0;
for (const c of checks) {
	if (c.installedVersion === null) {
		console.log(`  ✗ ${c.name}: declared ${c.declaredRange} but not installed`);
		failed++;
		continue;
	}
	if (c.declaredRange === '<NOT DECLARED>') {
		console.log(`  ✗ ${c.name}: not declared in apps/matrix-bot/package.json`);
		failed++;
		continue;
	}
	if (!satisfies(c.declaredRange, c.installedVersion)) {
		console.log(
			`  ✗ ${c.name}: declared ${c.declaredRange}, installed ${c.installedVersion} (DRIFT)`
		);
		failed++;
		continue;
	}
	console.log(`  ✓ ${c.name}: declared ${c.declaredRange}, installed ${c.installedVersion}`);
}

console.log('');
if (failed === 0) {
	console.log(`✓ all ${checks.length} version-pin checks hold`);
	process.exit(0);
}
console.error(`✗ ${failed} drifted, ${checks.length - failed} ok`);
process.exit(1);
