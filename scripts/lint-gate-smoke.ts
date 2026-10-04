#!/usr/bin/env tsx
/**
 * lint-gate-smoke — the formatting and lint gate that actually runs.
 *
 * F17c. Four workspaces declared a `lint` script — `prettier --check .`, and
 * `&& eslint .` for the web app — and nothing ran any of them: no root script,
 * not the battery, not CI. None of them passed either, by 742 files.
 * Meanwhile only `apps/*` had a prettier config, so `prettier --write` on a
 * package or a root script applied prettier's DEFAULTS and mangled the file
 * while reporting success — twice in this release.
 *
 * What this does, and deliberately does not do:
 *
 *   - A root `.prettierrc` carries the house style, so `--write` is safe
 *     everywhere. Checked here against the per-app copies it must agree with.
 *
 *   - It does NOT reformat the tree. That would be the largest, least reviewable
 *     change in a release, and it would move the exact source lines the mutation
 *     harnesses use as needles. Instead the files that were unformatted when the
 *     gate arrived are GRANDFATHERED in `scripts/prettier-ratchet-baseline.txt`,
 *     and the list can only shrink:
 *       · every governed file NOT on that list must be formatted — so nothing
 *         new arrives unformatted and nothing clean regresses;
 *       · every file ON the list must still exist and still be unformatted —
 *         so formatting one means deleting its line, and the list only shrinks.
 *
 *   - eslint for the web app, errors only. It had three: two disable-comments
 *     naming a rule the config does not load, and one useless escape.
 *     Warnings are not gated; 453 of them are a separate decision.
 *
 * Slow for a smoke (prettier over ~1,600 files is most of a minute), and in
 * the battery anyway: a check nobody runs is not a check.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');
const BIN = (name: string): string => join(REPO, 'node_modules', '.bin', name);

let pass = 0;
let fail = 0;
const ok = (m: string): void => {
	pass++;
	console.log(`  ✓ ${m}`);
};
const bad = (m: string, detail = ''): void => {
	fail++;
	console.log(`  ✗ ${m}`);
	if (detail) console.log(`      ${detail}`);
};

/** What the gate governs: code, not data or prose. JSON locales are
 *  tab-indented and gated by the i18n smokes; docs are hand-set. */
const GOVERNED = [
	'apps/*/src/**/*.{ts,js,svelte}',
	'apps/*/test/**/*.{ts,js}',
	'apps/*/scripts/**/*.{ts,js,mjs}',
	'packages/*/src/**/*.ts',
	'scripts/**/*.{ts,mjs}'
];

/** Every governed file, whatever its state. */
function governedFiles(): Set<string> {
	// The same globs prettier is given, expanded by bash (globstar + extglob,
	// braces rewritten as @(a|b)), so "governed" and "checked" are one list.
	const listed = execFileSync(
		'bash',
		[
			'-O',
			'globstar',
			'-O',
			'extglob',
			'-O',
			'nullglob',
			'-c',
			`for f in ${GOVERNED.map((g) => g.replace(/\{([^}]*)\}/g, '@($1)').replace(/,/g, '|')).join(' ')}; do echo "$f"; done`
		],
		{ cwd: REPO, encoding: 'utf8' }
	);
	return new Set(
		listed
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.includes('/node_modules/') && !l.includes('/i18n/locales/'))
	);
}

/** Governed files prettier would change. */
function unformattedFiles(): Set<string> {
	let stdout = '';
	try {
		stdout = execFileSync(BIN('prettier'), ['--list-different', ...GOVERNED], {
			cwd: REPO,
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024
		});
	} catch (err) {
		// Exit 1 is prettier's "some files differ", with the list on stdout.
		// Anything else is prettier failing to run, which must not read as clean.
		const e = err as { status?: number; stdout?: string; stderr?: string };
		if (e.status !== 1) {
			throw new Error(`prettier did not run (exit ${e.status}): ${String(e.stderr).slice(0, 300)}`);
		}
		stdout = e.stdout ?? '';
	}
	return new Set(
		stdout
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l.length > 0)
	);
}

const baselinePath = join(REPO, 'scripts', 'prettier-ratchet-baseline.txt');
const baselineLines = readFileSync(baselinePath, 'utf8')
	.split('\n')
	.map((l) => l.trim())
	.filter((l) => l.length > 0 && !l.startsWith('#'));
const baseline = new Set(baselineLines);

// ── the root config ─────────────────────────────────────────────────────────
{
	const root = JSON.parse(readFileSync(join(REPO, '.prettierrc'), 'utf8')) as Record<
		string,
		unknown
	>;
	const differing: string[] = [];
	for (const app of ['indexer', 'relay', 'ops-cli', 'web']) {
		const cfg = JSON.parse(readFileSync(join(REPO, 'apps', app, '.prettierrc'), 'utf8')) as Record<
			string,
			unknown
		>;
		for (const k of ['useTabs', 'singleQuote', 'trailingComma', 'printWidth']) {
			if (cfg[k] !== root[k]) differing.push(`${app}.${k}`);
		}
	}
	if (differing.length === 0)
		ok('the root .prettierrc carries the same house style as every app config');
	else
		bad(
			'the root .prettierrc disagrees with an app config',
			`${differing.join(', ')} — --write would format a package differently from an app`
		);
}

// ── the baseline file itself ────────────────────────────────────────────────
{
	const sorted = [...baselineLines].sort();
	if (baselineLines.length === baseline.size && sorted.every((l, i) => l === baselineLines[i]))
		ok(`the grandfather list is sorted and has no duplicates (${baseline.size} files)`);
	else bad('the grandfather list is unsorted or has duplicates');
}

const governed = governedFiles();
const unformatted = unformattedFiles();

if (governed.size > 1000) ok(`the gate governs ${governed.size} files`);
else
	bad(
		'the governed file list is implausibly small — the glob expansion broke',
		`${governed.size} files; an empty or short list would make every check below pass vacuously`
	);

// ── THE SHRINK-ONLY RULE ────────────────────────────────────────────────────
{
	const offenders = [...unformatted].filter((f) => !baseline.has(f)).sort();
	if (offenders.length === 0) ok('every governed file outside the grandfather list is formatted');
	else
		bad(
			`${offenders.length} file(s) are unformatted and not grandfathered`,
			`${offenders.slice(0, 10).join(', ')} — run \`npx prettier --write <file>\` from the repo root`
		);
}
{
	const gone = baselineLines.filter((f) => !existsSync(join(REPO, f)));
	if (gone.length === 0) ok('every grandfathered file still exists');
	else
		bad(
			`${gone.length} grandfathered file(s) no longer exist — delete their lines`,
			gone.slice(0, 10).join(', ')
		);
}
{
	const nowClean = baselineLines.filter((f) => existsSync(join(REPO, f)) && !unformatted.has(f));
	if (nowClean.length === 0)
		ok('every grandfathered file is still unformatted — the list only shrinks by editing it');
	else
		bad(
			`${nowClean.length} grandfathered file(s) are formatted now — delete their lines so they stay that way`,
			nowClean.slice(0, 10).join(', ')
		);
}

// ── eslint, web, errors only ────────────────────────────────────────────────
{
	try {
		execFileSync(BIN('eslint'), ['--quiet', '.'], {
			cwd: join(REPO, 'apps', 'web'),
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024
		});
		ok('eslint reports no errors in apps/web');
	} catch (err) {
		const e = err as { status?: number; stdout?: string };
		bad(
			`eslint reports errors in apps/web (exit ${e.status})`,
			String(e.stdout ?? '')
				.split('\n')
				.filter(Boolean)
				.slice(0, 6)
				.join(' | ')
		);
	}
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('✗ lint gate FAILED');
	process.exit(1);
}
console.log(`✓ all ${pass} lint-gate scenarios passed`);
