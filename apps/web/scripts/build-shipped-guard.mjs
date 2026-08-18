/**
 * apps/web build guard (cp751).
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
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const marker = join(webRoot, 'build', '.shipped');

if (existsSync(marker)) {
	console.log(
		'apps/web: using the prebuilt frontend shipped in this release (skipping vite build to keep byte-for-byte parity with the on-chain hashes).'
	);
	process.exit(0);
}

// No shipped build → this is CI or a source checkout: do the real build.
const r = spawnSync('npm', ['run', 'build:vite'], {
	stdio: 'inherit',
	cwd: webRoot,
	shell: process.platform === 'win32'
});
process.exit(r.status ?? 1);
