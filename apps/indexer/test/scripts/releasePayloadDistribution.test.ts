/**
 * v1.20.3 — the release-op builder's distribution block (Block 3 of the
 * ceremony). v1.20.2's first dry-run carried the PREVIOUS release's IPFS record
 * and CID (old values left in the laptop's terminal) and, once those were
 * dropped, no IPNS name at all — which every zero-clearnet node of v1.20.2 and
 * earlier requires, so morphitlat could not upgrade. These tests run the REAL
 * builder.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const APP = resolve(HERE, '../..');
const TSX = resolve(APP, '../../node_modules/.bin/tsx');

const SHA = 'c8f6ec8b1cfe6a322cf9640bd83879076c5bdd7c0c2245347589e3ecb2372bc1';
const FPR = '7B4C1D189DBB610C473B59ED53524E1F1017EB9C';
const CID_1201 = 'bafybeia5rkympgrdwxsi3dne4viuo3fbcjmgxhyg3tl2ia7p43wz2z2pni';
const CID_1202 = 'bafybeiegfyir3zryt3iosz7ysxikcki4vwtui35ykd4uf55zp4ww5uctki';
/** The real v1.20.1 IPNS record (it points at CID_1201). */
const RECORD_1201 =
	'CkEvaXBmcy9iYWZ5YmVpYTVya3ltcGdyZHd4c2kzZG5lNHZpdW8zZmJjam1neGh5ZzN0bDJpYTdwNDN3ejJ6MnBuaRJAs0rKf4ZWU9XM6M841HO/IMR5mS34LoqNkq1A+KMs5u72Q2IuchSdyWK9McLW2Du1GxOoXcYHgAWB3wm1+T8+DxgAIh4yMDI3LTEwLTAxVDAzOjQxOjIwLjU5NjAwMDAwMFoo26z31QYwgPCSy90IQkD4v2GpuSEAMqouW7IUgWms0JRaFzz6I2lscEaBGvcOi4S/JLoGNYZzGCEJaVB5c/bTRHM9EWR8UVjP3whk43kFSpwBpWNUVEwbAAAARdlkuABlVmFsdWVYQS9pcGZzL2JhZnliZWlhNXJreW1wZ3Jkd3hzaTNkbmU0dml1bzNmYmNqbWd4aHlnM3RsMmlhN3A0M3d6MnoycG5paFNlcXVlbmNlGmq91ltoVmFsaWRpdHlYHjIwMjctMTAtMDFUMDM6NDE6MjAuNTk2MDAwMDAwWmxWYWxpZGl0eVR5cGUA';

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function build(env: Record<string, string>, args: string[] = []) {
	const dir = mkdtempSync(join(tmpdir(), 'dist-m-'));
	dirs.push(dir);
	const f = join(dir, 'm.json');
	writeFileSync(f, JSON.stringify({ 'index.html': 'sha256-' + 'a'.repeat(43) + '=' }));
	// Only what the test gives: no MORPHIT_BUILD_* from the environment running it.
	const base = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !k.startsWith('MORPHIT_BUILD_'))
	);
	const r = spawnSync(TSX, [resolve(APP, 'scripts', 'release-build-payload.ts'), ...args], {
		cwd: resolve(APP, '../..'),
		env: {
			...base,
			MORPHIT_BUILD_VERSION: '1.20.3',
			MORPHIT_BUILD_HASH_MANIFEST_FILE: f,
			MORPHIT_BUILD_SOURCE_SHA256: SHA,
			MORPHIT_BUILD_GPG_FINGERPRINT: FPR,
			...env
		},
		input: '',
		encoding: 'utf8',
		timeout: 60_000
	});
	const dist =
		r.status === 0
			? (JSON.parse(r.stdout) as { distribution: Record<string, unknown> }).distribution
			: null;
	return { r, dist };
}

const CANONICAL_NAME = /export const MORPHIT_IPNS_NAME = '(k51[a-z0-9]+)'/.exec(
	readFileSync(resolve(APP, '../web/src/lib/ipns.ts'), 'utf8')
)![1]!;

describe('the release builder distribution block', () => {
	it('always names Morphit’s IPNS name, even when the anchor carries none (zero-clearnet nodes need it)', () => {
		const { r, dist } = build({ MORPHIT_BUILD_IPFS_CID: CID_1202 });
		expect(r.status).toBe(0);
		expect(dist?.ipns_name).toBe(CANONICAL_NAME);
		expect(dist?.ipfs_cid).toBe(CID_1202);
		expect(dist).not.toHaveProperty('ipns_record');
	});
	it('refuses an IPNS record that points at another CID (an old record left in the terminal)', () => {
		const { r } = build({
			MORPHIT_BUILD_IPFS_CID: CID_1202,
			MORPHIT_BUILD_IPNS_RECORD: RECORD_1201
		});
		expect(r.status).not.toBe(0);
		expect(r.stderr).toMatch(/IPNS record points at .*bafybeia5rky/);
		expect(r.stderr).toMatch(/unset/i);
	});
	it('refuses an IPNS record when there is no CID to check it against', () => {
		const { r } = build({ MORPHIT_BUILD_IPNS_RECORD: RECORD_1201 });
		expect(r.status).not.toBe(0);
		expect(r.stderr).toMatch(/IPNS record/);
	});
	it('refuses to emit a release with no CID (v1.20.2: zero-clearnet nodes could not fetch it)', () => {
		const { r } = build({});
		expect(r.status).not.toBe(0);
		expect(r.stdout, 'a payload with no ipfs_cid was emitted').toBe('');
		// It says how to supply the CID instead.
		expect(r.stderr).toMatch(/--ipfs-cid/);
	});
	it('emits a release with no CID only with the explicit override', () => {
		const { r, dist } = build({}, ['--allow-no-ipfs-cid']);
		expect(r.status, r.stderr.slice(-400)).toBe(0);
		expect(dist).not.toHaveProperty('ipfs_cid');
		expect(dist?.ipns_name).toBe(CANONICAL_NAME);
	});
	it('refuses an argument it does not know (a typo must not silently drop the CID)', () => {
		const { r } = build({ MORPHIT_BUILD_IPFS_CID: CID_1202 }, ['--ipfs-ci', CID_1202]);
		expect(r.status).not.toBe(0);
		expect(r.stdout).toBe('');
	});
	it('accepts a record that points at this release’s CID', () => {
		const { r, dist } = build({
			MORPHIT_BUILD_IPFS_CID: CID_1201,
			MORPHIT_BUILD_IPNS_RECORD: RECORD_1201
		});
		expect(r.status).toBe(0);
		expect(dist?.ipns_record).toBe(RECORD_1201);
	});
});
