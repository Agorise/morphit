/**
 * The heals run again (v1.21.18 audit, M6):
 *  - `sudo morphit-ops upgrade` on an up-to-date box ran them and exited 1
 *    when one warned, while docs/UPGRADING.md says it exits 0 there; the
 *    warnings say what to do. `upgrade --heals` keeps exit 1 for a warning
 *    (a script can tell), as UPGRADING.md now says.
 *  - With the background web heal (BunkerWeb) still at work it said "✓ Done:
 *    every repair of this release is in place".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());

async function heals(o: {
	upToDate?: boolean;
	warns: boolean;
	webHealRunning: boolean;
}): Promise<{ rc: number; out: string }> {
	vi.resetModules();
	const { runHealsAgain } = await import('../src/commands/upgrade.ts');
	const { warn } = await import('../src/render/term.ts');
	let out = '';
	const grab = (c: unknown): boolean => ((out += String(c)), true);
	vi.spyOn(process.stdout, 'write').mockImplementation(grab as never);
	vi.spyOn(process.stderr, 'write').mockImplementation(grab as never);
	// As root (the up-to-date path checks it).
	vi.spyOn(process as { getuid: () => number }, 'getuid').mockReturnValue(0);
	let rc = -1;
	try {
		rc = await runHealsAgain({
			...(o.upToDate ? { upToDate: true } : {}),
			steps: () => [
				[
					'a heal',
					() => (o.warns ? warn('something to fix; on this server: sudo true') : undefined)
				]
			],
			afterSteps: () => [['an after-restart check', async () => undefined]],
			webHealRunning: () => o.webHealRunning
		});
	} finally {
		vi.restoreAllMocks();
	}
	return { rc, out };
}

describe('the exit code', () => {
	it('an up-to-date `sudo morphit-ops upgrade` whose heal warned: exit 0, the warning counted', async () => {
		const r = await heals({ upToDate: true, warns: true, webHealRunning: false });
		expect(r.out).toMatch(/Done, with one warning above/);
		expect(r.rc).toBe(0);
	});
	it('`upgrade --heals` whose heal warned: exit 1', async () => {
		const r = await heals({ warns: true, webHealRunning: false });
		expect(r.rc).toBe(1);
	});
	it('nothing warned: exit 0 either way', async () => {
		expect((await heals({ warns: false, webHealRunning: false })).rc).toBe(0);
		expect((await heals({ upToDate: true, warns: false, webHealRunning: false })).rc).toBe(0);
	});
});

describe('the background web heal still at work', () => {
	it('not "every repair is in place": what still runs, and where to see how it ended', async () => {
		const r = await heals({ warns: false, webHealRunning: true });
		expect(r.out).not.toMatch(/every repair of this release is in place/);
		expect(r.out).toMatch(
			/Done, except the web firewall's check, still running in the background \(on this server: sudo morphit-ops status\)\./
		);
	});
	it('with a warning too: both said', async () => {
		const r = await heals({ warns: true, webHealRunning: true });
		expect(r.out).toMatch(
			/Done, with one warning above .* Not finished yet: the web firewall's check, still running in the background \(on this server: sudo morphit-ops status\)\./
		);
	});
	it('finished: the usual "✓ Done"', async () => {
		const r = await heals({ warns: false, webHealRunning: false });
		expect(r.out).toMatch(/✓ Done: every repair of this release is in place on this server/);
	});
});
