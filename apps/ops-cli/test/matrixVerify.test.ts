/**
 * `morphit-ops matrix` (menu 18).
 *
 *  - M10: "✓ … enabled and started — alerts will DM to you now" was printed
 *    from systemctl's exit code alone; the unit is Type=simple, so a bot that
 *    exits a moment later on a bad token looked fine. It is now read back,
 *    and a bot that is not running shows its last log lines.
 *  - M11: configured and running, the screen offered nothing but "Clear
 *    with: morphit-ops matrix clear". It now offers Change address / Send a
 *    test / Turn alerts off / Done (Enter = Done).
 *  - LOW: set and clear also update the operator config (so an Ansible
 *    re-run does not bring the old address back); setup's self-test that
 *    threw no longer says "Bot is up".
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceState } from '../src/commands/health.ts';

const promptChoices: Array<{ options: string[]; def: number | undefined }> = [];
vi.mock('../src/init/prompt.ts', async (orig) => ({
	...((await orig()) as object),
	askChoice: async (_q: string, options: readonly string[], def?: number) => {
		promptChoices.push({ options: [...options], def });
		return def ?? 0;
	}
}));

const DIR = mkdtempSync(join(tmpdir(), 'mx-verify-'));
const CONFIG = join(DIR, 'morphit.config.env');
process.env.MORPHIT_CONFIG_ENV_PATH = CONFIG;
const { runMatrix, configureMatrixAlerts } = await import('../src/commands/matrix.ts');

let out = '';
beforeEach(() => {
	out = '';
	writeFileSync(CONFIG, 'MORPHIT_MATRIX_BOT_ALERT_MXID=@old:example.org\n');
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		out += a.join(' ') + '\n';
	});
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
	delete process.env.MORPHIT_CONFIG_ENV_PATH;
	rmSync(DIR, { recursive: true, force: true });
});

const ready = { exists: true, mxidRaw: '@alice:example.org', tokenRaw: 'syt_real_token' };
const CTX = (positional: string[]) => ({ flags: {}, positional, colorEnabled: false });

describe('morphit-ops matrix', () => {
	it('set: a bot that dies after the restart is reported with its log, never "alerts will DM to you now"', async () => {
		const rc = await runMatrix(CTX(['set', '@alice:example.org']), {
			readEnv: () => ready,
			writeMxid: () => true,
			sync: () => ({ action: 'enable-restart', ok: true }),
			readState: (): ServiceState => 'failed',
			journalTail: () => 'M_UNKNOWN_TOKEN: Invalid access token passed.',
			settleMs: 0
		});
		expect(rc).toBe(1);
		expect(out).toContain('M_UNKNOWN_TOKEN: Invalid access token passed.');
		expect(out).not.toMatch(/alerts will DM to you now|enabled and \(re\)started/);
		expect(out).toContain('sudo systemctl restart morphit-matrix-bot');
	});

	it('set: a bot seen running once, then stopped at the second look, is not "up"', async () => {
		const looks: ServiceState[] = ['active', 'activating'];
		const rc = await runMatrix(CTX(['set', '@alice:example.org']), {
			readEnv: () => ready,
			writeMxid: () => true,
			sync: () => ({ action: 'enable-restart', ok: true }),
			readState: (): ServiceState => looks.shift() ?? 'activating',
			readRestarts: async () => 0,
			journalTail: () => 'M_UNKNOWN_TOKEN: Invalid access token passed.',
			settleMs: 0
		});
		expect(rc).toBe(1);
		expect(out).toMatch(
			/✗ The Matrix alert bot is not running \d+ s after it was started \(starting\)/
		);
		expect(out).not.toMatch(/alerts will DM to you now|enabled and \(re\)started/);
	});

	it('set: running at both looks but restarted by systemd in between: it keeps crashing, not "up"', async () => {
		const counts = [0, 1];
		const rc = await runMatrix(CTX(['set', '@alice:example.org']), {
			readEnv: () => ready,
			writeMxid: () => true,
			sync: () => ({ action: 'enable-restart', ok: true }),
			readState: (): ServiceState => 'active',
			readRestarts: async () => counts.shift() ?? 1,
			journalTail: () => 'Error: homeserver unreachable',
			settleMs: 0
		});
		expect(rc).toBe(1);
		expect(out).toMatch(
			/restarted by systemd 1 time in the \d+ s after it was started: it keeps crashing/
		);
		expect(out).toContain('Error: homeserver unreachable');
	});

	it('set also writes the address into the operator config', async () => {
		const written: Array<[string, string]> = [];
		const rc = await runMatrix(CTX(['set', '@alice:example.org']), {
			readEnv: () => ready,
			writeMxid: () => true,
			writeConfig: (v: string, p: string) => {
				written.push([v, p]);
				return true;
			},
			sync: () => ({ action: 'enable-restart', ok: true }),
			readState: (): ServiceState => 'active',
			settleMs: 0
		});
		expect(rc).toBe(0);
		expect(written).toEqual([['@alice:example.org', CONFIG]]);
	});

	it('configured and running: offers change / test / off / Done — and "Change" sets the new address', async () => {
		const offered: string[][] = [];
		const writes: string[] = [];
		const rc = await runMatrix(CTX([]), {
			readEnv: () => ready,
			readState: (): ServiceState => 'active',
			askChoice: async (_q: string, options: readonly string[]) => {
				offered.push([...options]);
				return 0;
			},
			ask: async () => '@new:example.org',
			writeMxid: (v: string) => {
				writes.push(v);
				return true;
			},
			writeConfig: () => true,
			sync: () => ({ action: 'enable-restart', ok: true }),
			settleMs: 0
		});
		expect(rc).toBe(0);
		expect(offered[0]).toEqual([
			'Change the alert address',
			'Send a test alert',
			'Turn Matrix alerts off',
			'Done'
		]);
		expect(writes).toEqual(['@new:example.org']);
		expect(out).not.toMatch(/Clear with: morphit-ops matrix clear/);
	});

	it('configured and running, at the real prompt: Enter is Done (nothing changes)', async () => {
		promptChoices.length = 0;
		const writes: string[] = [];
		const rc = await runMatrix(CTX([]), {
			readEnv: () => ready,
			readState: (): ServiceState => 'active',
			writeMxid: (v: string) => {
				writes.push(v);
				return true;
			}
		});
		expect(rc).toBe(0);
		const c = promptChoices[0]!;
		expect(c.options[c.def!]).toBe('Done');
		expect(writes).toEqual([]);
	});

	it('setup: a self-test that throws does not say "Bot is up"', async () => {
		const answers = ['@alice:example.org', 'https://matrix.example.org', 'syt_pasted'];
		const rc = await configureMatrixAlerts(false, {
			isTTY: true,
			torOnly: () => false,
			ask: async () => answers.shift() ?? '',
			askChoice: async () => 1,
			writeCreds: (() => true) as never,
			writeConfig: () => true,
			sync: () => ({ action: 'enable-restart', ok: true }),
			readState: (): ServiceState => 'active',
			settleMs: 0,
			readHealthcheckPort: () => 9,
			selfTest: async () => {
				throw new Error('connect ECONNREFUSED 127.0.0.1:9');
			}
		});
		expect(rc).toBe(0);
		expect(out).not.toMatch(/Bot is up/);
		expect(out).toMatch(/the test alert was not delivered/);
		expect(out).toContain('sudo morphit-ops matrix test');
	});
});
