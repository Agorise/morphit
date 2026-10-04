/**
 * `sudo morphit-ops upgrade` on a box already on the newest release still runs
 * this release's heals (self-heal is the rule): every heal message that says
 * "the next `sudo morphit-ops upgrade` tries again" is then true on an
 * up-to-date box too. `--check-only` and `--json` stay read-only.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OFFICIAL_PUB, signedRelease, stubIndexer } from './helpers/releaseChain.ts';

const { runUpgrade } = await import('../src/commands/upgrade.ts');

const scratch = mkdtempSync(join(tmpdir(), 'morphit-uptodate-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const saved = { ...process.env };
let work = '';

beforeEach(() => {
	work = mkdtempSync(join(scratch, 'run-'));
	const installDir = join(work, 'morphit');
	mkdirSync(installDir, { recursive: true });
	writeFileSync(
		join(installDir, 'release-info.json'),
		JSON.stringify({ tag: 'v1.18.0', commit: 'x', build_time: 'x', builder: 'x' })
	);
	const etcDir = join(work, 'etc');
	mkdirSync(etcDir);
	writeFileSync(
		join(etcDir, 'indexer.env'),
		'MORPHIT_INDEXER_RPC_ENDPOINTS=\nMORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=http://x.onion\nMORPHIT_INDEXER_TOR_SOCKS=127.0.0.1:1\n'
	);
	process.env.MORPHIT_INSTALL_DIR = installDir;
	process.env.MORPHIT_ETC_DIR = etcDir;
	process.env.MORPHIT_ENV_ROOT = join(work, 'envroot');
	process.env.MORPHIT_OFFLINE_RELEASE_DIR = join(work, 'no-drops');
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
	Object.assign(process.env, saved);
});

/** The same release as the one installed, offered from a local file. */
function sameReleaseFile(): string {
	const f = join(work, 'morphit-v1.18.0-offline.tar.gz');
	writeFileSync(f, 'bundle');
	return f;
}

describe('an up-to-date box', () => {
	it('`upgrade` (a release source that offers the installed version) still runs the heals', async () => {
		let heals = 0;
		const rc = await runUpgrade({
			flags: { 'from-file': sameReleaseFile() },
			positional: [],
			healsWhenUpToDate: async () => (heals++, 0)
		} as never);
		expect(rc).toBe(0);
		expect(heals, 'no heal ran on an up-to-date box').toBe(1);
	});

	it('a hidden-only box whose own indexer names the installed release still runs the heals', async () => {
		const sha = createHash('sha256').update('x').digest('hex');
		const CID = `bafy${'a'.repeat(55)}`;
		const idx = await stubIndexer({
			release: { version: '1.18.0', distribution: { source_sha256: sha, ipfs_cid: CID } },
			instances: { instances: [] },
			chain: signedRelease('1.18.0', {
				source_sha256: sha,
				ipfs_cid: CID,
				gpg_fingerprint: 'A'.repeat(40)
			})
		});
		let heals = 0;
		try {
			const rc = await runUpgrade({
				flags: {},
				positional: [],
				localIndexerBases: [idx.base],
				verifyLocalIndexer: () => ({ kind: 'verified' as const, how: 'override' as const }),
				trust: { postingPubkey: OFFICIAL_PUB },
				healsWhenUpToDate: async () => (heals++, 0)
			} as never);
			expect(rc).toBe(0);
		} finally {
			await idx.close();
		}
		expect(heals, 'no heal ran on an up-to-date hidden-only box').toBe(1);
	});

	it('the default heals run only for the install this morphit-ops belongs to (here: a scratch install, so none)', async () => {
		const out: string[] = [];
		vi.spyOn(process.stdout, 'write').mockImplementation(
			((c: unknown) => (out.push(String(c)), true)) as never
		);
		const rc = await runUpgrade({
			flags: { 'from-file': sameReleaseFile() },
			positional: []
		} as never);
		expect(rc).toBe(0);
		expect(out.join('')).toMatch(/Already on the latest release/);
		expect(out.join('')).toMatch(/not the one installed in .*so its repairs were not run there/);
		expect(out.join('')).not.toMatch(/Checking this release's repairs/);
	});

	it('`--check-only` and `--json` change nothing', async () => {
		let heals = 0;
		const f = sameReleaseFile();
		for (const flags of [
			{ 'from-file': f, 'check-only': 'true' },
			{ 'from-file': f, json: 'true' }
		]) {
			await runUpgrade({
				flags,
				positional: [],
				healsWhenUpToDate: async () => (heals++, 0)
			} as never);
		}
		expect(heals).toBe(0);
	});
});
