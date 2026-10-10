#!/usr/bin/env tsx
/**
 * vite-licenses-smoke — the licenses.txt builder (scripts/vite-licenses.ts)
 * run over real module ids from this tree's node_modules: every package whose
 * module is in the bundle is listed with its licence text, code a package
 * embeds is named, the app's own and workspace code is not listed, and the
 * output is the same on every run. The built file itself is checked by
 * scripts/license-disclosure-smoke.ts (repo root).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	buildLicensesText,
	fontsIn,
	packageRootOf,
	sourceUrlOf,
	viteHelperRootOf
} from './vite-licenses';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(WEB, 'package.json'));

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = ''): void {
	if (ok) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
		failed++;
	}
}

/** A real file of a package, as Rollup would name the module. */
function moduleOf(pkg: string): string {
	const pj = require.resolve(`${pkg}/package.json`);
	const meta = JSON.parse(readFileSync(pj, 'utf8')) as { module?: string; main?: string };
	const entry = join(dirname(pj), meta.module ?? meta.main ?? 'index.js');
	return existsSync(entry) ? entry : pj;
}

console.log('\n── vite-licenses smoke ───────────────────────────────\n');

check(
	'a scoped package root is found',
	packageRootOf('/x/node_modules/@beblurt/dblurt/lib/index.js') ===
		'/x/node_modules/@beblurt/dblurt'
);
check(
	'a nested node_modules resolves to the innermost package',
	packageRootOf('/x/node_modules/a/node_modules/b/i.js?commonjs-proxy') ===
		'/x/node_modules/a/node_modules/b'
);
check(
	'a virtual module prefix is ignored',
	packageRootOf('\0/x/node_modules/c/i.js') === '/x/node_modules/c'
);
check(
	'app code and workspace packages are not third-party',
	packageRootOf('/repo/apps/web/src/lib/x.ts') === null &&
		packageRootOf('/repo/packages/asset-registry/src/index.ts') === null
);

const ids = [
	moduleOf('@beblurt/dblurt'),
	moduleOf('jspdf'),
	moduleOf('libsodium-wrappers-sumo'),
	moduleOf('qrcode'),
	'/repo/apps/web/src/routes/+page.svelte',
	'\0virtual:morphit-i18n-loaders'
];
const jspdfCode = readFileSync(moduleOf('jspdf'), 'utf8');
const text = buildLicensesText(ids, (id) => (id === moduleOf('jspdf') ? jspdfCode : null));

check(
	'every bundled package is listed',
	['@beblurt/dblurt', 'jspdf', 'libsodium-wrappers-sumo', 'qrcode'].every((p) =>
		text.includes(`\n${p} `)
	),
	text.slice(0, 400)
);
check(
	'exactly the bundled packages (no app code, no virtual modules)',
	/\n4 packages\./.test(text)
);
const dblurtLicence = readFileSync(
	join(packageRootOf(moduleOf('@beblurt/dblurt'))!, 'LICENSE'),
	'utf8'
).trim();
check('the package licence TEXT travels with it (dblurt BSD-3)', text.includes(dblurtLicence));
check(
	'code a package embeds is named (jspdf → rgbcolor)',
	/jspdf [^\n]*\n[\s\S]*?Embeds: rgbcolor/.test(text)
);
check(
	'embedded licence comments are carried (jspdf RGBColor "Use it if you like it")',
	text.includes('@license Use it if you like it')
);
check(
	'the output is deterministic',
	buildLicensesText([...ids].reverse(), (id) => (id === moduleOf('jspdf') ? jspdfCode : null)) ===
		text
);

// ── v1.21.5: what the browser gets that is not a package module ────────────
{
	const withHelper = buildLicensesText([...ids, '\0vite/preload-helper.js']);
	check(
		"Vite's lazy-chunk helper (a virtual module) is listed as Vite",
		/\n5 packages\./.test(withHelper) && /\nvite \d+\.\d+\.\d+\nLicense: MIT/.test(withHelper)
	);
	const vite = withHelper.slice(withHelper.indexOf('\nvite '));
	check(
		"…with Vite's own licence only, not those of the build tooling it bundles",
		vite.includes('Vite is released under the MIT license') &&
			!vite.includes('Licenses of bundled dependencies') &&
			!vite.includes('@rollup/plugin-commonjs')
	);
	check(
		'other virtual modules stay out',
		viteHelperRootOf('\0virtual:morphit-i18n-loaders') === null
	);
}
check(
	'repository shorthands and git URLs become links',
	sourceUrlOf('lukeed/clsx') === 'https://github.com/lukeed/clsx' &&
		sourceUrlOf('github:nodeca/pako') === 'https://github.com/nodeca/pako' &&
		sourceUrlOf('git://github.com/feross/ieee754.git') === 'https://github.com/feross/ieee754' &&
		sourceUrlOf('git+https://github.com/x/y.git') === 'https://github.com/x/y' &&
		sourceUrlOf('https://svelte.dev') === 'https://svelte.dev'
);
{
	const fonts = fontsIn(join(import.meta.dirname, '..', 'static', 'fonts'));
	const served = readdirSync(join(import.meta.dirname, '..', 'static', 'fonts')).filter((f) =>
		f.endsWith('.woff2')
	);
	check(
		'every served font file is listed, under its OFL',
		fonts.length === 1 &&
			fonts[0]!.name === 'Comfortaa' &&
			served.every((f) => fonts[0]!.files.includes(f)) &&
			fonts[0]!.licenseFile.text.includes('SIL OPEN FONT LICENSE Version 1.1')
	);
	const withFonts = buildLicensesText(ids, () => null, fonts);
	check(
		'the font section follows the packages, with the full OFL text and the copyright line',
		/\n4 packages\./.test(withFonts) &&
			withFonts.indexOf('\nComfortaa (font)\n') > withFonts.indexOf('\nqrcode ') &&
			withFonts.includes('Copyright 2011 The Comfortaa Project Authors') &&
			withFonts.includes('Source: https://github.com/alexeiva/comfortaa')
	);
}

console.log('');
if (failed > 0) {
	console.error(`✗ ${failed} of ${passed + failed} vite-licenses checks FAILED`);
	process.exit(1);
}
console.log(`✓ all ${passed} vite-licenses checks passed`);
