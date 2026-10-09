/**
 * Installed-box heal: the release check runs on every node.
 *
 * WHY. `morphit-release-monitor` (twice a day: is a newer release out? → an
 * alert the Matrix bot sends to the operator) shipped in ops/systemd/ from
 * v1.9, but nothing ever installed it: no Ansible role, no upgrade step, and
 * refreshUnits.ts only refreshes units that are already there. docs/UPGRADING.md
 * said so ("Nothing installs it for you"). So an operator who seldom opens
 * `morphit-ops` was never told a release was out (2026-10-08, morphit.io:
 * `systemctl list-unit-files 'morphit-release-monitor*'` listed 0 unit files).
 *
 * WHAT, on this server:
 *  1. install the unit and the timer from this release (written only when
 *     their bytes differ, atomically, never through a link) and turn the timer
 *     on — lib/installUnits.ts, which then reads back "enabled" + "active";
 *  2. VERIFY the check itself works: run it once now (a oneshot: `systemctl
 *     start` returns when it has finished), read its result from systemd, and
 *     read what it logged: the script exits 0 when it could not check too, and
 *     logs `release_check_failed` instead.
 *     It reads the on-chain release record from this node's own indexer, so
 *     it normally leaves the box not at all.
 * FALLBACK when the first run fails: one more run after a pause (the indexer
 * may still be starting). Otherwise a calm line with the commands to look at it
 * on this server. Never throws.
 */
import { join } from 'node:path';
import type { HealCtx, HealResult } from './healTypes.ts';
import { installAndEnableUnits, type InstallUnitsResult } from './installUnits.ts';
import { runAsync } from './spinRun.ts';

export const RELEASE_MONITOR_UNITS = [
	'morphit-release-monitor.service',
	'morphit-release-monitor.timer'
] as const;
export const RELEASE_MONITOR_TIMER = 'morphit-release-monitor.timer';
export const RELEASE_MONITOR_SERVICE = 'morphit-release-monitor.service';

export interface ReleaseMonitorRuntime {
	/** Install the units and turn the timer on (reads back enabled + active). */
	install(): InstallUnitsResult;
	/** Run the check once; ok when systemd reports it finished successfully
	 *  and it did not log that it could not check. */
	runOnce(): Promise<{ ok: boolean; detail: string }> | { ok: boolean; detail: string };
	sleep(ms: number): Promise<void>;
}

export async function healReleaseMonitor(
	ctx: HealCtx,
	rt: ReleaseMonitorRuntime
): Promise<HealResult> {
	const inst = rt.install();
	if (!inst.ok) {
		return {
			strategy: 'left-alone',
			verified: false,
			detail:
				`Release check: could not turn it on (${inst.detail ?? 'unknown reason'}), so this server will not tell you when a newer release is out. ` +
				`On this server: sudo systemctl enable --now ${RELEASE_MONITOR_TIMER}`
		};
	}
	const firstTime = inst.written.length > 0;
	let run: { ok: boolean; detail: string } = { ok: false, detail: '' };
	for (let attempt = 1; attempt <= 2 && !run.ok; attempt++) {
		// The 20 s pause before the retry is a wait too: under the same spinner.
		const stop = ctx.spinner(
			attempt === 1
				? 'Running the release check once, to see that it works…'
				: 'Waiting 20 s, then running the release check once more…'
		);
		try {
			if (attempt === 2) await rt.sleep(20_000);
			run = await rt.runOnce();
		} finally {
			stop();
		}
	}
	if (!run.ok) {
		return {
			strategy: 'installed-check-failed',
			verified: false,
			detail:
				`Release check: on twice a day, but its first run did not succeed (${run.detail}). ` +
				`On this server, to see why: journalctl -u ${RELEASE_MONITOR_SERVICE} -n 20 --no-pager`
		};
	}
	if (!firstTime) return { strategy: 'already', verified: true, detail: '', routine: true };
	return {
		strategy: 'installed',
		verified: true,
		detail:
			'Release check: turned on (checked: it ran once and succeeded). Twice a day this server looks for a newer Morphit release, ' +
			'from the on-chain record its own indexer holds; when Matrix alerts are set up (sudo morphit-ops, option 17) you get a message when one is out.'
	};
}

/** What one run's journal lines say about it. PURE. */
export function releaseMonitorRunVerdict(journal: string): { ok: boolean; detail: string } {
	if (/"event":"release_check_failed"/.test(journal)) {
		const hint = /"hint":"([^"]{1,300})"/.exec(journal)?.[1];
		return { ok: false, detail: `it could not check${hint ? `: ${hint}` : ''}` };
	}
	return { ok: true, detail: '' };
}

type Run = (
	cmd: string,
	args: readonly string[],
	timeout: number
) => Promise<{ status: number | null; stdout: string }> | { status: number | null; stdout: string };

/** Without blocking: the spinner turns for the whole run (up to 2 minutes). */
const sh: Run = async (cmd, args, timeout) => {
	const r = await runAsync(cmd, args, { timeoutMs: timeout });
	return { status: r.status, stdout: r.stdout };
};

/** The real runtime. `installDir` is the release the self-heal runs from. */
export function realReleaseMonitorRuntime(
	installDir: string,
	/** Tests: the commands (systemctl, journalctl) as a box would answer. */
	run: Run = sh
): ReleaseMonitorRuntime {
	const systemdDir = process.env.MORPHIT_SYSTEMD_DIR ?? '/etc/systemd/system';
	const noSystemd = process.env.MORPHIT_HEAL_NO_SYSTEMD === '1';
	return {
		install: () =>
			installAndEnableUnits({
				templateDir: join(installDir, 'ops', 'systemd'),
				systemdDir,
				units: RELEASE_MONITOR_UNITS,
				timer: RELEASE_MONITOR_TIMER,
				noSystemd
			}),
		runOnce: async () => {
			if (noSystemd) return { ok: true, detail: 'systemd skipped' };
			// A oneshot: `start` returns when the run has finished. Its own
			// script is bounded by `timeout 90`.
			const since = Math.floor(Date.now() / 1000) - 1;
			const start = await run('systemctl', ['start', RELEASE_MONITOR_SERVICE], 120_000);
			const show = (
				await run(
					'systemctl',
					['show', RELEASE_MONITOR_SERVICE, '-p', 'Result', '-p', 'ExecMainStatus'],
					10_000
				)
			).stdout;
			const result = /^Result=(.*)$/m.exec(show)?.[1]?.trim() ?? '';
			const code = /^ExecMainStatus=(.*)$/m.exec(show)?.[1]?.trim() ?? '';
			if (!(start.status === 0 && result === 'success' && code === '0'))
				return {
					ok: false,
					detail: `systemd says result "${result || 'unknown'}", exit status ${code || 'unknown'}`
				};
			// The script exits 0 when it could not check too: it logs
			// release_check_failed instead. That is what tells them apart.
			// journald takes the run's output asynchronously: flush it first, or
			// a "could not check" line may not be there yet (review 2026-10-08).
			await run('journalctl', ['--sync'], 10_000);
			const logged = (
				await run(
					'journalctl',
					['-u', RELEASE_MONITOR_SERVICE, '--since', `@${since}`, '-o', 'cat', '--no-pager'],
					10_000
				)
			).stdout;
			return releaseMonitorRunVerdict(logged);
		},
		sleep: (ms) => new Promise((r) => setTimeout(r, ms))
	};
}
