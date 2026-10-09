/**
 * repo-root-tidy-smoke.
 *
 * The repository's top level is what a new instance admin or a user sees first
 * when looking for the installer, the docs or the source. Up to v1.21.0 it also
 * held one RELEASE-NOTES-v*.md per release (202 files) and the claims list.
 * Since v1.21.1 those live in docs/release-notes/ and docs/MORPHIT-BRAG-LIST.md.
 *
 * Checks:
 *   1. the top level holds only the entries listed below (anything else needs a
 *      deliberate decision: add it here, or put it in a folder); the files moved
 *      off it in v1.21.3 are where they now live; the release ceremony writes
 *      nothing into the repository;
 *   2. no release notes at the top level; this version's notes are in
 *      docs/release-notes/;
 *   3. release.yml publishes the release body from docs/release-notes/;
 *   4. EXECUTES ops/ipfs/stage-release-dir.sh (the same script installed nodes
 *      run when they seed a new release) on a tarball with the new layout and one
 *      with the old layout: both stage RELEASE-NOTES.md with the notes' bytes, so
 *      the release's IPFS directory (and CID) carries the notes either way.
 */
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		failures.push(name);
		console.log(`  ✗ ${name}${detail ? `\n      ${detail.slice(0, 600)}` : ''}`);
	}
};

console.log('\nrepo-root-tidy-smoke\n' + '─'.repeat(56));

// ── 1. what the top level holds ─────────────────────────────────────
const ALLOWED = new Set([
	// folders
	'.forgejo',
	'apps',
	'docs',
	'ops',
	'packages',
	'scripts',
	// what people look for first
	'README.md',
	'LICENSE',
	// the installer (release tarballs are unpacked and run from their top level)
	'morphit-setup.sh',
	// tool configuration that has to sit at the top:
	'package.json',
	'package-lock.json',
	// npm reads a project's settings only from its top folder
	'.npmrc',
	// prettier reads its ignore list from the folder it runs in (editors too)
	'.prettierignore',
	// not only for smokes: installed servers load it at run time (fast-sync,
	// the snapshot scripts and the commands they print)
	'tsconfig.smoke.json',
	'.gitignore'
]);
// 2026-10-08 (v1.21.3): moved off the top level at the maintainer's request.
const MOVED: ReadonlyArray<readonly [string, string]> = [
	['SECURITY.md', 'docs/SECURITY.md'],
	['THIRD-PARTY-LICENSES.md', 'docs/THIRD-PARTY-LICENSES.md'],
	['morphit.config.env.example', 'ops/env/morphit.config.env.example'],
	['.audit-allowlist.json', 'scripts/audit-allowlist.json'],
	['tsconfig.smoke-typecheck.json', 'scripts/tsconfig.smoke-typecheck.json']
];
// Never committed (.gitignore): present on a working machine, not in the repo.
const IGNORED =
	/^(\.git|node_modules|private|vendor|release|dist|\.canonical-release|\.npm-cache|\.svelte-kit|coverage|morphit-v.*\.tar\.gz.*|release-info\.json|release-signer\.fpr|ipfs-cid\.txt|ipns-.*\.txt|ipns-sign\..*|release\.json|.*\.env|.*\.tsbuildinfo)$/;
const extra = readdirSync(REPO).filter(
	(n) => !ALLOWED.has(n) && !(IGNORED.test(n) && !n.endsWith('.env.example'))
);
check(
	'the top level holds only the expected files and folders',
	extra.length === 0,
	`unexpected: ${extra.slice(0, 12).join(', ')}${extra.length > 12 ? ` … (+${extra.length - 12})` : ''} — put it in a folder (docs/, scripts/, …) and update what points at it, or add it to ALLOWED here`
);

for (const [from, to] of MOVED)
	check(
		`${from} lives at ${to}, not at the top level`,
		existsSync(join(REPO, to)) && !existsSync(join(REPO, from))
	);
{
	const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
		prettier?: { useTabs?: unknown };
	};
	check(
		'the house style is the "prettier" key of package.json (no .prettierrc at the top level)',
		pkg.prettier?.useTabs === true && !existsSync(join(REPO, '.prettierrc'))
	);
}
// The release ceremony writes its build manifest and payload to /tmp, not into
// the laptop's repository.
{
	const r = spawnSync('bash', [join(REPO, 'scripts', 'eli5-release.sh'), '9.9.9'], {
		encoding: 'utf8'
	});
	check(
		'the release ceremony writes no file into the repository',
		r.status === 0 &&
			!/> (?:apps\/web\/build-manifest\.release\.json|release\.json)\b/.test(r.stdout) &&
			/> \/tmp\/morphit-release\.json/.test(r.stdout) &&
			/> \/tmp\/morphit-build-manifest\.json/.test(r.stdout),
		r.stderr.slice(-300)
	);
}

// ── 2. release notes ────────────────────────────────────────────────
const NOTES_DIR = join(REPO, 'docs', 'release-notes');
const rootNotes = readdirSync(REPO).filter((n) => /^RELEASE-NOTES/.test(n));
check(
	'no release notes at the top level',
	rootNotes.length === 0,
	rootNotes.slice(0, 5).join(', ')
);
const version = (
	JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }
).version;
check(
	`this version's notes are in docs/release-notes/ (RELEASE-NOTES-v${version}.md)`,
	existsSync(join(NOTES_DIR, `RELEASE-NOTES-v${version}.md`))
);
check(
	'the claims list is docs/MORPHIT-BRAG-LIST.md',
	existsSync(join(REPO, 'docs', 'MORPHIT-BRAG-LIST.md')) &&
		!existsSync(join(REPO, 'MORPHIT-BRAG-LIST.md'))
);

// ── 3. release.yml reads the notes from there ───────────────────────
const yml = readFileSync(join(REPO, '.forgejo', 'workflows', 'release.yml'), 'utf8');
const notesFiles = [...yml.matchAll(/NOTES_FILE="([^"$]*)RELEASE-NOTES-\$\{TAG\}\.md"/g)].map(
	(m) => m[1]
);
check(
	'release.yml takes the release body from docs/release-notes/ (both places)',
	notesFiles.length === 2 && notesFiles.every((d) => d === 'docs/release-notes/'),
	JSON.stringify(notesFiles)
);

// ── 4. the stager finds the notes in either layout ──────────────────
const S = mkdtempSync(join(tmpdir(), 'morphit-root-tidy-'));
try {
	const stage = (layout: string): { ok: boolean; got: string; out: string } => {
		const tag = 'v9.9.9';
		const src = join(S, layout, 'src');
		const top = join(src, `morphit-${tag}`);
		const notesRel = layout === 'new' ? 'docs/release-notes' : '.';
		mkdirSync(join(top, notesRel), { recursive: true });
		const body = `# Morphit ${tag} (${layout} layout)\n`;
		writeFileSync(join(top, notesRel, `RELEASE-NOTES-${tag}.md`), body);
		writeFileSync(join(top, 'README.md'), '# readme\n');
		const tb = join(S, layout, `morphit-${tag}.tar.gz`);
		spawnSync('tar', ['-czf', tb, '-C', src, `morphit-${tag}`]);
		const out = join(S, layout, 'out');
		const r = spawnSync('sh', [join(REPO, 'ops', 'ipfs', 'stage-release-dir.sh'), tag, out], {
			encoding: 'utf8',
			timeout: 60_000,
			env: { ...process.env, MORPHIT_STAGE_TARBALL: tb }
		});
		const staged = join(out, 'RELEASE-NOTES.md');
		const got = existsSync(staged) ? readFileSync(staged, 'utf8') : '';
		const meta = existsSync(join(out, 'metadata.json'))
			? readFileSync(join(out, 'metadata.json'), 'utf8')
			: '';
		return {
			ok: r.status === 0 && got === body && /"release_notes": "RELEASE-NOTES.md"/.test(meta),
			got,
			out: `${r.stdout ?? ''}${r.stderr ?? ''}`
		};
	};
	const n = stage('new');
	check(
		'stage-release-dir.sh stages the notes from docs/release-notes/ (v1.21.1 on)',
		n.ok,
		n.got || n.out
	);
	const o = stage('old');
	check(
		'stage-release-dir.sh still stages notes from the top level (up to v1.21.0)',
		o.ok,
		o.got || o.out
	);
	// The staged directory is the same with or without SEED_VERBOSE (the CI log
	// lists it; the CID must not change).
	{
		const tag = 'v9.9.9';
		const tb = join(S, 'new', `morphit-${tag}.tar.gz`);
		const dirs = ['0', '1'].map((v) => {
			const out = join(S, `verbose-${v}`);
			spawnSync('sh', [join(REPO, 'ops', 'ipfs', 'stage-release-dir.sh'), tag, out], {
				encoding: 'utf8',
				timeout: 60_000,
				env: { ...process.env, MORPHIT_STAGE_TARBALL: tb, SEED_VERBOSE: v }
			});
			return out;
		});
		const same = spawnSync('diff', ['-r', dirs[0]!, dirs[1]!], { encoding: 'utf8' });
		check('SEED_VERBOSE changes nothing in the staged directory', same.status === 0, same.stdout);
	}
	// Installed v1.21.0 servers stage with their own copy of this script: the
	// line that finds the notes must stay what it was (any folder), so both
	// copies build the same directory.
	check(
		'the notes are matched in any folder, exactly as v1.21.0 does',
		readFileSync(join(REPO, 'ops', 'ipfs', 'stage-release-dir.sh'), 'utf8').includes(
			'grep -E "(^|/)RELEASE-NOTES-${ESC_TAG}\\.md$"'
		)
	);
} finally {
	rmSync(S, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.log(`✗ ${failures.length} repo-root-tidy check(s) failed`);
	process.exit(1);
}
console.log(`✓ all ${pass} repo-root-tidy checks passed`);
