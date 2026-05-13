#!/usr/bin/env tsx
/**
 * i18n-key-coverage-smoke.
 *
 * Walks the entire `apps/web/src/` tree, finds every static
 * `$_('foo.bar')` reference and every dynamic
 * `$_(`foo.${var}`)` prefix, and verifies:
 *
 *   1. Every static key resolves to a string in en.json.
 *   2. Every dynamic-key prefix resolves to a non-empty
 *      object in en.json.
 *
 * This catches the class of bug where a developer added new
 * `$_(...)` references in code but forgot to add the
 * corresponding strings to the locale files — the user sees
 * raw key strings like `onboarding.import.posting_only.error.bad_account`
 * instead of human-readable copy.
 *
 * Cross-locale parity is enforced by `voucher-locale-parity-smoke`
 * for specific keys; the existing in-repo audit elsewhere ensures
 * non-en locales stay in sync with en.  This smoke just enforces
 * that en (the source-of-truth) covers everything code references.
 *
 * Known false-positive avoidance:
 *   - `some.key` in `lib/utils/splitOnPlaceholder.ts` is a
 *     literal example string in a code comment / test path,
 *     not a real i18n reference.  Hardcoded ignore list.
 *   - Dynamic-template prefixes whose values are bounded by a
 *     small enum (e.g. `home.points.${point.key}.title` where
 *     `point.key` ranges over a fixed list) are validated by
 *     spot-checking that the prefix object exists; the smoke
 *     does not enumerate every possible substitution.
 *
 * Usage:
 *   cd apps/web && npx tsx scripts/i18n-key-coverage-smoke.ts
 */

import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';

const REPO = join(import.meta.dirname, '..');
const SRC = join(REPO, 'src');
const EN_JSON_PATH = join(SRC, 'lib/i18n/locales/en.json');

/** Keys to ignore — known-safe false positives. */
const IGNORE_KEYS = new Set<string>([
	// Literal example string in test/utility code, not a real
	// i18n reference.
	'some.key'
]);

/** Dynamic-key prefixes to ignore — these are intentionally
 *  scoped narrowly elsewhere, or use values that aren't worth
 *  enumerating in this smoke. */
const IGNORE_DYNAMIC_PREFIXES = new Set<string>([]);

interface KeyOccurrence {
	readonly key: string;
	readonly file: string;
	readonly dynamic: boolean;
	/** For dynamic occurrences only: the static portion of
	 *  the leaf-key name immediately following the parent
	 *  path's last dot, before the runtime substitution.
	 *  Example: in `foo.bar.step${n}_title`, parent path is
	 *  `foo.bar` and leafPrefix is `step`.  Empty string for
	 *  pure dot-prefixed substitutions like `foo.bar.${x}.baz`
	 *  (caller validates by checking `foo.bar` is an object). */
	readonly leafPrefix?: string;
}

function findSourceFiles(): string[] {
	// Use find so we don't pull in glob etc.  Covers .ts and
	// .svelte under apps/web/src/.
	const out = execSync(`find "${SRC}" -type f \\( -name '*.ts' -o -name '*.svelte' \\)`, {
		encoding: 'utf8'
	});
	return out
		.trim()
		.split('\n')
		.filter((s) => s.length > 0);
}

function extractKeysFromFile(filepath: string): KeyOccurrence[] {
	const src = readFileSync(filepath, 'utf8');
	const occurrences: KeyOccurrence[] = [];

	// Static: $_('foo.bar') or $_("foo.bar")
	for (const m of src.matchAll(/\$_\(\s*['"]([\w.]+)['"]/g)) {
		const key = m[1]!;
		if (!IGNORE_KEYS.has(key)) {
			occurrences.push({
				key,
				file: relative(REPO, filepath),
				dynamic: false
			});
		}
	}

	// Dynamic: $_(`foo.${...}`) — the smoke's responsibility
	// is to verify the static prefix IS surrounded by enough
	// keys that resolve.  Two cases:
	//
	//   1. Dot-prefixed substitution like `foo.bar.${x}.baz` —
	//      the prefix `foo.bar` (everything up to and
	//      including the last dot before `${`) must resolve
	//      to a non-empty object.
	//
	//   2. Non-dot substitution like `foo.bar.step${n}_title`
	//      — `${n}` is part of a leaf key name, not a path
	//      separator.  The prefix is `foo.bar` (the parent
	//      object containing the synthesized leaf keys).
	//      We can't enumerate every value of `${n}`, so we
	//      validate that the parent object exists and has
	//      AT LEAST ONE leaf key whose name starts with the
	//      static prefix immediately following the last dot.
	//
	// Implementation: split on the last dot before `${`.
	// Everything before that dot is the parent path; the
	// segment after is a "leaf prefix" the runtime substitutes
	// into.
	for (const m of src.matchAll(/\$_\(\s*`([^`]+)`/g)) {
		const tpl = m[1]!;
		if (!tpl.includes('${')) continue;
		const beforeFirstSub = tpl.split('${')[0]!;
		// Find the last `.` in the static portion before the
		// first substitution.  Everything before that dot is
		// the parent path; everything after is a leaf-name
		// prefix that the runtime extends with the
		// substitution value.
		const lastDot = beforeFirstSub.lastIndexOf('.');
		if (lastDot === -1) continue;
		const parentPath = beforeFirstSub.slice(0, lastDot);
		const leafPrefix = beforeFirstSub.slice(lastDot + 1);
		if (IGNORE_DYNAMIC_PREFIXES.has(parentPath)) continue;
		occurrences.push({
			key: parentPath,
			file: relative(REPO, filepath),
			dynamic: true,
			leafPrefix
		});
	}

	return occurrences;
}

function lookup(d: unknown, key: string): unknown {
	const parts = key.split('.');
	let cur = d;
	for (const p of parts) {
		if (cur === null || typeof cur !== 'object') return undefined;
		cur = (cur as Record<string, unknown>)[p];
	}
	return cur;
}

function main(): void {
	console.log('i18n-key-coverage smoke:\n');
	const en = JSON.parse(readFileSync(EN_JSON_PATH, 'utf8'));

	const files = findSourceFiles();
	let allOccurrences: KeyOccurrence[] = [];
	for (const f of files) {
		allOccurrences = allOccurrences.concat(extractKeysFromFile(f));
	}

	const staticKeys = new Map<string, string[]>();
	const dynamicEntries = new Map<string, { files: string[]; leafPrefixes: Set<string> }>();
	for (const o of allOccurrences) {
		if (o.dynamic) {
			const e = dynamicEntries.get(o.key) ?? {
				files: [],
				leafPrefixes: new Set<string>()
			};
			e.files.push(o.file);
			e.leafPrefixes.add(o.leafPrefix ?? '');
			dynamicEntries.set(o.key, e);
		} else {
			const arr = staticKeys.get(o.key) ?? [];
			arr.push(o.file);
			staticKeys.set(o.key, arr);
		}
	}

	let failures = 0;
	let scenarios = 0;

	// Scenario 1: every static key resolves to a string in en.json.
	scenarios++;
	const missingStatic: string[] = [];
	for (const [key, files] of staticKeys) {
		const v = lookup(en, key);
		if (typeof v !== 'string') {
			missingStatic.push(`${key} (in ${[...new Set(files)][0]})`);
		}
	}
	if (missingStatic.length === 0) {
		console.log(`  ✓ all ${staticKeys.size} static keys resolve to strings in en.json`);
	} else {
		console.log(`  ✗ ${missingStatic.length} static keys missing in en.json:`);
		for (const m of missingStatic) console.log(`      ${m}`);
		failures++;
	}

	// Scenario 2: every dynamic-key parent path resolves to
	// a non-empty object in en.json, AND if the occurrence
	// uses a non-empty leafPrefix (meaning the runtime
	// substitutes into a leaf-key name like `step${n}_title`),
	// at least one leaf key in the object has that prefix.
	scenarios++;
	const missingDynamic: string[] = [];
	for (const [parentPath, entry] of dynamicEntries) {
		const v = lookup(en, parentPath);
		if (v === undefined || v === null || typeof v !== 'object' || Array.isArray(v)) {
			missingDynamic.push(
				`${parentPath} (parent path missing or not an object) in ${[...new Set(entry.files)][0]}`
			);
			continue;
		}
		const objKeys = Object.keys(v as Record<string, unknown>);
		if (objKeys.length === 0) {
			missingDynamic.push(
				`${parentPath} (parent path is empty object) in ${[...new Set(entry.files)][0]}`
			);
			continue;
		}
		// For each non-empty leafPrefix, require at least
		// one matching leaf key.
		for (const leafPrefix of entry.leafPrefixes) {
			if (leafPrefix === '') continue; // pure ${x}.foo case — parent existing is enough
			const matches = objKeys.some((k) => k.startsWith(leafPrefix));
			if (!matches) {
				missingDynamic.push(
					`${parentPath}.${leafPrefix}<...> (no leaf key matches prefix) in ${[...new Set(entry.files)][0]}`
				);
			}
		}
	}
	if (missingDynamic.length === 0) {
		console.log(`  ✓ all ${dynamicEntries.size} dynamic-key parent paths resolve correctly`);
	} else {
		console.log(
			`  ✗ ${missingDynamic.length} dynamic-key parent paths missing or empty in en.json:`
		);
		for (const m of missingDynamic) console.log(`      ${m}`);
		failures++;
	}

	console.log(
		`\n${failures === 0 ? '✓ all' : '✗'} ${scenarios - failures}${failures === 0 ? '' : '/' + scenarios} scenarios passed`
	);
	process.exit(failures === 0 ? 0 : 1);
}

main();
