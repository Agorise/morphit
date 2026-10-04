/**
 * release-packers-exclude-private-smoke.
 *
 * `private/` at the repository root is the maintainer's private handoff (the
 * internal journals: see private/README.md on his machine). It must never be
 * committed and never ship. This smoke RUNS every tool that packs or copies the
 * source tree, on a scratch tree that holds a `private/` folder, and checks the
 * result:
 *   - the release job's "Build release tarball" step (.forgejo/workflows/release.yml);
 *   - scripts/build-offline-bundle.sh (its --tar-only seam packs with the
 *     bundle's own excludes);
 *   - scripts/release-sign.sh (its tar path for a tree without .git);
 *   - the Ansible local-install copy (roles/morphit/tasks/clone_and_build.yml);
 *   - git: `private/` is ignored, so `git add -A` never stages it.
 * Each check also requires a public file to be present, so a packer that packs
 * nothing cannot pass. (The IPFS seed stages the release tarball itself, so it
 * is covered by the release job's check.)
 *
 *   tsx scripts/release-packers-exclude-private-smoke.ts [--root <tree>]
 */
import { spawnSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import yaml from 'js-yaml';

const argRoot = process.argv.indexOf('--root');
const ROOT = resolve(argRoot > 0 ? process.argv[argRoot + 1]! : join(__dirname, '..'));

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};

const PRIVATE_FILES = ['private/README.md', 'private/TARBALL.md', 'private/docs/REVISIT-LIST.md'];
const PUBLIC_FILE = 'docs/PUBLIC.md';

/** A small tree shaped like the repository, with a private/ folder in it. */
function scratchTree(): string {
	const t = mkdtempSync(join(tmpdir(), 'packers-'));
	const put = (rel: string, body: string): void => {
		mkdirSync(dirname(join(t, rel)), { recursive: true });
		writeFileSync(join(t, rel), body);
	};
	put('package.json', JSON.stringify({ name: 'morphit', version: '9.9.9' }));
	put(PUBLIC_FILE, 'public\n');
	put('apps/web/README.md', 'web\n');
	for (const f of PRIVATE_FILES) put(f, 'private\n');
	for (const s of ['scripts/build-offline-bundle.sh', 'scripts/release-sign.sh']) {
		mkdirSync(join(t, 'scripts'), { recursive: true });
		copyFileSync(join(ROOT, s), join(t, s));
	}
	return t;
}

const run = (cmd: string, cwd: string, env: Record<string, string> = {}) =>
	spawnSync('bash', ['-c', cmd], {
		cwd,
		encoding: 'utf8',
		timeout: 120_000,
		env: { ...process.env, ...env }
	});

const listTar = (tarball: string): string[] => {
	const r = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
	return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
};
const hasPrivate = (entries: string[]): string[] =>
	entries.filter((e) => /(^|\/)private(\/|$)/.test(e.replace(/^\.\//, '')));
const hasPublic = (entries: string[]): boolean =>
	entries.some((e) => e.replace(/^\.\//, '').endsWith(PUBLIC_FILE));

// ── 1. the release job's tarball step ─────────────────────────────────
{
	const wf = yaml.load(readFileSync(join(ROOT, '.forgejo/workflows/release.yml'), 'utf8')) as {
		jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
	};
	const step = Object.values(wf.jobs)
		.flatMap((j) => j.steps ?? [])
		.find((s) => /Build release tarball/.test(s.name ?? ''));
	if (!step?.run) check('release.yml has a "Build release tarball" step', false);
	else {
		const t = scratchTree();
		const r = run(step.run, t, { TARBALL: 'morphit-v9.9.9.tar.gz' });
		const entries = listTar(join(t, 'morphit-v9.9.9.tar.gz'));
		check(
			'release job: the tarball carries the tree but not private/',
			r.status === 0 && hasPublic(entries) && hasPrivate(entries).length === 0,
			r.status !== 0
				? `exit ${r.status}: ${r.stderr.slice(0, 200)}`
				: `private entries: ${hasPrivate(entries).join(', ')}`
		);
		rmSync(t, { recursive: true, force: true });
	}
}

// ── 2. the offline bundle ─────────────────────────────────────────────
{
	const t = scratchTree();
	const out = join(mkdtempSync(join(tmpdir(), 'packers-out-')), 'bundle.tar.gz');
	const r = run(`bash scripts/build-offline-bundle.sh --tar-only ${JSON.stringify(out)}`, t);
	const entries = listTar(out);
	check(
		'offline bundle: the tarball carries the tree but not private/',
		r.status === 0 && hasPublic(entries) && hasPrivate(entries).length === 0,
		r.status !== 0
			? `exit ${r.status}: ${r.stderr.slice(0, 200)}`
			: `private entries: ${hasPrivate(entries).join(', ')}`
	);
	rmSync(t, { recursive: true, force: true });
	rmSync(dirname(out), { recursive: true, force: true });
}

// ── 3. release-sign.sh without .git (its own tar path) ────────────────
{
	const t = scratchTree();
	// The script signs after packing; with no signing key that step fails,
	// which does not matter here: the tarball is already written.
	run('bash scripts/release-sign.sh 9.9.9 </dev/null', t, { GNUPGHOME: join(t, '.gnupg-none') });
	const tarball = join(t, 'release', 'morphit-v9.9.9.tar.gz');
	const entries = existsSync(tarball) ? listTar(tarball) : [];
	check(
		'release-sign.sh: the tarball carries the tree but not private/',
		hasPublic(entries) && hasPrivate(entries).length === 0,
		entries.length === 0
			? 'no tarball written'
			: `private entries: ${hasPrivate(entries).join(', ')}`
	);
	rmSync(t, { recursive: true, force: true });
}

// ── 4. the Ansible local-install copy ─────────────────────────────────
{
	const tasks = yaml.load(
		readFileSync(join(ROOT, 'ops/ansible/roles/morphit/tasks/clone_and_build.yml'), 'utf8')
	) as Array<{ name?: string; 'ansible.builtin.shell'?: { cmd?: string } }>;
	const task = tasks.find((x) => /Copy the downloaded release into place/.test(x.name ?? ''));
	const cmd = task?.['ansible.builtin.shell']?.cmd;
	if (!cmd) check('clone_and_build.yml has the local-install copy task', false);
	else {
		const t = scratchTree();
		const dest = mkdtempSync(join(tmpdir(), 'packers-dest-'));
		const rendered = cmd
			.replace(/\{\{\s*morphit_local_source_path\s*\|\s*quote\s*\}\}/g, `'${t}'`)
			.replace(/\{\{\s*morphit_repo_path\s*\|\s*quote\s*\}\}/g, `'${dest}'`)
			.replace(/\{\{[^}]*--exclude=node_modules[^}]*\}\}/g, '--exclude=node_modules');
		const r = run(rendered, t);
		check(
			'Ansible local install: the copy carries the tree but not private/',
			r.status === 0 && existsSync(join(dest, PUBLIC_FILE)) && !existsSync(join(dest, 'private')),
			r.status !== 0
				? `exit ${r.status}: ${r.stderr.slice(0, 200)}`
				: 'private/ was copied to the install directory'
		);
		rmSync(t, { recursive: true, force: true });
		rmSync(dest, { recursive: true, force: true });
	}
}

// ── 5. git ignores private/ ───────────────────────────────────────────
{
	const t = scratchTree();
	copyFileSync(join(ROOT, '.gitignore'), join(t, '.gitignore'));
	const g = (args: string) => run(`git -c init.defaultBranch=main ${args}`, t);
	g('init -q');
	const ignored = PRIVATE_FILES.every((f) => g(`check-ignore -q ${f}`).status === 0);
	const status = g('status --porcelain --untracked-files=all').stdout;
	check(
		'git: every file under private/ is ignored and `git add -A` would stage none of it',
		ignored && !/private\//.test(status) && status.includes(PUBLIC_FILE),
		ignored
			? `git status shows: ${status
					.split('\n')
					.filter((l) => l.includes('private'))
					.join(', ')}`
			: 'not ignored'
	);
	rmSync(t, { recursive: true, force: true });
}

console.log('');
if (failed === 0) {
	console.log(`✓ all ${passed} release-packers-exclude-private checks passed`);
} else {
	console.log(`✗ ${failed} of ${passed + failed} release-packers-exclude-private checks FAILED`);
	process.exit(1);
}
