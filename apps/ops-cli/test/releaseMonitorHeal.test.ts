/**
 * The release check is installed, turned on and seen working on every node.
 *
 * 2026-10-08, morphit.io: `systemctl list-unit-files 'morphit-release-monitor*'`
 * listed 0 unit files. The twice-a-day release check (an alert the Matrix bot
 * sends when a newer release is out) shipped in ops/systemd/ but nothing ever
 * installed it, so an operator who seldom opens `morphit-ops` was never told.
 *
 * These run the heal with the real unit installer (lib/installUnits.ts) against
 * a temporary systemd directory, systemctl and the first run replaced by
 * recorded stand-ins, and the real after-restart step list.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
	healReleaseMonitor,
	releaseMonitorRunVerdict,
	realReleaseMonitorRuntime,
	RELEASE_MONITOR_UNITS,
	type ReleaseMonitorRuntime
} from '../src/lib/releaseMonitorHeal.ts';
import { installAndEnableUnits, type UnitsExec } from '../src/lib/installUnits.ts';
import { afterRestartHealSteps } from '../src/commands/upgrade.ts';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const TEMPLATES = join(REPO, 'ops', 'systemd');

let systemdDir: string;
let calls: string[];
let lines: { info: string[]; warn: string[] };
const ctx = {
	info: (m: string) => void lines.info.push(m),
	warn: (m: string) => void lines.warn.push(m),
	spinner: (l: string) => {
		calls.push(`spinner: ${l}`);
		return () => void calls.push('spinner stopped');
	}
};

/** systemctl as a box would answer; `timer` is what is-enabled / is-active say. */
const systemctl =
	(timer: { enabled: string; active: string }): UnitsExec =>
	(cmd, args) => {
		calls.push(`${cmd} ${args.join(' ')}`);
		if (args[0] === 'is-enabled') return { status: 0, stdout: `${timer.enabled}\n` };
		if (args[0] === 'is-active') return { status: 0, stdout: `${timer.active}\n` };
		return { status: 0, stdout: '' };
	};

function runtime(
	runs: Array<{ ok: boolean; detail: string }>,
	timer = { enabled: 'enabled', active: 'active' }
): ReleaseMonitorRuntime {
	return {
		install: () =>
			installAndEnableUnits({
				templateDir: TEMPLATES,
				systemdDir,
				units: RELEASE_MONITOR_UNITS,
				timer: 'morphit-release-monitor.timer',
				exec: systemctl(timer)
			}),
		runOnce: () => {
			calls.push('run once');
			return runs.shift() ?? { ok: true, detail: '' };
		},
		sleep: async (ms) => void calls.push(`sleep ${ms}`)
	};
}

beforeEach(() => {
	systemdDir = mkdtempSync(join(tmpdir(), 'morphit-release-monitor-'));
	calls = [];
	lines = { info: [], warn: [] };
});
afterEach(() => {
	rmSync(systemdDir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

describe('the release check heal', () => {
	it('a node without it gets the unit and the timer, the timer turned on, and one run that worked', async () => {
		const r = await healReleaseMonitor(ctx, runtime([{ ok: true, detail: '' }]));
		for (const u of RELEASE_MONITOR_UNITS) {
			expect(readFileSync(join(systemdDir, u))).toEqual(readFileSync(join(TEMPLATES, u)));
		}
		expect(calls).toContain('systemctl daemon-reload');
		expect(calls).toContain('systemctl enable --now morphit-release-monitor.timer');
		expect(calls).toContain('run once');
		expect(r.verified).toBe(true);
		expect(r.strategy).toBe('installed');
		expect(r.detail).toMatch(/Release check: turned on .*ran once and succeeded/);
		// The run is under the spinner.
		expect(calls.indexOf('run once')).toBeGreaterThan(
			calls.findIndex((c) => c.startsWith('spinner: '))
		);
		expect(calls.lastIndexOf('spinner stopped')).toBeGreaterThan(calls.indexOf('run once'));
	});

	it('already in place and working: one of the routine checks, nothing written', async () => {
		for (const u of RELEASE_MONITOR_UNITS) {
			writeFileSync(join(systemdDir, u), readFileSync(join(TEMPLATES, u)));
		}
		const r = await healReleaseMonitor(ctx, runtime([{ ok: true, detail: '' }]));
		expect(r).toMatchObject({ strategy: 'already', verified: true, routine: true });
		expect(calls).not.toContain('systemctl daemon-reload');
		// Still run once: an installed check that no longer works is caught.
		expect(calls).toContain('run once');
	});

	it('an out-of-date unit from an older release is replaced', async () => {
		writeFileSync(
			join(systemdDir, 'morphit-release-monitor.service'),
			'[Service]\nUser=morphit-host-monitor\n'
		);
		await healReleaseMonitor(ctx, runtime([{ ok: true, detail: '' }]));
		expect(readFileSync(join(systemdDir, 'morphit-release-monitor.service'))).toEqual(
			readFileSync(join(TEMPLATES, 'morphit-release-monitor.service'))
		);
	});

	it('a timer systemd does not show as running is said, with the command for this server', async () => {
		const r = await healReleaseMonitor(
			ctx,
			runtime([{ ok: true, detail: '' }], { enabled: 'disabled', active: 'inactive' })
		);
		expect(r.verified).toBe(false);
		expect(r.detail).toMatch(/could not turn it on .*not enabled/);
		expect(r.detail).toMatch(
			/On this server: sudo systemctl enable --now morphit-release-monitor\.timer/
		);
		expect(calls).not.toContain('run once');
	});

	it('a first run that could not check is tried once more after a pause, then said with where to look', async () => {
		const r = await healReleaseMonitor(
			ctx,
			runtime([
				{ ok: false, detail: 'it could not check' },
				{ ok: false, detail: 'it could not check' }
			])
		);
		expect(calls.filter((c) => c === 'run once')).toHaveLength(2);
		expect(calls).toContain('sleep 20000');
		expect(r.verified).toBe(false);
		expect(r.detail).toMatch(/first run did not succeed \(it could not check\)/);
		expect(r.detail).toMatch(
			/On this server, to see why: journalctl -u morphit-release-monitor\.service/
		);
	});

	it('a second run that works is enough', async () => {
		const r = await healReleaseMonitor(
			ctx,
			runtime([
				{ ok: false, detail: 'x' },
				{ ok: true, detail: '' }
			])
		);
		expect(r.verified).toBe(true);
	});
});

describe('what a run logged', () => {
	const event = (e: string, ctxJson = '{}') =>
		`{"ts":"2026-10-08T16:00:00Z","level":"info","module":"release","event":"${e}","context":${ctxJson}}`;

	it('release_check_failed is a failed run, whatever the exit status said', () => {
		const v = releaseMonitorRunVerdict(
			event('release_check_failed', '{"exit_code":5,"hint":"could not reach a release source"}')
		);
		expect(v.ok).toBe(false);
		expect(v.detail).toMatch(/could not reach a release source/);
	});

	it('up to date (nothing logged) or a release found is a run that worked', () => {
		expect(releaseMonitorRunVerdict('').ok).toBe(true);
		expect(
			releaseMonitorRunVerdict(
				event('release_available', '{"current":"v1.21.1","latest":"v1.21.2"}')
			).ok
		).toBe(true);
	});
});

describe('one run, as systemd and the journal report it', () => {
	const box =
		(o: { start: number; show: string; journal: string }) =>
		(cmd: string, args: readonly string[]) => {
			if (cmd === 'systemctl' && args[0] === 'start') return { status: o.start, stdout: '' };
			if (cmd === 'systemctl' && args[0] === 'show') return { status: 0, stdout: o.show };
			if (cmd === 'journalctl' && args[0] === '--sync') return { status: 0, stdout: '' };
			if (cmd === 'journalctl') {
				expect(args).toContain('morphit-release-monitor.service');
				return { status: 0, stdout: o.journal };
			}
			return { status: 1, stdout: '' };
		};

	it('exit status 0 but "could not check" in its log is a failed run', async () => {
		const rt = realReleaseMonitorRuntime(
			REPO,
			box({
				start: 0,
				show: 'Result=success\nExecMainStatus=0\n',
				journal:
					'{"ts":"x","level":"info","module":"release","event":"release_check_failed","context":{"exit_code":5,"hint":"no source"}}\n'
			})
		);
		const r = await rt.runOnce();
		expect(r.ok, 'a run that could not check counted as working').toBe(false);
		expect(r.detail).toMatch(/no source/);
	});

	it('a run systemd marks failed is a failed run', async () => {
		const rt = realReleaseMonitorRuntime(
			REPO,
			box({ start: 1, show: 'Result=exit-code\nExecMainStatus=203\n', journal: '' })
		);
		expect(await rt.runOnce()).toMatchObject({ ok: false });
		expect((await rt.runOnce()).detail).toMatch(/exit-code.*203/);
	});

	it('a clean run with nothing logged (up to date) works', async () => {
		const rt = realReleaseMonitorRuntime(
			REPO,
			box({ start: 0, show: 'Result=success\nExecMainStatus=0\n', journal: '' })
		);
		expect((await rt.runOnce()).ok).toBe(true);
	});
});

describe('wiring', () => {
	it('the checks that run after the services restart install it on this server', async () => {
		const step = afterRestartHealSteps().find(([n]) => /release check/.test(n));
		expect(step, 'no release-check step after the restart').toBeDefined();
		vi.stubEnv('MORPHIT_INSTALL_DIR', REPO);
		vi.stubEnv('MORPHIT_SYSTEMD_DIR', systemdDir);
		vi.stubEnv('MORPHIT_HEAL_NO_SYSTEMD', '1');
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		vi.spyOn(console, 'log').mockImplementation(() => undefined);
		try {
			await step![1]();
		} finally {
			vi.restoreAllMocks();
		}
		for (const u of RELEASE_MONITOR_UNITS) expect(existsSync(join(systemdDir, u))).toBe(true);
	});
});
