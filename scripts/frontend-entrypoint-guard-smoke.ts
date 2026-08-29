/**
 * frontend-entrypoint-guard-smoke
 *
 * A real operator's node went fully dark because its shipped `apps/web/build`
 * had every per-locale page but no `index.html`. The build guard trusted the
 * `.shipped` marker without checking, so it kept the incomplete build; nginx then
 * served `/` via `try_files … /index.html`, which — with no index.html — rewrote
 * `/index.html → /index.html` forever (infinite internal redirect → HTTP 500 on
 * every request). This smoke locks in the three protections that make that
 * impossible to ship again:
 *
 *   1. the build guard verifies index.html is present before trusting a .shipped
 *      build (and rebuilds if it's missing);
 *   2. the build guard fails loudly if a fresh vite build didn't emit index.html;
 *   3. the frontend nginx SPA fallback can NOT infinite-loop on a missing
 *      index.html (it routes through a named @spa location that ends in a status
 *      code, not a bare /index.html rewrite).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8');

let failed = 0;
let total = 0;
const check = (name: string, ok: boolean): void => {
	total++;
	console.log(`  ${ok ? '\u2713' : '\u2717'} ${name}`);
	if (!ok) failed++;
};

// ── 1 + 2: the build guard ──────────────────────────────────────────────────
const guard = read('apps/web/scripts/build-shipped-guard.mjs');
// It must gate "keep the shipped build" on index.html actually existing, not on
// the marker alone.
check(
	'build guard requires index.html before trusting a .shipped build (marker alone is not enough)',
	/existsSync\(marker\)\s*&&\s*existsSync\(indexHtml\)/.test(guard)
);
// It must handle "marker present but index.html missing" by rebuilding rather
// than silently keeping the broken build.
check(
	'build guard rebuilds (does not keep) a .shipped build whose index.html is missing',
	/existsSync\(marker\)\s*&&\s*!existsSync\(indexHtml\)/.test(guard)
);
// After the vite build it must FAIL if index.html wasn't produced.
check(
	'build guard fails loudly when a fresh vite build did not emit index.html',
	/!existsSync\(indexHtml\)/.test(guard) && /process\.exit\(1\)/.test(guard)
);

// ── 3: the nginx SPA fallback can't loop ────────────────────────────────────
for (const conf of ['ops/bunkerweb/frontend/nginx.conf', 'ops/nginx/web.conf']) {
	const src = read(conf);
	// No `location /` try_files may end in a bare `/index.html` fallback — that is
	// the exact rewrite-cycle that 500-loops when index.html is absent.
	const loops = /try_files[^;]*\/index\.html\s*;/.test(src);
	check(`${conf}: SPA try_files does not use a loop-prone bare /index.html fallback`, !loops);
	// It must route the fallback through a named location that ends in a status
	// code (so a missing index.html yields a clean error, never a loop).
	check(
		`${conf}: SPA fallback routes through @spa and ends in a status code (no infinite loop possible)`,
		/@spa/.test(src) && /try_files\s+\/index\.html\s*=\d{3}\s*;/.test(src)
	);
}

if (failed > 0) {
	console.error(`\n  ${failed} frontend-entrypoint-guard check(s) FAILED`);
	process.exit(1);
}
console.log(`\n\u2713 all ${total} frontend-entrypoint-guard checks hold`);
