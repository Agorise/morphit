/**
 * "List this instance?" → yes must end with the instance listed.
 *
 * 2026-10-12, a fresh VPS install: the operator answered yes, and the instance
 * never appeared on /instances. Two faults together:
 *   1. The wizard registered on the spot only if EVERY summary row was ✓. On a
 *      fresh VPS some rows are never ✓ at that moment (the PGP contact key and
 *      the canary are signed later on the operator's own computer; i2pd takes
 *      minutes), so it always took the "list later" path.
 *   2. "List later" only flipped MORPHIT_AUTO_REGISTER=yes in first-online.env.
 *      first-online had already done its other jobs during the install and
 *      switched its own timer off, so nothing ever read that switch again.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
	collectInstallSummary,
	readyToList,
	type SummaryProbe,
	type SummaryInputs
} from '../src/init/installSummary.ts';
import { armDeferredRegister, offerListing } from '../src/init/runAnsibleInstall.ts';

const inputs: SummaryInputs = {
	domain: 'vigilante.trading',
	mode: 'vps',
	torOnly: false,
	enableBunkerweb: true,
	repoPath: '/opt/morphit',
	relayAccount: 'vigil-relay'
};

/** A fresh VPS minutes after install: everything running and funded, but no
 *  PGP key or canary yet (signed later, off the server) and i2pd still building
 *  its tunnels. */
function freshVps(over: Partial<SummaryProbe> = {}): SummaryProbe {
	return {
		serviceActive: () => true,
		failedUnits: () => [],
		containerRunning: () => true,
		firewallActive: () => true,
		pathExists: (p) => !/pgp_keys\.asc|morphit-web\.dat|canary\.txt/.test(p),
		readText: (p) => (p.endsWith('/hostname') ? 'x'.repeat(56) + '.onion' : null),
		indexerHealth: async () => ({ reachable: true, synced: false, rpcOk: true, fxOk: true }),
		relayReachable: async () => true,
		relayBalanceBlurt: async () => 3014.669,
		systemHealth: () => ({ ok: true }),
		...over
	};
}

describe('ready to list on the federated directory', () => {
	it('a fresh VPS with no PGP key, canary or I2P tunnel yet is ready', async () => {
		const rows = await collectInstallSummary(inputs, freshVps());
		// The situation that blocked it: some rows really are ✗ here.
		expect(rows.some((r) => r.ok === false)).toBe(true);
		expect(readyToList(rows)).toBe(true);
	});

	it('not while the chain cannot be reached (the broadcast would hang)', async () => {
		const rows = await collectInstallSummary(
			inputs,
			freshVps({
				indexerHealth: async () => ({ reachable: true, synced: false, rpcOk: false, fxOk: null })
			})
		);
		expect(readyToList(rows)).toBe(false);
	});

	it('not with the relay unfunded', async () => {
		const rows = await collectInstallSummary(
			inputs,
			freshVps({ relayBalanceBlurt: async () => 5 })
		);
		expect(readyToList(rows)).toBe(false);
	});

	it('not with the relay, the indexer or the website down', async () => {
		for (const down of ['morphit-relay.service', 'morphit-indexer.service', 'postgresql']) {
			const rows = await collectInstallSummary(
				inputs,
				freshVps({ serviceActive: (u) => u !== down })
			);
			expect(readyToList(rows), down).toBe(false);
		}
		const noSite = await collectInstallSummary(inputs, freshVps({ containerRunning: () => false }));
		expect(readyToList(noSite)).toBe(false);
	});
});

describe('listing later', () => {
	function envFile(body: string): string {
		const p = join(mkdtempSync(join(tmpdir(), 'morphit-fo-')), 'first-online.env');
		writeFileSync(p, body);
		return p;
	}

	it('turns the switch on AND starts the background finisher again', () => {
		const p = envFile('MORPHIT_DOMAIN=vigilante.trading\nMORPHIT_AUTO_REGISTER=no\n');
		const ran: string[][] = [];
		const ok = armDeferredRegister(p, (args) => {
			ran.push(args);
			return 0;
		});
		expect(ok).toBe(true);
		expect(readFileSync(p, 'utf8')).toMatch(/^MORPHIT_AUTO_REGISTER=yes$/m);
		expect(readFileSync(p, 'utf8')).not.toMatch(/AUTO_REGISTER=no/);
		expect(ran).toContainEqual(['enable', '--now', 'morphit-first-online.timer']);
	});

	it('a registration marker left by an earlier install does not stop the new one', () => {
		const p = envFile('MORPHIT_AUTO_REGISTER=no\n');
		const marker = join(dirname(p), 'register.done');
		writeFileSync(marker, '');
		expect(armDeferredRegister(p, () => 0, marker)).toBe(true);
		expect(existsSync(marker)).toBe(false);
	});

	it('reports failure when the finisher cannot be started', () => {
		const p = envFile('MORPHIT_AUTO_REGISTER=no\n');
		expect(armDeferredRegister(p, () => 1)).toBe(false);
	});

	it('reports failure when there is no finisher on this box', () => {
		expect(armDeferredRegister('/nonexistent/first-online.env', () => 0)).toBe(false);
	});
});

describe('the listing step', () => {
	function run(o: {
		yes: boolean;
		ready: boolean;
		online: boolean;
		registerRc?: number;
		arms?: boolean;
	}) {
		const calls = { register: 0, arm: 0 };
		const out: string[] = [];
		return offerListing({
			askYesNo: async () => o.yes,
			ready: o.ready,
			online: o.online,
			register: () => {
				calls.register++;
				return o.registerRc ?? 0;
			},
			arm: () => {
				calls.arm++;
				return o.arms ?? true;
			},
			print: (s) => void out.push(s)
		}).then((r) => ({ r, calls, out: out.join('\n') }));
	}

	it('ready: registers now, and does not also leave a second registration queued', async () => {
		const { r, calls } = await run({ yes: true, ready: true, online: true });
		expect(calls).toEqual({ register: 1, arm: 0 });
		expect(r).toBe('registered');
	});

	it('ready but the registration fails: queues it for the background finisher', async () => {
		const { r, calls } = await run({ yes: true, ready: true, online: true, registerRc: 1 });
		expect(calls).toEqual({ register: 1, arm: 1 });
		expect(r).toBe('queued');
	});

	it('not ready, or offline: queues it, never tries now', async () => {
		for (const s of [
			{ ready: false, online: true },
			{ ready: false, online: false }
		]) {
			const { r, calls } = await run({ yes: true, ...s });
			expect(calls).toEqual({ register: 0, arm: 1 });
			expect(r).toBe('queued');
		}
	});

	it('when it cannot even be queued, gives the command to run by hand', async () => {
		const { r, out } = await run({ yes: true, ready: false, online: true, arms: false });
		expect(r).toBe('by-hand');
		expect(out).toContain('sudo morphit-ops register');
	});

	it('declining at register\u2019s own confirmation is not a listing, and queues nothing', async () => {
		const { REGISTER_DECLINED } = await import('../src/commands/register.ts');
		const { r, calls, out } = await run({
			yes: true,
			ready: true,
			online: true,
			registerRc: REGISTER_DECLINED
		});
		expect(r).toBe('declined');
		expect(calls).toEqual({ register: 1, arm: 0 });
		expect(out).toContain('sudo morphit-ops register');
	});

	it('no: does nothing', async () => {
		const { r, calls } = await run({ yes: false, ready: true, online: true });
		expect(calls).toEqual({ register: 0, arm: 0 });
		expect(r).toBe('declined');
	});
});

describe('the origin register uses', () => {
	it('is the configured origin, or a Tor-only node’s onion when the origin is empty', async () => {
		const { registerOrigin } = await import('../src/commands/register.ts');
		const onion = 'r'.repeat(56) + '.onion';
		expect(registerOrigin({ MORPHIT_INSTANCE_ORIGIN: 'https://vigilante.trading' })).toBe(
			'https://vigilante.trading'
		);
		expect(
			registerOrigin({ MORPHIT_INSTANCE_ORIGIN: '', MORPHIT_INSTANCE_TOR_ADDRESS: onion })
		).toBe(`http://${onion}`);
		expect(registerOrigin({ MORPHIT_INSTANCE_ORIGIN: '' })).toBeUndefined();
		expect(registerOrigin({ MORPHIT_INSTANCE_TOR_ADDRESS: 'not-an-onion' })).toBeUndefined();
	});
});
