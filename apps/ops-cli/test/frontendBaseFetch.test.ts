/**
 * A hidden-only node brings the frontend's pinned nginx base onto the box in
 * the after-restart unit, right after the tor-only egress heal sets Docker to
 * pull through Tor: from the offline bundle when it carries it (proven to be
 * the pinned image), else through Tor with the time Tor needs.
 *
 * Before: only the web heal's rebuild could fetch it, with about 40 seconds.
 * On morphitlat (2026-10-05) the pull through Tor did not fit, and
 * `upgrade --heals` kept reporting the older base with a manual command.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	BASE_FETCH_MIN_MS,
	BASE_FETCH_TIMEOUT_MS,
	fetchFrontendBaseThroughTor,
	realBaseFetchRuntime,
	termSafe,
	type BaseFetchRuntime,
	type PullResult
} from '../src/lib/frontendBaseFetch.ts';
import { afterRestartHealSteps, fetchFrontendBaseNow } from '../src/commands/upgrade.ts';
import {
	FRONTEND_BASE,
	daemonJsonProxiesAllowTor,
	noProxyBypassesRegistry
} from '../src/lib/proxyConfigHeal.ts';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOR = '127.0.0.1:9050';
const ctx = { info: () => {}, warn: () => {}, spinner: () => () => {} };
const OK: PullResult = { ok: true, timedOut: false, output: '' };

function rt(o: Partial<BaseFetchRuntime> & { present?: boolean[] } = {}) {
	const calls: number[] = [];
	const present = o.present ?? [false];
	let i = 0;
	const r: BaseFetchRuntime = {
		hiddenOnly: () => true,
		docker: () => 'up',
		frontend: () => 'morphit-frontend',
		frontendBase: () => 'nginx:alpine-older',
		basePresent: () => present[Math.min(i++, present.length - 1)]!,
		loadBundled: () => false,
		dockerPullsThroughTor: () => true,
		pull: async (t) => {
			calls.push(t);
			return OK;
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

	it('never pulls unless all of it holds: hidden-only, a frontend not on the pinned base, no image here or in the bundle, Docker through Tor', async () => {
		for (const o of [
			{ hiddenOnly: () => false },
			{ frontend: () => null },
			{ present: [true] },
			{ loadBundled: () => true },
			{ dockerPullsThroughTor: () => false }
		] as Array<Partial<BaseFetchRuntime> & { present?: boolean[] }>) {
			const { r, calls } = rt(o);
			const res = await fetchFrontendBaseThroughTor(ctx, r);
			expect(calls, JSON.stringify(Object.keys(o))).toEqual([]);
			expect(res.verified).toBe(true);
		}
	});

	it('a frontend already built on the pinned base fetches nothing, even when the base image itself was pruned (docker image prune -a)', async () => {
		const { r, calls } = rt({ frontendBase: () => FRONTEND_BASE, present: [false] });
		const res = await fetchFrontendBaseThroughTor(ctx, r);
		expect(calls).toEqual([]);
		expect(res.strategy).toBe('already');
		expect(res.verified).toBe(true);
	});

	it('the offline bundle comes first: loaded and proven, nothing pulled', async () => {
		let loads = 0;
		const { r, calls } = rt({
			loadBundled: () => (loads++, true)
		});
		const res = await fetchFrontendBaseThroughTor(ctx, r);
		expect(loads).toBe(1);
		expect(calls).toEqual([]);
		expect(res.strategy).toBe('loaded');
		expect(res.verified).toBe(true);
	});

	it('Docker not answering is said, with the command — never "nothing to change"', async () => {
		const { r, calls } = rt({ docker: () => 'down', frontend: () => null });
		const res = await fetchFrontendBaseThroughTor(ctx, r);
		expect(calls).toEqual([]);
		expect(res.verified).toBe(false);
		expect(res.routine).not.toBe(true);
		expect(res.detail).toMatch(/Docker is not answering/);
		expect(res.detail).toMatch(/sudo systemctl status docker/);
		// No Docker at all: no frontend to move, counted quietly.
		const none = await fetchFrontendBaseThroughTor(ctx, rt({ docker: () => 'missing' }).r);
		expect(none.verified).toBe(true);
	});

	it('a pull that ends without the image on the box is a warning, never a success', async () => {
		const { r } = rt({ present: [false, false] });
		const res = await fetchFrontendBaseThroughTor(ctx, r);
		expect(res.strategy).toBe('failed');
		expect(res.verified).toBe(false);
		const { r: r2 } = rt({ pull: async () => ({ ok: false, timedOut: false, output: '' }) });
		expect((await fetchFrontendBaseThroughTor(ctx, r2)).verified).toBe(false);
	});

	it('a failed pull shows what Docker said (429, manifest unknown, disk full …), fit for a terminal', async () => {
		const { r } = rt({
			pull: async () => ({
				ok: false,
				timedOut: false,
				output:
					'Error response from daemon: \u001b[31mtoomanyrequests\u001b[0m: You have reached your pull rate limit.\r\n\u001b]0;evil\u0007\u202e'
			})
		});
		const res = await fetchFrontendBaseThroughTor(ctx, r);
		expect(res.detail).toMatch(/through Tor failed/);
		expect(res.detail).toMatch(
			/Docker said: Error response from daemon: toomanyrequests: You have reached your pull rate limit\./
		);
		// eslint-disable-next-line no-control-regex
		expect(res.detail).not.toMatch(/[\u0000-\u001f\u007f\u202e]/);
		expect(res.detail).not.toMatch(/evil/);
	});

	it('says why a fetch failed: a quick failure is not "within 15 minutes", a stopped one is', async () => {
		const quick = await fetchFrontendBaseThroughTor(
			ctx,
			rt({ pull: async () => ({ ok: false, timedOut: false, output: 'manifest unknown' }) }).r
		);
		expect(quick.detail).toMatch(/through Tor failed/);
		expect(quick.detail).not.toMatch(/within/);
		const slow = await fetchFrontendBaseThroughTor(
			ctx,
			rt({ pull: async () => ({ ok: false, timedOut: true, output: '' }) }).r
		);
		expect(slow.detail).toMatch(/through Tor within 15 minutes/);
		expect(slow.verified).toBe(false);
	});

	it('the pull time is worked out when the pull starts, after the checks and the bundle load', async () => {
		const order: string[] = [];
		const { r } = rt({
			present: [false, true],
			loadBundled: () => (order.push('load'), false),
			pull: async (t) => (order.push(`pull ${t}`), OK)
		});
		await fetchFrontendBaseThroughTor(ctx, r, () => (order.push('budget'), 300_000));
		expect(order).toEqual(['load', 'budget', 'pull 300000']);
	});

	it('with less time left than a pull needs, no pull is started, and that is said', async () => {
		const { r, calls } = rt();
		const res = await fetchFrontendBaseThroughTor(ctx, r, BASE_FETCH_MIN_MS - 1);
		expect(calls).toEqual([]);
		expect(res.verified).toBe(false);
		expect(res.detail).toMatch(/sudo morphit-ops upgrade --heals/);
	});
});

describe('termSafe', () => {
	it('one line, no escapes or controls, the end kept when long', () => {
		expect(termSafe('a\u001b[2Kb\nc\td')).toBe('ab c d');
		expect(termSafe('x'.repeat(500) + 'END', 50)).toMatch(/^….*END$/);
		expect(termSafe('x'.repeat(500), 50).length).toBe(50);
	});
});

/** A `docker` on PATH that records its arguments and plays one part. */
function fakeDocker(dir: string, script: string): string {
	const bin = join(dir, 'bin');
	writeFileSync(join(dir, 'argv'), '');
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		join(bin, 'docker'),
		`#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(join(dir, 'argv'))}\n${script}\n`
	);
	chmodSync(join(bin, 'docker'), 0o755);
	return bin;
}

describe('the real runtime (a recording `docker` on PATH)', () => {
	let dir: string;
	let path0: string | undefined;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'base-fetch-'));
		path0 = process.env.PATH;
	});
	afterEach(() => {
		process.env.PATH = path0;
		rmSync(dir, { recursive: true, force: true });
	});
	const real = () =>
		realBaseFetchRuntime({ frontend: () => 'fe', buildDir: join(dir, 'install/apps/web/build') });

	it('pulls the pinned reference WITH its digest, and checks for it by that reference without pulling', async () => {
		process.env.PATH = `${fakeDocker(dir, 'exit 0')}:${path0}`;
		const r = real();
		expect(await r.pull(10_000)).toEqual({ ok: true, timedOut: false, output: '' });
		expect(r.basePresent()).toBe(true);
		const argv = readFileSync(join(dir, 'argv'), 'utf8').trim().split('\n');
		expect(argv[0]).toBe(`pull --quiet ${FRONTEND_BASE}`);
		expect(FRONTEND_BASE).toMatch(/@sha256:[0-9a-f]{64}$/);
		expect(argv).toContain(`image inspect --format {{.Id}} ${FRONTEND_BASE}`);
		expect(
			argv.some(
				(l) => /^create --pull never --network none .* /.test(l) && l.includes(FRONTEND_BASE)
			)
		).toBe(true);
		expect(argv.some((l) => /^pull/.test(l) && !l.includes('@sha256:'))).toBe(false);
	});

	it('a pull past its time is killed (SIGKILL), and reported as timed out', async () => {
		process.env.PATH = `${fakeDocker(dir, `echo $$ > ${JSON.stringify(join(dir, 'pid'))}; exec sleep 8`)}:${path0}`;
		const t0 = Date.now();
		const res = await real().pull(1500);
		expect(Date.now() - t0).toBeLessThan(5000);
		expect(res.ok).toBe(false);
		expect(res.timedOut).toBe(true);
		const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
		expect(() => process.kill(pid, 0)).toThrow();
	}, 20_000);

	it("a failing pull's own words come back (both streams, the end of them)", async () => {
		process.env.PATH = `${fakeDocker(dir, "echo 'Error response from daemon: manifest unknown' >&2; exit 1")}:${path0}`;
		const res = await real().pull(10_000);
		expect(res.ok).toBe(false);
		expect(res.timedOut).toBe(false);
		expect(res.output).toMatch(/manifest unknown/);
	});

	it('the running frontend is judged by its pinned-base label', () => {
		process.env.PATH = `${fakeDocker(dir, `echo '${FRONTEND_BASE}'`)}:${path0}`;
		expect(real().frontendBase('fe')).toBe(FRONTEND_BASE);
		const argv = readFileSync(join(dir, 'argv'), 'utf8');
		expect(argv).toMatch(
			/inspect --format \{\{index \.Config\.Labels "org\.morphit\.frontend-base"\}\} fe/
		);
	});

	it('nothing is loaded without an offline bundle', () => {
		process.env.PATH = `${fakeDocker(dir, 'exit 0')}:${path0}`;
		expect(real().loadBundled()).toBe(false);
		expect(readFileSync(join(dir, 'argv'), 'utf8')).not.toMatch(/load/);
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

	it('rebuilds the frontend when the base was fetched, loaded from the bundle, or already here — never while the background web heal runs', async () => {
		for (const [o, want] of [
			[{ present: [false, true] }, 1],
			[{ loadBundled: () => true }, 1],
			[{ present: [true] }, 1],
			[{ frontendBase: () => FRONTEND_BASE }, 0],
			[{ dockerPullsThroughTor: () => false }, 0]
		] as Array<[Partial<BaseFetchRuntime> & { present?: boolean[] }, number]>) {
			let rebuilt = 0;
			await fetchFrontendBaseNow({
				runtime: rt(o).r,
				waitIdle: async () => 'idle',
				deadline: Date.now() + 60 * 60_000,
				rebuild: async () => {
					rebuilt++;
				}
			});
			expect(rebuilt, JSON.stringify(Object.keys(o))).toBe(want);
		}
		let rebuilt = 0;
		await fetchFrontendBaseNow({
			runtime: rt({ present: [false, true] }).r,
			waitIdle: async () => 'timed-out',
			deadline: Date.now() + 60 * 60_000,
			rebuild: async () => {
				rebuilt++;
			}
		});
		expect(rebuilt).toBe(0);
	});

	it('the pull gets what the unit has left (at most 15 minutes), keeping time for the rebuild after it', async () => {
		const seen: number[] = [];
		const pull = async (t: number) => (seen.push(t), OK);
		await fetchFrontendBaseNow({
			runtime: rt({ present: [false, true], pull }).r,
			waitIdle: async () => 'idle',
			rebuild: async () => {},
			deadline: Date.now() + 2 * 60 * 60_000
		});
		expect(seen).toEqual([BASE_FETCH_TIMEOUT_MS]);
		seen.length = 0;
		const writes: string[] = [];
		const spy = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation((c: unknown) => (writes.push(String(c)), true));
		try {
			await fetchFrontendBaseNow({
				runtime: rt({ present: [false, true], pull }).r,
				waitIdle: async () => 'idle',
				rebuild: async () => {},
				deadline: Date.now() + 11 * 60_000
			});
		} finally {
			spy.mockRestore();
		}
		expect(seen).toEqual([]);
		expect(writes.join('')).toMatch(/no time left/);
	});

	it('Docker not answering reaches the operator as a warning, not as a check that found nothing', async () => {
		const { printRoutineSummary } = await import('../src/commands/upgrade.ts');
		// earlier tests' routine checks, counted in this module: printed now
		const so0 = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		printRoutineSummary();
		so0.mockRestore();
		const out: string[] = [];
		const so = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation((c: unknown) => (out.push(`OUT ${String(c)}`), true));
		const se = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation((c: unknown) => (out.push(`ERR ${String(c)}`), true));
		try {
			await fetchFrontendBaseNow({
				runtime: rt({ docker: () => 'down', frontend: () => null }).r,
				waitIdle: async () => 'idle',
				rebuild: async () => {},
				deadline: Date.now() + 60 * 60_000
			});
			printRoutineSummary();
		} finally {
			so.mockRestore();
			se.mockRestore();
		}
		expect(out.join('')).toMatch(/ERR .*Docker is not answering/);
		expect(out.join('')).not.toMatch(/found nothing to change/);
	});
});

describe("Docker's daemon.json proxies (they win over the daemon's environment)", () => {
	it('a proxy that is not Tor means Docker does not pull through Tor: never pull then', () => {
		expect(daemonJsonProxiesAllowTor(null, TOR)).toBe(true);
		expect(daemonJsonProxiesAllowTor('{"log-driver":"journald"}', TOR)).toBe(true);
		expect(
			daemonJsonProxiesAllowTor(
				'{"proxies":{"https-proxy":"socks5h://127.0.0.1:9050","http-proxy":"socks5h://127.0.0.1:9050"}}',
				TOR
			)
		).toBe(true);
		expect(
			daemonJsonProxiesAllowTor('{"proxies":{"https-proxy":"http://proxy.example:3128"}}', TOR)
		).toBe(false);
		expect(
			daemonJsonProxiesAllowTor('{"proxies":{"http-proxy":"http://10.0.0.1:8080"}}', TOR)
		).toBe(false);
		expect(daemonJsonProxiesAllowTor('{not json', TOR)).toBe(false);
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
				'{"proxies":{"https-proxy":"socks5h://127.0.0.1:9050","no-proxy":"*"}}',
				TOR
			)
		).toBe(false);
	});
});

it('the fake docker leaves nothing behind', () => {
	expect(existsSync(join(tmpdir(), 'argv'))).toBe(false);
});
