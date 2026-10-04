/**
 * undeclared-dependency-smoke.
 *
 * A package imported by a workspace but not declared in its package.json
 * resolves only because npm happened to hoist it to the root node_modules: a
 * different install layout (a deployed subset, the MCP deploy, a lockfile
 * change elsewhere) silently breaks it, and nothing records who needs it.
 *
 * For every workspace's src/ (what ships), the root scripts/, and every other
 * directory with its own package.json (scripts/ipns), every bare import must
 * be declared in the nearest package.json's dependencies / devDependencies /
 * peerDependencies / optionalDependencies, or be a Node built-in. Path
 * aliases ($lib, $app, $indexer, …) and relative imports are not packages;
 * comments are ignored.
 *   MORPHIT_DEPS_SCAN_ROOT=<other tree> tsx scripts/undeclared-dependency-smoke.ts
 */
import { builtinModules } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(
	process.env.MORPHIT_DEPS_SCAN_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..')
);
const BUILTIN = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const SKIP_DIRS = new Set([
	'node_modules',
	'build',
	'dist',
	'.svelte-kit',
	'.git',
	'vendor',
	'static'
]);
const CODE = /\.(?:ts|mts|cts|js|mjs|cjs|svelte)$/;

interface Pkg {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	workspaces?: string[];
}
const declared = (p: Pkg): Set<string> =>
	new Set([
		...Object.keys(p.dependencies ?? {}),
		...Object.keys(p.devDependencies ?? {}),
		...Object.keys(p.peerDependencies ?? {}),
		...Object.keys(p.optionalDependencies ?? {})
	]);

/** The package a bare specifier names, or null for aliases/relative/URLs. */
export function packageOf(spec: string): string | null {
	if (/^(?:\.|\/|[a-z]+:(?!$))/i.test(spec) && !spec.startsWith('node:')) return null; // relative, absolute, URL schemes
	if (/^[$~#]/.test(spec) || spec.startsWith('virtual:')) return null; // path aliases, subpath imports
	if (spec.startsWith('node:')) return spec;
	const parts = spec.split('/');
	if (spec.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
	return parts[0] ?? null;
}

const NPM_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w.@/-]*)?$/;
const stripComments = (t: string): string =>
	t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

function imports(raw: string): string[] {
	const text = stripComments(raw);
	const out: string[] = [];
	const res = [
		/\bimport\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g,
		/\bexport\s+(?:type\s+)?[^'"`;]*?\s+from\s+['"]([^'"]+)['"]/g,
		/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
		/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g
	];
	for (const re of res)
		for (const m of text.matchAll(re))
			if (NPM_NAME.test(m[1]!) || m[1]!.startsWith('node:')) out.push(m[1]!);
	return out;
}

function walk(dir: string, out: string[], nested: (d: string) => boolean): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const n of names) {
		if (SKIP_DIRS.has(n)) continue;
		const p = join(dir, n);
		const st = statSync(p);
		if (st.isDirectory()) {
			if (!nested(p)) walk(p, out, nested);
		} else if (CODE.test(n)) out.push(p);
	}
}

const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Pkg;
const workspaces: string[] = [];
for (const pattern of rootPkg.workspaces ?? []) {
	const base = join(ROOT, pattern.replace(/\/\*$/, ''));
	if (pattern.endsWith('/*')) {
		for (const n of existsSync(base) ? readdirSync(base) : []) {
			if (existsSync(join(base, n, 'package.json'))) workspaces.push(join(base, n));
		}
	} else if (existsSync(join(base, 'package.json'))) workspaces.push(base);
}
const isWorkspace = (d: string): boolean => workspaces.includes(d);

const problems: string[] = [];
const scan = (dir: string, pkg: Pkg, label: string, files: string[]): void => {
	const have = declared(pkg);
	const seen = new Map<string, string>();
	for (const f of files) {
		for (const spec of imports(readFileSync(f, 'utf8'))) {
			const name = packageOf(spec);
			if (name === null || BUILTIN.has(name) || have.has(name)) continue;
			if (!seen.has(name)) seen.set(name, relative(ROOT, f));
		}
	}
	for (const [name, where] of seen)
		problems.push(`${label}: imports ${name} (e.g. ${where}) but does not declare it`);
};

const ownPackage = (d: string): boolean => existsSync(join(d, 'package.json'));
for (const ws of workspaces) {
	const files: string[] = [];
	walk(join(ws, 'src'), files, ownPackage);
	scan(
		ws,
		JSON.parse(readFileSync(join(ws, 'package.json'), 'utf8')) as Pkg,
		relative(ROOT, ws),
		files
	);
}
const rootFiles: string[] = [];
const nestedPkgs: string[] = [];
walk(join(ROOT, 'scripts'), rootFiles, (d) => (ownPackage(d) ? (nestedPkgs.push(d), true) : false));
scan(ROOT, rootPkg, '(root scripts)', rootFiles);
for (const d of nestedPkgs) {
	const files: string[] = [];
	walk(d, files, ownPackage);
	scan(
		d,
		JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')) as Pkg,
		relative(ROOT, d),
		files
	);
}

if (problems.length > 0) {
	for (const p of problems) console.log(`  ✗ ${p}`);
	console.log(`✗ ${problems.length} undeclared dependenc${problems.length === 1 ? 'y' : 'ies'}`);
	process.exit(1);
}
const scanned = workspaces.length + 1 + nestedPkgs.length;
console.log(
	`✓ all ${scanned} packages declare every package they import (${workspaces.length} workspaces, the root scripts, ${nestedPkgs.length} nested script package${nestedPkgs.length === 1 ? '' : 's'})`
);
