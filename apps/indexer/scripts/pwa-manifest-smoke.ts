/**
 * PWA manifest smoke.
 *
 * Validates the static manifest file's structure against the
 * W3C manifest spec + Morphit-specific requirements:
 *   - Valid JSON.
 *   - Required fields (name, start_url, display).
 *   - Icons present and well-formed.
 *   - All shortcut URLs are absolute paths within scope.
 *   - Theme + background colors match the dark-mode-only design.
 *   - protocol_handlers, display_override, launch_handler well-formed.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

let scenarios = 0;
let failures = 0;
function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// Resolve from the smoke source file's location, not process.cwd() —
// the smoke runner sets cwd to each app's directory, so cwd-based
// paths are unreliable.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MANIFEST_PATH = resolve(__dirname, '../../web/static/manifest.webmanifest');
const text = readFileSync(MANIFEST_PATH, 'utf8');
const manifest = JSON.parse(text) as Record<string, unknown>;

console.log('\n── PWA manifest ──────────────────────────────────────────\n');

scenario('valid JSON', () => {
	JSON.parse(text);
});

scenario('required fields present', () => {
	for (const k of ['name', 'short_name', 'start_url', 'display', 'icons']) {
		if (!(k in manifest)) throw new Error(`missing ${k}`);
	}
});

scenario('name is "Morphit"', () => {
	if (manifest.name !== 'Morphit') throw new Error(String(manifest.name));
});

scenario('display is "standalone"', () => {
	if (manifest.display !== 'standalone') throw new Error(String(manifest.display));
});

scenario('display_override is well-formed', () => {
	const dor = manifest.display_override;
	if (!Array.isArray(dor)) throw new Error('not array');
	if (dor.length === 0) throw new Error('empty');
	for (const v of dor) {
		if (typeof v !== 'string') throw new Error('non-string entry');
	}
	// "standalone" must appear as a fallback per spec — otherwise
	// browsers without window-controls-overlay support fall back
	// to "browser" which loses the PWA feel.
	if (!dor.includes('standalone')) throw new Error('missing standalone fallback');
});

scenario('start_url is "/"', () => {
	if (manifest.start_url !== '/') throw new Error(String(manifest.start_url));
});

scenario('scope is "/"', () => {
	if (manifest.scope !== '/') throw new Error(String(manifest.scope));
});

scenario('background_color is dark and matches ink-950 page bg', () => {
	// Part 114: corrected from #0a0a0a (true black, wrong) to #0a0e16
	// (ink-950, the actual page background — see apps/web/src/app.css
	// line 119).  The PWA splash screen renders against this color
	// before the app's CSS loads, so a mismatch causes a visible
	// flicker on launch.
	const bg = String(manifest.background_color ?? '');
	if (bg !== '#0a0e16') throw new Error(`bg=${bg} expected #0a0e16`);
});

scenario('theme_color is brand emerald', () => {
	const tc = String(manifest.theme_color ?? '');
	if (tc.toLowerCase() !== '#00da69') throw new Error(`theme=${tc}`);
});

scenario('icons array has entries with both purposes', () => {
	const icons = manifest.icons as Array<Record<string, unknown>>;
	if (!Array.isArray(icons) || icons.length < 2) throw new Error(`icons.length=${icons.length}`);
	const purposes = new Set(icons.map((i) => String(i.purpose ?? '')));
	if (!purposes.has('any')) throw new Error('missing any');
	if (!purposes.has('maskable')) throw new Error('missing maskable');
});

scenario('every icon has src + sizes + type', () => {
	const icons = manifest.icons as Array<Record<string, unknown>>;
	for (const icon of icons) {
		for (const k of ['src', 'sizes', 'type']) {
			if (typeof icon[k] !== 'string')
				throw new Error(`icon missing ${k}: ${JSON.stringify(icon)}`);
		}
	}
});

scenario('protocol_handlers includes web+morphit', () => {
	const ph = manifest.protocol_handlers as Array<Record<string, unknown>>;
	if (!Array.isArray(ph) || ph.length === 0) throw new Error('no protocol_handlers');
	const morphit = ph.find((h) => h.protocol === 'web+morphit');
	if (!morphit) throw new Error('no web+morphit handler');
	if (!String(morphit.url).includes('%s')) throw new Error('handler URL must contain %s');
});

scenario('shortcuts has 3 entries', () => {
	const sc = manifest.shortcuts as Array<unknown>;
	if (!Array.isArray(sc)) throw new Error('not array');
	if (sc.length !== 3) throw new Error(`length=${sc.length}`);
});

scenario('every shortcut has name + url within scope', () => {
	const sc = manifest.shortcuts as Array<Record<string, unknown>>;
	const scope = String(manifest.scope);
	for (const s of sc) {
		if (typeof s.name !== 'string' || s.name.length === 0) throw new Error('missing name');
		const url = String(s.url);
		if (!url.startsWith(scope)) throw new Error(`url ${url} outside scope`);
	}
});

scenario('shortcut URLs are real Morphit routes', () => {
	const sc = manifest.shortcuts as Array<Record<string, unknown>>;
	const validRoutes = new Set(['/post', '/my/orders', '/orderbook']);
	for (const s of sc) {
		const url = String(s.url).split('?')[0]!;
		if (!validRoutes.has(url)) throw new Error(`bad shortcut url: ${url}`);
	}
});

scenario('every shortcut has an icon', () => {
	const sc = manifest.shortcuts as Array<Record<string, unknown>>;
	for (const s of sc) {
		const icons = s.icons as Array<unknown>;
		if (!Array.isArray(icons) || icons.length === 0)
			throw new Error(`shortcut ${s.name} has no icons`);
	}
});

scenario('launch_handler.client_mode is navigate-existing', () => {
	const lh = manifest.launch_handler as Record<string, unknown>;
	if (!lh) throw new Error('missing launch_handler');
	if (lh.client_mode !== 'navigate-existing') throw new Error(`client_mode=${lh.client_mode}`);
});

scenario('lang is set', () => {
	if (typeof manifest.lang !== 'string') throw new Error('lang missing or non-string');
});

scenario('dir is set', () => {
	if (manifest.dir !== 'ltr' && manifest.dir !== 'rtl' && manifest.dir !== 'auto')
		throw new Error(`dir=${manifest.dir}`);
});

scenario('orientation is permissive (any)', () => {
	// "any" lets users rotate the device freely.  Locking to
	// portrait-only is hostile on tablets.  This is a Morphit
	// design choice — we previously had portrait-primary.
	if (manifest.orientation !== 'any') throw new Error(`orientation=${manifest.orientation}`);
});

scenario('share_target is NOT present (deliberate)', () => {
	// We considered adding share_target but Morphit has no
	// page that gracefully receives shared text/URL — the most
	// likely target (/pair) is a keystore-pairing flow, not
	// a share-receiver.  Adding share_target without a real
	// destination would create broken share UX.
	if ('share_target' in manifest)
		throw new Error('share_target present — was it added without a real receiver page?');
});

scenario('id is NOT present (preserves installed-PWA continuity)', () => {
	// Adding `id` would change the PWA identity for users with
	// already-installed instances on next deploy.  Leaving it
	// absent means browsers default to start_url, which has been
	// "/" since first ship.
	if ('id' in manifest) throw new Error('id present — would break existing PWAs');
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
