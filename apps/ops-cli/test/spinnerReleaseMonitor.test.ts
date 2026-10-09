/**
 * The release-check heal retries a failed first run after a 20 s pause. The
 * operator sits through that pause at the terminal (`upgrade --heals`), so it is
 * under the spinner: started before the sleep, stopped only after the retry.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	healReleaseMonitor,
	realReleaseMonitorRuntime,
	type ReleaseMonitorRuntime
} from '../src/lib/releaseMonitorHeal.ts';
import { startDotsSpinner } from '../src/init/spinner.ts';
import { fakeTerminal } from './helpers/screen.ts';
import { spinnerFrames } from './helpers/pty.ts';

describe('the release check: the pause before the retry is under the spinner', () => {
	it('spinner up → sleep 20 s → run once more → spinner stopped', async () => {
		const log: string[] = [];
		let up = 0;
		const ctx = {
			info: () => {},
			warn: () => {},
			spinner: (l: string) => {
				up += 1;
				log.push(`spinner: ${l}`);
				return () => {
					up -= 1;
					log.push('spinner stopped');
				};
			}
		};
		const runs = [
			{ ok: false, detail: 'it could not check' },
			{ ok: true, detail: '' }
		];
		const rt: ReleaseMonitorRuntime = {
			install: () => ({ ok: true, written: [], timerRunning: true }),
			runOnce: () => {
				log.push(`run once (spinners up: ${up})`);
				return runs.shift()!;
			},
			sleep: async (ms) => void log.push(`sleep ${ms} (spinners up: ${up})`)
		};
		const r = await healReleaseMonitor(ctx, rt);
		expect(r.verified).toBe(true);
		expect(log).toEqual([
			'spinner: Running the release check once, to see that it works…',
			'run once (spinners up: 1)',
			'spinner stopped',
			'spinner: Waiting 20 s, then running the release check once more…',
			'sleep 20000 (spinners up: 1)',
			'run once (spinners up: 1)',
			'spinner stopped'
		]);
	});
});

describe('the release check run itself', () => {
	it('turns the spinner while systemd runs it, and flushes the journal before reading it', async () => {
		// Review 2026-10-08: the run was a blocking call (the spinner froze on
		// its first frame for up to two minutes), and the journal was read at
		// once, before journald had necessarily written what the run logged.
		const dir = mkdtempSync(join(tmpdir(), 'release-run-'));
		const calls = join(dir, 'calls');
		writeFileSync(calls, '');
		writeFileSync(
			join(dir, 'systemctl'),
			[
				'#!/bin/sh',
				`echo "systemctl $*" >> '${calls}'`,
				'case "$1" in start) sleep 0.6 ;; show) printf "Result=success\\nExecMainStatus=0\\n" ;; esac',
				'exit 0',
				''
			].join('\n'),
			{ mode: 0o755 }
		);
		writeFileSync(
			join(dir, 'journalctl'),
			['#!/bin/sh', `echo "journalctl $*" >> '${calls}'`, 'exit 0', ''].join('\n'),
			{ mode: 0o755 }
		);
		const PATH = process.env.PATH;
		process.env.PATH = `${dir}:${PATH}`;
		vi.stubEnv('MORPHIT_HEAL_NO_SYSTEMD', '');
		const term = fakeTerminal();
		try {
			const rt: ReleaseMonitorRuntime = {
				...realReleaseMonitorRuntime(dir),
				install: () => ({ ok: true, written: [], timerRunning: true })
			};
			const r = await healReleaseMonitor(
				{ info: () => {}, warn: () => {}, spinner: (l) => startDotsSpinner(l) },
				rt
			);
			const screen = term.out();
			expect(r.verified).toBe(true);
			expect(
				spinnerFrames(screen, 'Running the release check once, to see that it works…')
			).toBeGreaterThanOrEqual(3);
			const log = readFileSync(calls, 'utf8').trim().split('\n');
			const sync = log.findIndex((l) => /^journalctl .*--sync/.test(l));
			const read = log.findIndex((l) => /^journalctl .*-u morphit-release-monitor/.test(l));
			expect(sync, 'the journal was not flushed').toBeGreaterThanOrEqual(0);
			expect(sync).toBeLessThan(read);
		} finally {
			term.restore();
			process.env.PATH = PATH;
			vi.unstubAllEnvs();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
