/**
 * The installer tells an operator inside tmux how to leave it (2026-10-12: the
 * install finished and the operator did not know how to get out of tmux).
 */
import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { insideTmux, parseProcStat } from '../src/lib/insideTmux.ts';

describe('parseProcStat', () => {
	it('reads the parent pid, even when the command name holds spaces and parentheses', () => {
		expect(parseProcStat('4242 (tmux: server) S 1 4242 4242 0 -1')).toEqual({
			comm: 'tmux: server',
			ppid: 1
		});
		expect(parseProcStat('77 (a (b) c) R 4242 77 77 0')).toEqual({ comm: 'a (b) c', ppid: 4242 });
		expect(parseProcStat('garbage')).toBeNull();
	});
});

describe('insideTmux', () => {
	const tree: Record<number, string> = {
		900: '900 (node) S 800 0 0',
		800: '800 (sudo) S 700 0 0',
		700: '700 (bash) S 600 0 0',
		600: '600 (tmux: server) S 1 0 0'
	};
	const read = (p: string): string => {
		const pid = Number(p.split('/')[2]);
		if (!(pid in tree)) throw new Error('ENOENT');
		return tree[pid]!;
	};
	it('finds the tmux server among the parents (through sudo, which drops $TMUX)', () => {
		expect(insideTmux(900, read)).toBe(true);
	});
	it('no tmux among the parents: false', () => {
		expect(insideTmux(700, (p) => read(p).replace('tmux: server', 'sshd'))).toBe(false);
	});
	it('a read error: false', () => {
		expect(insideTmux(12345, read)).toBe(false);
	});

	const hasTmux = spawnSync('tmux', ['-V']).status === 0;
	it.runIf(hasTmux && process.platform === 'linux')(
		'a real tmux session, with the environment emptied as sudo does: true; outside it: false',
		() => {
			const dir = mkdtempSync(join(tmpdir(), 'tmuxhint-'));
			const out = join(dir, 'out');
			const script = join(dir, 'probe.mjs');
			const mod = new URL('../src/lib/insideTmux.ts', import.meta.url).pathname;
			writeFileSync(
				script,
				`import { insideTmux } from ${JSON.stringify(mod)};\n` +
					`import { writeFileSync } from 'node:fs';\n` +
					`writeFileSync(${JSON.stringify(out)}, String(insideTmux()));\n`
			);
			const tsx = new URL('../../../node_modules/.bin/tsx', import.meta.url).pathname;
			const sock = join(dir, 'sock');
			const r = spawnSync(
				'tmux',
				['-S', sock, 'new-session', '-d', `env -i PATH=${process.env.PATH} ${tsx} ${script}`],
				{ stdio: 'ignore' }
			);
			expect(r.status).toBe(0);
			const deadline = Date.now() + 20_000;
			let got = '';
			while (Date.now() < deadline) {
				try {
					got = readFileSync(out, 'utf8');
					if (got) break;
				} catch {
					/* not yet */
				}
				spawnSync('sleep', ['0.2']);
			}
			spawnSync('tmux', ['-S', sock, 'kill-server'], { stdio: 'ignore' });
			expect(got).toBe('true');
			expect(insideTmux()).toBe(false);
		},
		30_000
	);
});

describe('the guided install', () => {
	it('says how to leave tmux when it finishes inside it, and when it stops', async () => {
		vi.resetModules();
		let outcome: 'ok' | 'stop' = 'ok';
		vi.doMock('../src/lib/insideTmux.ts', async (orig) => ({
			...((await orig()) as object),
			insideTmux: () => true
		}));
		vi.doMock('../src/init/runAnsibleInstall.ts', () => ({
			runAnsibleInstall: async () => {
				if (outcome === 'stop')
					throw Object.assign(new Error('Aborted with Ctrl+C'), { name: 'AbortError' });
				return 1;
			}
		}));
		vi.doMock('../src/init/prompt.ts', async (orig) => ({
			...((await orig()) as object),
			askChoice: async () => 0
		}));
		const { runInstall } = await import('../src/commands/install.ts');
		const { TMUX_EXIT_HINT } = await import('../src/lib/insideTmux.ts');
		const lines: string[] = [];
		const spy = vi.spyOn(console, 'log').mockImplementation((...a) => void lines.push(a.join(' ')));
		try {
			await runInstall({ flags: {}, positional: [], colorEnabled: false } as never);
			expect(lines.join('\n')).toContain(TMUX_EXIT_HINT);
			lines.length = 0;
			outcome = 'stop';
			await expect(
				runInstall({ flags: {}, positional: [], colorEnabled: false } as never)
			).rejects.toMatchObject({ name: 'AbortError' });
			expect(lines.join('\n')).toContain(TMUX_EXIT_HINT);
		} finally {
			spy.mockRestore();
			vi.doUnmock('../src/lib/insideTmux.ts');
			vi.doUnmock('../src/init/runAnsibleInstall.ts');
			vi.doUnmock('../src/init/prompt.ts');
		}
	});
});
