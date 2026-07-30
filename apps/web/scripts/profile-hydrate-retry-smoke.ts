#!/usr/bin/env tsx
/**
 * profile-hydrate-retry — v1.8.12 (Ken).
 *
 * THE BUG. Display names and avatars were absent "every once in a while" and
 * appeared after a manual refresh. Ken's standard for it was right: "i should
 * never have to refresh the page to see the truth."
 *
 * `profileCache` has always separated a TRANSIENT fetch failure (soft-cached
 * 5s) from an authoritative "no profile" (90s), on the stated reasoning that
 * the short entry would expire and "the next render re-fetches". Nothing ever
 * did: each surface hydrates once per page load (and per loadMore), so on a
 * settled page the soft entry expired into silence and the row kept its
 * identicon until the user navigated away or refreshed.
 *
 * WHY THE RETRY LIVES IN THE CALLER. Two earlier attempts put it inside
 * profileCache and both failed: one blocked first render and broke the tested
 * fail-fast contract; the other needed a notification channel, because updating
 * the cache re-renders nothing. Each surface already owns reactive state —
 * writing to it IS the refresh — so the caller retries and the cache answers
 * the one question only it can: was that a real answer, or a blip?
 *
 * Tamper tests (each must turn this red):
 *   - Remove the retry from either surface.
 *   - Retry on ALL misses rather than only soft ones (re-asking forever for
 *     accounts that genuinely have no profile).
 *   - Make the retry unbounded.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..');
const read = (p: string): string => readFileSync(join(WEB, p), 'utf8');

const SURFACES = [
	['orderbook', 'src/routes/[lang]/orderbook/+page.svelte'],
	['profile', 'src/routes/[lang]/[x+40][account=account]/+page.svelte']
] as const;

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

console.log('\n── profile-hydrate-retry (v1.8.12) ───────────────────\n');

check(
	'the cache reports transient-vs-authoritative misses',
	/export function isSoftMiss\(/.test(read('src/lib/indexer/profileCache.ts')),
	'without this the caller cannot tell a blip from a real absence'
);

for (const [label, path] of SURFACES) {
	const src = read(path);
	const code = src
		.split('\n')
		.filter((l) => !/^\s*(\/\/|\*|\/\*|<!--|-->)/.test(l.trim()))
		.join('\n');

	check(
		`${label}: re-asks after a transient miss`,
		/isSoftMiss\(/.test(code),
		'a soft-cached failure expires into silence unless something asks again'
	);
	check(
		`${label}: retries ONLY soft misses, not every empty profile`,
		!/filter\(\(a\) => next\[a\] == null\)/.test(code),
		're-asking for accounts that genuinely have no profile is pointless traffic'
	);
	check(
		`${label}: the retry is bounded`,
		/attempt >= PROFILE_HYDRATE_RETRIES/.test(code),
		'an unbounded retry against a down indexer is a loop'
	);
	check(
		`${label}: waits past the cache's soft TTL before re-reading`,
		/PROFILE_HYDRATE_RETRY_MS = 5_500/.test(code),
		'retrying inside the 5s soft window just replays the same cached miss'
	);
}

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} profile-hydrate-retry checks passed` : '✗ profile-hydrate-retry FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
