/**
 * `morphit-ops branding apply` draws icons with rsvg-convert / ImageMagick,
 * one synchronous call after another. Run in the CLI's own process that froze
 * its spinner for the whole wait. It now runs in a child (the CLI itself,
 * `branding __apply-child`): the event loop — and so the spinner — keeps
 * turning, and the result is the same as in-process.
 *
 * And when the PNGs cannot be drawn, the reason given is the real one: an
 * ImageMagick without SVG support is not "neither rsvg-convert nor
 * ImageMagick".
 *
 * A small fixture build (the real slot builder makes its .brand-slots.json);
 * stand-in rasterizers on PATH.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyBranding, type BrandingSettings } from '../src/lib/branding.ts';
import { APPLY_CHILD, applyBrandingAsync } from '../src/commands/branding.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const SLOT_BUILDER = join(REPO, 'scripts', 'build-brand-slots.mjs');
const M = '⁠';
const LOGO_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="357" height="250"><rect width="357" height="250" fill="#0f0"/></svg>';

let root = '';
let buildDir = '';
let brandDir = '';
let bin = '';
const savedPath = process.env.PATH;

function write(rel: string, body: string): void {
	const p = join(buildDir, rel);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, body);
}
function tool(name: string, body: string): void {
	writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
	chmodSync(join(bin, name), 0o755);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'branding-async-'));
	buildDir = join(root, 'build');
	brandDir = join(root, 'branding');
	bin = join(root, 'bin');
	mkdirSync(buildDir, { recursive: true });
	mkdirSync(brandDir, { recursive: true });
	mkdirSync(bin, { recursive: true });
	write(
		'index.html',
		`<!doctype html><html lang="en"><head><title>${M}Morphit${M}</title></head><body></body></html>`
	);
	write(
		'en/login.html',
		`<!doctype html><html lang="en"><head><title>Sign in to ${M}Morphit${M}</title></head><body></body></html>`
	);
	write('manifest.webmanifest', JSON.stringify({ name: 'Morphit', short_name: 'Morphit' }) + '\n');
	const r = spawnSync(process.execPath, [SLOT_BUILDER, buildDir], { encoding: 'utf8' });
	expect(r.status, r.stderr).toBe(0);
	writeFileSync(join(brandDir, 'icon.svg'), LOGO_SVG);
	// Only these on PATH: a shell, sleep, node — and the stand-in rasterizers.
	for (const t of ['sh', 'sleep']) {
		const w = spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim();
		symlinkSync(w, join(bin, t));
	}
	symlinkSync(process.execPath, join(bin, 'node'));
	process.env.PATH = bin;
});
afterEach(() => {
	process.env.PATH = savedPath;
	rmSync(root, { recursive: true, force: true });
});

const settings = (): BrandingSettings => ({
	brandName: null,
	invalidBrandName: null,
	shortName: null,
	dir: brandDir
});

describe('branding apply in a child process', () => {
	it('the event loop keeps turning while the icons are drawn, and the result is the same', async () => {
		// A slow rasterizer that fails (as on a box without one that works).
		tool('rsvg-convert', 'sleep 0.5; exit 1');
		let ticks = 0;
		const timer = setInterval(() => ticks++, 100);
		let r;
		try {
			r = await applyBrandingAsync(
				{ buildDir, settings: settings(), dryRun: true },
				{
					cmd: join(REPO, 'node_modules', '.bin', 'tsx'),
					args: [join(REPO, 'apps', 'ops-cli', 'src', 'main.ts'), 'branding', APPLY_CHILD]
				}
			);
		} finally {
			clearInterval(timer);
		}
		expect(ticks).toBeGreaterThanOrEqual(5);
		expect(r.rasterizerMissing).toBe(true);
		const here = applyBranding({ buildDir, settings: settings(), dryRun: true });
		expect(r).toEqual(here);
	}, 120_000);
});

describe('why the PNGs could not be drawn', () => {
	it('ImageMagick without SVG support: said so, and which package gives it', () => {
		tool('convert', 'exit 1');
		const r = applyBranding({ buildDir, settings: settings(), dryRun: true });
		const w = r.warnings.join(' ');
		expect(w).toMatch(/ImageMagick on this server cannot read SVG files/);
		expect(w).toMatch(/sudo apt install librsvg2-bin/);
		expect(w).not.toMatch(/neither rsvg-convert nor ImageMagick/);
	});

	it('nothing at all: neither', () => {
		const r = applyBranding({ buildDir, settings: settings(), dryRun: true });
		expect(r.warnings.join(' ')).toMatch(/neither rsvg-convert nor ImageMagick/);
	});
});
