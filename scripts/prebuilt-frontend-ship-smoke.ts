/**
 * Morphit — prebuilt-frontend shipping smoke (cp750).
 *
 * THE BUG THIS EXISTS TO CATCH. A federated operator who REBUILDS the frontend
 * locally cannot match @morphit's on-chain build-integrity hashes (Morphit builds
 * are not byte-reproducible across machines), so an honest instance trips the
 * scary red "Build integrity check failed" banner. The fix (option A) ships the
 * CANONICAL prebuilt frontend in the release and has the install + upgrade DEPLOY
 * those exact bytes instead of rebuilding — with a rebuild FALLBACK if the
 * prebuilt is ever absent, so nothing hard-fails. This smoke pins all three legs.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  \u2713 ${label}`);
	} else {
		failed++;
		console.log(`  \u2717 ${label}`);
	}
}

// ─── 1. release.yml builds the canonical frontend + ships apps/web/build ───
const release = read('.forgejo/workflows/release.yml');
check('release builds the canonical web frontend before packaging', /npm run build -w apps\/web/.test(release));
check(
	'release tarball no longer EXCLUDES apps/*/build (so apps/web/build ships)',
	!/--exclude='\.\/apps\/\*\/build'/.test(release)
);
check(
	'release still excludes the .svelte-kit intermediate',
	/--exclude='\.\/apps\/\*\/\.svelte-kit'/.test(release)
);

// ─── 2. install copies the shipped build + restores it over any local rebuild ──
const cab = read('ops/ansible/roles/morphit/tasks/clone_and_build.yml');
check(
	'install copy no longer excludes ./apps/*/build',
	!/--exclude=\.\/apps\/\*\/build/.test(cab)
);
check(
	'install preserves the shipped build before the workspace build',
	/cp -a apps\/web\/build apps\/web\/\.build-shipped/.test(cab)
);
check(
	'install restores the canonical shipped build over the local rebuild',
	/mv apps\/web\/\.build-shipped apps\/web\/build/.test(cab)
);

// ─── 3. upgrade deploys the shipped build if present, else rebuilds (fallback) ──
const upgrade = read('apps/ops-cli/src/commands/upgrade.ts');
check(
	'upgrade checks for the shipped prebuilt (apps/web/build/index.html)',
	/existsSync\(shippedBuild\)/.test(upgrade) &&
		/'apps', 'web', 'build', 'index\.html'/.test(upgrade)
);
check(
	'upgrade still rebuilds as a FALLBACK when no prebuilt is shipped',
	/No prebuilt frontend in this release[\s\S]{0,120}runOrThrow\('npm', \['run', 'build'\]/.test(upgrade)
);

// ─── 4. build guard: `npm run build` deploys the shipped build if marked ───
const webPkg = JSON.parse(read('apps/web/package.json')) as { scripts: Record<string, string> };
check('apps/web build script routes through the shipped-build guard', /build-shipped-guard\.mjs/.test(webPkg.scripts.build ?? ''));
check('apps/web keeps the real vite build as build:vite', (webPkg.scripts['build:vite'] ?? '') === 'vite build');
const guard = read('apps/web/scripts/build-shipped-guard.mjs');
check('guard skips vite build when the .shipped marker is present', /build.*\.shipped/.test(guard) && /existsSync\(marker\)/.test(guard));
check('guard falls back to build:vite when unmarked (CI / source checkout)', /build:vite/.test(guard));
check('release drops the .shipped marker after building the canonical frontend', /touch apps\/web\/build\/\.shipped/.test(release));

console.log(`\n${passed} passed, ${failed} failed`);
console.log(
	failed === 0
		? `\u2713 all ${passed} prebuilt-frontend-ship checks passed`
		: '\u2717 prebuilt-frontend-ship FAILED'
);
process.exit(failed === 0 ? 0 : 1);
