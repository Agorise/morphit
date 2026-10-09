#!/usr/bin/env tsx
/**
 * gitignore-coverage-smoke — the secrets and artifacts Morphit's own tools
 * write INTO the working tree are ignored by git, and no real source is.
 *
 * `morphit-ops init` writes the relay's ACTIVE key (apps/relay/keystore.wif in
 * plaintext mode, keystore.json otherwise) and the operator env files
 * (morphit.env, morphit.config.env) into the repo root of a git-clone install.
 * The release, offline-bundle, canary and IPFS tools leave tarballs, anchors,
 * a signed canary and provenance files there too. Without ignore rules, one
 * `git add -A` on a dev clone or a git-clone install publishes them.
 *
 * How: copy the repo's .gitignore files into a scratch `git init`, then ask
 * git itself (`git check-ignore`) about
 *   1. every path those tools write → each must be ignored;
 *   2. every file in the tree (outside node_modules, build output and those
 *      artifact paths) → none may be ignored, so a new rule cannot silently
 *      drop real source from the repository.
 *
 * Usage: tsx scripts/gitignore-coverage-smoke.ts [--root <tree>]
 */

import { spawnSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const argRoot = process.argv.indexOf('--root');
const ROOT =
	argRoot > 0 ? process.argv[argRoot + 1] : join(dirname(fileURLToPath(import.meta.url)), '..');

/** Paths the repo's own tools write into the working tree (writer in the comment). */
const MUST_IGNORE: readonly string[] = [
	'morphit.env', // apps/ops-cli/src/init/render.ts
	'morphit.config.env', // render.ts
	'indexer.env', // a hand-copied service env
	'apps/relay/keystore.wif', // render.ts, plaintext relay ACTIVE key
	'apps/relay/keystore.json', // render.ts, encrypted relay key
	'release/morphit-v1.0.0.tar.gz', // scripts/release-sign.sh
	'release/distribution-anchor.env', // release-sign.sh
	'morphit-v1.0.0.tar.gz', // scripts/build-offline-bundle.sh
	'morphit-v1.0.0.tar.gz.sha256', // build-offline-bundle.sh
	'morphit-v1.0.0-offline.tar.gz', // build-offline-bundle.sh
	'.canonical-release/morphit-v1.0.0.tar.gz', // build-offline-bundle.sh
	'release-info.json', // release job + build-offline-bundle.sh
	'distribution-anchor.env', // release job
	'release-signer.fpr', // release job
	'ipfs-cid.txt', // release job
	'ipns-name.txt', // release job
	'ipns-sign.json', // release job
	'release.json', // ELI5 Block 3 before v1.21.3 (now written to /tmp)
	'apps/web/static/canary.txt', // scripts/canary/generate.sh default output
	'apps/web/static/pgp_keys.asc', // an operator's key, staged by older canary setups
	'.npm-cache/_cacache/index', // ops/ansible clone_and_build.yml
	'ops/postgres/.init.applied', // ops/ansible roles/postgres
	'vendor/node/bin/node', // build-offline-bundle.sh
	'apps/web/build/index.html', // vite build
	'apps/web/build-manifest.sha256', // apps/web/scripts/build-manifest.mjs
	'apps/indexer/dist/main.js', // workspace builds
	'coverage/index.html', // vitest --coverage
	'private/TARBALL.md', // the maintainer's private handoff (private/README.md)
	'private/docs/REVISIT-LIST.md', // same
	'private/deny-terms.json', // the private term list the content guards read
	'node_modules/x/index.js'
];

/** Artifact prefixes skipped when walking the real tree for check 2. */
const SKIP_DIRS = new Set(['node_modules', '.svelte-kit', 'build', 'dist', '.git', 'coverage']);
const SKIP_ROOT_DIRS = new Set([
	'vendor',
	'release',
	'.canonical-release',
	'.npm-cache',
	'private'
]);

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
}

function walk(dir: string, out: string[]): void {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		const rel = relative(ROOT, p);
		if (e.isDirectory()) {
			if (SKIP_DIRS.has(e.name)) continue;
			if (dir === ROOT && SKIP_ROOT_DIRS.has(e.name)) continue;
			walk(p, out);
		} else if (e.isFile() && !MUST_IGNORE.includes(rel)) {
			out.push(rel);
		}
	}
}

/** The .gitignore files of the tree, as repo-relative paths. */
function gitignoreFiles(): string[] {
	const out: string[] = [];
	const visit = (dir: string): void => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name)) visit(join(dir, e.name));
			} else if (e.name === '.gitignore') out.push(relative(ROOT, join(dir, e.name)));
		}
	};
	visit(ROOT);
	return out;
}

console.log('\n── gitignore coverage smoke ──────────────────────────\n');

if (spawnSync('git', ['--version']).status !== 0) {
	console.error('✗ git is not installed; this smoke asks git itself and cannot run without it');
	process.exit(1);
}

const scratch = mkdtempSync(join(tmpdir(), 'morphit-gitignore-'));
try {
	if (spawnSync('git', ['init', '-q', scratch]).status !== 0) throw new Error('git init failed');
	const ignores = gitignoreFiles();
	check('the tree has a root .gitignore', ignores.includes('.gitignore'), ignores.join(', '));
	for (const g of ignores) {
		mkdirSync(join(scratch, dirname(g)), { recursive: true });
		copyFileSync(join(ROOT, g), join(scratch, g));
	}
	// Create the artifacts for real, as the tools would.
	for (const p of MUST_IGNORE) {
		mkdirSync(join(scratch, dirname(p)), { recursive: true });
		writeFileSync(join(scratch, p), 'x\n');
	}

	/** The subset of `paths` git ignores in the scratch repo. */
	const ignored = (paths: readonly string[]): Set<string> => {
		const r = spawnSync('git', ['-C', scratch, 'check-ignore', '--stdin'], {
			input: paths.join('\n') + '\n',
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024
		});
		// 0 = some ignored, 1 = none ignored; anything else is git failing.
		if (r.status !== 0 && r.status !== 1) throw new Error(`git check-ignore failed: ${r.stderr}`);
		return new Set(r.stdout.split('\n').filter((l) => l.length > 0));
	};

	const hit = ignored(MUST_IGNORE);
	const missed = MUST_IGNORE.filter((p) => !hit.has(p));
	check(
		`every secret and artifact the tools write in the tree is ignored (${MUST_IGNORE.length} paths)`,
		missed.length === 0,
		`not ignored: ${missed.join(', ')}`
	);
	const status = spawnSync(
		'git',
		['-C', scratch, 'status', '--porcelain', '--untracked-files=all'],
		{
			encoding: 'utf8'
		}
	).stdout;
	const visible = status
		.split('\n')
		.filter((l) => l.startsWith('?? '))
		.map((l) => l.slice(3))
		.filter((p) => !p.endsWith('.gitignore'));
	check(
		'`git add -A` would stage none of them (git status shows no untracked artifact)',
		visible.length === 0,
		visible.join(', ')
	);

	const tree: string[] = [];
	walk(ROOT, tree);
	const wrongly = [...ignored(tree)].sort();
	check(
		`no file of the tree is ignored (${tree.length} files)`,
		tree.length > 1000 && wrongly.length === 0,
		tree.length <= 1000
			? `only ${tree.length} files walked — the walk is broken`
			: `ignored: ${wrongly.slice(0, 12).join(', ')}`
	);
	check(
		'the committed examples stay tracked',
		existsSync(join(ROOT, 'ops', 'env', 'morphit.config.env.example')) &&
			!ignored(['ops/env/morphit.config.env.example', 'ops/env/indexer.env.example']).size
	);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

console.log('');
if (fail > 0) {
	console.error(`✗ ${fail} of ${pass + fail} gitignore-coverage checks FAILED`);
	process.exit(1);
}
console.log(`✓ all ${pass} gitignore-coverage checks passed`);
