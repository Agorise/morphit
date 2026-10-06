/**
 * The after-restart phase (lib/afterRestartHeal.ts): a background unit that
 * waits until the services have restarted on the new release, then runs the
 * heals that need them. Here: the waiting rule and the unit it starts.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	AFTER_RESTART_SUBCOMMAND,
	launchAfterRestartHeals,
	waitForRestarts,
	waitForUnitIdle
} from '../src/lib/afterRestartHeal.ts';

describe('waiting for the restarts', () => {
	it('waits until every running service became active after the start mark', async () => {
		let t = 0;
		const since: Record<string, number> = { a: 50, b: 50 };
		const r = await waitForRestarts(100, ['a', 'b'], {
			activeSince: (s) => since[s] ?? null,
			isActive: () => true,
			now: () => t,
			sleep: async (ms) => {
				t += ms;
				if (t >= 10_000) since.a = 150;
				if (t >= 20_000) since.b = 160;
			}
		});
		expect(r).toBe('restarted');
		expect(t).toBe(20_000);
	});

	it('does not wait for a service that is not running, and gives up after the limit', async () => {
		let t = 0;
		expect(
			await waitForRestarts(100, ['down'], {
				activeSince: () => 1,
				isActive: () => false,
				now: () => t,
				sleep: async () => {}
			})
		).toBe('restarted');
		expect(
			await waitForRestarts(100, ['stuck'], {
				activeSince: () => 1,
				isActive: () => true,
				now: () => t,
				sleep: async (ms) => void (t += ms),
				maxMs: 60_000
			})
		).toBe('timed-out');
	});
});

describe('the background unit', () => {
	it('is a transient systemd unit running the hidden subcommand with the start mark', () => {
		const calls: string[][] = [];
		const r = launchAfterRestartHeals({
			run: (cmd, args) => (calls.push([cmd, ...args]), { status: cmd === 'systemctl' ? 3 : 0 }),
			cliPath: '/opt/morphit/apps/ops-cli/dist/main.js',
			nodePath: '/usr/bin/node',
			sinceUs: 123456
		});
		expect(r).toBe('launched');
		const sr = calls.find((c) => c[0] === 'systemd-run')!;
		expect(sr.slice(-4)).toEqual([
			'/usr/bin/node',
			'/opt/morphit/apps/ops-cli/dist/main.js',
			AFTER_RESTART_SUBCOMMAND,
			'123456'
		]);
		expect(sr).toContain('--collect');
	});
});

describe('waiting for another background unit', () => {
	it('returns once the unit is no longer active, or after the limit', async () => {
		let t = 0;
		let checks = 0;
		expect(
			await waitForUnitIdle('u', {
				isActive: () => ++checks < 3,
				now: () => t,
				sleep: async (ms) => void (t += ms)
			})
		).toBe('idle');
		expect(checks).toBe(3);
		t = 0;
		expect(
			await waitForUnitIdle('u', {
				isActive: () => true,
				now: () => t,
				sleep: async (ms) => void (t += ms),
				maxMs: 60_000
			})
		).toBe('timed-out');
		expect(t).toBeGreaterThanOrEqual(60_000);
	});
	// v1.21.1 review: the log was emptied before systemd-run, so a launch
	// that failed still looked like this upgrade's run and the last lines said
	// the checks were "still running".
	it('a launch that fails leaves a log that does not look like this run', () => {
		const d = mkdtempSync(join(tmpdir(), 'after-restart-'));
		process.env.MORPHIT_AFTER_RESTART_LOG = join(d, 'log');
		try {
			const r = launchAfterRestartHeals({
				run: (cmd) => ({ status: cmd === 'systemctl' ? 3 : 1 }),
				cliPath: '/x/main.js',
				nodePath: '/usr/bin/node',
				sinceUs: 1
			});
			expect(r).toBe('unavailable');
			expect(statSync(join(d, 'log')).mtimeMs).toBeLessThan(Date.now() - 86_400_000);
			expect(readFileSync(join(d, 'log'), 'utf8')).toMatch(/could not be started/);
		} finally {
			delete process.env.MORPHIT_AFTER_RESTART_LOG;
			rmSync(d, { recursive: true, force: true });
		}
	});
});
