/**
 * A hidden-only node fetches the frontend's pinned nginx base through Tor with
 * the time Tor needs, in the after-restart unit, right after the tor-only egress
 * heal sets Docker to pull through Tor.
 *
 * Before: only the web heal's rebuild could fetch it, with about 40 seconds.
 * On morphitlat (2026-10-05) the pull through Tor did not fit, and
 * `upgrade --heals` kept reporting the older base with a manual command.
 */
import { describe, expect, it } from 'vitest';
import {
	fetchFrontendBaseThroughTor,
	type BaseFetchRuntime
} from '../src/lib/frontendBaseFetch.ts';
import { afterRestartHealSteps, fetchFrontendBaseNow } from '../src/commands/upgrade.ts';
import { daemonJsonProxiesAllowTor, noProxyBypassesRegistry } from '../src/lib/proxyConfigHeal.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ctx = { info: () => {}, warn: () => {}, spinner: () => () => {} };

function rt(o: Partial<BaseFetchRuntime> & { present?: boolean[] } = {}) {
	const calls: number[] = [];
	const present = o.present ?? [false];
	let i = 0;
	const r: BaseFetchRuntime = {
		hiddenOnly: () => true,
		frontendPresent: () => true,
		basePresent: () => present[Math.min(i++, present.length - 1)]!,
		dockerPullsThroughTor: () => true,
		pull: async (t) => {
			calls.push(t);
			return true;
		},
		...o
	};
	return { r, calls };
}

describe('fetchFrontendBaseThroughTor', () => {
	it('pulls on a hidden-only node whose Docker pulls through Tor, with minutes to do it, and checks the image is there', async () => {
		const { r, calls } = rt({ present: [false, true] });
		const res = await fetchFrontendBaseThroughTor(ctx, r);
		expect(calls).toEqual([15 * 60_000]);
		expect(res.strategy).toBe('fetched');
		expect(res.verified).toBe(true);
	});

	it('never pulls unless all of it holds: hidden-only, a frontend, no image yet, Docker through Tor', async () => {
		for (const o of [
			{ hiddenOnly: () => false },
			{ frontendPresent: () => false },
			{ present: [true] },
			{ dockerPullsThroughTor: () => false }
		]) {
			const { r, calls } = rt(o);
			const res = await fetchFrontendBaseThroughTor(ctx, r);
			expect(calls, JSON.stringify(Object.keys(o))).toEqual([]);
			expect(res.verified).toBe(true);
		}
	});

	it('a pull that ends without the image on the box is a warning, never a success', async () => {
		const { r } = rt({ present: [false, false] });
		const res = await fetchFrontendBaseThroughTor(ctx, r);
		expect(res.strategy).toBe('failed');
		expect(res.verified).toBe(false);
		const { r: r2 } = rt({ pull: async () => false });
		expect((await fetchFrontendBaseThroughTor(ctx, r2)).verified).toBe(false);
	});
});

describe('where it runs', () => {
	it('in the after-restart unit, after the tor-only egress heal sets Docker to pull through Tor, and last (nothing waits behind its 15 minutes)', () => {
		const n = afterRestartHealSteps().map(([name]) => name);
		expect(n.indexOf('the frontend base image fetch')).toBeGreaterThan(
			n.indexOf('the tor-only egress heal')
		);
		expect(n[n.length - 1]).toBe('the frontend base image fetch');
	});
	it('the background unit may run long enough for it (restarts 15 + web heal 10 + egress 4 + fetch 15 + rebuild 3 min)', () => {
		const src = readFileSync(
			join(import.meta.dirname, '..', 'src', 'lib', 'afterRestartHeal.ts'),
			'utf8'
		);
		const m = /const UNIT_MAX_S = (\d+) \* 60;/.exec(src);
		expect(Number(m?.[1])).toBeGreaterThanOrEqual(15 + 10 + 4 + 15 + 3 + 5);
	});
	it('never rebuilds the frontend while the background web heal runs; rebuilds once it is idle', async () => {
		const runtime = rt({ present: [false, true] }).r;
		let rebuilt = 0;
		await fetchFrontendBaseNow({
			runtime,
			waitIdle: async () => 'timed-out',
			rebuild: async () => {
				rebuilt++;
			}
		});
		expect(rebuilt).toBe(0);
		await fetchFrontendBaseNow({
			runtime: rt({ present: [false, true] }).r,
			waitIdle: async () => 'idle',
			rebuild: async () => {
				rebuilt++;
			}
		});
		expect(rebuilt).toBe(1);
	});
	it('says why a fetch failed: a quick failure is not "within 15 minutes"', async () => {
		const { r } = rt({ pull: async () => false });
		const res = await fetchFrontendBaseThroughTor(ctx, r);
		expect(res.detail).toMatch(/through Tor failed/);
		expect(res.detail).not.toMatch(/within 15 minutes/);
	});
});

describe("Docker's daemon.json proxies (they win over the daemon's environment)", () => {
	it('a proxy that is not Tor means Docker does not pull through Tor: never pull then', () => {
		expect(daemonJsonProxiesAllowTor(null)).toBe(true);
		expect(daemonJsonProxiesAllowTor('{"log-driver":"journald"}')).toBe(true);
		expect(
			daemonJsonProxiesAllowTor(
				'{"proxies":{"https-proxy":"socks5h://127.0.0.1:9050","http-proxy":"socks5h://127.0.0.1:9050"}}'
			)
		).toBe(true);
		expect(
			daemonJsonProxiesAllowTor('{"proxies":{"https-proxy":"http://proxy.example:3128"}}')
		).toBe(false);
		expect(daemonJsonProxiesAllowTor('{"proxies":{"http-proxy":"http://10.0.0.1:8080"}}')).toBe(
			false
		);
		expect(daemonJsonProxiesAllowTor('{not json')).toBe(false);
	});
});

describe('NO_PROXY that would send a pull around Tor', () => {
	it('"*" or an entry covering Docker Hub means no Tor pull', () => {
		expect(noProxyBypassesRegistry('')).toBe(false);
		expect(noProxyBypassesRegistry('localhost,127.0.0.1,.internal')).toBe(false);
		expect(noProxyBypassesRegistry('*')).toBe(true);
		expect(noProxyBypassesRegistry('localhost,.docker.io')).toBe(true);
		expect(noProxyBypassesRegistry('registry-1.docker.io')).toBe(true);
		expect(noProxyBypassesRegistry('production.cloudflare.docker.com')).toBe(true);
		expect(noProxyBypassesRegistry('docker.io:443')).toBe(true);
		expect(noProxyBypassesRegistry('registry-1.docker.io:443,localhost')).toBe(true);
		expect(noProxyBypassesRegistry('.docker.com:443')).toBe(true);
		expect(
			daemonJsonProxiesAllowTor(
				'{"proxies":{"https-proxy":"socks5h://127.0.0.1:9050","no-proxy":"*"}}'
			)
		).toBe(false);
	});
});
