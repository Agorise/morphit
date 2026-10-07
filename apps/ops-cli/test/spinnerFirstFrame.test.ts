/**
 * A spinner wrapped around SYNCHRONOUS work (spawnSync, a blocking read) cannot
 * animate — the event loop is blocked — but its label must still be on screen
 * for the whole pause: the first frame is drawn when the spinner starts.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { startDotsSpinner } from '../src/init/spinner.ts';

describe('the spinner shows its label at once', () => {
	it('during blocking work, the label is already on the line', () => {
		let written = '';
		const out = {
			isTTY: true,
			write: (s: string) => ((written += s), true)
		} as unknown as NodeJS.WriteStream;
		const stop = startDotsSpinner('Turning off the OS fetches…', out);
		spawnSync('sleep', ['0.3']); // blocks the event loop: no interval tick runs
		expect(written).toContain('Turning off the OS fetches…');
		expect(written).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
		stop();
	});
});
