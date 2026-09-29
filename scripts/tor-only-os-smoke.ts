#!/usr/bin/env tsx
/**
 * scripts/tor-only-os-smoke.ts (v1.20.0, C13)
 *
 * A tor-only node's OWN operating system reached clearnet: apt fetched from the
 * Ubuntu mirrors directly (resolving their names with the box's resolver) and
 * chrony polled public NTP pools. This EXECUTES the real pieces against real
 * tools, with no network beyond loopback:
 *   - a fake apt repository on 127.0.0.1, published under a name that can
 *     never resolve (repo.morphit-smoke.invalid), and a stand-in for Tor's
 *     SocksPort that resolves names itself and logs every CONNECT;
 *   - REAL apt-get, reading a scratch root (APT_CONFIG), before and after the
 *     switch: before, apt tries the name itself (the leak); after, it asks the
 *     SOCKS port for it by name (socks5h, as over Tor);
 *   - the REAL `healTorOnlyOs` entry point (the self-heal `morphit-ops upgrade`
 *     runs) on a tor-only node, on a Tor that refuses, and on a clearnet node;
 *   - a repo added AFTER the switch (as a later Ansible run would) still goes
 *     through Tor, via the proxy belt;
 *   - morphit-tor-timesync.sh against the SOCKS stand-in answering HTTP Date
 *     headers: agreement, a skewed clock, an outlier, a split, no answers;
 *   - chrony and news switch + revert byte for byte.
 * Needs apt-get / apt-config (Ubuntu/Debian): this guards Ubuntu behaviour.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
	existsSync,
	symlinkSync,
	readdirSync,
	chmodSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const ROOT = resolve(import.meta.dirname, '..');
const OS_SCRIPT = join(ROOT, 'ops', 'tor-only', 'morphit-tor-only-os.sh');
const TIME_SCRIPT = join(ROOT, 'ops', 'tor-only', 'morphit-tor-timesync.sh');
const REPO_NAME = 'repo.morphit-smoke.invalid';

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

for (const tool of ['apt-get', 'apt-config']) {
	if (spawnSync('sh', ['-c', `command -v ${tool}`]).status !== 0) {
		console.log(
			`✗ ${tool} is not installed — this smoke guards apt's behaviour on Ubuntu and needs it.`
		);
		process.exit(1);
	}
}

// ── helpers: a SOCKS5 stand-in for Tor, and a static HTTP server (child processes,
// so the synchronous apt-get / heal calls below never block them) ─────────────
const SOCKS_JS = `
const net = require('net'), fs = require('fs');
const [port, log, mode, target] = process.argv.slice(1);
net.createServer((c) => {
  let buf = Buffer.alloc(0), stage = 0, user = null;
  const need = (n) => buf.length >= n;
  c.on('error', () => {});
  c.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (stage === 0) { if (!need(2) || !need(2 + buf[1])) return; const m = [...buf.subarray(2, 2 + buf[1])]; buf = buf.subarray(2 + buf[1]); if (m.includes(2)) { c.write(Buffer.from([5, 2])); stage = 1; } else { c.write(Buffer.from([5, 0])); stage = 2; } continue; }
      if (stage === 1) { if (!need(2) || !need(2 + buf[1] + 1)) return; const ul = buf[1]; if (!need(3 + ul + buf[2 + ul])) return; user = buf.subarray(2, 2 + ul).toString(); buf = buf.subarray(3 + ul + buf[2 + ul]); c.write(Buffer.from([1, 0])); stage = 2; continue; }
      if (stage === 2) {
        if (!need(5)) return; const at = buf[3]; let host, off;
        if (at === 3) { if (!need(5 + buf[4] + 2)) return; host = buf.subarray(5, 5 + buf[4]).toString(); off = 5 + buf[4]; }
        else if (at === 1) { if (!need(10)) return; host = [...buf.subarray(4, 8)].join('.'); off = 8; }
        else return c.destroy();
        const p = buf.readUInt16BE(off); buf = buf.subarray(off + 2);
        fs.appendFileSync(log, JSON.stringify({ user, host, port: p, atyp: at }) + '\\n');
        if (mode === 'hang') return; // a circuit that never comes up
        if (mode === 'refuse') { c.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
        if (mode.startsWith('date:')) {
          // target = "setup=S,answer=A": the circuit takes S s to come up (a
          // cold Tor), and the server takes A s from request to answer.
          const t = Object.fromEntries(String(target).split(',').map((kv) => kv.split('=')));
          const setup = Number(t.setup || 0) * 1000, answer = Number(t.answer || 0) * 1000;
          const spec = mode.slice(5).split(','); let off2 = spec[0];
          for (const kv of spec.slice(1)) { const [h, v] = kv.split('='); if (h === host) off2 = v; }
          stage = 3;
          setTimeout(() => c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])), setup);
          c.once('data', () => setTimeout(() => {
            const hdr = off2 === 'none' ? '' : 'Date: ' + new Date(Date.now() + Number(off2) * 1000).toUTCString() + '\\r\\n';
            c.end('HTTP/1.1 200 OK\\r\\n' + hdr + 'Content-Length: 0\\r\\nConnection: close\\r\\n\\r\\n');
          }, answer));
          return;
        }
        const u = net.connect(Number(target.split(':')[1]), target.split(':')[0], () => { c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); if (buf.length) u.write(buf); u.pipe(c); c.pipe(u); });
        u.on('error', () => c.destroy());
        stage = 9; return;
      }
      return;
    }
  });
}).listen(Number(port), '127.0.0.1', () => fs.appendFileSync(log, ''));
`;
const HTTP_JS = `
const http = require('http'), fs = require('fs'), path = require('path');
const [port, dir] = process.argv.slice(1);
http.createServer((q, r) => {
  const f = path.join(dir, decodeURIComponent(q.url.split('?')[0]));
  if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200); r.end(q.method === 'HEAD' ? undefined : fs.readFileSync(f));
}).listen(Number(port), '127.0.0.1');
`;

const children: ChildProcess[] = [];
function startNode(js: string, args: string[]): ChildProcess {
	const c = spawn(process.execPath, ['-e', js, ...args], { stdio: 'ignore' });
	children.push(c);
	return c;
}
const sleepSync = (ms: number): void => {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
const freePort = (() => {
	let p = 20000 + Math.floor(Math.random() * 20000);
	return () => ++p;
})();
function waitPort(port: number): void {
	for (let i = 0; i < 50; i++) {
		if (
			spawnSync(process.execPath, [
				'-e',
				`require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))`
			]).status === 0
		)
			return;
		sleepSync(100);
	}
}

/** `apt-get update` processes still running for the scratch root `r` — those
 *  carrying its APT_CONFIG. Counting every `apt-get update` on the machine made
 *  the check fail whenever anything else ran apt (another run of this smoke, the
 *  host's own apt timers). */
function leftoverAptGets(r: string): number {
	const conf = `APT_CONFIG=${join(r, 'apt-smoke.conf')}`;
	let n = 0;
	for (const pid of readdirSync('/proc')) {
		if (!/^\d+$/.test(pid)) continue;
		try {
			const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
			if (cmd.join(' ') !== 'apt-get update') continue;
			if (readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(conf)) n++;
		} catch {
			// the process ended while we looked
		}
	}
	return n;
}

const socksLog = (
	f: string
): Array<{ user: string | null; host: string; port: number; atyp: number }> =>
	existsSync(f)
		? readFileSync(f, 'utf8')
				.split('\n')
				.filter((l) => l.trim() !== '')
				.map((l) => JSON.parse(l))
		: [];

// ── the fake apt repository (flat, [trusted=yes]) ──────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'morphit-toros-smoke-'));
const repoDir = join(work, 'repo');
mkdirSync(repoDir);
writeFileSync(join(repoDir, 'Packages'), '');
const sha = createHash('sha256').update('').digest('hex');
writeFileSync(
	join(repoDir, 'Release'),
	`Origin: morphit-smoke\nLabel: morphit-smoke\nSuite: stable\nCodename: stable\nDate: ${new Date().toUTCString()}\nArchitectures: amd64 all\nSHA256:\n ${sha} 0 Packages\n`
);
const httpPort = freePort();
startNode(HTTP_JS, [String(httpPort), repoDir]);
waitPort(httpPort);

/** A scratch OS root: apt sources, apt dirs, the Tor drivers (as apt-transport-tor
 *  installs them), a motd-news file, an indexer.env. */
function scratchRoot(opts: { socksPort: number; hiddenOnly: boolean; drivers?: boolean }) {
	const r = mkdtempSync(join(work, 'root-'));
	for (const d of [
		'etc/apt/sources.list.d',
		'etc/apt/apt.conf.d',
		'etc/default',
		'etc/morphit',
		'etc/systemd/system',
		'usr/lib/apt/methods',
		'usr/local/lib/morphit',
		'var/lib/apt/lists/partial',
		'var/cache/apt/archives/partial'
	])
		mkdirSync(join(r, d), { recursive: true });
	for (const m of readdirSync('/usr/lib/apt/methods'))
		symlinkSync(join('/usr/lib/apt/methods', m), join(r, 'usr/lib/apt/methods', m));
	if (opts.drivers !== false) {
		symlinkSync('/usr/lib/apt/methods/http', join(r, 'usr/lib/apt/methods/tor+http'));
		symlinkSync('/usr/lib/apt/methods/https', join(r, 'usr/lib/apt/methods/tor+https'));
	}
	writeFileSync(join(r, 'etc/apt/sources.list'), '# see sources.list.d\n');
	writeFileSync(
		join(r, 'etc/apt/sources.list.d/smoke.sources'),
		`Types: deb\nURIs: http://${REPO_NAME}:${httpPort}/\nSuites: ./\nTrusted: yes\n`
	);
	writeFileSync(join(r, 'etc/default/motd-news'), 'ENABLED=1\n');
	writeFileSync(
		join(r, 'etc/morphit/indexer.env'),
		`MORPHIT_INDEXER_RPC_ENDPOINTS=${opts.hiddenOnly ? '' : 'https://rpc.example'}\nMORPHIT_INDEXER_TOR_SOCKS=127.0.0.1:${opts.socksPort}\n`
	);
	const aptConf = join(r, 'apt-smoke.conf');
	writeFileSync(
		aptConf,
		[
			`Dir::Etc "${r}/etc/apt/";`,
			`Dir::State::Lists "${r}/var/lib/apt/lists/";`,
			`Dir::Cache "${r}/var/cache/apt/";`,
			`Dir::Bin::Methods "${r}/usr/lib/apt/methods/";`,
			'APT::Sandbox::User "root";',
			''
		].join('\n')
	);
	// A stub Ubuntu Pro CLI: apt news on, records `config set`.
	const pro = join(r, 'pro-stub');
	writeFileSync(
		pro,
		`#!/bin/sh\nf="${r}/pro-state"\n[ -f "$f" ] || echo True > "$f"\nif [ "$1 $2" = "config show" ]; then echo "apt_news $(cat "$f")"; exit 0; fi\nif [ "$1 $2" = "config set" ]; then echo "$3" >> "${r}/pro-calls"; case "$3" in apt_news=false) echo False > "$f";; apt_news=true) echo True > "$f";; esac; exit 0; fi\nexit 1\n`
	);
	chmodSync(pro, 0o755);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		LC_ALL: 'C',
		APT_CONFIG: aptConf,
		MORPHIT_OS_ROOT: r,
		MORPHIT_ENV_ROOT: r,
		MORPHIT_HELPER_DIR: join(r, 'usr/local/lib/morphit'),
		MORPHIT_SYSTEMD_DIR: join(r, 'etc/systemd/system'),
		MORPHIT_HEAL_NO_SYSTEMD: '1',
		MORPHIT_INSTALL_DIR: ROOT,
		MORPHIT_PRO_BIN: pro,
		MORPHIT_APT_LOCK_WAIT: '10',
		MORPHIT_HEAL_RETRY_WAIT_MS: '200'
	};
	return { r, env };
}

const aptUpdate = (env: NodeJS.ProcessEnv): string => {
	const x = spawnSync('apt-get', ['update'], { encoding: 'utf8', env, timeout: 120_000 });
	return `${x.stdout}${x.stderr}`;
};
const tree = (dir: string, skip: string): Map<string, string> => {
	const out = new Map<string, string>();
	const walk = (d: string): void => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (p.startsWith(skip) || p.includes('/var/lib/apt/') || p.includes('/var/cache/apt/'))
				continue;
			if (e.isDirectory() && !e.isSymbolicLink()) walk(p);
			else if (!e.isSymbolicLink()) out.set(p, readFileSync(p, 'utf8'));
		}
	};
	walk(dir);
	return out;
};

async function main(): Promise<void> {
	const { healTorOnlyOs } = await import('../apps/ops-cli/src/lib/torOnlyOsHeal.ts');
	const quiet = { info: () => {}, warn: () => {}, spinner: () => () => {} };

	// ── 1. before the switch apt resolves the mirror's name ITSELF (the leak) ──
	{
		const socksPort = freePort();
		const log = join(work, `socks-${socksPort}.log`);
		startNode(SOCKS_JS, [String(socksPort), log, 'map', `127.0.0.1:${httpPort}`]);
		waitPort(socksPort);
		const { env } = scratchRoot({ socksPort, hiddenOnly: true });
		const out = aptUpdate(env);
		check(
			'unswitched apt resolves the mirror name itself and never asks Tor (the clearnet leak this fixes)',
			/Could not resolve '?repo\.morphit-smoke\.invalid/.test(out) && socksLog(log).length === 0,
			out
		);
	}

	// ── 2. the REAL self-heal on a tor-only node: apt over Tor, verified ──
	{
		const socksPort = freePort();
		const log = join(work, `socks-${socksPort}.log`);
		startNode(SOCKS_JS, [String(socksPort), log, 'map', `127.0.0.1:${httpPort}`]);
		waitPort(socksPort);
		const { r, env } = scratchRoot({ socksPort, hiddenOnly: true });
		const saved = { ...process.env };
		Object.assign(process.env, env);
		let out;
		try {
			out = await healTorOnlyOs(quiet);
		} finally {
			process.env = saved;
		}
		const sources = readFileSync(join(r, 'etc/apt/sources.list.d/smoke.sources'), 'utf8');
		const hits = socksLog(log).filter((e) => e.host === REPO_NAME);
		check(
			'heal (tor-only node): apt is switched and kept',
			out.apt === 'switched',
			JSON.stringify(out)
		);
		check(
			'heal: the source now reads tor+http:// and the proxy belt names Tor\u2019s SocksPort',
			sources.includes(`URIs: tor+http://${REPO_NAME}:${httpPort}/`) &&
				readFileSync(join(r, 'etc/apt/apt.conf.d/99morphit-tor-only.conf'), 'utf8').includes(
					`Acquire::http::Proxy "socks5h://apt-transport-tor@127.0.0.1:${socksPort}";`
				),
			sources
		);
		check(
			'heal VERIFIED over Tor: apt asked the SOCKS port for the mirror BY NAME (socks5h), as apt-transport-tor',
			hits.length > 0 && hits.every((e) => e.atyp === 3 && e.user === 'apt-transport-tor'),
			JSON.stringify(socksLog(log))
		);
		const after = aptUpdate(env);
		check(
			'after the heal a plain `apt-get update` (what unattended-upgrades runs) fetches over Tor',
			/^(Hit|Get):\d+ tor\+http:\/\/repo\.morphit-smoke\.invalid/m.test(after) &&
				!/Could not resolve/.test(after),
			after
		);
		check(
			'heal: the Tor time check script + units are installed for the timer (root-owned helper copy)',
			existsSync(join(r, 'usr/local/lib/morphit/morphit-tor-timesync.sh')) &&
				existsSync(join(r, 'etc/systemd/system/morphit-tor-timesync.timer')) &&
				existsSync(join(r, 'usr/local/lib/morphit/morphit-tor-only-os.sh')),
			JSON.stringify(out)
		);
		check(
			'heal: motd news off and Ubuntu Pro apt news turned off through its own CLI',
			readFileSync(join(r, 'etc/default/motd-news'), 'utf8') === 'ENABLED=0\n' &&
				readFileSync(join(r, 'pro-calls'), 'utf8').trim() === 'apt_news=false' &&
				out.news === 'switched',
			JSON.stringify(out)
		);
		const again = await (async () => {
			Object.assign(process.env, env);
			try {
				return await healTorOnlyOs(quiet);
			} finally {
				process.env = saved;
			}
		})();
		check(
			'heal is idempotent: a second run finds apt and news already done',
			again.apt === 'already' && again.news === 'already',
			JSON.stringify(again)
		);

		// A repository added AFTER the switch (a later Ansible run re-adding a plain
		// source) still goes through Tor: the proxy belt.
		writeFileSync(
			join(r, 'etc/apt/sources.list.d/later.list'),
			`deb [trusted=yes] http://later.morphit-smoke.invalid:${httpPort}/ ./\n`
		);
		const n0 = socksLog(log).length;
		const later = aptUpdate(env);
		check(
			'a plain http:// repo added after the switch still reaches the network only through Tor (proxy belt)',
			socksLog(log)
				.slice(n0)
				.some((e) => e.host === 'later.morphit-smoke.invalid' && e.atyp === 3) &&
				!/Could not resolve/.test(later),
			later
		);
		Object.assign(process.env, env);
		let third;
		try {
			third = await healTorOnlyOs(quiet);
		} finally {
			process.env = saved;
		}
		check(
			'the next upgrade\u2019s heal also rewrites that later repo to tor+http:// (and re-verifies over Tor)',
			third.apt === 'switched' &&
				readFileSync(join(r, 'etc/apt/sources.list.d/later.list'), 'utf8').includes(
					' tor+http://later.morphit-smoke.invalid'
				),
			JSON.stringify(third)
		);
	}

	// ── 2b. one repository down for its own reasons, the other fine: that is
	// apt working over Tor, and the switch is kept ──
	{
		const socksPort = freePort();
		const log = join(work, `socks-${socksPort}.log`);
		startNode(SOCKS_JS, [String(socksPort), log, 'map', `127.0.0.1:${httpPort}`]);
		waitPort(socksPort);
		const { r, env } = scratchRoot({ socksPort, hiddenOnly: true });
		writeFileSync(
			join(r, 'etc/apt/sources.list.d/gone.list'),
			`deb [trusted=yes] http://gone.morphit-smoke.invalid:${httpPort}/no-such-repo/ ./\n`
		);
		const torEnv = { ...env, MORPHIT_TOR_SOCKS: `127.0.0.1:${socksPort}` };
		const x = spawnSync('sh', [OS_SCRIPT, 'apt-apply', join(r, 'bk')], {
			encoding: 'utf8',
			env: torEnv
		});
		const v = spawnSync('sh', [OS_SCRIPT, 'apt-verify'], { encoding: 'utf8', env: torEnv });
		check(
			'apt-verify: one repo answering over Tor + one repo that is down = works over Tor (the down one is named)',
			x.status === 0 &&
				v.status === 0 &&
				/result=ok fetched=1 failed=1/.test(v.stdout) &&
				/gone\.morphit-smoke\.invalid/.test(v.stderr),
			`${v.status} ${v.stdout} ${v.stderr}`
		);
	}

	// ── 2c. Tor answers, but every file it brings back is junk: NOT verified ──
	{
		const socksPort = freePort();
		const log = join(work, `socks-${socksPort}.log`);
		startNode(SOCKS_JS, [String(socksPort), log, 'date:0', '-']);
		waitPort(socksPort);
		const { r, env } = scratchRoot({ socksPort, hiddenOnly: true });
		const before = tree(join(r, 'etc/apt'), join(r, 'var/lib/morphit-tor-only'));
		const saved = { ...process.env };
		Object.assign(process.env, env);
		let out;
		try {
			out = await healTorOnlyOs(quiet);
		} finally {
			process.env = saved;
		}
		check(
			'heal when every fetch over Tor comes back as junk (apt prints "Get" then an error): reverted byte for byte',
			out.apt === 'reverted' &&
				JSON.stringify([...before]) ===
					JSON.stringify([...tree(join(r, 'etc/apt'), join(r, 'var/lib/morphit-tor-only'))]),
			JSON.stringify(out)
		);
	}

	// ── 2d. (wave 2, O1) a refresh that hangs is ended at ITS deadline, apt-get included ──
	{
		const socksPort = freePort();
		startNode(SOCKS_JS, [String(socksPort), join(work, `socks-${socksPort}.log`), 'hang', '-']);
		waitPort(socksPort);
		const { r, env } = scratchRoot({ socksPort, hiddenOnly: true });
		const torEnv = { ...env, MORPHIT_TOR_SOCKS: `127.0.0.1:${socksPort}` };
		spawnSync('sh', [OS_SCRIPT, 'apt-apply', join(r, 'bk')], { encoding: 'utf8', env: torEnv });
		const t0 = Date.now();
		const v = spawnSync('sh', [OS_SCRIPT, 'apt-verify'], {
			encoding: 'utf8',
			timeout: 60_000,
			env: { ...torEnv, MORPHIT_APT_VERIFY_TIMEOUT: '6' }
		});
		const took = (Date.now() - t0) / 1000;
		const leftover = leftoverAptGets(r);
		check(
			'apt-verify with a 6 s budget and a Tor circuit that never comes up: "not verified" within the budget, no apt-get left running',
			v.status === 1 && /reason=timeout/.test(v.stdout) && took < 15 && leftover === 0,
			`${v.status} ${took}s leftover=${leftover} ${v.stdout} ${v.stderr}`
		);
	}

	// ── 2e. (wave 2, O1) the safety net: a switch left unchecked is verified or put back ──
	{
		const recover = (socksMode: string) => {
			const socksPort = freePort();
			startNode(SOCKS_JS, [
				String(socksPort),
				join(work, `socks-${socksPort}.log`),
				socksMode,
				socksMode === 'map' ? `127.0.0.1:${httpPort}` : '-'
			]);
			waitPort(socksPort);
			const { r, env } = scratchRoot({ socksPort, hiddenOnly: true });
			const torEnv = { ...env, MORPHIT_TOR_SOCKS: `127.0.0.1:${socksPort}` };
			const before = tree(join(r, 'etc/apt'), join(r, 'var/lib/morphit-tor-only'));
			const state = join(r, 'var/lib/morphit-tor-only');
			const bk = join(state, 'backup-test-apt');
			mkdirSync(bk, { recursive: true });
			writeFileSync(join(state, 'apt.pending'), `${bk}\n`);
			spawnSync('sh', [OS_SCRIPT, 'apt-apply', bk], { encoding: 'utf8', env: torEnv });
			const x = spawnSync('sh', [OS_SCRIPT, 'apt-recover'], { encoding: 'utf8', env: torEnv });
			return {
				r,
				x,
				before,
				after: tree(join(r, 'etc/apt'), state),
				pendingLeft: existsSync(join(state, 'apt.pending'))
			};
		};
		const bad = recover('refuse');
		check(
			'apt-recover: an unchecked switch that does not work over Tor is put back byte for byte, marker gone',
			bad.x.status === 0 &&
				!bad.pendingLeft &&
				JSON.stringify([...bad.before]) === JSON.stringify([...bad.after]),
			`${bad.x.stdout} ${bad.x.stderr}`
		);
		const good = recover('map');
		check(
			'apt-recover: an unchecked switch that works over Tor is kept, marker gone',
			good.x.status === 0 &&
				!good.pendingLeft &&
				readFileSync(join(good.r, 'etc/apt/sources.list.d/smoke.sources'), 'utf8').includes(
					'tor+http://'
				),
			`${good.x.stdout} ${good.x.stderr}`
		);
		const { env } = scratchRoot({ socksPort: 9, hiddenOnly: true });
		const none = spawnSync('sh', [OS_SCRIPT, 'apt-recover'], { encoding: 'utf8', env });
		check(
			'apt-recover with nothing pending does nothing',
			none.status === 0 && /nothing-pending/.test(none.stdout),
			none.stdout
		);
	}

	// ── 3. Tor refusing: the switch is put back byte for byte ──
	{
		const socksPort = freePort();
		const log = join(work, `socks-${socksPort}.log`);
		startNode(SOCKS_JS, [String(socksPort), log, 'refuse', '-']);
		waitPort(socksPort);
		const { r, env } = scratchRoot({ socksPort, hiddenOnly: true });
		const before = tree(join(r, 'etc/apt'), join(r, 'var/lib/morphit-tor-only'));
		const saved = { ...process.env };
		Object.assign(process.env, env);
		let out;
		try {
			out = await healTorOnlyOs(quiet);
		} finally {
			process.env = saved;
		}
		const after = tree(join(r, 'etc/apt'), join(r, 'var/lib/morphit-tor-only'));
		check(
			'heal with Tor refusing every circuit: apt is reverted, every apt file byte-identical, no belt left',
			out.apt === 'reverted' &&
				JSON.stringify([...before]) === JSON.stringify([...after]) &&
				!existsSync(join(r, 'etc/apt/apt.conf.d/99morphit-tor-only.conf')) &&
				!existsSync(join(r, 'var/lib/morphit-tor-only/apt.pending')),
			`${JSON.stringify(out)} ${JSON.stringify([...after.keys()])}`
		);
	}

	// ── 4. a clearnet node is never touched ──
	{
		const socksPort = freePort();
		const { r, env } = scratchRoot({ socksPort, hiddenOnly: false });
		const before = tree(r, join(r, '__none__'));
		const saved = { ...process.env };
		Object.assign(process.env, env);
		let out;
		try {
			out = await healTorOnlyOs(quiet);
		} finally {
			process.env = saved;
		}
		check(
			'heal on a clearnet node: nothing changes (apt, news, no helper installed)',
			out.apt === 'not-tor-only' &&
				JSON.stringify([...before]) === JSON.stringify([...tree(r, join(r, '__none__'))]),
			JSON.stringify(out)
		);
	}

	// ── 5. chrony + news switch and revert byte for byte (the script alone) ──
	{
		const { r, env } = scratchRoot({ socksPort: 9050, hiddenOnly: true });
		mkdirSync(join(r, 'etc/chrony/conf.d'), { recursive: true });
		const CHRONY =
			'confdir /etc/chrony/conf.d\npool ntp.ubuntu.com        iburst maxsources 4\npool 0.ubuntu.pool.ntp.org iburst maxsources 1\n' +
			'sourcedir /run/chrony-dhcp\nsourcedir /etc/chrony/sources.d\nkeyfile /etc/chrony/chrony.keys\ndriftfile /var/lib/chrony/chrony.drift\nrtcsync\nmakestep 1 3\n';
		writeFileSync(join(r, 'etc/chrony/chrony.conf'), CHRONY);
		writeFileSync(join(r, 'etc/chrony/conf.d/extra.conf'), 'server time.example iburst\n');
		const sh = (...a: string[]) => spawnSync('sh', [OS_SCRIPT, ...a], { encoding: 'utf8', env });
		const bk = join(r, 'bk-chrony');
		const c0 = sh('chrony-check').status;
		sh('chrony-apply', bk);
		const conf =
			readFileSync(join(r, 'etc/chrony/chrony.conf'), 'utf8') +
			readFileSync(join(r, 'etc/chrony/conf.d/extra.conf'), 'utf8');
		check(
			'chrony: every pool/server/sourcedir line (main file and conf.d) is disabled, the rest kept',
			c0 === 1 &&
				sh('chrony-check').status === 0 &&
				!/^[ \t]*(pool|server|peer|sourcedir)[ \t]/m.test(conf) &&
				conf.includes('driftfile /var/lib/chrony/chrony.drift'),
			conf
		);
		sh('chrony-revert', bk);
		check(
			'chrony: revert restores both files byte for byte',
			readFileSync(join(r, 'etc/chrony/chrony.conf'), 'utf8') === CHRONY &&
				readFileSync(join(r, 'etc/chrony/conf.d/extra.conf'), 'utf8') ===
					'server time.example iburst\n'
		);
		const nb = join(r, 'bk-news');
		sh('news-apply', nb);
		sh('news-revert', nb);
		check(
			'news: revert restores motd-news and turns Ubuntu Pro apt news back on',
			readFileSync(join(r, 'etc/default/motd-news'), 'utf8') === 'ENABLED=1\n' &&
				readFileSync(join(r, 'pro-state'), 'utf8').trim() === 'True'
		);
	}

	// ── 6. the Tor time check ──
	const time = (mode: string, extra: NodeJS.ProcessEnv = {}, target = '-') => {
		const socksPort = freePort();
		const log = join(work, `socks-${socksPort}.log`);
		startNode(SOCKS_JS, [String(socksPort), log, mode, target]);
		waitPort(socksPort);
		const x = spawnSync('sh', [TIME_SCRIPT, '--check'], {
			encoding: 'utf8',
			timeout: 120_000,
			env: {
				...process.env,
				MORPHIT_TOR_SOCKS: `127.0.0.1:${socksPort}`,
				MORPHIT_INDEXER_ENV: '/nonexistent',
				...extra
			}
		});
		const line =
			`${x.stdout}`
				.split('\n')
				.filter((l) => l.startsWith('MORPHIT_TOR_TIME '))
				.pop() ?? '';
		return { status: x.status, line, out: `${x.stdout}${x.stderr}`, log: socksLog(log) };
	};
	{
		const t = time('date:0');
		check(
			'time: 6 agreeing onion sources, clock right → in tolerance (exit 0), every request by NAME through Tor',
			t.status === 0 &&
				/result=in-tolerance answered=6 agreed=6/.test(t.line) &&
				t.log.length === 6 &&
				t.log.every((e) => e.atyp === 3 && e.host.endsWith('.onion')),
			t.out
		);
	}
	{
		const t = time('date:120');
		const off = Number(/offset=(-?[\d.]+)/.exec(t.line)?.[1]);
		check(
			'time: sources agree the clock is 2 min behind → would step by ~120 s',
			t.status === 0 && /result=would-step/.test(t.line) && Math.abs(off - 120) < 5,
			t.out
		);
	}
	{
		const t = time('date:120,dds6qkxpwdeubwucdiaord2xgbbeyds25rbsgr73tbfpqpt4a6vjwsyd.onion=90000');
		check(
			'time: one lying source is named and ignored (5 of 6 agree)',
			t.status === 0 && /agreed=5/.test(t.line) && /ignoring dds6/.test(t.out),
			t.out
		);
	}
	{
		const three = [
			'2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion',
			'jvgypgbnfyvfopg5msp6nwr2sl2fd6xmnguq35n7rfkw3yungjn2i4yd.onion',
			'vww6ybal4bd7szmgncyruucpgfkqahzddi37ktceo3ah7ngmcopnpyyd.onion'
		];
		const t = time(`date:0,${three.map((h) => `${h}=600`).join(',')}`);
		check(
			'time: a 3-against-3 split is no consensus → exit 1, clock untouched',
			t.status === 1 && /result=disagree/.test(t.line),
			t.out
		);
	}
	{
		const t = time('date:none');
		check(
			'time: no Date headers → few answers, exit 1',
			t.status === 1 && /result=few-answers answered=0/.test(t.line),
			t.out
		);
	}
	{
		const t = time('refuse');
		check(
			'time: Tor refusing → few answers, exit 1 (never a direct connection)',
			t.status === 1 && /result=few-answers/.test(t.line) && t.log.length === 6,
			t.out
		);
	}
	{
		// v1.20.0 wave 2 (O2): a cold Tor takes a long time to build the circuit.
		// That time must not count: the servers' clocks are RIGHT, so the verdict is
		// in tolerance. (Timing from before the circuit made this look 6.5 s off —
		// past the lowered 5 s threshold — and it would have been "corrected".)
		const t = time('date:0', { MORPHIT_TOR_TIME_STEP_AT: '5' }, 'setup=12');
		check(
			'time: a 12 s Tor circuit setup does not skew the measurement (right clock → in tolerance)',
			t.status === 0 &&
				/result=in-tolerance/.test(t.line) &&
				Math.abs(Number(/offset=(-?[\d.]+)/.exec(t.line)?.[1])) < 2,
			t.out
		);
	}
	{
		const t = time('date:0', { MORPHIT_TOR_TIME_MAX_GAP: '3' }, 'answer=5');
		check(
			'time: answers slower than MAX_GAP from request to first byte are not used (named), so no verdict',
			t.status === 1 &&
				/result=few-answers answered=0/.test(t.line) &&
				/answered too slowly/.test(t.out),
			t.out
		);
	}
	{
		// Tor just (re)started: the journal has no "Bootstrapped 100%" since then.
		const bin = join(work, 'bootbin');
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\necho "Mon 2026-09-28 09:00:00 UTC"\n');
		const journal = join(work, 'journal.txt');
		writeFileSync(join(bin, 'journalctl'), `#!/bin/sh\ncat "${journal}"\n`);
		chmodSync(join(bin, 'systemctl'), 0o755);
		chmodSync(join(bin, 'journalctl'), 0o755);
		writeFileSync(journal, 'Bootstrapped 45% (loading_descriptors): Loading relay descriptors\n');
		const t = time('date:120', { PATH: `${bin}:${process.env.PATH}` });
		check(
			'time: while Tor is still bootstrapping, a needed step is deferred (tor-starting, exit 1)',
			t.status === 1 && /result=tor-starting/.test(t.line),
			t.out
		);
		writeFileSync(
			journal,
			'Bootstrapped 45% (loading_descriptors)\nBootstrapped 100% (done): Done\n'
		);
		const t2 = time('date:120', { PATH: `${bin}:${process.env.PATH}` });
		check(
			'time: once Tor reports Bootstrapped 100%, the same skew is a step',
			t2.status === 0 && /result=would-step/.test(t2.line),
			t2.out
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
		rmSync(work, { recursive: true, force: true });
		console.log('─'.repeat(56));
		if (fail > 0) {
			console.log(`✗ ${fail} of ${pass + fail} tor-only OS checks failed`);
			process.exit(1);
		}
		console.log(`✓ all ${pass} tor-only OS checks passed`);
		process.exit(0);
	});
