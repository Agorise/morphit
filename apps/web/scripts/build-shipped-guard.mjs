/**
 * apps/web build guard (hardened cp-frontend-integrity).
 *
 * WHY THIS EXISTS. Federated operators must serve @morphit's EXACT frontend bytes
 * to pass the on-chain build-integrity check — a local rebuild is not
 * byte-reproducible and trips the scary red tamper banner. The release ships a
 * canonical prebuilt frontend (apps/web/build, marked with a `.shipped` file).
 *
 * The catch: `morphit-ops upgrade` runs the code of the version you're upgrading
 * FROM, so an older upgrade path still calls `npm run build` here. Because that
 * `build` script always comes from the NEW tarball, putting the decision HERE
 * makes the shipped build win regardless of how old the upgrading node's ops-cli
 * is. If the marker is present, we skip the (non-reproducible) vite build and keep
 * the shipped bytes as-is. Otherwise — CI, or a source checkout — we build.
 *
 * HARDENING (why the index.html checks below exist). A shipped OR freshly-built
 * `build/` that is missing its root entry point `index.html` is catastrophic: the
 * frontend nginx serves `/` via `try_files … /index.html`, and with no
 * index.html that rewrites to itself forever → an infinite redirect loop → HTTP
 * 500 on every request. A real operator's node went fully dark this way — the
 * build had every per-locale page but no index.html, yet passed as "success" and
 * deployed. So we now: (1) never trust a `.shipped` marker whose index.html is
 * absent — treat it as incomplete and rebuild so the node at least serves; and
 * (2) after any vite build, assert index.html exists and FAIL LOUDLY if not, so
 * an incomplete build can never masquerade as a good one and take a site down.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const buildDir = join(webRoot, 'build');
const marker = join(buildDir, '.shipped');
const indexHtml = join(buildDir, 'index.html');

if (existsSync(marker) && existsSync(indexHtml)) {
	console.log(
		'apps/web: using the prebuilt frontend shipped in this release (skipping vite build to keep byte-for-byte parity with the on-chain hashes).'
	);
	process.exit(0);
}
if (existsSync(marker) && !existsSync(indexHtml)) {
	console.error(
		'apps/web: a .shipped marker is present but build/index.html is MISSING — the shipped frontend is incomplete and would 500-loop at "/". Rebuilding from source so this node still serves (note: a local rebuild is not byte-reproducible and may show the build-integrity banner until the next clean upgrade).'
	);
	// fall through to the real build
}

// No shipped build (or an incomplete one) → CI, a source checkout, or self-heal.
const r = spawnSync('npm', ['run', 'build:vite'], {
	stdio: 'inherit',
	cwd: webRoot,
	shell: process.platform === 'win32'
});
if ((r.status ?? 1) !== 0) {
	console.error('apps/web: vite build failed.');
	process.exit(r.status ?? 1);
}
// adapter-static writes the SPA fallback to index.html as its LAST step; if it's
// absent the build is incomplete (partial failure, OOM mid-build, etc.). Refuse
// to pass — a missing index.html deploys a frontend that 500-loops on every hit.
if (!existsSync(indexHtml)) {
	console.error(
		'apps/web: vite build finished but build/index.html is MISSING — the frontend is incomplete and would not serve "/" (nginx would infinite-loop → 500). Aborting so a broken frontend never deploys. Re-run the build; if it persists, check for an out-of-memory kill or a prerender error on the root route.'
	);
	process.exit(1);
}
// Per-instance branding (docs/BRANDING.md): the adapter wrapper in
// svelte.config.js has already recorded every prerendered brand slot into
// build/.brand-slots.json and stripped the invisible slot markers. Re-run it as a
// safety net (a no-op on a processed build) BEFORE the postbuild verify.json
// hashes the build: a failure here is a real bug (a marker leaked or was left
// unpaired, or the map is missing) and must stop the build.
const slots = spawnSync(
	process.execPath,
	[join(webRoot, '..', '..', 'scripts', 'build-brand-slots.mjs'), buildDir],
	{
		stdio: 'inherit',
		cwd: webRoot
	}
);
if ((slots.status ?? 1) !== 0) {
	console.error('apps/web: brand-slot post-processing failed (scripts/build-brand-slots.mjs).');
	process.exit(slots.status ?? 1);
}
// Per-instance site origin (scripts/origin-slots.mjs): record every place
// a prerendered page or a static SEO file names the build origin, strip the
// page markers and shift the brand-slot offsets to match — after the brand
// slots (whose offsets it adjusts) and before verify.json hashes the build.
const origins = spawnSync(
	process.execPath,
	[join(webRoot, 'scripts', 'origin-slots.mjs'), 'record', buildDir],
	{ stdio: 'inherit', cwd: webRoot }
);
if ((origins.status ?? 1) !== 0) {
	console.error('apps/web: site-origin post-processing failed (scripts/origin-slots.mjs).');
	process.exit(origins.status ?? 1);
}
console.log('apps/web: build complete — root entry point (index.html) present.');
process.exit(0);
