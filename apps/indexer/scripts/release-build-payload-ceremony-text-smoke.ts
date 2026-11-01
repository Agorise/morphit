/**
 * release-build-payload-ceremony-text-smoke
 *
 * The release ceremony (ELI5 Block 3) runs release-build-payload.ts with
 * `< /dev/null`, so it asks nothing. The owner's v1.21.19 Block 3 output still
 * said "Enter values … Leave a field empty", named four mirrors as
 * "auto-mirrored" (the payload pins eighteen; only codeberg.org and gitea.com
 * get the release page), and told him to "pipe it to your Blurt signing tool"
 * (Block 4's release-broadcast.ts signs and broadcasts). The payload itself was
 * right; the words around it were not.
 *
 * This runs the builder exactly as Block 3 does (stdin not a terminal, the
 * MORPHIT_BUILD_* values the ceremony gives) and checks what it prints:
 *   1. it exits 0 and prints a payload that parses, with the pinned mirrors;
 *   2. none of the stale lines appear;
 *   3. it says it asks nothing, how the mirrors get the release, and that
 *      release-broadcast.ts broadcasts it.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
const BUILDER = join(HERE, 'release-build-payload.ts');

let failures = 0;
let scenarios = 0;
const ok = (m: string) => {
	console.log(`  ✓ ${m}`);
	scenarios++;
};
const bad = (m: string, d: string) => {
	console.error(`  ✗ ${m}\n      ${d}`);
	failures++;
	scenarios++;
};

const dir = mkdtempSync(join(tmpdir(), 'morphit-payload-text-'));
let out = '';
let err = '';
let status: number | null = null;
try {
	const manifest = join(dir, 'manifest.json');
	writeFileSync(
		manifest,
		JSON.stringify({ '/index.html': 'sha256-p2z5U8jU2KM8kQnD2b5EZCFxrH8qrCviVLpNec+swt4=' })
	);
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('MORPHIT_BUILD_')) env[k] = v;
	Object.assign(env, {
		MORPHIT_BUILD_VERSION: '1.21.19',
		MORPHIT_BUILD_BLURT_BASE: '125',
		MORPHIT_BUILD_HASH_MANIFEST_FILE: manifest,
		MORPHIT_BUILD_SOURCE_SHA256: '36bd5c06f28b60f7df76cc9495db564e007113111bbd343ec948f66c07e74d1d',
		MORPHIT_BUILD_GPG_FINGERPRINT: '7B4C1D189DBB610C473B59ED53524E1F1017EB9C',
		MORPHIT_BUILD_IPFS_CID: 'bafybeigw7knn6jgblhnhymf2dsdh27y7cgn6ckaxufj7o3wwvkcec723by'
	});
	// stdin 'ignore' = /dev/null, as in Block 3: not a terminal.
	const r = spawnSync(TSX, [BUILDER], {
		env,
		cwd: REPO,
		stdio: ['ignore', 'pipe', 'pipe'],
		encoding: 'utf-8',
		timeout: 120_000
	});
	out = r.stdout ?? '';
	err = r.stderr ?? '';
	status = r.status;
} finally {
	rmSync(dir, { recursive: true, force: true });
}

// ── 1. it builds the payload ─────────────────────────────────
let mirrors: unknown[] = [];
if (status !== 0) bad('the builder exits 0', `exit ${status}\n${err.slice(-800)}`);
else
	try {
		const p = JSON.parse(out) as { version?: string; distribution?: { mirrors?: unknown[] } };
		mirrors = p.distribution?.mirrors ?? [];
		if (p.version === '1.21.19' && mirrors.length > 4)
			ok(`it prints a payload that parses, with ${mirrors.length} pinned mirrors`);
		else bad('the payload carries the version and the pinned mirrors', out.slice(0, 400));
	} catch (e) {
		bad('the payload on stdout parses', String(e));
	}

// ── 2. no stale words ─────────────────────────────────────────
const STALE: [string, string][] = [
	['Enter values', 'tells the owner to enter values though nothing is asked'],
	['Leave a\nfield empty', 'tells the owner to leave fields empty though nothing is asked'],
	[
		'Leave any treasury field empty',
		'tells the owner to leave fields empty though nothing is asked'
	],
	['Leave ALL empty', 'tells the owner to leave fields empty though nothing is asked'],
	['auto-mirrored', 'names four mirrors as auto-mirrored'],
	['SourceHut)', 'names a short, fixed mirror list'],
	['Pipe it', 'tells the owner to pipe it to a signing tool'],
	['signing tool', 'tells the owner to use a separate signing tool'],
	['§40.5', 'points at the manual-signing section instead of Block 4']
];
for (const [s, why] of STALE)
	if (err.includes(s)) bad(`it does not print "${s.replace('\n', ' ')}"`, why);
	else ok(`it does not print "${s.replace('\n', ' ')}"`);

// ── 3. what it should say ─────────────────────────────────────
const WANT: [string, string][] = [
	['Asks nothing', 'says it asks nothing'],
	['codeberg.org and gitea.com also get the release', 'says which mirrors get the release page'],
	['release-broadcast.ts (ELI5 Block 4)', 'says Block 4 broadcasts it'],
	['PRIVATE', 'still says which key Block 4 asks for']
];
for (const [s, what] of WANT)
	if (err.replace(/\n/g, ' ').includes(s)) ok(`it ${what}`);
	else bad(`it ${what}`, `"${s}" missing from:\n${err.slice(0, 1500)}`);

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} release-build-payload-ceremony-text scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} release-build-payload-ceremony-text scenarios failed`);
	process.exit(1);
}
