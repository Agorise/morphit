#!/usr/bin/env node
/**
 * morphit-ops bin launcher (cp162).
 *
 * This is the published `bin` entry.  It exists to make the CLI
 * robust across every install path, eliminating the cp161
 * "command not found" failure class for good:
 *
 *   - PREFERRED: if `dist/main.js` exists (the esbuild bundle,
 *     produced by `npm run build` — which the Ansible playbook
 *     runs via `npm run build --workspaces --if-present`, and
 *     which operators run explicitly per the docs), exec it under
 *     plain `node`.  No tsx, no transpile-at-startup.
 *
 *   - FALLBACK: if `dist/main.js` is absent (e.g. a manual clone
 *     where the operator ran `npm install` but not yet
 *     `npm run build`), fall back to running the TypeScript source
 *     via tsx.  This preserves the pre-cp162 behavior so the bin
 *     never points at a missing file.
 *
 * Either way `npx morphit-ops <cmd>` / the bin symlink resolves to
 * a working tool.  The shim itself is plain JS with a node shebang,
 * so it always runs under node with zero dependencies of its own.
 *
 * Why a shim instead of pointing `bin` straight at dist/main.js:
 * a bare `bin -> dist/main.js` would break in any install path
 * that hasn't run the build yet (the manual `npm install`-only
 * flow doesn't build workspaces — only `cd apps/web && npm run
 * build` is in the manual docs).  Pointing `bin` straight at the
 * source needs tsx at runtime (the thing cp162 removes).  The shim
 * gets the best of both: compiled-and-fast when built, still-works
 * when not.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distEntry = resolve(pkgRoot, 'dist/main.js');
const srcEntry = resolve(pkgRoot, 'src/main.ts');
const args = process.argv.slice(2);

let child;
if (existsSync(distEntry)) {
	// Compiled path: run the bundle under plain node. No tsx.
	child = spawnSync(process.execPath, [distEntry, ...args], {
		stdio: 'inherit'
	});
} else {
	// Fallback: run TS source via tsx.  `tsx` resolves from the
	// workspace's node_modules/.bin (npm puts it on PATH for bin
	// scripts); if invoked in a bare shell, `npx tsx` finds the
	// local tsx.  We use the node_modules/.bin/tsx path directly
	// when available for speed + offline-safety, else fall back to
	// `npx tsx`.
	const localTsx = resolve(pkgRoot, '..', '..', 'node_modules', '.bin', 'tsx');
	if (existsSync(localTsx)) {
		child = spawnSync(localTsx, [srcEntry, ...args], { stdio: 'inherit' });
	} else {
		child = spawnSync('npx', ['tsx', srcEntry, ...args], {
			stdio: 'inherit'
		});
	}
}

if (child.error) {
	console.error(`morphit-ops: failed to launch — ${child.error.message}`);
	process.exit(1);
}
process.exit(child.status ?? 1);
