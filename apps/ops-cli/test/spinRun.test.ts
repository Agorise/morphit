/**
 * runAsync (lib/spinRun.ts): the child runner behind the turning spinner.
 * Review 2026-10-08: its time limit did nothing once the child had exited
 * while something it started kept the output open, and a character split
 * across two reads came out garbled.
 */
import { describe, it, expect } from 'vitest';
import { runAsync, showOutput } from '../src/lib/spinRun.ts';

describe('runAsync', () => {
	it('the time limit holds when the child exits but leaves something holding its output', async () => {
		const t0 = Date.now();
		const r = await runAsync('sh', ['-c', 'sleep 6 & exit 0'], { timeoutMs: 1_000 });
		expect(Date.now() - t0, 'waited for the background sleep').toBeLessThan(3_000);
		expect(r.status, 'the child itself exited 0').toBe(0);
	});

	it('a character split across two reads comes out whole', async () => {
		const r = await runAsync('sh', ['-c', "printf '\\303'; sleep 0.2; printf '\\251\\n'"], {
			timeoutMs: 5_000
		});
		expect(r.stdout).toBe('é\n');
		expect(r.output).toBe('é\n');
	});

	it('a run stopped at its time limit says so (it used to print nothing)', async () => {
		const r = await runAsync('sh', ['-c', 'sleep 5'], { timeoutMs: 200 });
		let printed = '';
		showOutput(r, { write: (t: string) => void (printed += t) } as unknown as NodeJS.WriteStream);
		expect(r.timedOut).toBe(true);
		expect(printed).toMatch(/did not finish in time/);
	});
});
