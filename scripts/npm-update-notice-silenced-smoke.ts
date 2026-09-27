#!/usr/bin/env tsx
/**
 * scripts/npm-update-notice-silenced-smoke.ts
 *
 * npm's "New major version of npm available! … To update run: npm install -g
 * npm@…" notice must never reach an operator. Following it is harmful: Morphit
 * ships and pins its own Node/npm, and a global npm upgrade can break an
 * install.
 *
 * WHY THE EARLIER FIXES KEPT MISSING IT. The notice is printed by the npm/npx
 * process that STARTED the command, when that process exits — i.e. by the
 * `npx` in `npx morphit-ops install` (morphit-setup.sh) or `sudo -u morphit npx
 * morphit-ops upgrade` (UPGRADING.md), after all of morphit-ops' own output.
 * morphit-ops sets npm_config_update_notifier=false in its OWN environment,
 * which reaches its children but can never reach its parent; the Ansible global
 * npmrc is written mid-install (after the parent npx has read its config) and
 * does not exist on manual installs. Reproduced on npm 10.9.7: `npx --no-install
 * morphit-ops branding status` printed the notice with every existing fix in
 * place.
 *
 * THE FIX. A project `.npmrc` at the repo root: the outer npm reads it at
 * startup from its working directory (any subdirectory of the install resolves
 * to the workspace root), whichever user runs it — `sudo -u` resets the
 * environment, not the working directory. morphit-setup.sh also passes the
 * setting to its npx explicitly.
 *
 * Invariants:
 *   N-1  The repo-root .npmrc sets update-notifier=false and fund=false.
 *   N-2  npm itself reads it: `npm config get update-notifier` in the repo root,
 *        with no user/global npmrc and no npm_config_* env, says false.
 *   N-3  morphit-setup.sh's hand-off to the wizard passes
 *        npm_config_update_notifier=false to its npx.
 *   N-4  .npmrc ships: not git-ignored, not excluded from the offline bundle,
 *        and (in a git checkout) tracked — the release tarball is built from
 *        the checkout, so an untracked .npmrc would silently not ship.
 *   N-5  The global `morphit-ops` launcher (whose `npm exec` is the parent of
 *        every command) exports the setting, and every upgrade writes it to the
 *        box's global npmrc (a manual install never ran the Ansible task that
 *        does) — and the install does too.
 *   N-5c The heal writes the file itself, root-owned 0644: `npm config set
 *        --location=global` would leave it 0666, world-writable, and any local
 *        account could then add `script-shell=` and run code as root.
 *        Exercised for real on a scratch file (an existing 0666 file is
 *        repaired; a symbolic link is refused).
 *   N-5d Ansible keeps the global npmrc root-owned 0644 after its own
 *        `npm config set`.
 */

import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { ensureQuietNpmrc } from '../apps/ops-cli/src/lib/npmNotice.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
	if (ok) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
		failed++;
	}
}

console.log('\n── npm-update-notice-silenced smoke ──\n');

// N-1
let npmrc = '';
try {
	npmrc = readFileSync(join(REPO, '.npmrc'), 'utf8');
} catch {
	/* reported below */
}
const setting = (key: string): string | null =>
	new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)\\s*$`, 'm').exec(npmrc)?.[1] ?? null;
check(
	'N-1: repo .npmrc sets update-notifier=false and fund=false',
	setting('update-notifier') === 'false' && setting('fund') === 'false',
	`update-notifier=${setting('update-notifier')} fund=${setting('fund')}`
);

// N-2 — npm's own view, isolated from this machine's config.
const scratch = mkdtempSync(join(tmpdir(), 'morphit-npmrc-'));
try {
	const emptyUser = join(scratch, 'user-npmrc');
	const emptyGlobal = join(scratch, 'global-npmrc');
	writeFileSync(emptyUser, '');
	writeFileSync(emptyGlobal, '');
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (!/^npm_config_/i.test(k)) env[k] = v;
	}
	env.npm_config_userconfig = emptyUser;
	env.npm_config_globalconfig = emptyGlobal;
	let got = '';
	try {
		got = execFileSync('npm', ['config', 'get', 'update-notifier'], {
			cwd: REPO,
			env,
			encoding: 'utf8',
			timeout: 60_000
		}).trim();
	} catch (err) {
		got = `error: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
	}
	check(
		'N-2: npm reads it — `npm config get update-notifier` in the install says false',
		got === 'false',
		`got "${got}"`
	);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

// N-3
const setup = readFileSync(join(REPO, 'morphit-setup.sh'), 'utf8');
const handoff =
	setup.split('\n').find((l) => /^\s*exec\b.*npx\b.*morphit-ops\s+install/.test(l)) ?? '';
check(
	'N-3: morphit-setup.sh hands off to the wizard with the notifier off',
	/npm_config_update_notifier=false/.test(handoff),
	`hand-off line: ${handoff || '(not found)'}`
);

// N-4
const gitignore = readFileSync(join(REPO, '.gitignore'), 'utf8');
const bundle = readFileSync(join(REPO, 'scripts', 'build-offline-bundle.sh'), 'utf8');
check(
	'N-4: .npmrc ships (not git-ignored, not excluded from the offline bundle)',
	!/^\s*[^#\s]*npmrc/m.test(gitignore) && !/--exclude=['"]?[^'"\s]*npmrc/.test(bundle)
);
let tracked = true;
let trackDetail = '';
if (existsSync(join(REPO, '.git'))) {
	try {
		execFileSync('git', ['ls-files', '--error-unmatch', '.npmrc'], { cwd: REPO, stdio: 'pipe' });
	} catch {
		tracked = false;
		trackDetail = '.npmrc is not tracked by git — run: git add .npmrc';
	}
	try {
		execFileSync('git', ['check-ignore', '-q', '.npmrc'], { cwd: REPO, stdio: 'pipe' });
		tracked = false;
		trackDetail = '.npmrc is git-ignored';
	} catch {
		/* not ignored — good */
	}
}
check('N-4b: .npmrc is tracked by git (so the release tarball carries it)', tracked, trackDetail);

// N-5 — the launcher's own npm (the parent of every `morphit-ops` command) and
// every other npm on the box.
const launcher = readFileSync(
	join(REPO, 'ops', 'ansible', 'roles', 'morphit', 'templates', 'morphit-ops.j2'),
	'utf8'
);
const beforeExec = launcher.slice(0, launcher.search(/^exec npm exec/m));
check(
	'N-5a: the global morphit-ops launcher turns the notice off before `exec npm exec`',
	/export[^\n]*npm_config_update_notifier=false/.test(beforeExec)
);
const upgradeSrc = readFileSync(
	join(REPO, 'apps', 'ops-cli', 'src', 'commands', 'upgrade.ts'),
	'utf8'
);
const installSrc = readFileSync(
	join(REPO, 'apps', 'ops-cli', 'src', 'commands', 'install.ts'),
	'utf8'
);
check(
	'N-5b: every upgrade and every install writes update-notifier=false to the global npmrc',
	/\['the npm notice heal', \(\) => healNpmUpdateNotice\(\)\]/.test(upgradeSrc) &&
		/from '\.\.\/lib\/npmNotice\.ts'/.test(upgradeSrc) &&
		/healNpmUpdateNotice\(\)/.test(installSrc)
);

// N-5c — for real, on scratch files.
const npmNoticeSrc = readFileSync(
	join(REPO, 'apps', 'ops-cli', 'src', 'lib', 'npmNotice.ts'),
	'utf8'
);
const rcScratch = mkdtempSync(join(tmpdir(), 'npm-notice-smoke-'));
let n5c = '';
try {
	const rc = join(rcScratch, 'etc', 'npmrc');
	const r1 = ensureQuietNpmrc(rc);
	const m1 = statSync(rc).mode & 0o777;
	if (!r1.changed || m1 !== 0o644)
		n5c += `new file: changed=${r1.changed} mode=${m1.toString(8)}; `;
	writeFileSync(rc, 'prefix=/usr/local\nupdate-notifier=true\n');
	chmodSync(rc, 0o666);
	ensureQuietNpmrc(rc);
	const text = readFileSync(rc, 'utf8');
	const m2 = statSync(rc).mode & 0o777;
	if (m2 !== 0o644) n5c += `0666 file left at ${m2.toString(8)}; `;
	if (!/^update-notifier=false$/m.test(text) || !/^fund=false$/m.test(text))
		n5c += 'settings not written; ';
	if (!/^prefix=\/usr\/local$/m.test(text)) n5c += 'existing settings lost; ';
	const link = join(rcScratch, 'link-npmrc');
	symlinkSync(rc, link);
	let refused = false;
	try {
		ensureQuietNpmrc(link);
	} catch {
		refused = true;
	}
	if (!refused) n5c += 'wrote through a symbolic link; ';
} finally {
	rmSync(rcScratch, { recursive: true, force: true });
}
check(
	'N-5c: the heal writes the global npmrc itself, root-owned 0644 (never npm config set, which leaves it 0666)',
	n5c === '' && !/'config',\s*'set'/.test(npmNoticeSrc),
	n5c || 'npmNotice.ts calls `npm config set`'
);

// N-5d
const cloneBuild = readFileSync(
	join(REPO, 'ops', 'ansible', 'roles', 'morphit', 'tasks', 'clone_and_build.yml'),
	'utf8'
);
check(
	'N-5d: Ansible keeps the global npmrc root-owned 0644 after setting it',
	/npm config get globalconfig/.test(cloneBuild) &&
		/mode:\s*["']?0644["']?/.test(cloneBuild.slice(cloneBuild.search(/globalconfig/)))
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.error('✗ npm-update-notice-silenced smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${passed} npm-update-notice-silenced checks passed`);
