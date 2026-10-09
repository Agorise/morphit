/**
 * The installed-box heals of the run in the upgrade's
 * self-heal phase, in the order they need, and their result reaches the
 * operator: info when the heal observed its end state, warn when not.
 * (The heals' own behaviour is tested next to them; here, only the wiring.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const results: Record<string, { strategy: string; verified: boolean; detail: string }> = {};
vi.mock('../src/lib/unitPrivilegeHeal.ts', async (orig) => ({
	...((await orig()) as object),
	heal: async () => results.priv
}));
vi.mock('../src/lib/sysctlForwardHeal.ts', async (orig) => ({
	...((await orig()) as object),
	heal: async () => results.fwd
}));
let tlsCalls = 0;
vi.mock('../src/lib/tlsRenewHeal.ts', async (orig) => ({
	...((await orig()) as object),
	heal: async () => {
		tlsCalls++;
		return results.tls;
	}
}));

const called: string[] = [];
for (const [mod, name] of [
	['../src/lib/bridgeCidrHeal.ts', 'bridge'],
	['../src/lib/nginxVhostHeal.ts', 'nginx'],
	['../src/lib/hiddenRpcEnvHeal.ts', 'hiddenRpc'],
	['../src/lib/relayHealthEnvHeal.ts', 'relayHealth'],
	['../src/lib/pgRoleHeal.ts', 'pgRole'],
	['../src/lib/indexerEnvShadowHeal.ts', 'shadow'],
	['../src/lib/torPowHeal.ts', 'pow'],
	['../src/lib/etcPermHeal.ts', 'etcPerm'],
	['../src/lib/mailRelayHeal.ts', 'mail'],
	['../src/lib/vapidHeal.ts', 'vapid'],
	['../src/lib/logLevelHeal.ts', 'logLevel'],
	['../src/lib/torOnlyEgressHeal.ts', 'egress'],
	['../src/lib/torBridgesHeal.ts', 'torBridges'],
	['../src/lib/osQuietHeal.ts', 'quiet'],
	['../src/lib/bunkerwebJobsHeal.ts', 'jobs'],
	['../src/lib/indexerMemoryHeal.ts', 'memory']
] as const) {
	vi.doMock(mod, async () => ({
		...((await vi.importActual(mod)) as object),
		heal: async () => (
			called.push(name),
			{ strategy: 'applied', verified: true, detail: `${name.toUpperCase()}-DETAIL` }
		)
	}));
}
vi.doMock('../src/lib/releaseMonitorHeal.ts', async () => ({
	...((await vi.importActual('../src/lib/releaseMonitorHeal.ts')) as object),
	healReleaseMonitor: async () => (
		called.push('releaseMonitor'),
		{ strategy: 'installed', verified: true, detail: 'RELEASEMONITOR-DETAIL' }
	)
}));
vi.doMock('../src/lib/proxyConfigHeal.ts', async () => ({
	...((await vi.importActual('../src/lib/proxyConfigHeal.ts')) as object),
	healProxyConfig: async () => (called.push('proxy'), { kind: 'already' })
}));
vi.doMock('../src/lib/webHeal.ts', async () => ({
	...((await vi.importActual('../src/lib/webHeal.ts')) as object),
	writeWebHealState: () => undefined
}));
const upgrade = await import('../src/commands/upgrade.ts');
const { selfHealSteps } = upgrade;

let out = '';
let err = '';
beforeEach(() => {
	out = '';
	err = '';
	vi.restoreAllMocks();
	vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => ((out += String(c)), true));
	vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => ((err += String(c)), true));
});

const names = (): string[] => selfHealSteps().map(([n]) => n);

describe('heal wiring in the self-heal phase', () => {
	it('the service-user heal runs early: after the helper refresh and the tor-only OS heal, before the network heals', () => {
		const n = names();
		expect(n.indexOf('the service-user heal')).toBe(n.indexOf('the tor-only OS heal') + 1);
		expect(n.indexOf('the helper-script refresh')).toBeLessThan(n.indexOf('the service-user heal'));
		expect(n.indexOf('the service-user heal')).toBeLessThan(n.indexOf('the IPFS privacy heal'));
	});

	it('the IPv4 forwarding heal runs before the web-proxy heals', () => {
		const n = names();
		expect(n).toContain('the IPv4 forwarding heal');
		expect(n.indexOf('the IPv4 forwarding heal')).toBeLessThan(n.indexOf('the web-proxy heals'));
	});

	it('a heal’s detail is printed, as a warning only when it could not verify', async () => {
		results.priv = { strategy: 'applied', verified: true, detail: 'PRIV-DETAIL-OK' };
		results.fwd = { strategy: 'left-alone', verified: false, detail: 'FWD-DETAIL-UNVERIFIED' };
		const steps = selfHealSteps();
		await steps.find(([n]) => n === 'the service-user heal')![1]();
		await steps.find(([n]) => n === 'the IPv4 forwarding heal')![1]();
		// info goes to stdout, a warning to stderr (render/term.ts).
		expect(out).toMatch(/PRIV-DETAIL-OK/);
		expect(err).not.toMatch(/PRIV-DETAIL-OK/);
		expect(err).toMatch(/FWD-DETAIL-UNVERIFIED/);
	});

	it('the TLS renewal heal runs after the frontend config heal and before the web-proxy heals', () => {
		const n = names();
		expect(n.indexOf('the TLS renewal heal')).toBe(n.indexOf('the frontend config heal') + 1);
		expect(n.indexOf('the TLS renewal heal')).toBeLessThan(n.indexOf('the web-proxy heals'));
	});

	it('the TLS renewal heal reports its detail, and never runs on a hidden-only node', async () => {
		const run = (upgrade as { healTlsRenewalUnlessHidden?: (h?: () => boolean) => Promise<void> })
			.healTlsRenewalUnlessHidden;
		expect(run, 'no TLS renewal heal is wired').toBeTypeOf('function');
		results.tls = { strategy: 'webroot', verified: true, detail: 'TLS-DETAIL-OK' };
		tlsCalls = 0;
		await run!(() => true);
		expect(tlsCalls, 'asked Let’s Encrypt from a hidden-only node').toBe(0);
		await run!(() => false);
		expect(tlsCalls).toBe(1);
		expect(out).toMatch(/TLS-DETAIL-OK/);
	});

	it('the proxy-bridge and nginx vhost heals run in the self-heal phase, after the frontend config heal', () => {
		const n = names();
		expect(n.indexOf('the proxy-bridge heal')).toBeGreaterThan(
			n.indexOf('the frontend config heal')
		);
		expect(n.indexOf('the nginx vhost heal')).toBeGreaterThan(
			n.indexOf('the frontend config heal')
		);
	});

	it('the heals that need the restarted services run in the after-restart phase, started before any question', async () => {
		const n = names();
		// The web-proxy result is the last step that works; the two after it only print.
		expect(n.slice(-3)).toEqual([
			'the web-proxy result',
			'the routine checks summary',
			'the questions left for later'
		]);
		// Started after every heal that restarts the indexer or the relay itself
		// (the unit waits for the restarts that come after its start)…
		for (const s of ['the service-user heal', 'the proxy-bridge heal', 'the stopped-relay heal'])
			expect(n.indexOf(s), s).toBeLessThan(n.indexOf('the after-restart heals'));
		// …and before every step that has a question for the operator: a child
		// stopped at 300 s while one is pending still has the unit running.
		for (const s of ['the relay log notice', 'the Matrix bot tor-only heal'])
			expect(n.indexOf(s), s).toBeGreaterThan(n.indexOf('the after-restart heals'));
		const after = (
			upgrade as { afterRestartHealSteps?: () => Array<[string, () => Promise<void>]> }
		).afterRestartHealSteps;
		expect(after, 'no after-restart phase').toBeTypeOf('function');
		called.length = 0;
		for (const [, step] of after!()) await step();
		expect(called).toEqual([
			'hiddenRpc',
			'relayHealth',
			'pgRole',
			'shadow',
			'vapid',
			'logLevel',
			'releaseMonitor',
			// 2026-10-09 (lib/torBridgesHeal.ts): a network that filters plain Tor
			// gets bridges, before the tor-only egress heal (which relies on Tor).
			'torBridges',
			'egress'
		]);
		expect(out).toMatch(
			/HIDDENRPC-DETAIL[\s\S]*SHADOW-DETAIL[\s\S]*VAPID-DETAIL[\s\S]*LOGLEVEL-DETAIL[\s\S]*RELEASEMONITOR-DETAIL[\s\S]*TORBRIDGES-DETAIL[\s\S]*EGRESS-DETAIL/
		);
	});

	it('the onion PoW, /etc/morphit permission and alert mail heals run in the self-heal phase, PoW after the tor-only OS heal', async () => {
		const n = names();
		for (const s of [
			'the onion PoW heal',
			'the /etc/morphit permission heal',
			'the alert mail heal'
		])
			expect(n, s).toContain(s);
		expect(n.indexOf('the onion PoW heal')).toBeGreaterThan(n.indexOf('the tor-only OS heal'));
		expect(n.indexOf('the onion PoW heal')).toBeLessThan(n.indexOf('the after-restart heals'));
		called.length = 0;
		const steps = selfHealSteps();
		for (const s of [
			'the onion PoW heal',
			'the /etc/morphit permission heal',
			'the alert mail heal'
		])
			await steps.find(([x]) => x === s)![1]();
		expect(called).toEqual(['pow', 'etcPerm', 'mail']);
		expect(out).toMatch(/POW-DETAIL[\s\S]*ETCPERM-DETAIL[\s\S]*MAIL-DETAIL/);
	});

	it('the empty fee-address line heal runs before the restarts, and its check after them', () => {
		const n = names();
		expect(n).toContain('the empty fee-address line heal');
		expect(n.indexOf('the empty fee-address line heal')).toBeLessThan(
			n.indexOf('the after-restart heals')
		);
		const after = (
			upgrade as { afterRestartHealSteps: () => Array<[string, unknown]> }
		).afterRestartHealSteps();
		expect(after.map(([x]) => x)).toContain('the fee address check');
	});

	it('the indexer memory cap heal runs in the self-heal phase (after the unit refresh, which precedes the phase), and so in `upgrade --heals` and an up-to-date upgrade', async () => {
		const n = names();
		expect(n).toContain('the indexer memory cap heal');
		expect(n.indexOf('the indexer memory cap heal')).toBeGreaterThan(
			n.indexOf('the service-user heal')
		);
		expect(n.indexOf('the indexer memory cap heal')).toBeLessThan(
			n.indexOf('the after-restart heals')
		);
		called.length = 0;
		await selfHealSteps().find(([x]) => x === 'the indexer memory cap heal')![1]();
		expect(called).toEqual(['memory']);
		expect(out).toMatch(/MEMORY-DETAIL/);
	});

	// 2026-10-08: the upgrade no longer asks about plain-text database backups
	// (the database holds nothing sensitive); it named that question after
	// every upgrade until answered.
	it('no heal and no question is about the database backups', () => {
		const all = [
			...names(),
			...(upgrade as { afterRestartHealSteps: () => Array<[string, unknown]> })
				.afterRestartHealSteps()
				.map(([x]) => x)
		];
		expect(all.filter((x) => /backup/i.test(x))).toEqual([]);
	});

	it('the tor-only egress heal waits for the background web-proxy heal (it may restart Docker), and runs after it', async () => {
		const run = (
			upgrade as {
				healTorOnlyEgressAfterWebHeal?: (d: {
					waitIdle: (unit: string) => Promise<'idle' | 'timed-out'>;
				}) => Promise<void>;
			}
		).healTorOnlyEgressAfterWebHeal;
		expect(run, 'no egress step').toBeTypeOf('function');
		const waited: string[] = [];
		called.length = 0;
		await run!({ waitIdle: async (u) => (waited.push(u), 'timed-out') });
		expect(waited).toEqual(['morphit-web-heal']);
		expect(called, 'restarted Docker under a running web-proxy heal').toEqual([]);
		expect(err).toMatch(/next upgrade/);
		await run!({ waitIdle: async () => 'idle' });
		expect(called).toEqual(['egress']);
	});

	it('the quiet-OS heal runs in the self-heal phase on every node', async () => {
		const n = names();
		expect(n).toContain('the quiet OS heal');
		called.length = 0;
		await selfHealSteps().find(([x]) => x === 'the quiet OS heal')![1]();
		expect(called).toEqual(['quiet']);
		expect(out).toMatch(/QUIET-DETAIL/);
	});

	it('the BunkerWeb jobs heal runs right after the proxy-config heal, in the (background) web-proxy job', async () => {
		called.length = 0;
		await upgrade.runWebProxyHealsNow({ background: true });
		expect(called).toEqual(['proxy', 'jobs']);
		expect(out).toMatch(/JOBS-DETAIL/);
	});
});

describe('the after-restart run', () => {
	it('runs its checks only once the restarted services answer, and names one that never did', async () => {
		const events: string[] = [];
		const run = (
			upgrade as {
				runAfterRestartHeals: (
					sinceUs: number,
					deps: {
						waitRestarts: () => Promise<'restarted' | 'timed-out'>;
						waitAnswers: (s: readonly string[]) => Promise<string[]>;
						steps: () => Array<[string, () => Promise<void>]>;
					}
				) => Promise<void>;
			}
		).runAfterRestartHeals;
		await run(0, {
			waitRestarts: async () => (events.push('restarted'), 'restarted'),
			waitAnswers: async (s) => (
				events.push(`answers: ${s.join(', ')}`),
				['morphit-relay.service']
			),
			steps: () => [['a check', async () => void events.push('check')]]
		});
		expect(events).toEqual([
			'restarted',
			'answers: morphit-indexer.service, morphit-relay.service',
			'check'
		]);
		expect(err).toMatch(/morphit-relay\.service did not answer on its health address/);
	});
});
