#!/usr/bin/env tsx
/**
 * avatar-size-thresholds — v1.8.10 (the maintainer, t.txt).
 *
 * THE BUG THIS EXISTS TO CATCH. The settings page rendered the avatar preview's
 * size line and its red warning from two HARDCODED numbers — 2048 (warn) and
 * 3072 ("maximum") — while the avatar module's real constants were
 * SOFT_WARN_AVATAR_BYTES = 4096 and MAX_AVATAR_BYTES = 6144. Both hardcoded
 * values were wrong, and each produced its own user-visible lie:
 *
 *   • The preview said "of 3.0 KB maximum" for a cap that does not exist, so a
 *     3.5 KB avatar was reported as OVER a limit it was comfortably under.
 *   • The warning fired above 2048 — a third of the real cap — so a perfectly
 *     fine 2.9 KB image got a red error claiming it was near the limit.
 *   • There was only ONE message, so a file that genuinely exceeded the cap and
 *     could not be broadcast at all was told, reassuringly, that it was
 *     "getting close to the size limit".
 *
 * the maintainer hit all three. The page now mirrors the module's constants and renders
 * three distinct states (fine / approaching / over).
 *
 * WHY MIRRORED, NOT IMPORTED: `$lib/avatar` carries the SVG sanitizer, minifier
 * and raster encoder and is deliberately lazy-imported, so pulling it in
 * statically just to read two numbers would drag all of that into the initial
 * bundle. This smoke is the price of that decision — it makes the mirror
 * non-drifting, which is the only thing a duplicated constant needs.
 *
 * Tamper tests (each must turn this red):
 *   - Change either constant in the settings page → parity check fails.
 *   - Change either constant in $lib/avatar → parity check fails.
 *   - Delete the over-cap branch → the three-state check fails.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..');
const SETTINGS = join(WEB, 'src/routes/[lang]/settings/+page.svelte');
const AVATAR = join(WEB, 'src/lib/avatar/index.ts');

const settings = readFileSync(SETTINGS, 'utf8');
const avatar = readFileSync(AVATAR, 'utf8');
/** Comments are stripped for the anti-pattern scan: this fix's own comment
 *  necessarily names the wrong numbers it replaced (2048 / 3072), and a naive
 *  scan would flag the documentation as the bug. */
const settingsCode = settings
	.split('\n')
	.filter((l) => !/^\s*(\/\/|\*|\/\*|<!--|-->)/.test(l.trim()))
	.join('\n');

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

console.log('\n── avatar-size-thresholds (v1.8.10) ──────────────────\n');

// ─── the module's canonical hard cap ─────────────────────────────
const modCap = /export const MAX_AVATAR_BYTES\s*=\s*(\d+)/.exec(avatar)?.[1];
check('the avatar module exports a hard cap', modCap !== undefined);

// ─── the settings page mirrors the cap; the soft warn is GONE (v1.16.5) ──
const uiCap = /const AVATAR_CAP_BYTES\s*=\s*(\d+)/.exec(settingsCode)?.[1];
check('the settings page declares a named cap constant', uiCap !== undefined);
check(
	`the mirrored cap (${uiCap ?? '?'}) equals the module's (${modCap ?? '?'})`,
	uiCap !== undefined && uiCap === modCap,
	'the preview would state a maximum the code does not enforce'
);
// the maintainer (v1.16.5): the amber "getting close to the size limit" nag was removed —
// a file comfortably under the cap needs no warning. Pin that it stays gone.
check(
	'the soft-warn nag is gone from the UI (v1.16.5)',
	!/AVATAR_SOFT_WARN_BYTES/.test(settingsCode) && !/preview_getting_large/.test(settingsCode),
	're-introducing a soft warn brings back the clutter the maintainer removed'
);

// ─── no stray magic numbers left in the avatar preview ───────────
check(
	'the preview no longer hardcodes a cap in formatBytes',
	!/formatBytes\(\s*\d+\s*\)/.test(settingsCode),
	'a literal byte count here is exactly how the 3072 lie survived'
);
check(
	'the size comparison uses the named constant, not a literal',
	!/avatarStagedBytes\s*>\s*\d+/.test(settingsCode),
	'comparing against a literal re-introduces the drift this smoke exists to stop'
);

// ─── the one remaining state: over the hard cap ──────────────────
check(
	'the OVER-CAP state exists (the only size warning now)',
	settingsCode.includes('avatarStagedBytes > AVATAR_CAP_BYTES') && /preview_too_large/.test(settingsCode),
	'without the hard-cap branch an over-limit file broadcasts and is rejected on-chain'
);

// ─── the layout fix that stopped the text squishing ──────────────
check(
	'the size text column can use the space beside the 96px avatar',
	/min-w-0 flex-1 text-sm/.test(settings),
	'without a width basis the column is squeezed to a few characters per line'
);

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} avatar-size-thresholds checks passed` : '✗ avatar-size-thresholds FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
