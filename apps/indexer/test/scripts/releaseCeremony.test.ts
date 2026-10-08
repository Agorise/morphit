/**
 * Blocks 3 and 6 of the release ceremony, run for real.
 *
 *
 * Block 3 (Block 4 before 2026-10-07) `source`d the distribution-anchor.env the release job wrote,
 *   on the laptop that then asks for the @morphit WIF. Anything a dependency
 *   wrote into that file in CI ran there.
 * the on-chain build manifest was converted from whatever the canonical
 *   instance SERVED at /verify.json, unchecked, and anchored for every instance.
 *
 * 2026-10-07: the payload is built and broadcast BEFORE morphit.io upgrades (the
 *   upgrade installs an unsigned release only by its on-chain record), so
 *   Block 3 checks the manifest against the verify.json inside the tarball, and
 *   Block 6 checks the upgraded site's served verify.json against the tarball.
 *
 * The commands are taken from `bash scripts/eli5-release.sh` itself (the
 * blocks' code). Downloads are replaced by local fixtures; every path the block
 * writes is moved into a scratch directory; `npm ci` is skipped (this repo is
 * already installed). The dry-run broadcast line is not run.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '../../../..');
const FPR = '7B4C1D189DBB610C473B59ED53524E1F1017EB9C';
const CID = 'bafybeiegfyir3zryt3iosz7ysxikcki4vwtui35ykd4uf55zp4ww5uctki';
const S = mkdtempSync(join(tmpdir(), 'morphit-ceremony-'));
afterAll(() => rmSync(S, { recursive: true, force: true }));

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
let tarball = '';
let buildHex: Record<string, string> = {};
let buildFiles: Record<string, string> = {};
// The laptop's repository: Block 2 made and pushed tag v9.9.9 there. OLD is
// another signed-tag object of the same name (the tag before it was remade).
const GIT_DIR = join(S, 'laptop', '.git');
let TAG_OBJECT = '';
let OLD_TAG_OBJECT = '';

beforeAll(() => {
	const git = (...a: string[]): string => {
		const r = spawnSync('git', a, {
			cwd: join(S, 'laptop'),
			encoding: 'utf8',
			env: {
				...process.env,
				GIT_CONFIG_GLOBAL: '/dev/null',
				GIT_CONFIG_NOSYSTEM: '1',
				GIT_AUTHOR_NAME: 'm',
				GIT_AUTHOR_EMAIL: 'm@x.invalid',
				GIT_COMMITTER_NAME: 'm',
				GIT_COMMITTER_EMAIL: 'm@x.invalid'
			}
		});
		if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
		return r.stdout.trim();
	};
	mkdirSync(join(S, 'laptop'));
	git('init', '-q');
	git('commit', '-q', '--allow-empty', '-m', 'one');
	git('tag', '-a', 'v9.9.9', '-m', 'Morphit v9.9.9');
	OLD_TAG_OBJECT = git('rev-parse', 'refs/tags/v9.9.9');
	git('commit', '-q', '--allow-empty', '-m', 'two');
	git('tag', '-f', '-a', 'v9.9.9', '-m', 'Morphit v9.9.9');
	TAG_OBJECT = git('rev-parse', 'refs/tags/v9.9.9');

	buildFiles = {
		'apps/web/build/index.html': '<html>release</html>',
		'apps/web/build/service-worker.js': 'self.x=1',
		'apps/web/build/_app/immutable/entry/start.abc.js': 'export{}',
		'apps/web/build/robots.txt': 'User-agent: *',
		'release-info.json': '{"tag":"v9.9.9"}'
	};
	buildHex = Object.fromEntries(
		Object.entries(buildFiles)
			.filter(([k]) => k.startsWith('apps/web/build/'))
			.map(([k, v]) => [k.slice('apps/web/build/'.length), sha(v)])
	);
	tarball = makeTarball('good', buildHex);
});

const verifyJson = (hex: Record<string, string>): string =>
	JSON.stringify({ morphit_version: '9.9.9', hash_manifest: hex });

/** A release tarball whose apps/web/build/verify.json lists `ownList`. */
function makeTarball(name: string, ownList: Record<string, string>): string {
	const tree = join(S, `tree-${name}`);
	const files = { ...buildFiles, 'apps/web/build/verify.json': verifyJson(ownList) };
	for (const [rel, body] of Object.entries(files)) {
		mkdirSync(join(tree, rel, '..'), { recursive: true });
		writeFileSync(join(tree, rel), body);
	}
	const dir = join(S, `rel-${name}`);
	mkdirSync(dir);
	const out = join(dir, 'morphit-v9.9.9.tar.gz');
	expect(spawnSync('tar', ['-czf', out, '-C', tree, '.']).status).toBe(0);
	return out;
}

/** One block's section of what eli5-release.sh prints (up to the next one). */
function blockText(n: number): string {
	const out = spawnSync('bash', [join(REPO, 'scripts', 'eli5-release.sh'), '9.9.9'], {
		encoding: 'utf8'
	}).stdout;
	const end = out.indexOf(`**BLOCK ${n + 1}**`);
	return out.slice(out.indexOf(`**BLOCK ${n}**`), end === -1 ? undefined : end);
}
const block3Text = (): string => blockText(3);

/** A block's commands, as eli5-release.sh prints them. */
function blockCmds(n: number): string[] {
	const code = /```\n([\s\S]*?)```/.exec(blockText(n))![1]!;
	return code.split('\n').filter((l) => l.trim() !== '');
}
const block3 = (): string[] => blockCmds(3);

interface Fixtures {
	anchor: string;
	/** The verify.json the canonical instance serves (Block 6). */
	served?: Record<string, string>;
	/** The release tarball (default: the good one). */
	tarball?: string;
}

/** Run a block's commands with downloads replaced by the fixtures. */
function runBlock(
	n: 3 | 6,
	fx: Fixtures,
	extraEnv: Record<string, string> = {},
	/** Replaces Block 3's payload-build line (the recovery runs it again). */
	payloadLine?: string,
	/** A scratch run directory to reuse (Block 6 after Block 3). */
	reuse?: string
) {
	const run = reuse ?? mkdtempSync(join(S, 'run-'));
	const home = join(run, 'home');
	const tmp = join(run, 'tmp');
	mkdirSync(home, { recursive: true });
	mkdirSync(tmp, { recursive: true });
	writeFileSync(join(run, 'anchor.env'), fx.anchor);
	if (fx.served !== undefined) writeFileSync(join(run, 'verify.json'), verifyJson(fx.served));
	const tb = fx.tarball ?? tarball;
	const lines = blockCmds(n)
		.filter(
			(l) => !/^npm ci\b/.test(l) && !/release-broadcast\.ts/.test(l) && !/update-canary/.test(l)
		)
		.map((l) =>
			payloadLine !== undefined && /release-build-payload\.ts/.test(l) ? payloadLine : l
		)
		.map((line) => {
			const l = line
				.replace(/(^|\s|=)\/tmp\//g, `$1${tmp}/`)
				.replace(/(^|\s)~\//g, `$1${home}/`)
				.replace(/apps\/web\/build-manifest\.release\.json/g, join(run, 'manifest.json'))
				.replace(/(^|\s|>\s?)release\.json\b/g, `$1${join(run, 'release.json')}`);
			const dl = /^curl -fsSL (\S+) -o (\S+)$/.exec(l);
			if (!dl) return l;
			const src = dl[1]!.endsWith('distribution-anchor.env')
				? join(run, 'anchor.env')
				: dl[1]!.endsWith('.tar.gz')
					? tb
					: join(run, 'verify.json');
			return `cp ${src} ${dl[2]}`;
		});
	const r = spawnSync('bash', ['-e', '-c', lines.join('\n')], {
		cwd: REPO,
		env: { ...process.env, HOME: home, PWNED: join(run, 'PWNED'), GIT_DIR, ...extraEnv },
		encoding: 'utf8',
		timeout: 120_000
	});
	const rel = join(run, 'release.json');
	let payload: {
		hash_manifest?: Record<string, string>;
		distribution?: Record<string, unknown>;
	} | null = null;
	try {
		payload = JSON.parse(readFileSync(rel, 'utf8'));
	} catch {
		payload = null;
	}
	return { r, payload, pwned: existsSync(join(run, 'PWNED')), run };
}
const runBlock3 = (
	fx: Fixtures,
	extraEnv: Record<string, string> = {},
	payloadLine?: string
): ReturnType<typeof runBlock> => runBlock(3, fx, extraEnv, payloadLine);

const goodAnchor = (tb: string = tarball): string =>
	[
		'# anchor',
		`export MORPHIT_BUILD_SOURCE_SHA256=${sha(readFileSync(tb))}`,
		`export MORPHIT_BUILD_GPG_FINGERPRINT=${FPR}`,
		`export MORPHIT_BUILD_IPFS_CID=${CID}`,
		`export MORPHIT_BUILD_TAG_OBJECT=${TAG_OBJECT}`
	].join('\n') + '\n';

const noCidAnchor = (): string => goodAnchor().replace(/^export MORPHIT_BUILD_IPFS_CID=.*\n/m, '');

describe('ELI5 Block 3', () => {
	it('builds the payload: hashes from the anchored tarball, its own verify.json matching', () => {
		const { r, payload } = runBlock3({ anchor: goodAnchor() });
		expect(r.status, r.stderr.slice(-600)).toBe(0);
		expect(payload?.distribution?.source_sha256).toBe(sha(readFileSync(tarball)));
		expect(payload?.distribution?.ipfs_cid).toBe(CID);
		expect(payload?.hash_manifest?.['/index.html']).toBe(
			`sha256-${Buffer.from(buildHex['index.html']!, 'hex').toString('base64')}`
		);
	});

	it('refuses a tarball whose own verify.json differs from its build in one file', () => {
		const bad = makeTarball('own-differs', { ...buildHex, 'index.html': 'f'.repeat(64) });
		const { r, payload } = runBlock3({ anchor: goodAnchor(bad), tarball: bad });
		expect(payload, 'a build its own list does not back was anchored').toBeNull();
		expect(r.stderr).toMatch(/own verify\.json does not match its build/);
	});

	it('reads nothing a server serves (morphit.io still serves the previous release)', () => {
		const text = block3().join('\n');
		expect(text).not.toMatch(/morphit\.io\/verify\.json/);
		expect(text).not.toMatch(/--served/);
	});

	it('never runs what the anchor file says', () => {
		const anchor =
			goodAnchor() + `export MORPHIT_BUILD_IPNS_RECORD=${'A'.repeat(64)}; touch "$PWNED"\n`;
		const { pwned, payload } = runBlock3({ anchor });
		expect(pwned, 'the anchor file was executed').toBe(false);
		expect(payload, 'a malformed anchor was accepted').toBeNull();
	});

	it('refuses an anchor naming another signed object of the tag made here (the tag was moved after the push)', () => {
		const anchor = goodAnchor().replace(TAG_OBJECT, OLD_TAG_OBJECT);
		const { r, payload } = runBlock3({ anchor });
		expect(payload, 'a build of a moved tag was anchored').toBeNull();
		expect(r.stderr).toMatch(/tag was moved after it was pushed/);
	});

	it('refuses an anchor that names no tag object', () => {
		const anchor = goodAnchor().replace(/^export MORPHIT_BUILD_TAG_OBJECT=.*\n/m, '');
		const { r, payload } = runBlock3({ anchor });
		expect(payload).toBeNull();
		expect(r.stderr).toMatch(/names no tag object/);
	});

	it('refuses an anchor whose signing key is not a pinned release signer', () => {
		const anchor = goodAnchor().replace(FPR, 'A'.repeat(40));
		expect(runBlock3({ anchor }).payload).toBeNull();
	});

	// v1.20.2: release.yml could not compute the CID, the anchor carried none, the
	// payload went out without one, and zero-clearnet nodes could not upgrade.

	it('stops when the anchor carries no IPFS CID, and says to pass --ipfs-cid', () => {
		const { r, payload } = runBlock3({ anchor: noCidAnchor() });
		expect(payload, 'a payload with no ipfs_cid was written').toBeNull();
		expect(r.stderr).toMatch(/--ipfs-cid/);
	});

	it('the recovery the blocks print (payload line + --ipfs-cid) anchors the CID the release box printed', () => {
		const text = block3Text();
		const recovery = /`([^`]*release-build-payload\.ts --ipfs-cid <cid>[^`]*)`/.exec(text)?.[1];
		expect(recovery, 'Block 3 does not say how to supply a missing CID').toBeDefined();
		// It is Block 3's own payload line with only the flag added.
		const line = block3().find((l) => /release-build-payload\.ts/.test(l))!;
		expect(recovery).toBe(
			line.replace('release-build-payload.ts', 'release-build-payload.ts --ipfs-cid <cid>')
		);
		const { r, payload } = runBlock3(
			{ anchor: noCidAnchor() },
			{},
			recovery!.replace('<cid>', CID)
		);
		expect(r.status, r.stderr.slice(-600)).toBe(0);
		expect(payload?.distribution?.ipfs_cid).toBe(CID);
	});

	it('refuses --ipfs-cid when the anchor already carries a CID', () => {
		const line = block3().find((l) => /release-build-payload\.ts/.test(l))!;
		const other = 'bafybeia5rkympgrdwxsi3dne4viuo3fbcjmgxhyg3tl2ia7p43wz2z2pni';
		const { payload } = runBlock3(
			{ anchor: goodAnchor() },
			{},
			line.replace('release-build-payload.ts', `release-build-payload.ts --ipfs-cid ${other}`)
		);
		expect(payload, 'a hand-typed CID overrode the anchored one').toBeNull();
	});

	it('refuses a --ipfs-cid that is not a CID', () => {
		const line = block3().find((l) => /release-build-payload\.ts/.test(l))!;
		for (const bad of ['bafy-not-a-cid', `${CID}x$(touch PWNED)`, '']) {
			const { payload } = runBlock3(
				{ anchor: noCidAnchor() },
				{},
				line.replace('release-build-payload.ts', `release-build-payload.ts --ipfs-cid '${bad}'`)
			);
			expect(payload, `--ipfs-cid '${bad}' was accepted`).toBeNull();
		}
	});
});

describe("ELI5 Block 6 (after the broadcast and morphit.io's upgrade)", () => {
	it('passes when morphit.io serves the anchored build', () => {
		const b3 = runBlock3({ anchor: goodAnchor() });
		expect(b3.r.status, b3.r.stderr.slice(-600)).toBe(0);
		const { r } = runBlock(6, { anchor: goodAnchor(), served: buildHex }, {}, undefined, b3.run);
		expect(r.status, r.stderr.slice(-600)).toBe(0);
		expect(r.stderr).toMatch(/the served verify\.json matches/);
	});

	it('fails when morphit.io serves another build for one file', () => {
		const b3 = runBlock3({ anchor: goodAnchor() });
		expect(b3.r.status, b3.r.stderr.slice(-600)).toBe(0);
		const served = { ...buildHex, 'service-worker.js': 'e'.repeat(64) };
		const { r } = runBlock(6, { anchor: goodAnchor(), served }, {}, undefined, b3.run);
		expect(r.status, 'a site serving another build passed the check').not.toBe(0);
		expect(r.stderr).toMatch(/served verify\.json does not match/);
	});
});

describe('the payload builder with MORPHIT_BUILD_ANCHOR_FILE', () => {
	it('refuses a MORPHIT_BUILD_* value an earlier ceremony left in the terminal', () => {
		const dir = mkdtempSync(join(S, 'b-'));
		writeFileSync(join(dir, 'a.env'), goodAnchor());
		writeFileSync(
			join(dir, 'm.json'),
			JSON.stringify({ '/index.html': `sha256-${'a'.repeat(43)}=` })
		);
		const base = Object.fromEntries(
			Object.entries(process.env).filter(([k]) => !k.startsWith('MORPHIT_BUILD_'))
		);
		const r = spawnSync(
			join(REPO, 'node_modules', '.bin', 'tsx'),
			[join(REPO, 'apps', 'indexer', 'scripts', 'release-build-payload.ts')],
			{
				cwd: REPO,
				env: {
					...base,
					MORPHIT_BUILD_ANCHOR_FILE: join(dir, 'a.env'),
					MORPHIT_BUILD_VERSION: '9.9.9',
					MORPHIT_BUILD_HASH_MANIFEST_FILE: join(dir, 'm.json'),
					MORPHIT_BUILD_IPFS_CID: 'bafybeia5rkympgrdwxsi3dne4viuo3fbcjmgxhyg3tl2ia7p43wz2z2pni'
				},
				input: '',
				encoding: 'utf8',
				timeout: 60_000
			}
		);
		expect(r.status, 'a stale CID from the terminal was accepted').not.toBe(0);
	});
});

// 2026-10-07: the fallback for a release whose anchor has no IPFS CID ran the
// INSTALLED seed script on morphit.io, i.e. the previous release's seed and
// staging code. A change in how a release directory is staged would then give
// a CID this release's own upgrades (staging with their own copy) never
// reproduce, and every one of them would refuse it as a mismatch. Both places
// that print the fallback now print one command that seeds with the release's
// own scripts from the published tarball, checked against the anchored hash.
describe('the no-CID fallback (morphit.io, as root)', () => {
	const STUB_CID = 'bafybeihostedbythenewscriptsaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

	function eli5Command(): string {
		const text = block3Text();
		const note = text.slice(text.indexOf('this release has no IPFS CID'));
		return /```\n([^\n]+)\n```/.exec(note)![1]!;
	}

	function builderCommand(): string {
		const { r } = runBlock3({ anchor: noCidAnchor() });
		const line = r.stderr.split('\n').find((l) => /mktemp -d/.test(l));
		expect(line, r.stderr.slice(-800)).toBeDefined();
		return line!.trim();
	}

	/** The release on its download page: a tarball laid out as release.yml
	 *  packs it (./ops/ipfs/…), whose seed script says which copy ran. */
	function releasePage(tamperAnchor = false) {
		const d = mkdtempSync(join(S, 'nocid-'));
		const tree = join(d, 'tree');
		mkdirSync(join(tree, 'ops', 'ipfs'), { recursive: true });
		const seed = readFileSync(join(REPO, 'ops/ipfs/morphit-ipfs-seed.sh'), 'utf8');
		writeFileSync(
			join(tree, 'ops/ipfs/morphit-ipfs-seed.sh'),
			seed.replace(/^#!\/bin\/sh\n/, '#!/bin/sh\necho "seed copy: $0" >&2\n')
		);
		writeFileSync(
			join(tree, 'ops/ipfs/stage-release-dir.sh'),
			readFileSync(join(REPO, 'ops/ipfs/stage-release-dir.sh'))
		);
		const page = join(d, 'page');
		mkdirSync(page);
		const tgz = join(page, 'morphit-v9.9.9.tar.gz');
		expect(spawnSync('tar', ['-czf', tgz, '-C', tree, '.']).status).toBe(0);
		const want = tamperAnchor ? 'f'.repeat(64) : sha(readFileSync(tgz));
		writeFileSync(
			join(page, 'distribution-anchor.env'),
			`# anchor\nexport MORPHIT_BUILD_SOURCE_SHA256=${want}\nexport MORPHIT_BUILD_GPG_FINGERPRINT=${FPR}\n`
		);
		const bin = join(d, 'bin');
		mkdirSync(bin);
		const stub = (name: string, body: string): void =>
			writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
		// curl: -O saves the named file from the page; the seed's own anchor read
		// prints it; every reachability probe gets no answer.
		stub(
			'curl',
			`url=""; save=0
for a; do case "$a" in -fsSLO) save=1 ;; http*) url="$a" ;; esac; done
f="${page}/$(basename "$url")"
if [ "$save" = 1 ]; then cp "$f" .; exit $?; fi
case "$url" in *distribution-anchor.env) cat "$f"; exit 0 ;; esac
printf 000; exit 7`
		);
		stub('sudo', `[ "$1" = -u ] && [ "$2" = ipfs ] || exit 9\nshift 2\nexec "$@"`);
		stub(
			'ipfs',
			`while case "$1" in --*) true ;; *) false ;; esac; do shift; done
case "$1" in
id) exit 0 ;;
config) case "$2" in Routing.Type) echo dht ;; Addresses.Gateway) echo /ip4/127.0.0.1/tcp/8082 ;; esac; exit 0 ;;
add) for a; do last="$a"; done; ls "$last" > "${d}/staged.txt"; echo ${STUB_CID}; exit 0 ;;
esac
exit 0`
		);
		return { d, bin };
	}

	function runOnMorphitIo(cmd: string, tamperAnchor = false) {
		const { d, bin } = releasePage(tamperAnchor);
		const tmp = join(d, 'tmp');
		mkdirSync(tmp);
		const r = spawnSync('bash', ['-c', cmd], {
			cwd: d,
			env: { PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmp, HOME: d },
			encoding: 'utf8',
			timeout: 60_000
		});
		const staged = existsSync(join(d, 'staged.txt'))
			? readFileSync(join(d, 'staged.txt'), 'utf8')
			: null;
		return { r, staged, tmp };
	}

	it('the release blocks and the payload builder print the same command', () => {
		expect(builderCommand()).toBe(eli5Command());
	});

	it('seeds with the scripts inside the checked release tarball and prints the CID', () => {
		const { r, staged, tmp } = runOnMorphitIo(eli5Command());
		expect(r.stderr, r.stderr.slice(-800)).toMatch(
			new RegExp(`morphit-ipfs-seed: hosted v9\\.9\\.9 → ${STUB_CID}`)
		);
		// The copy that ran is the one unpacked from the release tarball.
		const ran = /seed copy: (\S+)/.exec(r.stderr)?.[1] ?? '';
		expect(ran.startsWith(`${tmp}/`), `ran ${ran || 'no seed script'}`).toBe(true);
		expect(ran).not.toMatch(/^\/opt\//);
		// The staged release directory holds the tarball under both names and its metadata.
		expect(staged).toMatch(/morphit-v9\.9\.9\.tar\.gz/);
		expect(staged).toMatch(/morphit-latest\.tar\.gz/);
		expect(staged).toMatch(/metadata\.json/);
	});

	it('a tarball that does not match the anchored SHA-256 is not seeded', () => {
		const { r, staged } = runOnMorphitIo(eli5Command(), true);
		expect(r.status).not.toBe(0);
		expect(staged, 'a tarball that failed its check was added to IPFS').toBeNull();
		expect(r.stderr).not.toMatch(/seed copy:/);
		expect(r.stderr).not.toMatch(/hosted v9\.9\.9/);
	});
});

describe('Block 6 without the served file', () => {
	it('says the served verify.json could not be read, not a stack trace', () => {
		const b3 = runBlock3({ anchor: goodAnchor() });
		expect(b3.r.status, b3.r.stderr.slice(-600)).toBe(0);
		const r = spawnSync(
			'node',
			[
				join(REPO, 'apps/web/scripts/verify-json-to-release-manifest.mjs'),
				'--anchor',
				join(b3.run, 'anchor.env'),
				'--tarball',
				tarball,
				'--served',
				join(b3.run, 'no-such-verify.json')
			],
			{ encoding: 'utf8' }
		);
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/could not read the served verify\.json .*ENOENT.*fetch it first/);
		expect(r.stderr).not.toMatch(/\n\s+at /);
	});
});
