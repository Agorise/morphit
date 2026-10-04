#!/usr/bin/env tsx
/**
 * vite-licenses-smoke — the licenses.txt builder (scripts/vite-licenses.ts)
 * run over real module ids from this tree's node_modules: every package whose
 * module is in the bundle is listed with its licence text, code a package
 * embeds is named, the app's own and workspace code is not listed, and the
 * output is the same on every run. The built file itself is checked by
 * scripts/license-disclosure-smoke.ts (repo root).
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildLicensesText, packageRootOf } from './vite-licenses';

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

console.log('');
if (failed > 0) {
	console.error(`✗ ${failed} of ${passed + failed} vite-licenses checks FAILED`);
	process.exit(1);
}
console.log(`✓ all ${passed} vite-licenses checks passed`);
