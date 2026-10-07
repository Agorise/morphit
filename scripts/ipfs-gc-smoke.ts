#!/usr/bin/env tsx
/**
 * scripts/ipfs-gc-smoke.ts (v1.20.0, C16)
 *
 * Nothing ever unpinned a superseded Morphit release or indexer snapshot, or
 * removed the snapshot copies the publisher stages inside the IPFS repo, so a
 * node's repo only grew. This EXECUTES the real ops/ipfs/morphit-ipfs-gc.sh
 * (and the real `healIpfsGc` self-heal entry) against a stub Kubo that keeps
 * its pins and content in a JSON file and logs every call, with the local
 * indexer's /v1/release served from 127.0.0.1, and asserts the PINS and FILES
 * left afterwards:
 *   - superseded releases/snapshots are unpinned; the anchored release, the
 *     previous one, anything newer and the running one stay; the anchored
 *     snapshot, anything newer and two older ones stay; unknown pins stay;
 *   - a staged snapshot copy is removed only once nothing pins it;
 *   - no anchor known → nothing of that kind is unpinned; daemon down → nothing;
 *   - every read is --offline (never a network fetch) and every call goes to
 *     the daemon's API (never opens the repo itself).
 * (Proven once against a real Kubo 0.42 daemon as well — see the v1.20.0 report.)
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
	existsSync,
	chmodSync,
	readdirSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(import.meta.dirname, '..');
const GC = join(ROOT, 'ops', 'ipfs', 'morphit-ipfs-gc.sh');

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? `\n      ${detail.slice(0, 1500)}` : ''}`);
	}
};

// A tar (ustar) with the given files, gzipped — what snapshot-export.ts writes.
function tarGz(files: Record<string, Buffer>): Buffer {
	const blocks: Buffer[] = [];
	for (const [name, data] of Object.entries(files)) {
		const h = Buffer.alloc(512);
		h.write(name, 0);
		h.write('0000644\0', 100);
		h.write('0000000\0', 108);
		h.write('0000000\0', 116);
		h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
		h.write('00000000000\0', 136);
		h.write('        ', 148);
		h.write('0', 156);
		h.write('ustar\0', 257);
		h.write('00', 263);
		let sum = 0;
		for (const b of h) sum += b;
		h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
		blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

// The stub Kubo. Content: { pins: [cid…], objects: { cid: {dir:{name:b64}} | {file:b64} },
// down?: bool, failRm?: [cid], gc: n }. Every argv is logged.
const STUB_IPFS = `#!/usr/bin/env node
const fs = require('fs');
const st = process.env.STUB_STATE;
const s = JSON.parse(fs.readFileSync(st, 'utf8'));
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(argv) + '\\n');
const save = () => fs.writeFileSync(st, JSON.stringify(s));
const a = [];
let api = false, offline = false, len = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--api') { api = true; i++; continue; }
  if (argv[i] === '--offline') { offline = true; continue; }
  if (argv[i].startsWith('--timeout')) continue;
  a.push(argv[i]);
}
if (!api) { console.error('stub: refusing to open a repo without --api'); process.exit(9); }
if (s.down) { console.error('Error: cannot connect to the api'); process.exit(1); }
const obj = (p) => { const [cid, ...rest] = p.split('/'); const o = s.objects[cid]; if (!o) return null; if (rest.length === 0) return o; if (!o.dir) return null; const f = o.dir[rest.join('/')]; return f === undefined ? null : { file: f }; };
if (a[0] === 'id') { console.log('12D3KooStub'); process.exit(0); }
if (a[0] === 'pin' && a[1] === 'ls') {
  const target = a.find((x, i) => i > 1 && !x.startsWith('-'));
  if (target) { if (s.pins.includes(target)) { console.log(target + ' recursive'); process.exit(0); } console.error("Error: path '" + target + "' is not pinned"); process.exit(1); }
  for (const c of s.pins) console.log(c); process.exit(0);
}
if (a[0] === 'pin' && a[1] === 'rm') {
  const c = a[2];
  if ((s.failRm || []).includes(c)) { console.error('Error: simulated'); process.exit(1); }
  if (!s.pins.includes(c)) { console.error('Error: not pinned or pinned indirectly'); process.exit(1); }
  s.pins = s.pins.filter((x) => x !== c); save(); process.exit(0);
}
if (a[0] === 'repo' && a[1] === 'gc') { s.gc = (s.gc || 0) + 1; for (const k of Object.keys(s.objects)) if (!s.pins.includes(k)) delete s.objects[k]; save(); process.exit(0); }
if (a[0] === 'repo' && a[1] === 'stat') { const n = Object.values(s.objects).reduce((t, o) => t + (o.file ? Buffer.from(o.file, 'base64').length : 4096), 0); console.log('RepoSize:   ' + n); console.log('StorageMax: 10000000000'); process.exit(0); }
if (a[0] === 'cat') {
  let p = null;
  for (let i = 1; i < a.length; i++) { if (a[i] === '-l') { len = Number(a[++i]); continue; } p = a[i]; }
  const o = obj(p);
  if (!o) { console.error('Error: block was not found locally (offline)'); process.exit(1); }
  if (o.dir) { console.error('Error: this dag node is a directory'); process.exit(1); }
  let b = Buffer.from(o.file, 'base64'); if (len !== null) b = b.subarray(0, len);
  process.stdout.write(b); process.exit(0);
}
console.error('stub: unhandled ' + JSON.stringify(a)); process.exit(2);
`;

const HTTP_JS = `
const http = require('http');
const [port, body] = process.argv.slice(1);
http.createServer((q, r) => { if (q.url === '/v1/release') { r.writeHead(200, {'content-type':'application/json'}); r.end(body); } else { r.writeHead(404); r.end(); } }).listen(Number(port), '127.0.0.1');
`;
const children: ChildProcess[] = [];
const sleepSync = (ms: number): void =>
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) as unknown as void;
/** Start the fake /v1/release server and return its port once it answers with
 *  THIS body. Ports are picked below the kernel's ephemeral range (32768+) so an
 *  outgoing connection cannot already hold one; a port that does not come up
 *  (taken, or a slow start) is retried on another, and after three tries the
 *  smoke stops with that reason instead of running its checks against nothing
 *  (it used to carry on after 5 s, turning a fixture problem into a wrong
 *  verdict about the GC script). */
function serveRelease(body: string): number {
	for (let attempt = 0; attempt < 3; attempt++) {
		const port = 20000 + Math.floor(Math.random() * 12000);
		children.push(
			spawn(process.execPath, ['-e', HTTP_JS, String(port), body], { stdio: 'ignore' })
		);
		for (let i = 0; i < 100; i++) {
			const r = spawnSync(
				'curl',
				['-fsS', '--max-time', '1', `http://127.0.0.1:${port}/v1/release`],
				{ encoding: 'utf8' }
			);
			if (r.status === 0 && r.stdout === body) return port;
			sleepSync(100);
		}
	}
	throw new Error('fixture: the fake /v1/release server did not come up on any of 3 ports');
}

const b64 = (b: Buffer | string): string => Buffer.from(b).toString('base64');
const releaseDir = (tag: string, name = 'Morphit') => ({
	dir: {
		'metadata.json': b64(
			`{\n  "name": "${name}",\n  "version": "${tag.slice(1)}",\n  "tag": "${tag}",\n  "tarball": "morphit-${tag}.tar.gz",\n  "sha256": "x"\n}\n`
		),
		[`morphit-${tag}.tar.gz`]: b64('x')
	}
});
const snapshot = (block: number) =>
	tarGz({
		'manifest.json': Buffer.from(
			JSON.stringify(
				{
					snapshotFormatVersion: 2,
					chainId: 'cd8d90f2',
					schemaVersion: 63,
					lastAppliedBlock: block,
					dumpSha256: 'x'
				},
				null,
				2
			)
		),
		'indexer.sql.gz': gzipSync(Buffer.from(`dump ${block}`))
	});

const REL = {
	'v1.17.0': 'bafyrel1170',
	'v1.18.0': 'bafyrel1180',
	'v1.19.0': 'bafyrel1190',
	'v1.19.1': 'bafyrel1191'
} as const;
const SNAP = (b: number): string => `bafksnap${b}`;
const BLOCKS = [100, 200, 300, 400, 500, 600];

function fixture(o: { failRm?: string[]; down?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'morphit-ipfs-gc-'));
	const bin = join(dir, 'bin');
	const repo = join(dir, 'repo');
	mkdirSync(bin);
	mkdirSync(join(repo, 'indexer-snapshots'), { recursive: true });
	writeFileSync(join(bin, 'ipfs'), STUB_IPFS);
	chmodSync(join(bin, 'ipfs'), 0o755);
	writeFileSync(join(repo, 'api'), '/ip4/127.0.0.1/tcp/5999\n');
	const objects: Record<string, unknown> = {};
	for (const [tag, cid] of Object.entries(REL)) objects[cid] = releaseDir(tag);
	for (const b of BLOCKS) {
		const tgz = snapshot(b);
		objects[SNAP(b)] = { file: b64(tgz) };
		// The publisher's staged copy + payload (as pin-indexer-snapshot.sh writes them).
		writeFileSync(join(repo, 'indexer-snapshots', `morphit-indexer-snapshot-${b}.tar.gz`), tgz);
		writeFileSync(
			join(repo, 'indexer-snapshots', `indexer-snapshot-payload-${b}.json`),
			`{\n  "ipfs_cid": "${SNAP(b)}",\n  "last_applied_block": ${b}\n}\n`
		);
	}
	objects['bafyotherdir'] = releaseDir('v1.0.0', 'SomethingElse'); // not ours
	objects['bafyothergz'] = { file: b64(gzipSync(Buffer.from('not a snapshot'))) }; // not ours
	objects['bafyemptydir'] = { dir: {} };
	const pins = Object.keys(objects);
	const state = join(dir, 'state.json');
	writeFileSync(
		state,
		JSON.stringify({ pins, objects, failRm: o.failRm ?? [], down: o.down ?? false, gc: 0 })
	);
	const mirror = join(dir, 'snapshot-mirror.json');
	writeFileSync(
		mirror,
		JSON.stringify(
			{ cid: SNAP(400), sha256: 'x', lastAppliedBlock: 400, mirroredAt: 'now' },
			null,
			2
		)
	);
	const install = join(dir, 'install');
	mkdirSync(install);
	writeFileSync(
		join(install, 'package.json'),
		'{\n  "name": "morphit",\n  "version": "1.19.1"\n}\n'
	);
	const log = join(dir, 'ipfs.log');
	writeFileSync(log, '');
	return { dir, bin, repo, state, mirror, install, log };
}
type Fx = ReturnType<typeof fixture>;

const releasePort = serveRelease(
	JSON.stringify({ version: '1.19.0', distribution: { ipfs_cid: REL['v1.19.0'] } })
);

function env(fx: Fx, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return {
		PATH: `${fx.bin}:${process.env.PATH}`,
		HOME: fx.dir,
		TMPDIR: fx.dir,
		IPFS_PATH: fx.repo,
		STUB_STATE: fx.state,
		STUB_LOG: fx.log,
		MORPHIT_RELEASE_URL: `http://127.0.0.1:${releasePort}/v1/release`,
		MORPHIT_RELEASE_URL_FALLBACKS: 'http://127.0.0.1:9/v1/release',
		MORPHIT_SNAPSHOT_MIRROR_STATE: fx.mirror,
		MORPHIT_INSTALL_DIR: fx.install,
		...extra
	};
}
function gc(fx: Fx, args: string[] = [], extra: Record<string, string> = {}) {
	const r = spawnSync('sh', [GC, ...args], {
		encoding: 'utf8',
		env: env(fx, extra),
		timeout: 120_000
	});
	const s = JSON.parse(readFileSync(fx.state, 'utf8')) as { pins: string[]; gc: number };
	const calls = readFileSync(fx.log, 'utf8')
		.split('\n')
		.filter((l) => l.trim() !== '')
		.map((l) => JSON.parse(l) as string[]);
	const line =
		`${r.stdout}`
			.split('\n')
			.filter((l) => l.startsWith('MORPHIT_IPFS_GC '))
			.pop() ?? '';
	return {
		status: r.status,
		out: `${r.stdout}${r.stderr}`,
		pins: new Set(s.pins),
		gcRuns: s.gc,
		calls,
		line
	};
}
const staged = (fx: Fx): string[] => readdirSync(join(fx.repo, 'indexer-snapshots')).sort();

async function main(): Promise<void> {
	// 1. The normal case.
	{
		const fx = fixture();
		const r = gc(fx);
		const gone = [
			...Object.values(REL),
			...BLOCKS.map(SNAP),
			'bafyotherdir',
			'bafyothergz',
			'bafyemptydir'
		].filter((c) => !r.pins.has(c));
		check(
			'unpins ONLY the superseded release (v1.17.0) and the snapshot outside the window (block 100)',
			r.status === 0 &&
				JSON.stringify(gone.sort()) === JSON.stringify([REL['v1.17.0'], SNAP(100)].sort()),
			`${JSON.stringify(gone)}\n${r.out}`
		);
		check(
			'keeps the anchored release, the previous one and the running one (v1.18.0, v1.19.0, v1.19.1)',
			r.pins.has(REL['v1.18.0']) &&
				r.pins.has(REL['v1.19.0']) &&
				r.pins.has(REL['v1.19.1']) &&
				/kept_releases=v1\.18\.0,v1\.19\.0,v1\.19\.1/.test(r.line),
			r.line
		);
		check(
			'keeps the anchored snapshot (400), everything newer (500, 600) and two older ones (200, 300)',
			[200, 300, 400, 500, 600].every((b) => r.pins.has(SNAP(b))) &&
				/kept_snapshots=200,300,400,500,600/.test(r.line),
			r.line
		);
		check(
			'never touches pins that are not Morphit releases/snapshots',
			r.pins.has('bafyotherdir') && r.pins.has('bafyothergz') && r.pins.has('bafyemptydir')
		);
		check(
			'removes the staged tarball + payload of the unpinned snapshot only',
			!staged(fx).includes('morphit-indexer-snapshot-100.tar.gz') &&
				!staged(fx).includes('indexer-snapshot-payload-100.json') &&
				staged(fx).length === 10,
			JSON.stringify(staged(fx))
		);
		check(
			'reclaims the space once (repo gc) after unpinning',
			r.gcRuns === 1 && /result=done .*unpinned=2 staged_removed=2/.test(r.line),
			r.line
		);
		check(
			'every content read is --offline and every call goes to the running daemon (--api)',
			r.calls.filter((c) => c.includes('cat')).every((c) => c.includes('--offline')) &&
				r.calls.every((c) => c[0] === '--api'),
			JSON.stringify(r.calls.filter((c) => c.includes('cat') && !c.includes('--offline')))
		);
		const again = gc(fx);
		check(
			'a second run finds nothing to let go',
			again.status === 0 && /result=nothing-to-do/.test(again.line) && again.gcRuns === 1,
			again.line
		);
	}
	// 2. A pin that will not come off keeps its staged copy (a nocopy pin reads it).
	{
		const fx = fixture({ failRm: [SNAP(100)] });
		const r = gc(fx);
		check(
			'a snapshot that could not be unpinned keeps its staged copy, and the run says partial (exit 1)',
			r.status === 1 &&
				r.pins.has(SNAP(100)) &&
				staged(fx).includes('morphit-indexer-snapshot-100.tar.gz') &&
				/result=partial/.test(r.line),
			`${r.line}\n${r.out}`
		);
	}
	// 3. Without an anchor, nothing of that kind is let go.
	{
		const fx = fixture();
		rmSync(fx.mirror);
		const r = gc(fx, [], { MORPHIT_RELEASE_URL: 'http://127.0.0.1:9/v1/release' });
		check(
			'indexer silent + no mirror state → every release and every snapshot stays',
			r.status === 0 &&
				r.pins.size === 13 &&
				staged(fx).length === 12 &&
				/result=nothing-to-do/.test(r.line),
			`${r.line}\n${r.out}`
		);
	}
	// 4. Daemon down → nothing at all.
	{
		const fx = fixture({ down: true });
		const r = gc(fx);
		check(
			'IPFS daemon not answering → nothing changed, exit 0',
			r.status === 0 && /result=no-daemon/.test(r.line) && staged(fx).length === 12,
			r.out
		);
	}
	// 5. Dry run.
	{
		const fx = fixture();
		const r = gc(fx, ['--dry-run']);
		check(
			'--dry-run names what it would let go and changes nothing',
			r.status === 0 &&
				r.pins.size === 13 &&
				staged(fx).length === 12 &&
				/would unpin release v1\.17\.0/.test(r.out) &&
				/result=dry-run/.test(r.line),
			r.out
		);
	}
	// 6. Anchor moves to v1.19.1: v1.18.0 goes, v1.19.0 becomes "previous".
	{
		const fx = fixture();
		const port = serveRelease(
			JSON.stringify({ version: 'v1.19.1', distribution: { ipfs_cid: REL['v1.19.1'] } })
		);
		const r = gc(fx, [], { MORPHIT_RELEASE_URL: `http://127.0.0.1:${port}/v1/release` });
		check(
			'after the next broadcast the release two back goes, the previous one stays',
			!r.pins.has(REL['v1.18.0']) &&
				!r.pins.has(REL['v1.17.0']) &&
				r.pins.has(REL['v1.19.0']) &&
				r.pins.has(REL['v1.19.1']),
			r.line
		);
	}
	// 6b. A node still RUNNING an older release keeps that one too.
	{
		const fx = fixture();
		writeFileSync(
			join(fx.install, 'package.json'),
			'{\n  "name": "morphit",\n  "version": "1.17.0"\n}\n'
		);
		const r = gc(fx);
		check(
			'the release this node is still running (v1.17.0, below the previous one) stays pinned',
			r.pins.has(REL['v1.17.0']) &&
				/kept_releases=v1\.17\.0,v1\.18\.0,v1\.19\.0,v1\.19\.1/.test(r.line),
			r.line
		);
	}
	// 7. The real self-heal entry: installs the helper + units and runs it.
	{
		const fx = fixture();
		const helperDir = join(fx.dir, 'usr-local-lib-morphit');
		const systemdDir = join(fx.dir, 'systemd');
		mkdirSync(helperDir);
		mkdirSync(systemdDir);
		writeFileSync(join(fx.repo, 'config'), '{}');
		const { healIpfsGc } = await import('../apps/ops-cli/src/lib/ipfsGcHeal.ts');
		const saved = { ...process.env };
		Object.assign(process.env, env(fx), {
			MORPHIT_INSTALL_DIR: ROOT,
			MORPHIT_HELPER_DIR: helperDir,
			MORPHIT_SYSTEMD_DIR: systemdDir,
			MORPHIT_HEAL_NO_SYSTEMD: '1'
		});
		const said: string[] = [];
		let out;
		try {
			// Asynchronous since v1.21.1: the clean-up runs without blocking, so its
			// spinner turns.
			out = await healIpfsGc({
				info: (m) => said.push(m),
				warn: (m) => said.push(`WARN ${m}`),
				spinner: () => () => {}
			});
		} finally {
			process.env = saved;
		}
		const s = JSON.parse(readFileSync(fx.state, 'utf8')) as { pins: string[] };
		check(
			'self-heal: installs the root helper + weekly units, runs the clean-up and reads its result back',
			out.kind === 'ran' &&
				out.summary.result === 'done' &&
				out.summary.unpinned === 2 &&
				existsSync(join(helperDir, 'morphit-ipfs-gc.sh')) &&
				existsSync(join(systemdDir, 'morphit-ipfs-gc.timer')) &&
				!s.pins.includes(REL['v1.17.0']),
			`${JSON.stringify(out)} ${said.join(' | ')}`
		);
	}
}

main()
	.catch((e) => {
		fail++;
		console.log(`  ✗ smoke crashed: ${e instanceof Error ? e.stack : String(e)}`);
	})
	.finally(() => {
		for (const c of children) c.kill();
		console.log('─'.repeat(56));
		if (fail > 0) {
			console.log(`✗ ${fail} of ${pass + fail} ipfs gc checks failed`);
			process.exit(1);
		}
		console.log(`✓ all ${pass} ipfs gc checks passed`);
		process.exit(0);
	});
