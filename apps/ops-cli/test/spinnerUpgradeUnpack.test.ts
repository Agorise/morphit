/**
 * During a real upgrade the operator sits through the tarball unpack and each
 * service restart. Both show the braille spinner for the whole wait: the stand-in
 * `tar` and `systemctl` on PATH copy what the (fake) terminal shows at the moment
 * they run, so the test sees the spinner WAS the current line during the wait.
 *
 * Drives the real runUpgrade on a hidden-only node (as upgradeRestartRollback
 * does): no npm, no clearnet.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OFFICIAL_PUB, signedRelease, stubIndexer } from './helpers/releaseChain.ts';
import { currentLine, fakeTerminal, frameRe, type FakeTerminal } from './helpers/screen.ts';

let peerBytes: Buffer = Buffer.alloc(0);
vi.mock('../src/init/hiddenUpgradeTransport.js', () => ({
	makeHiddenTarballFetcher: () => async () => new Uint8Array(peerBytes)
}));

const { runUpgrade } = await import('../src/commands/upgrade.ts');

const scratch = mkdtempSync(join(tmpdir(), 'morphit-unpack-spin-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const CID = `bafy${'a'.repeat(55)}`;
const peers = { instances: [{ alt_networks: { tor: `${'p'.repeat(56)}.onion` } }] };
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const REAL_TAR = spawnSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).stdout.trim();

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
	expect(spawnSync(REAL_TAR, ['-czf', out, '-C', tree, '.']).status).toBe(0);
	return readFileSync(out);
}

let work = '';
let installDir = '';
let term: FakeTerminal | null = null;
const saved = { ...process.env };

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
	writeFileSync(
		join(etcDir, 'indexer.env'),
		'MORPHIT_INDEXER_RPC_ENDPOINTS=\nMORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=http://x.onion\nMORPHIT_INDEXER_TOR_SOCKS=127.0.0.1:1\n'
	);
	const bin = join(work, 'bin');
	mkdirSync(bin);
	writeFileSync(join(work, 'screen'), '');
	const stub = (name: string, body: string): void => {
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	};
	stub('npm', 'exit 1');
	// tar: when it unpacks, keep what the terminal showed, then do the real work.
	stub(
		'tar',
		`case "$1" in -xzf) cp '${join(work, 'screen')}' '${join(work, 'at-tar')}' ;; esac\nexec '${REAL_TAR}' "$@"`
	);
	// systemctl: knows only the indexer, which stays up; a restart keeps the screen.
	const marker = join(work, 'indexer-restarted');
	stub(
		'systemctl',
		`case "$*" in
  "is-active --quiet morphit-indexer.service") exit 0 ;;
  "restart morphit-indexer.service") cp '${join(work, 'screen')}' '${join(work, 'at-restart')}'; : > '${marker}'; exit 0 ;;
  "show -p ActiveState --value morphit-indexer.service") echo active; exit 0 ;;
  "show -p NRestarts --value morphit-indexer.service") echo 0; exit 0 ;;
esac
exit 1`
	);
	process.env.PATH = `${bin}:${saved.PATH ?? '/usr/bin:/bin'}`;
	process.env.MORPHIT_INSTALL_DIR = installDir;
	process.env.MORPHIT_ETC_DIR = etcDir;
	process.env.MORPHIT_ENV_ROOT = join(work, 'envroot');
	process.env.MORPHIT_OFFLINE_RELEASE_DIR = join(work, 'no-drops');
	process.env.MORPHIT_WEB_ROOT = join(work, 'www');
	process.env.MORPHIT_SYSTEMD_DIR = join(work, 'systemd');
	process.env.MORPHIT_HELPER_DIR = join(work, 'helpers');
	term = fakeTerminal({ mirror: join(work, 'screen') });
});

afterEach(() => {
	term?.restore();
	term = null;
	vi.restoreAllMocks();
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
	Object.assign(process.env, saved);
});

describe('the upgrade: unpacking and restarting show the spinner', () => {
	it('the spinner is the current line while tar unpacks and while a service restarts', async () => {
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
			await runUpgrade({
				flags: { yes: 'true' },
				positional: [],
				localIndexerBases: [idx.base],
				verifyLocalIndexer: () => ({ kind: 'verified' as const, how: 'override' as const }),
				trust: { postingPubkey: OFFICIAL_PUB }
			} as never);
		} finally {
			await idx.close();
		}
		const tag = JSON.parse(readFileSync(join(installDir, 'release-info.json'), 'utf8')).tag;
		expect(tag).toBe('v1.18.0');
		expect(currentLine(readFileSync(join(work, 'at-tar'), 'utf8'))).toMatch(
			frameRe('Unpacking the new release…')
		);
		expect(currentLine(readFileSync(join(work, 'at-restart'), 'utf8'))).toMatch(
			frameRe('Restarting morphit-indexer.service…')
		);
	}, 120_000);
});
