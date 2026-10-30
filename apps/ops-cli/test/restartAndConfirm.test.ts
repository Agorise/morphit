/**
 * After `edit` / `alt-address` save a setting: what the operator is told about
 * the restart and the running services.
 *
 *  - Every command printed names the real unit: `sudo systemctl restart
 *    morphit-indexer` (`… restart indexer` is "Unit indexer.service not found"
 *    on every install).
 *  - "the change is live" only after the running service was CHECKED to have
 *    the new settings — never on the restart's exit code alone.
 *  - The check (it can wait a while for the new process) runs under the
 *    spinner, and a service that is not running afterwards is said, with the
 *    command that shows why.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { offerRestart } from '../src/lib/restartServices.ts';
import { restartWithWritten, serviceEnvs } from '../src/lib/laterEnvShadow.ts';

let printed: string[] = [];
beforeEach(() => {
	printed = [];
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		printed.push(a.map(String).join(' '));
	});
});
afterEach(() => vi.restoreAllMocks());

describe('offerRestart', () => {
	it('declined: the command to run later names the real units', async () => {
		await offerRestart(['morphit-indexer', 'morphit-relay'], {
			confirm: async () => false,
			exec: () => ({ status: 0 })
		});
		const text = printed.join('\n');
		expect(text).toMatch(/^\s*sudo systemctl restart morphit-indexer$/m);
		expect(text).toMatch(/^\s*sudo systemctl restart morphit-relay$/m);
		expect(text).not.toMatch(/systemctl restart (indexer|relay)\b/);
	});

	it('a failed restart: the real unit, and how to see why', async () => {
		await offerRestart(['morphit-indexer'], {
			confirm: async () => true,
			exec: () => ({ status: 1 })
		});
		const text = printed.join('\n');
		expect(text).toMatch(/sudo systemctl restart morphit-indexer$/m);
		expect(text).toMatch(/sudo journalctl -u morphit-indexer -n 50 --no-pager/);
	});

	it('restarted: says so, but does not claim the change is live (that is checked after)', async () => {
		expect(
			await offerRestart(['morphit-indexer'], {
				confirm: async () => true,
				exec: () => ({ status: 0 })
			})
		).toBe(true);
		const text = printed.join('\n');
		expect(text).toMatch(/restarted indexer/);
		expect(text).not.toMatch(/live/);
	});
});

describe('restartWithWritten: the check after the restart', () => {
	let root = '';
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'restart-confirm-'));
		mkdirSync(join(root, 'opt/morphit'), { recursive: true });
		mkdirSync(join(root, 'etc/morphit'), { recursive: true });
		writeFileSync(
			join(root, 'opt/morphit/morphit.config.env'),
			"MORPHIT_INSTANCE_TAGLINE='New words'\n"
		);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const run = async (processEnv: (k: string) => string | undefined | null) => {
		const lines: string[] = [];
		const spin: Array<{ label: string; stoppedBeforeVerdict: boolean | null }> = [];
		let current: { label: string; stoppedBeforeVerdict: boolean | null } | null = null;
		await restartWithWritten(['MORPHIT_INSTANCE_TAGLINE'], ['morphit-indexer'], {
			offer: async () => true,
			print: (l) => {
				if (current !== null && current.stoppedBeforeVerdict === null)
					current.stoppedBeforeVerdict = false;
				lines.push(l);
			},
			envs: serviceEnvs(root),
			canRead: () => true,
			runtime: { processEnv: (_u, k) => processEnv(k), sleep: async () => {} },
			spinner: (label) => {
				current = { label, stoppedBeforeVerdict: null };
				spin.push(current);
				return () => {
					if (current !== null && current.stoppedBeforeVerdict === null)
						current.stoppedBeforeVerdict = true;
				};
			}
		});
		return { text: lines.join('\n'), spin };
	};

	it('the wait runs under the spinner, and "live" is said only once it is confirmed', async () => {
		const r = await run(() => 'New words');
		expect(r.spin).toHaveLength(1);
		expect(r.spin[0]!.label).toMatch(/Checking that the indexer is running with the new settings/);
		// The spinner is off the screen before the verdict is printed.
		expect(r.spin[0]!.stoppedBeforeVerdict).toBe(true);
		expect(r.text).toMatch(
			/✓ checked: the running indexer uses the new settings — the change is live/
		);
	});

	it('a service that is not running after the restart is said, with how to see why', async () => {
		const r = await run(() => null);
		expect(r.text).toMatch(/✗ the indexer is not running after the restart/);
		expect(r.text).toMatch(/sudo journalctl -u morphit-indexer -n 50 --no-pager/);
		expect(r.text).not.toMatch(/live/);
	});

	it('an old value still running after the restart and the wait: how to see why, and where the value comes from — not "restart it" again', async () => {
		const r = await run(() => 'Old words');
		// It was JUST restarted and checked for a while: "run: sudo systemctl
		// restart" again was circular advice.
		expect(r.text).toMatch(
			/the indexer did not pick up the new MORPHIT_INSTANCE_TAGLINE after the restart: it runs with Old words, its settings give New words/
		);
		expect(r.text).toMatch(/sudo journalctl -u morphit-indexer -n 50 --no-pager/);
		// The files that set it, in the order the service reads them.
		expect(r.text).toContain(`set in ${join(root, 'opt/morphit/morphit.config.env')}`);
		expect(r.text).not.toMatch(/systemctl restart/);
		expect(r.text).not.toMatch(/live/);
	});

	it('set in two files: both named, in the order read, the last one winning', async () => {
		writeFileSync(
			join(root, 'opt/morphit/morphit.env'),
			"MORPHIT_INSTANCE_TAGLINE='Earlier words'\n"
		);
		const r = await run(() => 'Old words');
		expect(r.text).toContain(
			`set in ${join(root, 'opt/morphit/morphit.env')}, then ${join(root, 'opt/morphit/morphit.config.env')} — the last one wins`
		);
	});
});
