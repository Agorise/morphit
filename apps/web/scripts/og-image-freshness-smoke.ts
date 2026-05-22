#!/usr/bin/env tsx
/**
 * apps/web/scripts/og-image-freshness-smoke.ts
 *
 * Structural Defense #40 — OG image PNG freshness (cp112).
 *
 * `apps/web/static/og-image.svg` is the source of truth for the
 * social-share OG card.  But Twitter/X, LinkedIn, Slack, and Discord
 * don't reliably render SVG OG images (Twitter rejects SVG outright
 * per their card spec).  So `og-image.png` ships alongside as the
 * primary `og:image` / `twitter:image`, regenerated via
 * `scripts/build-og-image-png.sh`.
 *
 * Same shape as `mediakit-freshness-smoke.ts`: if the PNG is older
 * than its SVG source (or missing entirely), CI fails before tarball.
 *
 * Catches the recurring class:
 *   1. Designer updates og-image.svg
 *   2. Forgets to re-run build-og-image-png.sh
 *   3. PNG ships stale → Twitter/LinkedIn/etc. share previews show
 *      the OLD design while the page's SVG shows the NEW one.
 *
 * Scenarios:
 *   I-1: og-image.svg exists (source of truth committed)
 *   I-2: og-image.png exists (regeneration not skipped)
 *   I-3: og-image.png mtime >= og-image.svg mtime
 *   I-4: og-image.png is 1200×630 (Twitter/Facebook required size)
 *   I-5: og-image.png is under 5 MB (Twitter Card hard cap)
 *   I-6: build-og-image-png.sh exists at the documented path
 */

import { existsSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

const SVG = join(REPO, 'apps/web/static/og-image.svg');
const PNG = join(REPO, 'apps/web/static/og-image.png');
const BUILDER = join(REPO, 'scripts/build-og-image-png.sh');

let failed = 0;
let passed = 0;
function pass(name: string): void {
	console.log(`  ✓ ${name}`);
	passed++;
}
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`);
	console.error(`      ${detail}`);
	failed++;
}

console.log('\n── og-image-freshness smoke (cp112) ───────────────────\n');

// I-1
if (existsSync(SVG)) {
	pass('og-image.svg exists');
} else {
	fail('og-image.svg exists', `missing source file at ${SVG}`);
}

// I-2
if (existsSync(PNG)) {
	pass('og-image.png exists');
} else {
	fail(
		'og-image.png exists',
		`missing — run 'bash scripts/build-og-image-png.sh' to regenerate`
	);
}

// I-3
if (existsSync(SVG) && existsSync(PNG)) {
	const svgMtime = statSync(SVG).mtimeMs;
	const pngMtime = statSync(PNG).mtimeMs;
	// Slack allowance: 2-second timestamp granularity in some filesystems
	// (CI runners sometimes report whole-second mtimes).  A 2-second
	// slack absorbs that without admitting actual stale builds.
	if (pngMtime >= svgMtime - 2000) {
		pass('og-image.png mtime >= og-image.svg mtime');
	} else {
		const drift = Math.round((svgMtime - pngMtime) / 1000);
		fail(
			'og-image.png mtime >= og-image.svg mtime',
			`PNG is ${drift}s older than SVG — run 'bash scripts/build-og-image-png.sh'`
		);
	}
}

// I-4: 1200×630
if (existsSync(PNG)) {
	const png = readFileSync(PNG);
	// PNG IHDR chunk starts at byte 16 (after 8-byte signature + 8-byte
	// length+type header); width is bytes 16..19 BE, height 20..23 BE.
	if (png.length >= 24 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47) {
		const w = (png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19];
		const h = (png[20] << 24) | (png[21] << 16) | (png[22] << 8) | png[23];
		if (w === 1200 && h === 630) {
			pass(`og-image.png is 1200×630 (Twitter / Facebook OG spec)`);
		} else {
			fail(
				`og-image.png is 1200×630`,
				`actual ${w}×${h} — Twitter Card summary_large_image requires 2:1 ratio at 1200×630 or larger`
			);
		}
	} else {
		fail('og-image.png is 1200×630', `file at ${PNG} is not a valid PNG (header check failed)`);
	}
}

// I-5: < 5 MB (Twitter cap)
if (existsSync(PNG)) {
	const bytes = statSync(PNG).size;
	if (bytes <= 5 * 1024 * 1024) {
		pass(`og-image.png is under 5 MB (${(bytes / 1024).toFixed(1)} KB)`);
	} else {
		fail(
			`og-image.png is under 5 MB`,
			`${(bytes / 1024 / 1024).toFixed(2)} MB — Twitter Card hard cap is 5 MB`
		);
	}
}

// I-6: builder script committed
if (existsSync(BUILDER)) {
	pass('scripts/build-og-image-png.sh is committed');
} else {
	fail(
		'scripts/build-og-image-png.sh is committed',
		`builder script missing at ${BUILDER}; readers can't regenerate the PNG when they edit the SVG`
	);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error(`\nog-image-freshness smoke FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} og-image-freshness checks pass`);
