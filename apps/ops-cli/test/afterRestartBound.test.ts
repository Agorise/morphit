/**
 * The after-restart unit (morphit-after-upgrade-heal) runs under a systemd
 * time limit. It used to be a fixed 65 minutes whose test assumed the tor-only
 * egress heal takes 4 minutes, while that heal's own timeouts allow ~44; past
 * the limit systemd kills the unit in the middle of the frontend base fetch,
 * and its log never says "Done.".
 *
 * Now the limit is computed from the steps' own limits (one source each), the
 * egress heal's bound is checked against every path through it with each call
 * at its limit, and the fetch fits its pull into what the unit has left.
 */
import { TOR_BRIDGES_HEAL_MAX_MS } from '../src/lib/torBridgesHeal.ts';
import { describe, expect, it } from 'vitest';
import {
	AFTER_RESTART_WAIT_MS,
	AFTER_RESTART_ANSWER_MS,
	EARLY_HEALS_MAX_MS,
	UNIT_END_RESERVE_MS,
	WEB_HEAL_IDLE_MAX_MS,
	afterRestartDeadline,
	launchAfterRestartHeals,
	waitForUnitIdle
} from '../src/lib/afterRestartHeal.ts';
import { BASE_FETCH_TIMEOUT_MS } from '../src/lib/frontendBaseFetch.ts';
import {
	EGRESS_HEAL_MAX_MS,
	EGRESS_INSTALL_TIMEOUT_MS,
	EGRESS_SCRIPT_TIMEOUT_MS,
	EGRESS_SYSTEMCTL_TIMEOUT_MS,
	TOR_PROBE_TIMEOUT_MS,
	TOR_PROBE_TRIES,
	healTorOnlyEgress,
	type EgressRuntime
} from '../src/lib/torOnlyEgressHeal.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ctx = { info: () => {}, warn: () => {}, spinner: () => () => {} };

/** One path through the egress heal, every call taking its full limit. */
async function egressPath(bits: number): Promise<number> {
	let t = 0;
	const b = (i: number): boolean => ((bits >> i) & 1) === 1;
	const checked = new Set<string>();
	let torCalls = 0;
	const rt: EgressRuntime = {
		torOnly: () => true,
		torWorks: async () => {
			t += TOR_PROBE_TRIES * TOR_PROBE_TIMEOUT_MS;
			return torCalls++ === 0 ? true : b(0);
		},
		install: () => ((t += EGRESS_INSTALL_TIMEOUT_MS), true),
		script: (mode) => {
			t += EGRESS_SCRIPT_TIMEOUT_MS;
			const [what, step] = mode.split('-') as [string, string];
			const failsFirst: Record<string, number> = { units: 1, i2pd: 2, docker: 3, egress: 4 };
			if (step === 'apply') return what === 'egress' && b(5) ? 1 : 0;
			if (step === 'check') {
				if (checked.has(what) || !b(failsFirst[what] ?? 0)) return 0;
				checked.add(what);
				return 1;
			}
			return b(6) ? 1 : 0;
		},
		systemctl: () => ((t += EGRESS_SYSTEMCTL_TIMEOUT_MS), { ok: true, out: 'enabled' }),
		sleep: async (ms) => {
			t += ms;
		},
		matrixDecision: () => (b(7) ? 'kept-clearnet' : null)
	};
	await healTorOnlyEgress(ctx, { runtime: rt });
	return t;
}

describe('the after-restart unit is never killed in the middle of its work', () => {
	it("the egress heal's bound holds on every path with every call at its limit, and is that worst path", async () => {
		let worst = 0;
		for (let bits = 0; bits < 256; bits++) worst = Math.max(worst, await egressPath(bits));
		expect(worst).toBeLessThanOrEqual(EGRESS_HEAL_MAX_MS);
		expect(EGRESS_HEAL_MAX_MS - worst).toBeLessThan(60_000);
		// far more than the 4 minutes the old limit assumed
		expect(worst).toBeGreaterThan(30 * 60_000);
	});

	it("the web heal's idle wait is the one the bound counts", async () => {
		let now = 0;
		const r = await waitForUnitIdle('x', {
			isActive: () => true,
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			}
		});
		expect(r).toBe('timed-out');
		expect(now).toBeGreaterThanOrEqual(WEB_HEAL_IDLE_MAX_MS);
		expect(now).toBeLessThan(WEB_HEAL_IDLE_MAX_MS + 15_000);
	});

	it('the unit is started with a limit that covers every step at its own limit', () => {
		const dir = mkdtempSync(join(tmpdir(), 'after-bound-'));
		const prev = process.env.MORPHIT_AFTER_RESTART_LOG;
		process.env.MORPHIT_AFTER_RESTART_LOG = join(dir, 'log');
		const seen: string[][] = [];
		try {
			const r = launchAfterRestartHeals({
				cliPath: '/opt/morphit/apps/ops-cli/dist/main.js',
				sinceUs: 1,
				run: (cmd, args) => {
					if (cmd === 'systemd-run') seen.push(args);
					return { status: cmd === 'systemctl' ? 3 : 0, stdout: '' };
				}
			});
			expect(r).toBe('launched');
		} finally {
			if (prev === undefined) delete process.env.MORPHIT_AFTER_RESTART_LOG;
			else process.env.MORPHIT_AFTER_RESTART_LOG = prev;
			rmSync(dir, { recursive: true, force: true });
		}
		const max = Number(
			/^--property=RuntimeMaxSec=(\d+)$/
				.exec(seen[0]!.find((a) => a.startsWith('--property=RuntimeMaxSec=')) ?? '')
				?.at(1)
		);
		const steps =
			AFTER_RESTART_WAIT_MS +
			AFTER_RESTART_ANSWER_MS +
			EARLY_HEALS_MAX_MS +
			TOR_BRIDGES_HEAL_MAX_MS +
			WEB_HEAL_IDLE_MAX_MS +
			EGRESS_HEAL_MAX_MS +
			BASE_FETCH_TIMEOUT_MS +
			WEB_HEAL_IDLE_MAX_MS +
			UNIT_END_RESERVE_MS;
		expect(max * 1000).toBeGreaterThanOrEqual(steps);
	});

	it('the deadline the fetch fits into is the unit start plus that limit', () => {
		const start = 1_000_000;
		const d = afterRestartDeadline(start + 90_000, 90);
		expect(d - start).toBeGreaterThanOrEqual(
			AFTER_RESTART_WAIT_MS + WEB_HEAL_IDLE_MAX_MS * 2 + EGRESS_HEAL_MAX_MS + BASE_FETCH_TIMEOUT_MS
		);
	});
});
