/**
 * The guided install pauses morphit-first-online while it restores the snapshot
 * (its first online run restarts tor and i2pd, which would drop a download
 * going over them). A run already under way is waited for first — under the
 * spinner. A oneshot unit is "activating" for its whole run, and `systemctl
 * is-active` exits 3 for that, so the old check never waited (review,
 * 2026-10-12).
 */
import { describe, expect, it } from 'vitest';
import {
	unitBusy,
	withFirstOnlinePaused,
	type FirstOnlinePauseDeps
} from '../src/init/runAnsibleInstall.ts';
import { abortError } from '../src/init/prompt.ts';

function deps(states: string[], stopAfter = Infinity) {
	const calls: string[] = [];
	let shows = 0;
	let sleeps = 0;
	const d: FirstOnlinePauseDeps = {
		systemctl: (args) => {
			calls.push(args.join(' '));
			if (args[0] === 'is-active') return { status: 0, stdout: '' }; // the timer runs
			if (args[0] === 'show') return { status: 0, stdout: `${states.shift() ?? 'inactive'}\n` };
			return { status: 0, stdout: '' };
		},
		sleep: async () => void sleeps++,
		spinner: () => {
			shows++;
			return () => undefined;
		},
		checkStop: () => {
			if (sleeps >= stopAfter) throw abortError();
		}
	};
	return { d, calls, shows: () => shows, sleeps: () => sleeps };
}

describe('pausing first-online for the restore', () => {
	it('waits, under the spinner, while a run of it is under way ("activating")', async () => {
		const t = deps(['activating', 'activating', 'activating', 'inactive']);
		let ranAt = -1;
		await withFirstOnlinePaused(async () => void (ranAt = t.sleeps()), t.d);
		expect(ranAt).toBe(2); // three looks while it ran, two waits between them
		expect(t.shows()).toBe(1);
		expect(t.calls).toContain('stop morphit-first-online.timer');
		expect(t.calls.at(-1)).toBe('start morphit-first-online.timer');
	});

	it('no run under way: straight on, no spinner', async () => {
		const t = deps(['inactive']);
		await withFirstOnlinePaused(async () => undefined, t.d);
		expect(t.sleeps()).toBe(0);
		expect(t.shows()).toBe(0);
	});

	it('Ctrl+C during the wait: nothing restored, and the timer is started again', async () => {
		const t = deps(['activating', 'activating', 'activating'], 1);
		let ran = false;
		await expect(withFirstOnlinePaused(async () => void (ran = true), t.d)).rejects.toMatchObject({
			name: 'AbortError'
		});
		expect(ran).toBe(false);
		expect(t.calls.at(-1)).toBe('start morphit-first-online.timer');
	});

	it('which states are a run under way', () => {
		for (const s of ['activating', 'deactivating', 'reloading', 'active'])
			expect(unitBusy(s)).toBe(true);
		for (const s of ['inactive', 'failed', '', 'unknown']) expect(unitBusy(s)).toBe(false);
	});
});
