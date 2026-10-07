/**
 * Block 4 of the release ceremony, run for real.
 *
 *
 * Block 4 `source`d the distribution-anchor.env the release job wrote,
 *   on the laptop that then asks for the @morphit WIF. Anything a dependency
 *   wrote into that file in CI ran there.
 * the on-chain build manifest was converted from whatever the canonical
 *   instance SERVED at /verify.json, unchecked, and anchored for every instance.
 *
 * The commands are taken from `bash scripts/eli5-release.sh` itself (Block 4's
 * code block). Downloads are replaced by local fixtures; every path the block
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

	const tree = join(S, 'tree');
	const files: Record<string, string> = {
		'apps/web/build/index.html': '<html>release</html>',
		'apps/web/build/service-worker.js': 'self.x=1',
		'apps/web/build/_app/immutable/entry/start.abc.js': 'export{}',
		'apps/web/build/robots.txt': 'User-agent: *',
		'release-info.json': '{"tag":"v9.9.9"}'
	};
	for (const [rel, body] of Object.entries(files)) {
		mkdirSync(join(tree, rel, '..'), { recursive: true });
		writeFileSync(join(tree, rel), body);
	}
	buildHex = Object.fromEntries(
		Object.entries(files)
			.filter(([k]) => k.startsWith('apps/web/build/'))
			.map(([k, v]) => [k.slice('apps/web/build/'.length), sha(v)])
	);
	tarball = join(S, 'morphit-v9.9.9.tar.gz');
	expect(spawnSync('tar', ['-czf', tarball, '-C', tree, '.']).status).toBe(0);
});

/** Block 4's section of what eli5-release.sh prints (up to Block 5). */
function block4Text(): string {
	const out = spawnSync('bash', [join(REPO, 'scripts', 'eli5-release.sh'), '9.9.9'], {
		encoding: 'utf8'
	}).stdout;
	return out.slice(out.indexOf('**BLOCK 4**'), out.indexOf('**BLOCK 5**'));
}

/** Block 4's commands, as eli5-release.sh prints them. */
function block4(): string[] {
	const code = /```\n([\s\S]*?)```/.exec(block4Text())![1]!;
	return code.split('\n').filter((l) => l.trim() !== '');
}

interface Fixtures {
	anchor: string;
	served: Record<string, string>;
}

function runBlock4(
	fx: Fixtures,
	extraEnv: Record<string, string> = {},
	/** Replaces Block 4's payload-build line (the recovery runs it again). */
	payloadLine?: string
) {
	const run = mkdtempSync(join(S, 'run-'));
	const home = join(run, 'home');
	const tmp = join(run, 'tmp');
	mkdirSync(home);
	mkdirSync(tmp);
	writeFileSync(join(run, 'anchor.env'), fx.anchor);
	writeFileSync(
		join(run, 'verify.json'),
		JSON.stringify({ morphit_version: '9.9.9', hash_manifest: fx.served })
	);
	const lines = block4()
		.filter((l) => !/^npm ci\b/.test(l) && !/release-broadcast\.ts/.test(l))
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
					? tarball
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
	return { r, payload, pwned: existsSync(join(run, 'PWNED')) };
}

const goodAnchor = (): string =>
	[
		'# anchor',
		`export MORPHIT_BUILD_SOURCE_SHA256=${sha(readFileSync(tarball))}`,
		`export MORPHIT_BUILD_GPG_FINGERPRINT=${FPR}`,
		`export MORPHIT_BUILD_IPFS_CID=${CID}`,
		`export MORPHIT_BUILD_TAG_OBJECT=${TAG_OBJECT}`
	].join('\n') + '\n';

describe('ELI5 Block 4', () => {
	it('builds the payload: hashes from the anchored tarball, the served verify.json matching', () => {
		const { r, payload } = runBlock4({ anchor: goodAnchor(), served: buildHex });
		expect(r.status, r.stderr.slice(-600)).toBe(0);
		expect(payload?.distribution?.source_sha256).toBe(sha(readFileSync(tarball)));
		expect(payload?.distribution?.ipfs_cid).toBe(CID);
		expect(payload?.hash_manifest?.['/index.html']).toBe(
			`sha256-${Buffer.from(buildHex['index.html']!, 'hex').toString('base64')}`
		);
	});

	it('refuses when the served verify.json differs from the tarball in one file', () => {
		const served = { ...buildHex, 'index.html': 'f'.repeat(64) };
		const { payload } = runBlock4({ anchor: goodAnchor(), served });
		expect(payload, 'a manifest the tarball does not back was anchored').toBeNull();
	});

	it('never runs what the anchor file says', () => {
		const anchor =
			goodAnchor() + `export MORPHIT_BUILD_IPNS_RECORD=${'A'.repeat(64)}; touch "$PWNED"\n`;
		const { pwned, payload } = runBlock4({ anchor, served: buildHex });
		expect(pwned, 'the anchor file was executed').toBe(false);
		expect(payload, 'a malformed anchor was accepted').toBeNull();
	});

	it('refuses an anchor naming another signed object of the tag made here (the tag was moved after the push)', () => {
		const anchor = goodAnchor().replace(TAG_OBJECT, OLD_TAG_OBJECT);
		const { r, payload } = runBlock4({ anchor, served: buildHex });
		expect(payload, 'a build of a moved tag was anchored').toBeNull();
		expect(r.stderr).toMatch(/tag was moved after it was pushed/);
	});

	it('refuses an anchor that names no tag object', () => {
		const anchor = goodAnchor().replace(/^export MORPHIT_BUILD_TAG_OBJECT=.*\n/m, '');
		const { r, payload } = runBlock4({ anchor, served: buildHex });
		expect(payload).toBeNull();
		expect(r.stderr).toMatch(/names no tag object/);
	});

	it('refuses an anchor whose signing key is not a pinned release signer', () => {
		const anchor = goodAnchor().replace(FPR, 'A'.repeat(40));
		expect(runBlock4({ anchor, served: buildHex }).payload).toBeNull();
	});

	// v1.20.2: release.yml could not compute the CID, the anchor carried none, the
	// payload went out without one, and zero-clearnet nodes could not upgrade.
	const noCidAnchor = (): string =>
		goodAnchor().replace(/^export MORPHIT_BUILD_IPFS_CID=.*\n/m, '');

	it('stops when the anchor carries no IPFS CID, and says to pass --ipfs-cid', () => {
		const { r, payload } = runBlock4({ anchor: noCidAnchor(), served: buildHex });
		expect(payload, 'a payload with no ipfs_cid was written').toBeNull();
		expect(r.stderr).toMatch(/--ipfs-cid/);
	});

	it('the recovery the blocks print (payload line + --ipfs-cid) anchors the CID the release box printed', () => {
		const text = block4Text();
		const recovery = /`([^`]*release-build-payload\.ts --ipfs-cid <cid>[^`]*)`/.exec(text)?.[1];
		expect(recovery, 'Block 4 does not say how to supply a missing CID').toBeDefined();
		// It is Block 4's own payload line with only the flag added.
		const line = block4().find((l) => /release-build-payload\.ts/.test(l))!;
		expect(recovery).toBe(
			line.replace('release-build-payload.ts', 'release-build-payload.ts --ipfs-cid <cid>')
		);
		const { r, payload } = runBlock4(
			{ anchor: noCidAnchor(), served: buildHex },
			{},
			recovery!.replace('<cid>', CID)
		);
		expect(r.status, r.stderr.slice(-600)).toBe(0);
		expect(payload?.distribution?.ipfs_cid).toBe(CID);
	});

	it('refuses --ipfs-cid when the anchor already carries a CID', () => {
		const line = block4().find((l) => /release-build-payload\.ts/.test(l))!;
		const other = 'bafybeia5rkympgrdwxsi3dne4viuo3fbcjmgxhyg3tl2ia7p43wz2z2pni';
		const { payload } = runBlock4(
			{ anchor: goodAnchor(), served: buildHex },
			{},
			line.replace('release-build-payload.ts', `release-build-payload.ts --ipfs-cid ${other}`)
		);
		expect(payload, 'a hand-typed CID overrode the anchored one').toBeNull();
	});

	it('refuses a --ipfs-cid that is not a CID', () => {
		const line = block4().find((l) => /release-build-payload\.ts/.test(l))!;
		for (const bad of ['bafy-not-a-cid', `${CID}x$(touch PWNED)`, '']) {
			const { payload } = runBlock4(
				{ anchor: noCidAnchor(), served: buildHex },
				{},
				line.replace('release-build-payload.ts', `release-build-payload.ts --ipfs-cid '${bad}'`)
			);
			expect(payload, `--ipfs-cid '${bad}' was accepted`).toBeNull();
		}
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
