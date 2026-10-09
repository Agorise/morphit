/**
 * The braille spinner and the terminal it draws on (review 2026-10-08):
 * a label wider than the terminal wrapped, so every frame went to a new line
 * and the screen filled with copies; and Ctrl-C while it turned left the
 * operator's shell with no cursor.
 */
import { describe, it, expect, vi } from 'vitest';
import { startDotsSpinner } from '../src/init/spinner.ts';
import { runInTerminal } from './helpers/pty.ts';

describe('the spinner on the terminal', () => {
	it('never draws a line wider than the terminal', () => {
		vi.useFakeTimers();
		const writes: string[] = [];
		const out = {
			isTTY: true,
			columns: 40,
			write: (s: string) => void writes.push(s)
		} as unknown as NodeJS.WriteStream;
		const label = 'Checking the internet can reach this node (through Tor — up to a few minutes)…';
		try {
			const stop = startDotsSpinner(label, out, 5);
			vi.advanceTimersByTime(40);
			stop();
		} finally {
			vi.useRealTimers();
		}
		const frames = writes.filter((w) => w.startsWith('\r  '));
		expect(frames.length).toBeGreaterThanOrEqual(3);
		for (const f of frames) expect([...f.slice(1)].length, f).toBeLessThan(40);
		expect(frames[0]).toMatch(/Checking the internet/);
	});

	it('Ctrl-C while it turns gives the cursor back', () => {
		const r = runInTerminal(
			'src/init/spinner.ts',
			`$.startDotsSpinner('Waiting for something slow…');
setTimeout(() => process.kill(process.pid, 'SIGINT'), 300);
await new Promise((r) => setTimeout(r, 5_000));`,
			{ timeoutMs: 20_000 }
		);
		const hidden = r.out.lastIndexOf('\u001b[?25l');
		expect(hidden, 'the spinner never drew').toBeGreaterThanOrEqual(0);
		expect(r.out.lastIndexOf('\u001b[?25h'), 'the cursor was left hidden').toBeGreaterThan(hidden);
		expect(r.status).toBe(130);
	}, 30_000);
});
