#!/usr/bin/env tsx
/**
 * removed-static-asset-guard smoke — cp300.
 *
 * FOOTPRINT + REGRESSION GUARD. Some static assets were deliberately
 * removed and MUST NOT silently reappear in the shipped `static/` tree
 * (every file there ships to every deployment).
 *
 * Why this guard exists: `brand/morphit-fee-flow.png` (~475 KB) was
 * removed once (2026-05-06 audit: "drop the PNG, reference the SVG")
 * and later crept back in when a session re-rendered it via rsvg-convert
 * "for blog upload convenience" and the export landed in `static/brand/`
 * instead of `/mnt/user-data/outputs/`. cp299 caught it as unreferenced
 * dead weight; cp300 deleted it again. This smoke makes the deletion
 * STICK — same spirit as the Forgejo-naming regression guard.
 *
 * Rule for the future: a one-off raster export for a blog post goes to
 * `/mnt/user-data/outputs/` (handed to Ken), NEVER committed into the
 * web app's `static/` dir. The SVG source-of-truth
 * (`brand/morphit-fee-flow.svg`, referenced by docs/FEES-AND-REWARDS.md)
 * is the thing that ships.
 *
 * Positive control (anti-no-op): the guard also confirms it can SEE a
 * file that genuinely exists — the retained `morphit-fee-flow.svg`. If
 * that control ever reads as "absent," the existence check itself is
 * broken and every absence assertion below is meaningless, so we fail.
 */

import { existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC = join(__dirname, '..', 'static');

let fails = 0;
let passed = 0;
const ok = (m: string): void => {
	passed++;
	console.log(`  ok   ${m}`);
};
const bad = (m: string): void => {
	console.error(`  FAIL ${m}`);
	fails++;
};

/** Assets that were deliberately removed and must stay out of static/. */
const FORBIDDEN: { path: string; reason: string }[] = [
	{
		path: 'brand/morphit-fee-flow.png',
		reason:
			'orphan raster removed twice; ships ~475 KB for nothing. Use the .svg; blog exports go to /mnt/user-data/outputs.'
	}
];

/** Files that MUST exist — proves the existence check is not a no-op. */
const POSITIVE_CONTROL: string[] = ['brand/morphit-fee-flow.svg'];

console.log('removed-static-asset-guard smoke:');

// 1) Positive control first — if this is broken, nothing else is trustworthy.
for (const rel of POSITIVE_CONTROL) {
	const p = join(STATIC, rel);
	if (existsSync(p) && statSync(p).isFile()) {
		ok(`positive control present: ${rel} (existence check works)`);
	} else {
		bad(
			`positive control MISSING: ${rel} — the existence check is broken, so the absence assertions below cannot be trusted`
		);
	}
}

// 2) Forbidden assets must be absent.
for (const { path: rel, reason } of FORBIDDEN) {
	const p = join(STATIC, rel);
	if (!existsSync(p)) {
		ok(`stays removed: ${rel}`);
	} else {
		const kb = Math.round(statSync(p).size / 1024);
		bad(`reappeared: ${rel} (${kb} KB) — ${reason}`);
	}
}

console.log('\n────────────────────────────────────────────────────────');
if (fails > 0) {
	console.error(`✗ ${fails} of ${passed + fails} scenarios failed`);
	process.exit(1);
}
console.log(`✓ all ${passed} scenarios passed`);
