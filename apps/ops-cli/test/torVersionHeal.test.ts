/**
 * Tor too old for the Tor network (morphitlat, 2026-10-29 → 2026-11-01): since
 * 28 October 2026 the network requires subprotocols Tor 0.4.8 lacks, so a 0.4.8
 * Tor stalls at "Bootstrapped 30%" and loads nothing. Ubuntu's 0.4.9.11 sits in
 * noble-updates, which the daily automatic updates skip; a zero-clearnet node
 * can only fetch it over Tor, i.e. only while Tor still connects.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
	aptViaTor,
	heal,
	healTorVersion,
	parseTorVersion,
	torUpgradeArgs,
	TOR_MIN_VERSION,
	versionAtLeast,
	type TorVersionRuntime
} from '../src/lib/torVersionHeal.ts';
import { releaseTorBridgesLock, takeTorBridgesLock } from '../src/lib/torBridgesHeal.ts';

const ctx = { info: () => undefined, warn: () => undefined, spinner: () => () => undefined };
const scratch = mkdtempSync(join(tmpdir(), 'tor-version-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A server: Tor `version`, upgraded to `offered` by apt when asked. */
function server(o: {
	version: string | null;
	hidden?: boolean;
	works?: boolean | ((afterInstall: boolean) => boolean);
	offered?: string | null;
	updateOk?: boolean;
	installOk?: boolean;
	/** apt says it worked, yet the binary stays (a held package, a pin). */
	installLies?: boolean;
	base?: string | null;
}) {
	let v = o.version;
	let installed = false;
	const calls: string[] = [];
	const rt: TorVersionRuntime = {
		torVersion: () => v,
		hiddenOnly: () => o.hidden ?? false,
		torWorks: async () => {
			calls.push(`works${installed ? ':after' : ''}`);
			return typeof o.works === 'function' ? o.works(installed) : (o.works ?? true);
		},
		aptUpdate: async (overTor) => {
			calls.push(`update${overTor ? ':tor' : ''}`);
			return o.updateOk ?? true;
		},
		candidate: () => (o.offered === undefined ? '0.4.9.11' : o.offered),
		install: async (overTor) => {
			calls.push(`install${overTor ? ':tor' : ''}`);
			if (o.installOk === false) return false;
			installed = true;
			if (o.installLies !== true) v = o.offered === undefined ? '0.4.9.11' : o.offered;
			return true;
		},
		ubuntuBase: () => (o.base === undefined ? 'noble' : o.base)
	};
	return { rt, calls };
}

describe('versions', () => {
	it('compares dotted versions; 0.4.8 is too old, 0.4.9 and later are not', () => {
		expect(versionAtLeast('0.4.8.10', TOR_MIN_VERSION)).toBe(false);
		expect(versionAtLeast('0.4.8.22', TOR_MIN_VERSION)).toBe(false);
		expect(versionAtLeast('0.4.9.11', TOR_MIN_VERSION)).toBe(true);
		expect(versionAtLeast('0.4.9', TOR_MIN_VERSION)).toBe(true);
		expect(versionAtLeast('0.4.10.1', TOR_MIN_VERSION)).toBe(true);
		expect(versionAtLeast('0.5.0.0', TOR_MIN_VERSION)).toBe(true);
		expect(versionAtLeast('garbage', TOR_MIN_VERSION)).toBe(false);
	});
	it('reads `tor --version`', () => {
		expect(parseTorVersion('Tor version 0.4.8.10.\nThis build of Tor…')).toBe('0.4.8.10');
		expect(parseTorVersion('nothing')).toBeNull();
	});
});

describe('the Tor version heal', () => {
	it('leaves a new enough Tor alone (routine, no apt)', async () => {
		const s = server({ version: '0.4.9.11' });
		const r = await heal(ctx, s.rt);
		expect(r).toMatchObject({ strategy: 'already', verified: true, routine: true });
		expect(s.calls).toEqual([]);
	});

	it('says nothing where Tor is not installed', async () => {
		const r = await heal(ctx, server({ version: null }).rt);
		expect(r).toMatchObject({ strategy: 'not-installed', routine: true });
	});

	it('a normal server: apt directly, then Tor read back as 0.4.9 and proven to connect', async () => {
		const s = server({ version: '0.4.8.10' });
		const r = await heal(ctx, s.rt);
		expect(s.calls).toEqual(['update', 'install', 'works:after']);
		expect(r).toMatchObject({ strategy: 'applied', verified: true });
		expect(r.detail).toMatch(/from 0\.4\.8\.10 to 0\.4\.9\.11/);
		expect(r.routine).toBeUndefined();
	});

	it('a zero-clearnet server whose Tor still connects: apt through Tor', async () => {
		const s = server({ version: '0.4.8.10', hidden: true });
		const r = await heal(ctx, s.rt);
		expect(s.calls).toEqual(['works', 'update:tor', 'install:tor', 'works:after']);
		expect(r.verified).toBe(true);
	});

	it('a zero-clearnet server whose Tor is dead (morphitlat): no apt at all, and how to bring the packages', async () => {
		const s = server({ version: '0.4.8.10', hidden: true, works: false });
		const r = await heal(ctx, s.rt);
		expect(s.calls).toEqual(['works']);
		expect(r).toMatchObject({ strategy: 'left-alone', verified: false });
		expect(r.detail).toMatch(/since 28 October 2026/);
		expect(r.detail).toMatch(/tor_0\.4\.9\.11-0ubuntu0\.24\.04\.1_amd64\.deb/);
		expect(r.detail).toMatch(/sudo apt install \.\/tor_\*\.deb \.\/tor-geoipdb_\*\.deb/);
	});

	it('Ubuntu offers no 0.4.9 here: nothing installed, and where to get it', async () => {
		const s = server({ version: '0.4.8.10', offered: '0.4.8.10', base: 'jammy' });
		const r = await heal(ctx, s.rt);
		expect(s.calls).toEqual(['update']);
		expect(r).toMatchObject({ strategy: 'no-candidate', verified: false });
		expect(r.detail).toMatch(/Ubuntu offers 0\.4\.8\.10 here/);
		expect(r.detail).toMatch(/support\.torproject\.org\/apt/);
	});

	it('the refresh fails: nothing installed', async () => {
		const s = server({ version: '0.4.8.10', updateOk: false });
		const r = await heal(ctx, s.rt);
		expect(s.calls).toEqual(['update']);
		expect(r.strategy).toBe('no-candidate');
		expect(r.detail).toMatch(/could not be refreshed/);
	});

	it('the install fails: said, with the command', async () => {
		const s = server({ version: '0.4.8.10', installOk: false });
		const r = await heal(ctx, s.rt);
		expect(r).toMatchObject({ strategy: 'install-failed', verified: false });
		expect(r.detail).toMatch(/sudo apt-get install --only-upgrade tor/);
	});

	it('apt says it worked but `tor --version` is still old: not claimed (Tor itself is read back)', async () => {
		const s = server({ version: '0.4.8.10', installLies: true });
		const r = await heal(ctx, s.rt);
		expect(r).toMatchObject({ strategy: 'install-failed', verified: false });
		expect(r.detail).toMatch(/Tor is 0\.4\.8\.10/);
	});

	it('installed but not connected yet: not claimed as working (the bridges check follows)', async () => {
		const s = server({ version: '0.4.8.10', works: (after) => !after });
		const r = await heal(ctx, s.rt);
		expect(r).toMatchObject({ strategy: 'applied-not-connected', verified: false });
	});
});

describe('apt on the real server', () => {
	it('keeps the operator torrc and only upgrades', () => {
		const a = torUpgradeArgs(false, '127.0.0.1:9050');
		expect(a).toContain('Dpkg::Options::=--force-confold');
		expect(a).toContain('--only-upgrade');
		expect(a.slice(-2)).toEqual(['tor', 'tor-geoipdb']);
		expect(a.join(' ')).not.toMatch(/Proxy/);
	});
	it('through Tor on a zero-clearnet node: socks5h (names resolved by Tor)', () => {
		expect(aptViaTor('127.0.0.1:9050')).toEqual([
			'-o',
			'Acquire::http::Proxy=socks5h://apt-transport-tor@127.0.0.1:9050',
			'-o',
			'Acquire::https::Proxy=socks5h://apt-transport-tor@127.0.0.1:9050'
		]);
		expect(torUpgradeArgs(true, '127.0.0.1:9050').slice(0, 4)).toEqual(aptViaTor('127.0.0.1:9050'));
	});
});

describe('one Tor change at a time', () => {
	it('while the bridges check holds the lock, the version heal waits for next time', async () => {
		const lock = join(scratch, 'held.lock');
		expect(takeTorBridgesLock(lock)).toBe(true);
		const s = server({ version: '0.4.8.10' });
		try {
			const r = await healTorVersion(ctx, { runtime: s.rt, lockPath: lock });
			expect(r).toMatchObject({ strategy: 'busy', routine: true });
			expect(s.calls).toEqual([]);
		} finally {
			releaseTorBridgesLock(lock);
		}
	});
	it('takes the lock and gives it back', async () => {
		const lock = join(scratch, 'free.lock');
		const s = server({ version: '0.4.8.10' });
		const r = await healTorVersion(ctx, { runtime: s.rt, lockPath: lock });
		expect(r.strategy).toBe('applied');
		expect(takeTorBridgesLock(lock)).toBe(true);
		releaseTorBridgesLock(lock);
	});
});

describe('the Tor bridges timer (upgrade --tor-bridges)', () => {
	it('checks the Tor version first, then the bridges', async () => {
		vi.spyOn(process as unknown as { getuid: () => number }, 'getuid').mockReturnValue(0);
		const order: string[] = [];
		const { runTorBridgesCheck } = await import('../src/commands/upgrade.ts');
		vi.spyOn(console, 'log').mockImplementation(() => undefined);
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		try {
			const rc = await runTorBridgesCheck(
				async () => {
					order.push('bridges');
					return { strategy: 'already', verified: true, detail: 'ok' };
				},
				async () => {
					order.push('version');
					return { strategy: 'applied', verified: true, detail: 'Tor updated' };
				}
			);
			expect(order).toEqual(['version', 'bridges']);
			expect(rc).toBe(0);
		} finally {
			vi.restoreAllMocks();
		}
	});
});
