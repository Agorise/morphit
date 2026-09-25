/**
 * Who is listening on the indexer's port? (v1.18.0 deep-deep, ops-1)
 *
 * `morphit-ops upgrade` runs as root and took the release it installs from
 * whatever answered first on 127.0.0.1 / 172.18.0.1 / 172.17.0.1 port 8081.
 * Before anything is asked now, the listener must be proven to be
 * morphit-indexer.service. These build a scratch /proc (the same files the
 * kernel exposes) to drive every branch, including the shapes of the maintainer's real
 * boxes: morphit.io's indexer on 172.18.0.1, morphitlat's on 127.0.0.1. The last
 * case runs the check against the REAL /proc of this machine.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	verifyIndexerListener,
	locateLocalIndexer,
	candidateIndexerBases,
	parseProcNetTcp,
	FALLBACK_INDEXER_BASES,
	type ListenerVerdict
} from '../src/init/hiddenUpgradeLocalIndexer.ts';

let proc = '';
beforeEach(() => {
	proc = mkdtempSync(join(tmpdir(), 'morphit-fakeproc-'));
	mkdirSync(join(proc, 'net'));
});
afterEach(() => rmSync(proc, { recursive: true, force: true }));

/** IPv4 dotted → the kernel's little-endian hex. */
const hex4 = (ip: string): string =>
	ip
		.split('.')
		.map((b) => Number(b).toString(16).padStart(2, '0').toUpperCase())
		.reverse()
		.join('');

function listen(
	sockets: Array<{ ip: string; port: number; uid: number; inode: number }>,
	v6: string[] = []
): void {
	const head =
		'  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
	const rows = sockets.map(
		(s, i) =>
			`   ${i}: ${hex4(s.ip)}:${s.port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 0A ` +
			`00000000:00000000 00:00000000 00000000 ${s.uid} 0 ${s.inode} 1 0000000000000000 100 0 0 10 0\n`
	);
	writeFileSync(join(proc, 'net', 'tcp'), head + rows.join(''));
	writeFileSync(join(proc, 'net', 'tcp6'), head + v6.join(''));
}

function processHolding(pid: number, inode: number, cgroup: string, comm: string, uid = 0): void {
	mkdirSync(join(proc, String(pid), 'fd'), { recursive: true });
	symlinkSync(`socket:[${inode}]`, join(proc, String(pid), 'fd', '7'));
	writeFileSync(join(proc, String(pid), 'cgroup'), cgroup);
	writeFileSync(join(proc, String(pid), 'comm'), `${comm}\n`);
	writeFileSync(
		join(proc, String(pid), 'status'),
		`Name:\t${comm}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`
	);
}

const INDEXER_CG = '0::/system.slice/morphit-indexer.service\n';
const asRoot = (host: string, port = 8081, env: NodeJS.ProcessEnv = {}): ListenerVerdict =>
	verifyIndexerListener(host, port, { procRoot: proc, isRoot: () => true, env });
const unprivileged = (host: string, mainPid: number | null): ListenerVerdict =>
	verifyIndexerListener(host, 8081, {
		procRoot: proc,
		isRoot: () => false,
		indexerMainPid: () => mainPid,
		env: {}
	});

describe('as root: the listener must be in morphit-indexer.service', () => {
	it("morphit.io's shape: the indexer on the docker bridge 172.18.0.1 is verified", () => {
		listen([{ ip: '172.18.0.1', port: 8081, uid: 0, inode: 5555 }]);
		processHolding(4242, 5555, INDEXER_CG, 'node');
		expect(asRoot('172.18.0.1')).toEqual({ kind: 'verified', how: 'cgroup' });
	});

	it("morphitlat's shape: the indexer on loopback is verified (cgroup v1 layout too)", () => {
		listen([{ ip: '127.0.0.1', port: 8081, uid: 0, inode: 5555 }]);
		processHolding(
			4242,
			5555,
			'12:pids:/system.slice/morphit-indexer.service\n1:name=systemd:/system.slice/morphit-indexer.service\n',
			'node'
		);
		expect(asRoot('127.0.0.1')).toEqual({ kind: 'verified', how: 'cgroup' });
	});

	it('any other process on the port is refused, and named', () => {
		listen([{ ip: '127.0.0.1', port: 8081, uid: 998, inode: 6666 }]);
		processHolding(777, 6666, '0::/system.slice/ipfs.service\n', 'python3', 998);
		const v = asRoot('127.0.0.1');
		expect(v.kind).toBe('refused');
		expect(v.kind === 'refused' && v.reason).toContain('pid 777');
	});

	it('a unit whose name merely CONTAINS the indexer unit name is refused', () => {
		listen([{ ip: '127.0.0.1', port: 8081, uid: 0, inode: 6666 }]);
		processHolding(777, 6666, '0::/system.slice/evil-morphit-indexer.service.d/x\n', 'sh');
		expect(asRoot('127.0.0.1').kind).toBe('refused');
	});

	it('nothing on the port is "nothing listening", so the next candidate may be tried', () => {
		listen([{ ip: '127.0.0.1', port: 9999, uid: 0, inode: 1 }]);
		expect(asRoot('127.0.0.1')).toEqual({ kind: 'nothing-listening' });
	});

	it('a wildcard bind is judged by its owner, like any other', () => {
		listen([{ ip: '0.0.0.0', port: 8081, uid: 0, inode: 5555 }]);
		processHolding(4242, 5555, INDEXER_CG, 'node');
		expect(asRoot('172.18.0.1').kind).toBe('verified');
		rmSync(join(proc, '4242'), { recursive: true });
		processHolding(777, 5555, '0::/user.slice/user-1000.slice\n', 'nc', 1000);
		expect(asRoot('172.18.0.1').kind).toBe('refused');
	});

	it('an exact bind is what a connection reaches, not a wildcard beside it', () => {
		listen([
			{ ip: '0.0.0.0', port: 8081, uid: 1000, inode: 6666 },
			{ ip: '127.0.0.1', port: 8081, uid: 0, inode: 5555 }
		]);
		processHolding(4242, 5555, INDEXER_CG, 'node');
		expect(asRoot('127.0.0.1').kind).toBe('verified');
	});

	it('an IPv6 loopback listener is found in tcp6', () => {
		listen(
			[],
			[
				'   0: 00000000000000000000000001000000:1F91 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 5555 1 0 100 0 0 10 0\n'
			]
		);
		processHolding(4242, 5555, INDEXER_CG, 'node');
		expect(asRoot('::1')).toEqual({ kind: 'verified', how: 'cgroup' });
	});

	it('the documented override skips only the ownership check', () => {
		listen([{ ip: '127.0.0.1', port: 8081, uid: 1000, inode: 6666 }]);
		processHolding(777, 6666, '0::/user.slice\n', 'node', 1000);
		expect(asRoot('127.0.0.1', 8081, { MORPHIT_UPGRADE_TRUST_LOCAL_INDEXER: '1' })).toEqual({
			kind: 'verified',
			how: 'override'
		});
		expect(asRoot('127.0.0.1', 9000, { MORPHIT_UPGRADE_TRUST_LOCAL_INDEXER: '1' }).kind).toBe(
			'nothing-listening'
		);
	});

	it('a host name that is not an IP address cannot be checked, so it is refused', () => {
		listen([]);
		expect(asRoot('indexer.internal').kind).toBe('refused');
	});
});

describe('unprivileged (the release monitor): the socket owner must be the indexer user', () => {
	it('a root-owned listener, with the indexer running as root, is verified', () => {
		listen([{ ip: '172.18.0.1', port: 8081, uid: 0, inode: 5555 }]);
		processHolding(4242, 5555, INDEXER_CG, 'node', 0);
		expect(unprivileged('172.18.0.1', 4242)).toEqual({ kind: 'verified', how: 'socket-owner' });
	});
	it("another user's listener is refused", () => {
		listen([{ ip: '127.0.0.1', port: 8081, uid: 1001, inode: 6666 }]);
		processHolding(4242, 5555, INDEXER_CG, 'node', 0);
		expect(unprivileged('127.0.0.1', 4242).kind).toBe('refused');
	});
	it('with the indexer not running, nothing is trusted', () => {
		listen([{ ip: '127.0.0.1', port: 8081, uid: 0, inode: 5555 }]);
		expect(unprivileged('127.0.0.1', null).kind).toBe('refused');
	});
});

describe('which address is asked', () => {
	it('the configured listen address, and only it', () => {
		const dir = mkdtempSync(join(tmpdir(), 'morphit-cfg-'));
		try {
			const f = join(dir, 'indexer.env');
			writeFileSync(
				f,
				'MORPHIT_INDEXER_LISTEN_HOST=172.18.0.1\nMORPHIT_INDEXER_LISTEN_PORT=8081\n'
			);
			expect(candidateIndexerBases({ unitEnvFiles: [f] })).toEqual(['http://172.18.0.1:8081']);
			writeFileSync(f, 'MORPHIT_INDEXER_LISTEN_HOST=0.0.0.0\nMORPHIT_INDEXER_LISTEN_PORT=9081\n');
			expect(candidateIndexerBases({ unitEnvFiles: [f] })).toEqual(['http://127.0.0.1:9081']);
			writeFileSync(f, 'MORPHIT_INDEXER_RPC_ENDPOINTS=\n');
			expect(candidateIndexerBases({ unitEnvFiles: [f] })).toEqual(FALLBACK_INDEXER_BASES);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('the first address with a listener is final: a refused one never hands over to the next', () => {
		const verdicts: Record<string, ListenerVerdict> = {
			'127.0.0.1': { kind: 'refused', reason: 'not the indexer' },
			'172.18.0.1': { kind: 'verified', how: 'cgroup' }
		};
		const asked: string[] = [];
		const verifyListener = (h: string): ListenerVerdict => {
			asked.push(h);
			return verdicts[h] ?? { kind: 'nothing-listening' };
		};
		expect(() => locateLocalIndexer({ bases: FALLBACK_INDEXER_BASES, verifyListener })).toThrow(
			/not the indexer/
		);
		expect(asked).toEqual(['127.0.0.1']);
		verdicts['127.0.0.1'] = { kind: 'nothing-listening' };
		expect(locateLocalIndexer({ bases: FALLBACK_INDEXER_BASES, verifyListener })).toBe(
			'http://172.18.0.1:8081'
		);
	});
});

describe('against the real /proc of this machine', () => {
	it('a listener of this test process is found, and it is not the indexer', async () => {
		const server: Server = createServer((_q, r) => r.end('{}'));
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const { port } = server.address() as AddressInfo;
		try {
			// Found at all? (parse of the real kernel table)
			const { readFileSync } = await import('node:fs');
			const rows = parseProcNetTcp(readFileSync('/proc/net/tcp', 'utf8'));
			expect(rows.some((r) => r.port === port)).toBe(true);
			const v = verifyIndexerListener('127.0.0.1', port, { indexerMainPid: () => null, env: {} });
			expect(v.kind).toBe('refused');
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
		expect(verifyIndexerListener('127.0.0.1', port, { env: {} }).kind).toBe('nothing-listening');
	});
});
