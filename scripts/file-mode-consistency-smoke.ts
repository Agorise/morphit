#!/usr/bin/env tsx
/**
 * file-mode-consistency-smoke.
 *
 * The executable bit says how a file is meant to be used, and git and the
 * release tarball carry it:
 *   - every shell script with a shebang is executable, so an operator can
 *     run it as documented (`sudo ./script.sh`), except a library that is
 *     only ever sourced (ops/scripts/lib/);
 *   - every Python file with a shebang is executable (BunkerWeb runs
 *     ops/bunkerweb/scheduler/mmdb-local.py as a job by its path);
 *   - no TypeScript file is executable: they run through tsx, and a stray +x
 *     on one of hundreds reads as an accident;
 *   - nothing is executable without a shebang.
 *
 * Usage: tsx scripts/file-mode-consistency-smoke.ts [--root <tree>]
 */
import { openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const argRoot = process.argv.indexOf('--root');
const ROOT =
	argRoot > 0 ? process.argv[argRoot + 1]! : join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.svelte-kit', 'build', 'dist', 'coverage']);
const SKIP_ROOT_DIRS = new Set([
	'vendor',
	'release',
	'.canonical-release',
	'.npm-cache',
	'private'
]);
/** Sourced, never executed. */
const SOURCED_ONLY = /^ops\/scripts\/lib\//;

const startsWithShebang = (p: string): boolean => {
	const fd = openSync(p, 'r');
	try {
		const b = Buffer.alloc(2);
		return readSync(fd, b, 0, 2, 0) === 2 && b.toString() === '#!';
	} finally {
		closeSync(fd);
	}
};

const problems: string[] = [];
let shells = 0;
let tsFiles = 0;
const walk = (dir: string): void => {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			if (SKIP_DIRS.has(e.name) || (dir === ROOT && SKIP_ROOT_DIRS.has(e.name))) continue;
			walk(p);
			continue;
		}
		if (!e.isFile()) continue;
		const rel = relative(ROOT, p);
		const exec = (statSync(p).mode & 0o111) !== 0;
		const shebang = startsWithShebang(p);
		if (e.name.endsWith('.sh')) {
			shells++;
			if (shebang && !exec && !SOURCED_ONLY.test(rel))
				problems.push(`${rel}: a runnable shell script that is not executable`);
		}
		if (e.name.endsWith('.py') && shebang && !exec)
			problems.push(`${rel}: a runnable Python script that is not executable`);
		if (e.name.endsWith('.ts')) {
			tsFiles++;
			if (exec) problems.push(`${rel}: an executable TypeScript file`);
		}
		if (exec && !shebang) problems.push(`${rel}: executable without a shebang`);
	}
};
walk(ROOT);

if (shells < 50 || tsFiles < 1000) {
	console.log(
		`✗ only ${shells} shell scripts and ${tsFiles} .ts files under ${ROOT} — wrong root?`
	);
	process.exit(1);
}
if (problems.length > 0) {
	for (const p of problems) console.log(`  ✗ ${p}`);
	console.log(`✗ ${problems.length} file-mode problem(s)`);
	process.exit(1);
}
console.log(`✓ all ${shells + tsFiles} shell and TypeScript files have consistent modes`);
