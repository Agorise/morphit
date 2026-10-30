/**
 * "Configure only" (morphit-ops install, second choice) and its fast-sync,
 * with the real fast-sync driver; only the restore itself (the bash child) is
 * a stand-in.
 *
 * Review of v1.21.18, 2026-10-29:
 *  - how to start the services was said twice: fast-sync's "start the
 *    indexer", then the install's own "enable --now" (M8);
 *  - "Decline and the node will full-replay from genesis" — the indexer
 *    replays the chain itself (M8);
 *  - a fast-sync stopped with Ctrl+C (exit 130) went on to the next question
 *    as if nothing had happened (L9).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const asked: string[] = [];
vi.mock('../src/init/prompt.ts', async (orig) => ({
	...(await orig<typeof import('../src/init/prompt.ts')>()),
	askChoice: async () => 1, // "Configure only"
	askYesNo: async (q: string, def: boolean) => {
		asked.push(q);
		return def;
	}
}));
let restoreRc: number | null = 0;
vi.mock('node:child_process', async (orig) => {
	const real = await orig<typeof import('node:child_process')>();
	return {
		...real,
		spawnSync: ((cmd: string, ...rest: unknown[]) => {
			const script = String((rest[0] as string[] | undefined)?.[1] ?? '');
			if (cmd !== 'bash' || !script.includes('snapshot-bootstrap.ts'))
				return (real.spawnSync as (...a: unknown[]) => unknown)(cmd, ...rest);
			return { status: restoreRc, stdout: '', stderr: '', pid: 0, output: [], signal: null };
		}) as typeof real.spawnSync
	};
});

const { runInstall } = await import('../src/commands/install.ts');

let dir = '';
let out = '';
const HOME = process.env.HOME;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'install-configure-'));
	process.env.HOME = dir;
	mkdirSync(join(dir, 'etc', 'systemd', 'system'), { recursive: true });
	writeFileSync(join(dir, 'etc', 'systemd', 'system', 'morphit-indexer.service'), '');
	out = '';
	asked.length = 0;
	const add = (...a: unknown[]): void => {
		out += `${a.map(String).join(' ')}\n`;
	};
	vi.spyOn(console, 'log').mockImplementation(add);
	vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
		out += String(s);
		return true;
	});
	restoreRc = 0;
});
afterEach(() => {
	process.env.HOME = HOME;
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

const configureOnly = (): Promise<number> =>
	runInstall(
		{ flags: {}, positional: [], colorEnabled: false },
		{
			root: dir,
			probePresent: async () => true,
			runInit: async () => 0,
			runHarden: async () => 0,
			offerPathSymlink: async () => undefined,
			finishInstall: () => undefined
		}
	);

describe('"Configure only" and its fast-sync', () => {
	it('how to start the services is said once, at the end', async () => {
		expect(await configureOnly()).toBe(0);
		expect(out).toContain('Fast-sync complete');
		expect(out).not.toContain('sudo systemctl start morphit-indexer');
		expect(out.split('sudo systemctl enable --now morphit-indexer').length - 1).toBe(1);
	});

	it('the zero-trust choice says what really happens', async () => {
		await configureOnly();
		expect(out).toContain('your indexer replays the chain itself');
		expect(out).not.toMatch(/genesis/);
	});

	it('a fast-sync stopped with Ctrl+C stops the install there, and says so', async () => {
		restoreRc = 130;
		const code = await configureOnly();
		expect(code).toBe(130);
		expect(out).toContain('Stopped — you pressed Ctrl+C during the fast-sync');
		expect(out).toContain('sudo morphit-ops fast-sync');
		expect(out).toContain('sudo morphit-ops harden');
		// Nothing after it was asked or done.
		expect(asked.some((q) => /hardening/i.test(q))).toBe(false);
		expect(out).not.toContain('Install steps complete');
	});
});
