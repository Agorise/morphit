/**
 * The Tor bridges heal (lib/torBridgesHeal.ts): a server whose network filters
 * plain Tor moves its Tor onto the release's built-in bridges, proves its .onion
 * loads, and puts the previous torrc back when it does not (morphitir,
 * 2026-10-09). Driven through a fake server; the last cases hand the torrc it
 * writes to the real `tor --verify-config` when Tor is installed.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	BUILTIN_BRIDGES_PATH,
	TOR_BRIDGES_HEAL_MAX_MS,
	TOR_BRIDGES_BEGIN,
	TOR_BRIDGES_END,
	aptInstallArgs,
	bridgeLinesFrom,
	healTorBridges,
	onionHostname,
	takeTorBridgesLock,
	torProbeUser,
	verifyTorrc,
	type TorBridgesState,
	withBridges,
	type TorBridgesRuntime
} from '../src/lib/torBridgesHeal.ts';

const REPO = join(__dirname, '..', '..', '..');
const SHIPPED = JSON.parse(readFileSync(join(REPO, BUILTIN_BRIDGES_PATH), 'utf8')) as unknown;

const ORIGINAL = [
	'# BEGIN MORPHIT HIDDEN SERVICE (managed by Ansible)',
	'HiddenServiceDir /var/lib/tor/morphit',
	'HiddenServicePort 80 127.0.0.1:8090',
	'HiddenServicePoWDefensesEnabled 1',
	'# END MORPHIT HIDDEN SERVICE (managed by Ansible)',
	''
].join('\n');

interface Box {
	torrc: string;
	active: boolean;
	pkgs: Set<string>;
	installable: Set<string>;
	/** Does Tor load things with this torrc? */
	worksWith: (torrc: string) => boolean;
	connectsWith: (torrc: string) => boolean;
	acceptConfig: boolean;
	hidden: boolean;
	writable: boolean;
	installAttempts: string[];
	/** Each install: over Tor (true) or not. */
	installOverTor: boolean[];
	/** Would a separate plain Tor client work on this network? */
	plainWorks: boolean;
	plainProbes: number;
	/** What the heal keeps between runs. */
	state: TorBridgesState;
	restarts: number;
	writes: number;
	t: number;
	connectedAt: number | null;
}

function box(over: Partial<Box> = {}): Box {
	return {
		torrc: ORIGINAL,
		active: true,
		pkgs: new Set(),
		installable: new Set(['snowflake-client', 'obfs4proxy']),
		worksWith: (t) => t.includes('UseBridges 1'),
		connectsWith: (t) => t.includes('UseBridges 1'),
		acceptConfig: true,
		hidden: false,
		writable: true,
		installAttempts: [],
		installOverTor: [],
		plainWorks: false,
		plainProbes: 0,
		state: {},
		restarts: 0,
		writes: 0,
		t: 1_000_000,
		connectedAt: null,
		...over
	};
}

function runtime(b: Box): TorBridgesRuntime {
	return {
		readTorrc: () => b.torrc,
		writeTorrc: (t) => {
			if (!b.writable) return false;
			b.torrc = t;
			b.writes++;
			return true;
		},
		verifies: () => ({
			ok: b.acceptConfig,
			out: b.acceptConfig ? '' : '[warn] Bridge line did not parse.'
		}),
		torActive: () => b.active,
		onion: () => `${'a'.repeat(56)}.onion`,
		status: async (url) => (b.worksWith(b.torrc) ? (url.includes('.onion') ? 200 : 200) : 0),
		installed: (p) => b.pkgs.has(p),
		install: async (p, overTor) => {
			b.installAttempts.push(p);
			b.installOverTor.push(overTor);
			if (b.installable.has(p)) b.pkgs.add(p);
			return b.installable.has(p);
		},
		restartTor: async () => {
			b.restarts++;
			b.connectedAt = b.connectsWith(b.torrc) ? b.t + 20_000 : null;
			return true;
		},
		connectedSince: (since) =>
			b.connectedAt !== null && b.connectedAt >= since && b.t >= b.connectedAt,
		bridgeList: () => SHIPPED,
		hiddenOnly: () => b.hidden,
		plainTorWorks: async () => (b.plainProbes++, b.plainWorks),
		readState: () => ({ ...b.state }),
		writeState: (st) => void (b.state = { ...st }),
		sleep: async (ms) => {
			b.t += ms;
		},
		now: () => b.t
	};
}

const ctx = { info: () => undefined, warn: () => undefined, spinner: () => () => undefined };

describe('the release ships a usable bridge list', () => {
	it('ops/tor/builtin-bridges.json holds Snowflake and obfs4 bridges, Snowflake first', () => {
		const lines = bridgeLinesFrom(SHIPPED);
		expect(lines.filter((l) => l.startsWith('snowflake ')).length).toBeGreaterThan(0);
		expect(lines.filter((l) => l.startsWith('obfs4 ')).length).toBeGreaterThan(0);
		expect(lines[0]).toMatch(/^snowflake /);
		expect(lines.some((l) => l.startsWith('meek'))).toBe(false);
	});

	// v1.21.4 review: Ubuntu's snowflake-client (2.5.1) reads `front=`, not the
	// list's `fronts=`, and without it reaches the broker with no domain
	// fronting — which a network that filters Tor blocks.
	it('every Snowflake line names one front that older clients read', () => {
		const snow = bridgeLinesFrom(SHIPPED).filter((l) => l.startsWith('snowflake '));
		expect(snow.length).toBeGreaterThan(0);
		for (const l of snow) {
			const fronts = /(?:^| )fronts=([^ ]+)/.exec(l)?.[1]?.split(',') ?? [];
			expect(fronts.length, l).toBeGreaterThan(0);
			expect(l.split(' ')).toContain(`front=${fronts[0]}`);
		}
		// A line that already names a front keeps it, once.
		const own = bridgeLinesFrom([
			`snowflake 192.0.2.3:80 ${'A'.repeat(40)} front=x.example fronts=y.example`
		]);
		expect(own[0]!.split(' ').filter((w) => w.startsWith('front=')).length).toBe(1);
		expect(own[0]!.split(' ')).toContain('front=x.example');
	});
});

describe('the heal on a server', () => {
	it('a Tor that works is left alone: nothing installed, written or restarted', async () => {
		const b = box({ worksWith: () => true });
		const r = await healTorBridges(ctx, { runtime: runtime(b) });
		expect(r.strategy).toBe('already');
		expect([b.writes, b.restarts, b.pkgs.size]).toEqual([0, 0, 0]);
	});

	it("morphitir's case: plain Tor loads nothing → transports installed, bridges written, Tor restarted, .onion proven", async () => {
		const b = box();
		const r = await healTorBridges(ctx, { runtime: runtime(b) });
		expect(r).toMatchObject({ strategy: 'applied', verified: true });
		expect([...b.pkgs].sort()).toEqual(['obfs4proxy', 'snowflake-client']);
		expect(b.torrc.startsWith(ORIGINAL.trimEnd())).toBe(true);
		expect(b.torrc).toContain('UseBridges 1');
		expect(b.torrc).toContain('ClientTransportPlugin snowflake exec /usr/bin/snowflake-client');
		expect(b.torrc).toContain('ClientTransportPlugin obfs4 exec /usr/bin/obfs4proxy');
		expect(b.torrc.match(/^Bridge /gm)?.length).toBe(bridgeLinesFrom(SHIPPED).length);
		expect(b.restarts).toBe(1);
	});

	it('Tor that does not connect over the bridges either: the previous torrc is put back and Tor restarted on it', async () => {
		const b = box({ connectsWith: () => false });
		const r = await healTorBridges(ctx, { runtime: runtime(b) });
		expect(r).toMatchObject({ strategy: 'reverted', verified: false });
		expect(b.torrc).toBe(ORIGINAL);
		expect(b.restarts).toBe(2);
	});

	it('Tor connected but nothing loads through it: put back too', async () => {
		const b = box({ worksWith: () => false });
		const r = await healTorBridges(ctx, { runtime: runtime(b) });
		expect(r.strategy).toBe('reverted');
		expect(b.torrc).toBe(ORIGINAL);
	});

	it('a torrc Tor rejects is never written', async () => {
		const b = box({ acceptConfig: false });
		const r = await healTorBridges(ctx, { runtime: runtime(b) });
		expect(r.strategy).toBe('left-alone');
		expect([b.writes, b.restarts]).toEqual([0, 0]);
	});

	it('no transport can be installed: nothing written, and the operator is told what to run', async () => {
		const b = box({ installable: new Set() });
		const r = await healTorBridges(ctx, { runtime: runtime(b) });
		expect(r.strategy).toBe('left-alone');
		expect(r.detail).toMatch(/apt-get install snowflake-client obfs4proxy/);
		expect(b.writes).toBe(0);
	});

	it('only Snowflake installable: only Snowflake bridges and its transport are written', async () => {
		const b = box({ installable: new Set(['snowflake-client']) });
		await healTorBridges(ctx, { runtime: runtime(b) });
		expect(b.torrc).toContain('ClientTransportPlugin snowflake');
		expect(b.torrc).not.toContain('obfs4');
	});

	it('run again on a bridged server that fails: one block, refreshed, not a second one', async () => {
		const b = box({ pkgs: new Set(['snowflake-client', 'obfs4proxy']) });
		b.torrc = withBridges(ORIGINAL, [
			'snowflake 192.0.2.9:80 ' + 'C'.repeat(40) + ' fingerprint=x'
		]);
		// The old bridge no longer works; the release's list does.
		b.worksWith = (t) => t.includes('UseBridges 1') && !t.includes('192.0.2.9');
		const r = await healTorBridges(ctx, { runtime: runtime(b) });
		expect(r.strategy).toBe('refreshed');
		expect(b.torrc.split('\n').filter((l) => l === TOR_BRIDGES_BEGIN).length).toBe(1);
		expect(b.torrc.split('\n').filter((l) => l === TOR_BRIDGES_END).length).toBe(1);
		expect(b.torrc).not.toContain('192.0.2.9');
	});

	it('bridges that stopped working, on a network that no longer filters Tor: the bridges come out again', async () => {
		const b = box({ pkgs: new Set(['snowflake-client', 'obfs4proxy']) });
		b.torrc = withBridges(ORIGINAL, bridgeLinesFrom(SHIPPED));
		b.worksWith = (t) => !t.includes('UseBridges 1');
		b.connectsWith = () => true;
		const r = await healTorBridges(ctx, { runtime: runtime(b) });
		expect(r).toMatchObject({ strategy: 'bridges-removed', verified: true });
		expect(b.torrc).not.toContain(TOR_BRIDGES_BEGIN);
		expect(b.torrc).toContain('HiddenServiceDir /var/lib/tor/morphit');
	});

	it('a run killed before its proof left bridges that do not work: the next run does not keep trusting them', async () => {
		const b = box({ pkgs: new Set(['snowflake-client', 'obfs4proxy']) });
		const left = withBridges(ORIGINAL, [
			'snowflake 192.0.2.9:80 ' + 'C'.repeat(40) + ' fingerprint=x'
		]);
		b.torrc = left;
		b.worksWith = () => false;
		b.connectsWith = () => false;
		const r = await healTorBridges(ctx, { runtime: runtime(b) });
		expect(r.strategy).toBe('reverted');
		// Both the release's bridges and plain Tor were tried…
		expect(r.detail).toMatch(/over the bridges: .*; without bridges: /);
		// …and with neither working, the torrc is as this run found it.
		expect(b.torrc).toBe(left);
	});

	it('a Tor/I2P-only server never installs over clearnet', async () => {
		const b = box({ hidden: true });
		const r = await healTorBridges(ctx, { runtime: runtime(b) });
		expect(b.installAttempts, 'apt ran on a Tor/I2P-only server').toEqual([]);
		expect(r.strategy).toBe('left-alone');
		expect(r.detail).toMatch(/fetches nothing over clearnet/);
		expect(b.writes).toBe(0);
	});

	it('a put-back that cannot be written is said, not claimed', async () => {
		const b = box({ connectsWith: () => false });
		let n = 0;
		const rt = runtime(b);
		const r = await healTorBridges(ctx, {
			runtime: { ...rt, writeTorrc: (t) => (n++ === 0 ? rt.writeTorrc(t) : false) }
		});
		expect(r.strategy).toBe('reverted');
		expect(r.detail).toMatch(/could not be put back/);
	});

	it('never runs past its time limit, even when every step takes as long as it may', async () => {
		const b = box({ worksWith: () => false });
		const rt = runtime(b);
		const slow: TorBridgesRuntime = {
			...rt,
			status: async (url, ms) => ((b.t += ms), 0),
			install: async (p, overTor) => ((b.t += 4 * 60_000), rt.install(p, overTor)),
			restartTor: async () => ((b.t += 2 * 60_000), rt.restartTor())
		};
		const start = b.t;
		const r = await healTorBridges(ctx, { runtime: slow });
		expect(r.strategy).toBe('reverted');
		expect(b.t - start, 'the after-restart unit would kill it mid-way').toBeLessThanOrEqual(
			TOR_BRIDGES_HEAL_MAX_MS
		);
	});

	// v1.21.4 review: a working Tor on bridges was never moved back, so one
	// failed check could keep a server on bridges for good.
	it('bridges on a network that no longer filters Tor: a separate plain client proves it, and the bridges come out', async () => {
		const b = box({ pkgs: new Set(['snowflake-client', 'obfs4proxy']), plainWorks: true });
		b.torrc = withBridges(ORIGINAL, bridgeLinesFrom(SHIPPED));
		b.worksWith = () => true;
		b.connectsWith = () => true;
		const r = await healTorBridges(ctx, { runtime: runtime(b) });
		expect(r).toMatchObject({ strategy: 'bridges-removed', verified: true });
		expect(b.torrc).not.toContain(TOR_BRIDGES_BEGIN);
		expect(b.restarts).toBe(1);
	});

	it('bridges still needed (a plain client loads nothing): nothing written or restarted', async () => {
		const b = box({ pkgs: new Set(['snowflake-client', 'obfs4proxy']), plainWorks: false });
		b.torrc = withBridges(ORIGINAL, bridgeLinesFrom(SHIPPED));
		const r = await healTorBridges(ctx, { runtime: runtime(b) });
		expect(r.strategy).toBe('already');
		expect([b.writes, b.restarts, b.plainProbes]).toEqual([0, 0, 1]);
	});

	it('a Tor without bridges that works never starts the plain client', async () => {
		const b = box({ worksWith: () => true });
		await healTorBridges(ctx, { runtime: runtime(b) });
		expect(b.plainProbes).toBe(0);
	});

	// v1.21.4 review (2nd pass): when the plain client got through but this
	// server's Tor did not, the result said "loads nothing" about a Tor that
	// worked over bridges, nothing proved it worked again, and every run
	// restarted Tor twice.
	it('the plain client worked but this Tor does not without bridges: the bridges go back, proven, and plain waits a week', async () => {
		const b = box({ pkgs: new Set(['snowflake-client', 'obfs4proxy']), plainWorks: true });
		const bridged = withBridges(ORIGINAL, bridgeLinesFrom(SHIPPED));
		b.torrc = bridged;
		b.connectsWith = (t) => t.includes('UseBridges 1');
		const r = await healTorBridges(ctx, { runtime: runtime(b) });
		expect(r).toMatchObject({ strategy: 'already', verified: true, routine: false });
		expect(r.detail).not.toMatch(/loads nothing/);
		expect(r.detail).toMatch(/bridges stay/);
		expect(b.torrc).toBe(bridged);
		expect(b.restarts).toBe(2);
		// The next runs, within the week: no plain client, no restart.
		b.t += 2 * 24 * 3_600_000;
		const again = await healTorBridges(ctx, { runtime: runtime(b) });
		expect(again.strategy).toBe('already');
		expect([b.plainProbes, b.restarts]).toEqual([1, 2]);
		// After the week it is tried again.
		b.t += 6 * 24 * 3_600_000;
		await healTorBridges(ctx, { runtime: runtime(b) });
		expect(b.plainProbes).toBe(2);
	});

	it('the bridges put back but Tor loads nothing over them yet: said, not claimed', async () => {
		const b = box({ pkgs: new Set(['snowflake-client', 'obfs4proxy']), plainWorks: true });
		b.torrc = withBridges(ORIGINAL, bridgeLinesFrom(SHIPPED));
		b.connectsWith = (t) => t.includes('UseBridges 1') && b.restarts < 2;
		const r = await healTorBridges(ctx, { runtime: runtime(b) });
		expect(r.verified).toBe(false);
		expect(r.detail).toMatch(/bridges/);
	});

	it('the plain client worked but Tor refuses the config without bridges: nothing restarted, and Tor still works over them', async () => {
		const b = box({
			pkgs: new Set(['snowflake-client', 'obfs4proxy']),
			plainWorks: true,
			acceptConfig: false
		});
		const bridged = withBridges(ORIGINAL, bridgeLinesFrom(SHIPPED));
		b.torrc = bridged;
		const r = await healTorBridges(ctx, { runtime: runtime(b) });
		expect(r).toMatchObject({ strategy: 'already', verified: true });
		expect(r.detail).not.toMatch(/did not work without bridges/);
		expect([b.writes, b.restarts]).toEqual([0, 0]);
		expect(b.torrc).toBe(bridged);
	});

	// A throwaway client reaching public Tor relays is traffic a filtering
	// network sees: at most once a day.
	it('the plain client runs at most once a day', async () => {
		const b = box({ pkgs: new Set(['snowflake-client', 'obfs4proxy']), plainWorks: false });
		b.torrc = withBridges(ORIGINAL, bridgeLinesFrom(SHIPPED));
		await healTorBridges(ctx, { runtime: runtime(b) });
		b.t += 6 * 3_600_000;
		await healTorBridges(ctx, { runtime: runtime(b) });
		expect(b.plainProbes).toBe(1);
		b.t += 19 * 3_600_000;
		await healTorBridges(ctx, { runtime: runtime(b) });
		expect(b.plainProbes).toBe(2);
	});

	// v1.21.4 review: the torrc was written from a copy read up to ~40 minutes
	// earlier, so an edit made meanwhile (an operator, Ansible, the PoW heal)
	// was silently lost.
	it('a torrc changed by something else during the run is never overwritten', async () => {
		const b = box();
		const rt = runtime(b);
		let reads = 0;
		const r = await healTorBridges(ctx, {
			runtime: {
				...rt,
				readTorrc: () => {
					if (reads++ === 1) b.torrc = `${ORIGINAL}# edited by the operator\n`;
					return b.torrc;
				}
			}
		});
		expect(b.torrc).toContain('# edited by the operator');
		expect(b.writes).toBe(0);
		expect(r.verified).toBe(false);
		expect(r.detail).toMatch(/changed/);
	});

	it('nor put back over an edit made after this run wrote it', async () => {
		const b = box({ connectsWith: () => false });
		const rt = runtime(b);
		const r = await healTorBridges(ctx, {
			runtime: {
				...rt,
				restartTor: async () => {
					if (b.restarts === 0) b.torrc += '# edited during the restart\n';
					return rt.restartTor();
				}
			}
		});
		expect(b.torrc).toContain('# edited during the restart');
		expect(r.detail).toMatch(/changed/);
	});

	// v1.21.4 review: on a Tor/I2P-only server the advice was an apt-get that
	// runs through the very Tor that does not work.
	it('a Tor/I2P-only server gets the transports over Tor while Tor works', async () => {
		const b = box({ hidden: true, worksWith: () => true });
		const r = await healTorBridges(ctx, { runtime: runtime(b) });
		expect(r.strategy).toBe('already');
		// Only obfs4: Snowflake asks DNS for its front and STUN servers, which a
		// Tor-only node's egress rule refuses to every user.
		expect(b.installAttempts).toEqual(['obfs4proxy']);
		expect(b.installOverTor).toEqual([true]);
		expect([b.writes, b.restarts]).toEqual([0, 0]);
		expect(r.routine).toBe(false);
	});

	it('a Tor/I2P-only server moves onto obfs4 bridges only, even with Snowflake installed', async () => {
		const b = box({ hidden: true, pkgs: new Set(['snowflake-client', 'obfs4proxy']) });
		const r = await healTorBridges(ctx, { runtime: runtime(b) });
		expect(r.strategy).toBe('applied');
		expect(b.torrc).toMatch(/^Bridge obfs4 /m);
		expect(b.torrc).not.toMatch(/snowflake/);
	});

	it('a Tor/I2P-only server whose Tor already loads nothing is told how to bring the packages in', async () => {
		const b = box({ hidden: true });
		const r = await healTorBridges(ctx, { runtime: runtime(b) });
		expect(b.installAttempts).toEqual([]);
		expect(r.detail).toMatch(/apt-get download obfs4proxy/);
	});

	it('on bridges, with the transports to install over Tor and the plain client taking all its time: still within the limit', async () => {
		const b = box({ hidden: true, plainWorks: true });
		b.torrc = withBridges(ORIGINAL, bridgeLinesFrom(SHIPPED));
		b.worksWith = (t) => t.includes('UseBridges 1') || b.restarts > 0;
		b.connectsWith = () => false;
		const rt = runtime(b);
		const slow: TorBridgesRuntime = {
			...rt,
			status: async (url, ms) => {
				const r = await rt.status(url, ms);
				b.t += r === 0 ? ms : 1_000;
				return r;
			},
			install: async (p, overTor) => ((b.t += 4 * 60_000), rt.install(p, overTor)),
			plainTorWorks: async (until) => ((b.t = until), rt.plainTorWorks(until)),
			restartTor: async () => ((b.t += 2 * 60_000), rt.restartTor())
		};
		const start = b.t;
		await healTorBridges(ctx, { runtime: slow });
		expect(b.t - start).toBeLessThanOrEqual(TOR_BRIDGES_HEAL_MAX_MS);
	});

	it('no Tor running: nothing to do', async () => {
		const b = box({ active: false });
		expect((await healTorBridges(ctx, { runtime: runtime(b) })).strategy).toBe('skipped');
		expect(b.writes).toBe(0);
	});
});

describe.skipIf(spawnSync('tor', ['--version']).status !== 0)(
	'the real Tor accepts what the heal writes',
	() => {
		it('the check the heal runs passes on a torrc with every shipped bridge, and fails on a broken one', () => {
			const ok = verifyTorrc(withBridges(ORIGINAL, bridgeLinesFrom(SHIPPED)));
			expect(ok.ok, ok.out).toBe(true);
			expect(verifyTorrc(`${ORIGINAL}UseBridges 1\nBridge snowflake not-an-address\n`).ok).toBe(
				false
			);
		});
	}
);

describe('which .onion the check loads', () => {
	it("this server's own service (/var/lib/tor/morphit) first, whatever else is there", () => {
		const d = mkdtempSync(join(tmpdir(), 'torlib-'));
		try {
			for (const [dir, host] of [
				['aaa-other', `${'b'.repeat(56)}.onion`],
				['morphit', `${'m'.repeat(56)}.onion`]
			] as const) {
				mkdirSync(join(d, dir));
				writeFileSync(join(d, dir, 'hostname'), `${host}\n`);
			}
			expect(onionHostname(d)).toBe(`${'m'.repeat(56)}.onion`);
			rmSync(join(d, 'morphit'), { recursive: true });
			expect(onionHostname(d)).toBe(`${'b'.repeat(56)}.onion`);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe('one run at a time', () => {
	// v1.21.4 review: two runs that both saw a stale lock could both end up
	// holding it — the second moved the first one's fresh lock aside.
	it('a lock taken by another run between the stale check and the move is given back', () => {
		const d = mkdtempSync(join(tmpdir(), 'torlock-'));
		const lock = join(d, 'lock');
		try {
			mkdirSync(lock);
			writeFileSync(join(lock, 'pid'), '2147483646'); // gone
			const other = String(process.ppid); // alive, not us
			const got = takeTorBridgesLock(lock, Date.now(), {
				beforeMoveAside: () => {
					// The other run took the stale lock over first.
					rmSync(lock, { recursive: true, force: true });
					mkdirSync(lock);
					writeFileSync(join(lock, 'pid'), other);
				}
			});
			expect(got).toBe(false);
			expect(existsSync(lock)).toBe(true);
			expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(other);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe('installing a transport', () => {
	it('waits for a dpkg lock instead of failing, and on a Tor/I2P-only server goes only through Tor', () => {
		const plain = aptInstallArgs('obfs4proxy', false, '127.0.0.1:9050');
		expect(plain.join(' ')).toMatch(/DPkg::Lock::Timeout=\d+/);
		expect(plain.join(' ')).not.toMatch(/Proxy/);
		const tor = aptInstallArgs('obfs4proxy', true, '127.0.0.1:9050');
		expect(tor).toContain('Acquire::http::Proxy=socks5h://apt-transport-tor@127.0.0.1:9050');
		expect(tor).toContain('Acquire::https::Proxy=socks5h://apt-transport-tor@127.0.0.1:9050');
		expect(tor.slice(-1)).toEqual(['obfs4proxy']);
	});
});

describe('the separate plain Tor client', () => {
	it("runs as Tor's own user (a Tor-only node lets only that user out)", () => {
		const d = mkdtempSync(join(tmpdir(), 'passwd-'));
		try {
			writeFileSync(
				join(d, 'passwd'),
				'root:x:0:0:root:/root:/bin/bash\ndebian-tor:x:103:105::/var/lib/tor:/bin/false\n'
			);
			expect(torProbeUser(join(d, 'passwd'))).toEqual({ uid: 103, gid: 105 });
			writeFileSync(join(d, 'passwd'), 'root:x:0:0:root:/root:/bin/bash\n');
			expect(torProbeUser(join(d, 'passwd'))).toBeNull();
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	// Running it for real (as that user, ending with its owner, within its
	// limit): scripts/tor-plain-probe-execution-smoke.ts.
});
