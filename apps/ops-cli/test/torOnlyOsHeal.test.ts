/**
 * The post-upgrade tor-only OS heal (v1.20.0, C13).
 *
 * These drive applyAndVerifyTorOnlyOs with the REAL ops/tor-only/morphit-tor-only-os.sh
 * (check/apply/revert run for real against a scratch root: real apt sources,
 * a real chrony.conf, a real /etc/default/motd-news) and a simulated rest of
 * the box: whether Tor answers, what the apt refresh over Tor returns, the Tor
 * time check's verdict, and what chronyd reports. They assert the FILES that
 * end up on disk (switched, or byte-identical to before), the markers that make
 * an interrupted run safe, and the order of the steps — never message text.
 * (The real apt refresh over a SOCKS proxy is covered by scripts/tor-only-os-smoke.ts.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
	existsSync,
	symlinkSync,
	readdirSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	applyAndVerifyTorOnlyOs,
	APT_VERIFY_MIN_MS,
	REVERT_MARGIN_MS,
	torSocksFromEnv,
	type TorOnlyOsRuntime,
	type ScriptRun
} from '../src/lib/torOnlyOsHeal.ts';

const SCRIPT = join(
	import.meta.dirname,
	'..',
	'..',
	'..',
	'ops',
	'tor-only',
	'morphit-tor-only-os.sh'
);
const SOCKS = '127.0.0.1:9050';

const UBUNTU_SOURCES = `Types: deb
URIs: http://archive.ubuntu.com/ubuntu/
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://security.ubuntu.com/ubuntu/
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`;
const DOCKER_LIST =
	'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable\n';
const CHRONY = `confdir /etc/chrony/conf.d
pool ntp.ubuntu.com        iburst maxsources 4
pool 0.ubuntu.pool.ntp.org iburst maxsources 1
sourcedir /run/chrony-dhcp
sourcedir /etc/chrony/sources.d
keyfile /etc/chrony/chrony.keys
driftfile /var/lib/chrony/chrony.drift
rtcsync
makestep 1 3
`;

let root = '';
let state = '';
let aptConf = '';

/** Every file under the scratch root, path → content (links as '->target'). */
function snapshot(): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (d: string): void => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (p.startsWith(state)) continue;
			if (e.isSymbolicLink()) out.set(p, '->');
			else if (e.isDirectory()) walk(p);
			else out.set(p, readFileSync(p, 'utf8'));
		}
	};
	walk(root);
	return out;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'morphit-toros-'));
	state = join(root, 'var', 'lib', 'morphit-tor-only');
	mkdirSync(join(root, 'etc', 'apt', 'sources.list.d'), { recursive: true });
	mkdirSync(join(root, 'etc', 'apt', 'apt.conf.d'), { recursive: true });
	mkdirSync(join(root, 'etc', 'chrony', 'conf.d'), { recursive: true });
	mkdirSync(join(root, 'etc', 'default'), { recursive: true });
	mkdirSync(join(root, 'usr', 'lib', 'apt', 'methods'), { recursive: true });
	writeFileSync(join(root, 'etc', 'apt', 'sources.list'), '# moved to sources.list.d\n');
	writeFileSync(join(root, 'etc', 'apt', 'sources.list.d', 'ubuntu.sources'), UBUNTU_SOURCES);
	writeFileSync(join(root, 'etc', 'apt', 'sources.list.d', 'docker.list'), DOCKER_LIST);
	writeFileSync(join(root, 'etc', 'chrony', 'chrony.conf'), CHRONY);
	writeFileSync(join(root, 'etc', 'default', 'motd-news'), 'ENABLED=1\n');
	// apt-config reads the scratch root's apt.conf.d (APT_CONFIG is read first).
	aptConf = join(root, 'apt-test.conf');
	writeFileSync(aptConf, `Dir::Etc "${root}/etc/apt/";\n`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface Sim {
	torUp: boolean;
	transportPresent: boolean;
	/** Each strategy's result, in order; true also puts the drivers in place. */
	strategies: boolean[];
	/** apt-verify exit statuses, one per call (last repeats). */
	verify: number[];
	timeCheck: number;
	chronyPresent: boolean;
	chronyActive: boolean;
	/** chronyc source count after a restart when the conf still names sources
	 *  (real file state decides 0 vs this). */
	strayChronySources: number;
	stopWorks: boolean;
	timesyncd: boolean;
	unitsOk: boolean;
	recoverOk: boolean;
	/** Simulated clock (ms); each apt-verify call advances it by verifyTakesMs. */
	clock: { t: number };
	verifyTakesMs: number;
	/** What each apt-verify was allowed (timeoutMs + env), for the budget tests. */
	limits: Array<{ timeoutMs: number; env?: Readonly<Record<string, string>> }>;
}

function runtime(sim: Sim, calls: string[]): TorOnlyOsRuntime {
	const env = {
		...process.env,
		MORPHIT_OS_ROOT: root,
		MORPHIT_TOR_SOCKS: SOCKS,
		APT_CONFIG: aptConf,
		// Never the real Ubuntu Pro CLI of the machine running the tests.
		MORPHIT_PRO_BIN: join(root, 'no-pro-here')
	};
	let verifyIdx = 0;
	const real = (mode: string, bk?: string): ScriptRun => {
		const r = spawnSync('sh', [SCRIPT, mode, ...(bk ? [bk] : [])], { encoding: 'utf8', env });
		return { status: r.status ?? 1, output: `${r.stdout}${r.stderr}` };
	};
	const drivers = (): void => {
		for (const d of ['tor+http', 'tor+https']) {
			const p = join(root, 'usr', 'lib', 'apt', 'methods', d);
			if (!existsSync(p)) symlinkSync('/bin/true', p);
		}
	};
	if (sim.transportPresent) drivers();
	let chronyUp = sim.chronyActive;
	let timesyncd = sim.timesyncd;
	return {
		script: (mode, bk, limits) => {
			calls.push(`script:${mode}`);
			if (mode === 'apt-verify') {
				if (limits) sim.limits.push(limits);
				sim.clock.t += sim.verifyTakesMs;
				const s = sim.verify[Math.min(verifyIdx, sim.verify.length - 1)] ?? 1;
				verifyIdx++;
				return { status: s, output: `MORPHIT_TOR_APT result=${s}` };
			}
			return real(mode, bk);
		},
		torAnswers: async () => {
			calls.push('torAnswers');
			return sim.torUp;
		},
		aptTransportPresent: () =>
			existsSync(join(root, 'usr', 'lib', 'apt', 'methods', 'tor+http')) &&
			existsSync(join(root, 'usr', 'lib', 'apt', 'methods', 'tor+https')),
		aptTransportStrategies: () =>
			sim.strategies.map((ok, i) => ({
				name: `strategy-${i}`,
				run: () => {
					calls.push(`strategy-${i}`);
					if (ok) drivers();
					return ok;
				}
			})),
		newBackupDir: (part) => {
			mkdirSync(state, { recursive: true });
			const d = join(state, `backup-${Date.now()}-${Math.random().toString(16).slice(2)}-${part}`);
			mkdirSync(d);
			return d;
		},
		readMarker: (n) => {
			try {
				return readFileSync(join(state, n), 'utf8').trim() || null;
			} catch {
				return null;
			}
		},
		writeMarker: (n, v) => {
			calls.push(`mark:${n}`);
			mkdirSync(state, { recursive: true });
			writeFileSync(join(state, n), v);
			return true;
		},
		clearMarker: (n) => rmSync(join(state, n), { force: true }),
		installTimeCheck: () => {
			calls.push('installTimeCheck');
			return sim.unitsOk ? { ok: true } : { ok: false, detail: 'simulated' };
		},
		installRecover: () => {
			calls.push('installRecover');
			return sim.recoverOk ? { ok: true } : { ok: false, detail: 'simulated' };
		},
		now: () => sim.clock.t,
		runTimeCheck: () => {
			calls.push('runTimeCheck');
			return { status: sim.timeCheck, output: `MORPHIT_TOR_TIME result=x answered=2` };
		},
		chronyPresent: () => sim.chronyPresent,
		chronyActive: () => chronyUp,
		restartChrony: () => {
			calls.push('restartChrony');
			chronyUp = true;
			return true;
		},
		chronySourceCount: () =>
			/^[ \t]*(pool|server|peer|sourcedir)[ \t]/m.test(
				readFileSync(join(root, 'etc', 'chrony', 'chrony.conf'), 'utf8')
			)
				? 3
				: sim.strayChronySources,
		stopDisableChrony: () => {
			calls.push('stopDisableChrony');
			if (sim.stopWorks) chronyUp = false;
			return sim.stopWorks;
		},
		timesyncdActive: () => timesyncd,
		disableTimesyncd: () => {
			calls.push('disableTimesyncd');
			timesyncd = false;
			return true;
		},
		sleep: async () => {
			calls.push('sleep');
		},
		spinner: () => () => {}
	};
}

const base = (o: Partial<Sim> = {}): Sim => ({
	torUp: true,
	transportPresent: false,
	strategies: [false, true, true],
	verify: [0],
	timeCheck: 0,
	chronyPresent: true,
	chronyActive: true,
	strayChronySources: 0,
	stopWorks: true,
	timesyncd: false,
	unitsOk: true,
	recoverOk: true,
	clock: { t: 1_000_000 },
	verifyTakesMs: 1000,
	limits: [],
	...o
});

const run = (sim: Sim, calls: string[], hiddenOnly = true, hardStopAt?: number) =>
	applyAndVerifyTorOnlyOs({
		hiddenOnly,
		socks: SOCKS,
		runtime: runtime(sim, calls),
		info: () => {},
		warn: () => {},
		hardStopAt
	});

const read = (...p: string[]): string => readFileSync(join(root, ...p), 'utf8');

describe('tor-only OS heal — which nodes', () => {
	it('never touches a clearnet node: not one file, not one check', async () => {
		const before = snapshot();
		const calls: string[] = [];
		const out = await run(base(), calls, false);
		expect(out).toEqual({ apt: 'not-tor-only', time: 'not-tor-only', news: 'not-tor-only' });
		expect(calls).toEqual([]);
		expect(snapshot()).toEqual(before);
	});
});

describe('tor-only OS heal — apt', () => {
	it('switches apt to Tor, using the first transport strategy that is SEEN to work, and keeps it once a refresh over Tor works', async () => {
		const calls: string[] = [];
		const out = await run(base(), calls);
		expect(out.apt).toBe('switched');
		expect(out.aptTransport).toBe('strategy-1');
		expect(read('etc', 'apt', 'sources.list.d', 'ubuntu.sources')).toContain(
			'URIs: tor+http://archive.ubuntu.com/ubuntu/'
		);
		expect(read('etc', 'apt', 'sources.list.d', 'ubuntu.sources')).toContain(
			'URIs: tor+http://security.ubuntu.com/ubuntu/'
		);
		expect(read('etc', 'apt', 'sources.list.d', 'docker.list')).toContain(
			' tor+https://download.docker.com/'
		);
		expect(read('etc', 'apt', 'apt.conf.d', '99morphit-tor-only.conf')).toContain(
			'Acquire::https::Proxy "socks5h://apt-transport-tor@127.0.0.1:9050";'
		);
		// The switch is recorded BEFORE it is made, and cleared only after the verdict.
		expect(calls.indexOf('mark:apt.pending')).toBeLessThan(calls.indexOf('script:apt-apply'));
		expect(calls.indexOf('script:apt-apply')).toBeLessThan(calls.indexOf('script:apt-verify'));
		expect(existsSync(join(state, 'apt.pending'))).toBe(false);
		// The real script now says apt is on Tor.
		const again: string[] = [];
		expect((await run(base({ transportPresent: true }), again)).apt).toBe('already');
		expect(again).not.toContain('script:apt-apply');
	});

	it('puts every apt file back byte for byte when no refresh over Tor works (after one retry)', async () => {
		const before = snapshot();
		const calls: string[] = [];
		const out = await run(base({ transportPresent: true, verify: [1, 1] }), calls);
		expect(out.apt).toBe('reverted');
		expect(calls.filter((c) => c === 'script:apt-verify')).toHaveLength(2);
		expect(calls).toContain('script:apt-revert');
		const after = snapshot();
		for (const [p, c] of before) {
			if (p.includes('/etc/apt/')) expect(after.get(p)).toBe(c);
		}
		expect(existsSync(join(root, 'etc', 'apt', 'apt.conf.d', '99morphit-tor-only.conf'))).toBe(
			false
		);
		expect(existsSync(join(state, 'apt.pending'))).toBe(false);
	});

	it('keeps the switch when the second refresh over Tor works', async () => {
		const out = await run(base({ transportPresent: true, verify: [1, 0] }), []);
		expect(out.apt).toBe('switched');
		expect(read('etc', 'apt', 'sources.list.d', 'docker.list')).toContain('tor+https://');
	});

	it('reverts (does not keep an unverified switch) when apt stayed busy', async () => {
		const out = await run(base({ transportPresent: true, verify: [3] }), []);
		expect(out.apt).toBe('reverted');
		expect(read('etc', 'apt', 'sources.list.d', 'docker.list')).toBe(DOCKER_LIST);
	});

	it('changes nothing when Tor does not answer', async () => {
		const before = snapshot();
		const calls: string[] = [];
		const out = await run(base({ torUp: false }), calls);
		expect(out.apt).toBe('tor-not-answering');
		expect(calls).not.toContain('script:apt-apply');
		const after = snapshot();
		for (const [p, c] of before) if (p.includes('/etc/apt/')) expect(after.get(p)).toBe(c);
	});

	it('changes nothing (and removes driver links it made) when no transport strategy works', async () => {
		const before = snapshot();
		const out = await run(base({ strategies: [false, false, false] }), []);
		expect(out.apt).toBe('no-transport');
		const after = snapshot();
		for (const [p, c] of before) if (p.includes('/etc/apt/')) expect(after.get(p)).toBe(c);
	});

	it('an interrupted run (switched, never verified) is VERIFIED by the next one, not trusted', async () => {
		// Run 1 is "killed" after the apply: simulate by applying and leaving the marker.
		const calls1: string[] = [];
		const rt = runtime(base({ transportPresent: true }), calls1);
		const bk = rt.newBackupDir('apt')!;
		rt.writeMarker('apt.pending', bk);
		expect(rt.script('apt-apply', bk).status).toBe(0);
		expect(rt.script('apt-check').status).toBe(0); // looks done…
		// Run 2: the refresh over Tor fails → everything goes back to the ORIGINAL.
		const calls2: string[] = [];
		const out = await run(base({ transportPresent: true, verify: [1, 1] }), calls2);
		expect(out.apt).toBe('reverted');
		expect(calls2).toContain('script:apt-verify');
		expect(read('etc', 'apt', 'sources.list.d', 'ubuntu.sources')).toBe(UBUNTU_SOURCES);
		expect(read('etc', 'apt', 'sources.list.d', 'docker.list')).toBe(DOCKER_LIST);
	});

	it('an interrupted run and Tor now down → put back', async () => {
		const rt = runtime(base({ transportPresent: true }), []);
		const bk = rt.newBackupDir('apt')!;
		rt.writeMarker('apt.pending', bk);
		rt.script('apt-apply', bk);
		const out = await run(base({ transportPresent: true, torUp: false }), []);
		expect(out.apt).toBe('reverted');
		expect(read('etc', 'apt', 'sources.list.d', 'docker.list')).toBe(DOCKER_LIST);
	});

	it('offline-install phase: keeps the configuration, marks it for the next upgrade to verify', async () => {
		const calls: string[] = [];
		const out = await run(base({ transportPresent: true, verify: [10] }), calls);
		expect(out.apt).toBe('config-only');
		expect(existsSync(join(state, 'apt.unverified'))).toBe(true);
		expect(read('etc', 'apt', 'sources.list.d', 'docker.list')).toContain('tor+https://');
		// Next upgrade: online now, the refresh over Tor is checked.
		const calls2: string[] = [];
		const out2 = await run(base({ transportPresent: true, verify: [0] }), calls2);
		expect(out2.apt).toBe('switched');
		expect(calls2).toContain('script:apt-verify');
		expect(existsSync(join(state, 'apt.unverified'))).toBe(false);
	});
});

describe('tor-only OS heal — time', () => {
	it('keeps chrony on its servers when the Tor time check has no consensus', async () => {
		const calls: string[] = [];
		const out = await run(base({ transportPresent: true, timeCheck: 1 }), calls);
		expect(out.time).toBe('no-consensus');
		expect(read('etc', 'chrony', 'chrony.conf')).toBe(CHRONY);
		expect(calls).not.toContain('restartChrony');
	});

	it('takes chrony off public NTP only AFTER the Tor time check works, and sees zero sources', async () => {
		const calls: string[] = [];
		const out = await run(base({ transportPresent: true }), calls);
		expect(out.time).toBe('switched');
		expect(calls.indexOf('installTimeCheck')).toBeLessThan(calls.indexOf('runTimeCheck'));
		expect(calls.indexOf('runTimeCheck')).toBeLessThan(calls.indexOf('script:chrony-apply'));
		const conf = read('etc', 'chrony', 'chrony.conf');
		expect(conf).not.toMatch(/^[ \t]*(pool|server|peer|sourcedir)[ \t]/m);
		expect(conf).toContain('driftfile /var/lib/chrony/chrony.drift');
		expect(existsSync(join(state, 'chrony.pending'))).toBe(false);
	});

	it('stops chrony when it still lists a source after the edit (the Tor check keeps the clock)', async () => {
		const out = await run(base({ transportPresent: true, strayChronySources: 1 }), []);
		expect(out.time).toBe('chrony-stopped');
	});

	it('puts chrony back when it still lists a source and cannot be stopped', async () => {
		const calls: string[] = [];
		const out = await run(
			base({ transportPresent: true, strayChronySources: 1, stopWorks: false }),
			calls
		);
		expect(out.time).toBe('reverted');
		expect(read('etc', 'chrony', 'chrony.conf')).toBe(CHRONY);
		expect(calls.lastIndexOf('restartChrony')).toBeGreaterThan(
			calls.indexOf('script:chrony-revert')
		);
	});

	it('does not touch chrony when the time check could not be set up', async () => {
		const out = await run(base({ transportPresent: true, unitsOk: false }), []);
		expect(out.time).toBe('units-failed');
		expect(read('etc', 'chrony', 'chrony.conf')).toBe(CHRONY);
	});

	it('turns systemd-timesyncd off (after a consensus) on a box without chrony', async () => {
		rmSync(join(root, 'etc', 'chrony', 'chrony.conf'));
		const calls: string[] = [];
		const out = await run(
			base({ transportPresent: true, chronyPresent: false, timesyncd: true }),
			calls
		);
		expect(out.time).toBe('timesyncd-off');
		expect(calls.indexOf('runTimeCheck')).toBeLessThan(calls.indexOf('disableTimesyncd'));
	});
});

describe('tor-only OS heal — news', () => {
	it('turns motd news off and checks it', async () => {
		const out = await run(base({ transportPresent: true }), []);
		expect(out.news).toBe('switched');
		expect(read('etc', 'default', 'motd-news')).toBe('ENABLED=0\n');
	});
});

describe('torSocksFromEnv', () => {
	it('reads the indexer SocksPort, never a name', () => {
		const f = join(root, 'indexer.env');
		writeFileSync(f, 'MORPHIT_INDEXER_TOR_SOCKS=127.0.0.1:9150\n');
		expect(torSocksFromEnv([f])).toBe('127.0.0.1:9150');
		writeFileSync(f, 'MORPHIT_INDEXER_TOR_SOCKS=localhost:9150\n');
		expect(torSocksFromEnv([f])).toBe('127.0.0.1:9050');
	});
});

describe('tor-only OS heal — the upgrade stops the self-heal at a fixed time (wave 2, O1)', () => {
	it('does not start a switch it could not finish checking: nothing changes, calm "deferred"', async () => {
		const before = snapshot();
		const calls: string[] = [];
		const sim = base({ transportPresent: true });
		const out = await run(sim, calls, true, sim.clock.t + APT_VERIFY_MIN_MS);
		expect(out.apt).toBe('deferred');
		expect(calls).not.toContain('script:apt-apply');
		expect(calls).not.toContain('mark:apt.pending');
		const after = snapshot();
		for (const [p, c] of before) if (p.includes('/etc/apt/')) expect(after.get(p)).toBe(c);
	});

	it('a switch left unchecked by an earlier run is put back FIRST THING when there is no time to check it', async () => {
		const rt = runtime(base({ transportPresent: true }), []);
		const bk = rt.newBackupDir('apt')!;
		rt.writeMarker('apt.pending', bk);
		rt.script('apt-apply', bk);
		const calls: string[] = [];
		const sim = base({ transportPresent: true });
		const out = await run(sim, calls, true, sim.clock.t + 30_000);
		expect(out.apt).toBe('reverted');
		expect(calls).not.toContain('script:apt-verify');
		expect(read('etc', 'apt', 'sources.list.d', 'docker.list')).toBe(DOCKER_LIST);
		expect(existsSync(join(state, 'apt.pending'))).toBe(false);
	});

	it('the refresh over Tor is given only the time left (minus a put-back margin), lock wait included', async () => {
		const sim = base({ transportPresent: true, verify: [0] });
		const stopAt = sim.clock.t + 200_000;
		await run(sim, [], true, stopAt);
		expect(sim.limits).toHaveLength(1);
		const l = sim.limits[0]!;
		expect(l.timeoutMs).toBeLessThanOrEqual(200_000 - REVERT_MARGIN_MS);
		expect(Number(l.env?.MORPHIT_APT_VERIFY_TIMEOUT) * 1000).toBeLessThan(l.timeoutMs);
		expect(Number(l.env?.MORPHIT_APT_LOCK_WAIT)).toBeLessThanOrEqual(
			Number(l.env?.MORPHIT_APT_VERIFY_TIMEOUT)
		);
	});

	it('no retry when the first check used up the time: put back, never left pending', async () => {
		const calls: string[] = [];
		const sim = base({ transportPresent: true, verify: [1, 0], verifyTakesMs: 60_000 });
		const out = await run(sim, calls, true, sim.clock.t + 170_000);
		expect(out.apt).toBe('reverted');
		expect(calls.filter((c) => c === 'script:apt-verify')).toHaveLength(1);
		expect(existsSync(join(state, 'apt.pending'))).toBe(false);
		expect(read('etc', 'apt', 'sources.list.d', 'docker.list')).toBe(DOCKER_LIST);
	});

	it('the safety-net unit (verify-or-revert after boot) is installed before any switch; without it, no switch', async () => {
		const calls: string[] = [];
		const out = await run(base({ transportPresent: true, recoverOk: false }), calls);
		expect(out.apt).toBe('apply-failed');
		expect(calls).not.toContain('script:apt-apply');
		const calls2: string[] = [];
		await run(base({ transportPresent: true }), calls2);
		expect(calls2.indexOf('installRecover')).toBeLessThan(calls2.indexOf('script:apt-apply'));
	});

	it('the time check is not started without time for it (chrony untouched)', async () => {
		const calls: string[] = [];
		const sim = base({ transportPresent: true, verifyTakesMs: 60_000 });
		const out = await run(sim, calls, true, sim.clock.t + 160_000);
		expect(out.time).toBe('deferred');
		expect(calls).not.toContain('runTimeCheck');
		expect(read('etc', 'chrony', 'chrony.conf')).toBe(CHRONY);
	});
});
