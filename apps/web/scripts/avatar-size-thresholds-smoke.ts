#!/usr/bin/env tsx
/**
 * avatar-size-thresholds — v1.8.10 (Ken, t.txt).
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
 * Ken hit all three. The page now mirrors the module's constants and renders
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

// ─── the module's canonical values ───────────────────────────────
const modCap = /export const MAX_AVATAR_BYTES\s*=\s*(\d+)/.exec(avatar)?.[1];
const modWarn = /export const SOFT_WARN_AVATAR_BYTES\s*=\s*(\d+)/.exec(avatar)?.[1];
check('the avatar module exports a hard cap', modCap !== undefined);
check('the avatar module exports a soft-warn threshold', modWarn !== undefined);
check(
	`the soft-warn threshold (${modWarn ?? '?'}) is below the hard cap (${modCap ?? '?'})`,
	modCap !== undefined && modWarn !== undefined && Number(modWarn) < Number(modCap),
	'a warn threshold at or above the cap can never produce an "approaching" state'
);

// ─── the settings page mirrors them exactly ──────────────────────
const uiCap = /const AVATAR_CAP_BYTES\s*=\s*(\d+)/.exec(settingsCode)?.[1];
const uiWarn = /const AVATAR_SOFT_WARN_BYTES\s*=\s*(\d+)/.exec(settingsCode)?.[1];
check('the settings page declares a named cap constant', uiCap !== undefined);
check('the settings page declares a named soft-warn constant', uiWarn !== undefined);
check(
	`the mirrored cap (${uiCap ?? '?'}) equals the module's (${modCap ?? '?'})`,
	uiCap !== undefined && uiCap === modCap,
	'the preview would state a maximum the code does not enforce'
);
check(
	`the mirrored soft-warn (${uiWarn ?? '?'}) equals the module's (${modWarn ?? '?'})`,
	uiWarn !== undefined && uiWarn === modWarn,
	'the warning would fire at a size unrelated to the real limit'
);

// ─── no stray magic numbers left in the avatar preview ───────────
check(
	'the preview no longer hardcodes a cap in formatBytes',
	!/formatBytes\(\s*\d+\s*\)/.test(settingsCode),
	'a literal byte count here is exactly how the 3072 lie survived'
);
check(
	'the size comparisons use the named constants, not literals',
	!/avatarStagedBytes\s*>\s*\d+/.test(settingsCode),
	'comparing against a literal re-introduces the drift this smoke exists to stop'
);

// ─── three distinct states, in the right order ───────────────────
const overIdx = settingsCode.indexOf('avatarStagedBytes > AVATAR_CAP_BYTES');
const warnIdx = settingsCode.indexOf('avatarStagedBytes > AVATAR_SOFT_WARN_BYTES');
check(
	'an OVER-CAP state exists and is distinct from the approaching one',
	overIdx !== -1 && warnIdx !== -1 && /preview_too_large/.test(settingsCode),
	'one message for both states told an over-limit user they were merely "getting close"'
);
check(
	'the over-cap branch is tested BEFORE the approaching branch',
	overIdx !== -1 && warnIdx !== -1 && overIdx < warnIdx,
	'checked second, every over-cap file would match "approaching" first and never report as too large'
);
check(
	'the two states are mutually exclusive (else-if, not two independent ifs)',
	/\{:else if\s+avatarStagedBytes\s*>\s*AVATAR_SOFT_WARN_BYTES\}/.test(settingsCode),
	'independent ifs would render both messages at once for an over-cap file'
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
