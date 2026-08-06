#!/usr/bin/env tsx
/**
 * storage-key-classification — v1.8.11 (Ken, t.txt).
 *
 * THE BUG THIS EXISTS TO PREVENT. Ken signed out of @kentest3, signed in as
 * @kencode, and found kentest3's region setting waiting for him. The cause was
 * not one bad key: it was that keys had been added over two years with no
 * shared answer to "does this belong to the person or to the browser?" Some
 * were account-suffixed, some were mirrored to chain, and some — including
 * `morphit.userPreferences.v1` — were plain globals every account shared.
 *
 * Correcting the keys that happened to be wrong in July 2026 would leave the
 * NEXT one to chance. So `storageKeyRegistry.ts` records the decision for every
 * key, and this smoke fails the build when a key appears in the source that the
 * registry does not mention. Adding a key now forces the question.
 *
 * Tamper tests (each must turn this red):
 *   - `localStorage.setItem('morphit.newThing', …)` without registering it.
 *   - Delete an entry from STORAGE_KEYS that the source still writes.
 *   - Put a person-ish key in the DEVICE tier (it would survive sign-out).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..');
const SRC = join(WEB, 'src');
const REGISTRY = join(SRC, 'lib/storage/storageKeyRegistry.ts');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
		failed++;
	}
};

console.log('\n── storage-key-classification (v1.8.11) ──────────────\n');

const registrySrc = readFileSync(REGISTRY, 'utf8');

/** Every `key:` literal declared in the registry. */
const declared = new Set<string>(
	[...registrySrc.matchAll(/\{\s*key:\s*'([^']+)'/g)].map((m) => m[1]!)
);
check(`the registry declares keys (${declared.size})`, declared.size > 20);

/** Tier of each declared key, for the device-tier safety check below. */
const deviceTier = [...registrySrc.matchAll(/\{\s*key:\s*'([^']+)',\s*tier:\s*'device'/g)].map(
	(m) => m[1]!
);
check(`the device tier is small and deliberate (${deviceTier.length})`, deviceTier.length > 0 && deviceTier.length <= 10, 'a large device tier means keys are surviving sign-out unexamined');

// A device key is left behind on a SHARED machine after sign-out, so none may
// name a person or their content. This mirrors the unit test on the sweep, but
// applies to the registry as the source of truth.
for (const k of deviceTier) {
	check(
		`device key is not person-ish: ${k}`,
		!/name|bio|url|chat|draft|account|profile|peer|message/i.test(k),
		'a key naming user content must not survive an explicit sign-out'
	);
}

/** Walk the web source for literal `morphit.*` storage keys. */
function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === 'node_modules' || entry.startsWith('.')) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		// Skip tests: their fixtures deliberately invent unregistered keys to
		// prove the sweep fails CLOSED, and counting those would be circular.
		else if (/\.(ts|svelte)$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(full);
	}
	return out;
}

const files = walk(SRC);
check(`scanned the web source (${files.length} files)`, files.length > 100);

/** Keys the SOURCE actually uses. Comment lines are stripped: the registry's
 *  own prose and every fix's explanatory comment necessarily quote key names,
 *  and counting those would make the scan self-satisfying. */
const used = new Map<string, string>(); // key -> first file that writes it
for (const file of files) {
	if (file === REGISTRY) continue;
	const code = readFileSync(file, 'utf8')
		.split('\n')
		.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
		.join('\n');
	for (const m of code.matchAll(/'(morphit\.[A-Za-z0-9_.]+)'/g)) {
		const key = m[1]!;
		// Trailing-dot forms are prefixes built at runtime (`morphit.draft.` +
		// id); the registry declares the prefix, so normalise before matching.
		const norm = key.endsWith('.') ? key.slice(0, -1) : key;
		if (!used.has(norm)) used.set(norm, file.replace(`${WEB}/`, ''));
	}
}
check(`found storage keys in use (${used.size})`, used.size > 15);

/** Exact match, or a declared prefix (suffixed + namespaced families). */
const isClassified = (key: string): boolean => {
	for (const d of declared) {
		if (key === d || key.startsWith(`${d}.`)) return true;
	}
	return false;
};

const unclassified: string[] = [];
for (const [key, file] of used) {
	if (!isClassified(key)) unclassified.push(`${key}  (${file})`);
}
check(
	'every storage key in the source is classified in the registry',
	unclassified.length === 0,
	unclassified.length > 0
		? `unclassified:\n      ${unclassified.join('\n      ')}\n    → add each to STORAGE_KEYS with a tier: is it the PERSON's (account) or the BROWSER's (device)?`
		: ''
);

// The leak that started this, pinned by name so it cannot silently regress to
// a device key and start surviving sign-out again.
check(
	'userPreferences is classified ACCOUNT, not device',
	/key: 'morphit\.userPreferences\.v1',\s*tier: 'account'/.test(registrySrc),
	'this is the key whose region value followed Ken from kentest3 into kencode'
);
check(
	'both syndication opt-ins are mirrored to chain (v1.8.11)',
	/key: 'morphit\.syndication\.firstTradeAnnounce',\s*tier: 'account',\s*protection: 'mirrored'/.test(
		registrySrc
	) &&
		/key: 'morphit\.syndication\.orderBlogDefault',\s*tier: 'account',\s*protection: 'mirrored'/.test(
			registrySrc
		),
	'they publish on the user\'s behalf, so they must follow the account rather than the browser'
);

// Every ACCOUNT key must declare HOW it is protected — an account key with no
// protection is exactly the shape of the original bug.
const accountWithoutProtection = [
	...registrySrc.matchAll(/\{\s*key: '([^']+)',\s*tier: 'account',\s*note:/g)
].map((m) => m[1]!);
check(
	'no ACCOUNT key is missing a protection field',
	accountWithoutProtection.length === 0,
	`missing protection: ${accountWithoutProtection.join(', ')}`
);

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} storage-key-classification checks passed` : '✗ storage-key-classification FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
