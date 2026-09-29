/**
 * The upgrade must judge a service restart by OBSERVED running state, not the
 * `systemctl restart` exit code, and the rollback must bring a CRASHED unit back
 * up (review B6).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyUnitOutcome, evaluateRestartSamples, rollback } from '../src/commands/upgrade.ts';

describe('classifyUnitOutcome (post-restart running state)', () => {
	it('active + no new restarts = up', () => {
		expect(classifyUnitOutcome('active', 3, 3)).toBe('up');
	});
	it('failed = down (would roll back)', () => {
		expect(classifyUnitOutcome('failed', 0, 0)).toBe('down');
	});
	it('a crash-loop (3+ automatic restarts in the window) = down even while it reads active', () => {
		expect(classifyUnitOutcome('active', 2, 5)).toBe('down');
	});
	// wave 4 (P6): morphit-indexer.service exits + retries while Postgres comes
	// up; ONE automatic restart is normal and must never roll back a good upgrade.
	it('ONE automatic restart, now active again = up (not a rollback)', () => {
		expect(classifyUnitOutcome('active', 0, 1)).toBe('up');
	});
	it('ONE automatic restart, now activating = wait (still coming up)', () => {
		expect(classifyUnitOutcome('activating', 0, 1)).toBe('wait');
	});
	it('activating = wait (a slow first chain read is not a failure)', () => {
		expect(classifyUnitOutcome('activating', 0, 0)).toBe('wait');
	});
	it('still not active when the window ends = down', () => {
		expect(classifyUnitOutcome('activating', 0, 1, true)).toBe('down');
	});
});

describe('evaluateRestartSamples (the whole polling window)', () => {
	const s = (state: string, restarts: number) => ({ activeState: state, restarts });
	it('Postgres-late indexer: one restart then steadily active = up', () => {
		expect(
			evaluateRestartSamples(
				0,
				[
					s('active', 0),
					s('activating', 1),
					s('active', 1),
					s('active', 1),
					s('active', 1),
					s('active', 1)
				],
				false
			)
		).toBe('up');
	});
	it('crash-loop: three restarts inside the window = down', () => {
		expect(
			evaluateRestartSamples(0, [s('activating', 1), s('activating', 2), s('activating', 3)], false)
		).toBe('down');
	});
	it('failed at any point = down', () => {
		expect(evaluateRestartSamples(0, [s('active', 0), s('failed', 0)], false)).toBe('down');
	});
	it('not yet stable and the window is not over = wait', () => {
		expect(evaluateRestartSamples(0, [s('activating', 1), s('active', 1)], false)).toBe('wait');
	});
	it('window over while active (never failed, <3 restarts) = up', () => {
		expect(evaluateRestartSamples(0, [s('activating', 1), s('active', 1)], true)).toBe('up');
	});
	it('window over while still activating = down', () => {
		expect(evaluateRestartSamples(0, [s('activating', 1), s('activating', 2)], true)).toBe('down');
	});
});

describe('rollback restarts a CRASHED (inactive) enabled unit', () => {
	let root = '';
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'morphit-rb6-'));
		vi.spyOn(console, 'log').mockImplementation(() => undefined);
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	it('issues a restart for a unit that is enabled but not active, and restarts the container', () => {
		const install = join(root, 'install');
		const backup = join(root, 'backup');
		const tmp = join(root, 'tmp');
		mkdirSync(install, { recursive: true });
		mkdirSync(backup, { recursive: true });
		mkdirSync(tmp, { recursive: true });
		writeFileSync(join(backup, 'marker'), 'prev');

		// The relay CRASHED on the new code: is-active fails, but it is enabled.
		const calls: string[] = [];
		const systemctl = (args: readonly string[]): { status: number | null } => {
			calls.push(args.join(' '));
			const svc = args[args.length - 1];
			if (args[0] === 'is-active') return { status: svc === 'morphit-relay.service' ? 3 : 0 };
			if (args[0] === 'is-enabled') return { status: 0 };
			return { status: 0 };
		};
		let containerRestarts = 0;
		const restartContainer = (): void => {
			containerRestarts++;
		};

		const code = rollback(
			install,
			backup,
			tmp,
			new Error('relay failed to come up'),
			{ webRoot: join(root, 'web'), webRootBackup: null, container: 'morphit-frontend' },
			[],
			{ systemctl, restartContainer }
		);
		expect(code).toBe(3);
		expect(existsSync(join(install, 'marker'))).toBe(true); // backup swapped back
		// Both services restarted, including the crashed (inactive) relay.
		expect(calls).toContain('restart morphit-relay.service');
		expect(calls).toContain('restart morphit-indexer.service');
		// H-9: the frontend container is re-attached to the restored install.
		expect(containerRestarts).toBe(1);
	});
});
