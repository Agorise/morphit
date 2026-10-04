/**
 * An upgrade whose restarted service does not stay up rolls back.
 *
 * The pure classifier is covered in upgradeRestartVerify.test.ts; this drives
 * the real runUpgrade through step 10 with a `systemctl` stub that reports the
 * indexer active before the restart and `failed` after it, and checks the
 * upgrade returns non-zero with the previous release back in place. A service
 * that stays up is the control: the same upgrade completes on the new release.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OFFICIAL_PUB, signedRelease, stubIndexer } from './helpers/releaseChain.ts';

let peerBytes: Buffer = Buffer.alloc(0);
vi.mock('../src/init/hiddenUpgradeTransport.js', () => ({
	makeHiddenTarballFetcher: () => async () => new Uint8Array(peerBytes)
}));

const { runUpgrade } = await import('../src/commands/upgrade.ts');

const scratch = mkdtempSync(join(tmpdir(), 'morphit-restart-rollback-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const CID = `bafy${'a'.repeat(55)}`;
const peers = { instances: [{ alt_networks: { tor: `${'p'.repeat(56)}.onion` } }] };
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const lock = (wsVersion: string): string =>
	JSON.stringify({
		name: 'morphit',
		version: wsVersion,
		lockfileVersion: 3,
		packages: {
			'': { name: 'morphit', version: wsVersion, workspaces: ['apps/ops-cli'] },
			'apps/ops-cli': {
				name: 'morphit-ops',
				version: wsVersion,
				dependencies: { 'left-pad': '*' }
			},
			'node_modules/morphit-ops': { resolved: 'apps/ops-cli', link: true },
			'node_modules/left-pad': {
				version: '1.3.0',
				resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
				integrity: 'sha512-1.3.0'
			}
		}
	});

function slimRelease(): Buffer {
	const tree = mkdtempSync(join(scratch, 'tree-'));
	writeFileSync(
		join(tree, 'release-info.json'),
		JSON.stringify({ tag: 'v1.18.0', commit: 'c', build_time: 't', builder: 'b' })
	);
	writeFileSync(join(tree, 'package.json'), '{}');
	writeFileSync(join(tree, 'package-lock.json'), lock('1.18.0'));
	mkdirSync(join(tree, 'apps', 'web', 'build'), { recursive: true });
	writeFileSync(join(tree, 'apps', 'web', 'build', 'index.html'), '<html></html>');
	mkdirSync(join(tree, 'apps', 'ops-cli'), { recursive: true });
	const out = join(scratch, `rel-${Math.random().toString(36).slice(2)}.tar.gz`);
	expect(spawnSync('tar', ['-czf', out, '-C', tree, '.']).status).toBe(0);
	return readFileSync(out);
}

let work = '';
let installDir = '';
let ctlLog = '';
const saved = { ...process.env };

/** A `systemctl` that knows only the indexer: active before, `afterState` once restarted. */
function stubSystemctl(bin: string, afterState: string): void {
	const marker = join(work, 'indexer-restarted');
	writeFileSync(
		join(bin, 'systemctl'),
		`#!/bin/sh
echo "$*" >> '${ctlLog}'
case "$*" in
  "is-active --quiet morphit-indexer.service") exit 0 ;;
  "restart morphit-indexer.service") : > '${marker}'; exit 0 ;;
  "show -p ActiveState --value morphit-indexer.service")
    if [ -e '${marker}' ]; then echo '${afterState}'; else echo active; fi; exit 0 ;;
  "show -p NRestarts --value morphit-indexer.service") echo 0; exit 0 ;;
esac
exit 1
`
	);
	chmodSync(join(bin, 'systemctl'), 0o755);
}

beforeEach(() => {
	work = mkdtempSync(join(scratch, 'run-'));
	installDir = join(work, 'morphit');
	const etcDir = join(work, 'etc');
	mkdirSync(etcDir);
	mkdirSync(join(installDir, 'node_modules', 'left-pad'), { recursive: true });
	mkdirSync(join(installDir, 'apps', 'ops-cli'), { recursive: true });
	writeFileSync(
		join(installDir, 'node_modules', 'left-pad', 'package.json'),
		JSON.stringify({ name: 'left-pad', version: '1.3.0' })
	);
	spawnSync('ln', ['-s', '../apps/ops-cli', join(installDir, 'node_modules', 'morphit-ops')]);
	writeFileSync(join(installDir, 'package-lock.json'), lock('1.17.15'));
	writeFileSync(
		join(installDir, 'release-info.json'),
		JSON.stringify({ tag: 'v1.17.15', commit: 'x', build_time: 'x', builder: 'x' })
	);
	// A hidden-only node with unchanged dependencies: no npm, no clearnet.
	writeFileSync(
		join(etcDir, 'indexer.env'),
		'MORPHIT_INDEXER_RPC_ENDPOINTS=\nMORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=http://x.onion\nMORPHIT_INDEXER_TOR_SOCKS=127.0.0.1:1\n'
	);
	const bin = join(work, 'bin');
	mkdirSync(bin);
	ctlLog = join(work, 'systemctl.log');
	writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 1\n');
	chmodSync(join(bin, 'npm'), 0o755);
	process.env.PATH = `${bin}:${saved.PATH ?? '/usr/bin:/bin'}`;
	process.env.MORPHIT_INSTALL_DIR = installDir;
	process.env.MORPHIT_ETC_DIR = etcDir;
	process.env.MORPHIT_ENV_ROOT = join(work, 'envroot');
	process.env.MORPHIT_OFFLINE_RELEASE_DIR = join(work, 'no-drops');
	process.env.MORPHIT_WEB_ROOT = join(work, 'www');
	process.env.MORPHIT_SYSTEMD_DIR = join(work, 'systemd');
	process.env.MORPHIT_HELPER_DIR = join(work, 'helpers');
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
	Object.assign(process.env, saved);
});

async function upgrade(): Promise<number> {
	const bytes = slimRelease();
	peerBytes = bytes;
	const idx = await stubIndexer({
		release: { version: '1.18.0', distribution: { source_sha256: sha(bytes), ipfs_cid: CID } },
		instances: peers,
		chain: signedRelease('1.18.0', {
			source_sha256: sha(bytes),
			ipfs_cid: CID,
			gpg_fingerprint: 'A'.repeat(40)
		})
	});
	try {
		return await runUpgrade({
			flags: { yes: 'true' },
			positional: [],
			localIndexerBases: [idx.base],
			verifyLocalIndexer: () => ({ kind: 'verified' as const, how: 'override' as const }),
			trust: { postingPubkey: OFFICIAL_PUB }
		} as never);
	} finally {
		await idx.close();
	}
}

const tag = (): string =>
	JSON.parse(readFileSync(join(installDir, 'release-info.json'), 'utf8')).tag;
const ctlCalls = (): string[] =>
	existsSync(ctlLog) ? readFileSync(ctlLog, 'utf8').split('\n') : [];

describe('the upgrade restart step', () => {
	it('rolls back when a service that was running does not stay up on the new release', async () => {
		stubSystemctl(join(work, 'bin'), 'failed');
		const rc = await upgrade();
		expect(ctlCalls()).toContain('restart morphit-indexer.service');
		expect(rc).not.toBe(0);
		expect(tag()).toBe('v1.17.15');
	}, 120_000);

	it('keeps the new release when the service stays up (control)', async () => {
		stubSystemctl(join(work, 'bin'), 'active');
		await upgrade();
		expect(ctlCalls()).toContain('restart morphit-indexer.service');
		expect(tag()).toBe('v1.18.0');
	}, 120_000);
});
