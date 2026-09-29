/**
 * Footgun 6 (review B10): the HIDDEN-federation upgrade path must NOT print the
 * "No sibling .asc signature …" warning — its trust anchor is the on-chain
 * SHA-256 (hidden-federation-onchain-sha256), which needs no .asc, so the
 * warning was false alarm moments before the upgrade verified and proceeded
 * (morphitlat). A hand-supplied --from-file tarball with no .asc still
 * gets it.
 *
 * Behavioural: drives the REAL runUpgrade with the hidden resolver stubbed (no
 * Tor/I2P, no network) and asserts on what it actually prints. Everything runs
 * against scratch dirs; the fake tarball fails to extract, so the run rolls
 * back inside the scratch install dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let hiddenTarball = '';

vi.mock('../src/init/hiddenUpgradeResolve.ts', async (importOriginal) => {
	const orig = (await importOriginal()) as Record<string, unknown>;
	return {
		...orig,
		readHiddenReleaseTarget: async () => ({ tag: 'v9.9.9' }),
		tryResolveHiddenUpgrade: async () => ({
			tarballPath: hiddenTarball,
			version: '9.9.9',
			servedBy: 'http://peer.onion'
		})
	};
});

const { runUpgrade } = await import('../src/commands/upgrade.ts');

let root = '';
let out = '';
const savedEnv = { ...process.env };

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'morphit-asc-warn-'));
	const install = join(root, 'install');
	mkdirSync(install, { recursive: true });
	writeFileSync(
		join(install, 'release-info.json'),
		JSON.stringify({ tag: 'v1.0.0', commit: 'x', build_time: 'x', builder: 'x' })
	);
	mkdirSync(join(root, 'etc'), { recursive: true });
	process.env.MORPHIT_INSTALL_DIR = install;
	process.env.MORPHIT_ETC_DIR = join(root, 'etc');
	process.env.MORPHIT_SYSTEMD_DIR = join(root, 'systemd');
	process.env.MORPHIT_HELPER_DIR = join(root, 'helpers');
	out = '';
	const grab = (chunk: unknown): boolean => {
		out += String(chunk);
		return true;
	};
	vi.spyOn(process.stdout, 'write').mockImplementation(grab as never);
	vi.spyOn(process.stderr, 'write').mockImplementation(grab as never);
	vi.spyOn(console, 'log').mockImplementation(
		(...a: unknown[]) => void (out += a.join(' ') + '\n')
	);
	vi.spyOn(console, 'error').mockImplementation(
		(...a: unknown[]) => void (out += a.join(' ') + '\n')
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	process.env = { ...savedEnv };
	rmSync(root, { recursive: true, force: true });
});

const NO_ASC = /No sibling \.asc signature/;
const deadIndexer = {
	localIndexerBases: ['http://127.0.0.1:1'],
	verifyLocalIndexer: () => ({ kind: 'nothing-listening' as const })
};

describe('the "No sibling .asc" warning (footgun 6)', () => {
	it('is NOT printed on the hidden-federation (on-chain SHA-256) path', async () => {
		hiddenTarball = join(root, 'morphit-9.9.9.tar.gz');
		writeFileSync(hiddenTarball, 'not a real tarball');
		await runUpgrade({ flags: { yes: 'true' }, positional: [], ...deadIndexer });
		expect(out).toMatch(/Offline upgrade|local tarball/); // it really took the hidden → offline path
		expect(out).not.toMatch(NO_ASC);
	});

	it('IS printed for a hand-supplied --from-file tarball with no .asc', async () => {
		const tb = join(root, 'morphit-v9.9.9.tar.gz');
		writeFileSync(tb, 'not a real tarball');
		await runUpgrade({ flags: { yes: 'true', 'from-file': tb }, positional: [], ...deadIndexer });
		expect(out).toMatch(NO_ASC);
	});
});
