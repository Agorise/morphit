/**
 * Ctrl+C, or an SSH session that drops, while the upgrade has moved
 * /opt/morphit aside and is unpacking the new release (v1.21.17 audit, H2):
 * Node's default on SIGINT / SIGHUP is to exit at once, which left /opt/morphit
 * EMPTY, the old install in a .bak folder, no rollback and no message.
 *
 * The real runUpgrade runs in its own process group (as a terminal's
 * foreground job) with a stand-in `tar` that takes 20 s; the signal goes to
 * the WHOLE group, as the terminal sends it (tar gets it too). Afterwards the
 * previous install must be back where it was, and the operator told so.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPS } from './helpers/pty.ts';

const FLOW = join(OPS, 'test', 'helpers', 'upgradeFlow.mts');
const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function stopDuringUnpack(sig: NodeJS.Signals): Promise<{ out: string; dir: string }> {
	const dir = mkdtempSync(join(tmpdir(), 'upgrade-stop-'));
	dirs.push(dir);
	// Plain node with tsx's loader (as the installed CLI runs under plain node):
	// tsx's own CLI wrapper relays signals and kills a child that is slow to
	// report one, which is not what an operator's terminal does.
	const child = spawn(process.execPath, ['--import', 'tsx', FLOW, 'slow-tar', dir], {
		cwd: OPS,
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let out = '';
	child.stdout.on('data', (b: Buffer) => (out += b));
	child.stderr.on('data', (b: Buffer) => (out += b));
	const closed = new Promise<void>((r) => child.on('close', () => r()));
	await vi.waitFor(
		() => {
			if (!existsSync(join(dir, 'tar-started'))) throw new Error('tar has not started yet');
		},
		{ timeout: 90_000, interval: 200 }
	);
	process.kill(-child.pid!, sig);
	await closed;
	return { out, dir };
}

describe('a signal while the new release is being installed', () => {
	it('Ctrl+C: the previous install is put back and the operator is told, plainly', async () => {
		const { out, dir } = await stopDuringUnpack('SIGINT');
		const install = join(dir, 'morphit');
		expect(JSON.parse(readFileSync(join(install, 'release-info.json'), 'utf8')).tag).toBe(
			'v1.21.16'
		);
		expect(readdirSync(dir).filter((n) => n.startsWith('morphit.bak-'))).toEqual([]);
		expect(out).toMatch(/Stopping — you pressed Ctrl\+C\. .*previous one is being put back/);
		expect(out).toMatch(/Not upgraded — this server is back on v1\.21\.16/);
		expect(out).toMatch(/Why: you pressed Ctrl\+C\./);
		// Ctrl+C's own exit code, as a shell reports it (v1.21.18 audit: it was 3).
		expect(out).toMatch(/=== exit code 130/);
	}, 150_000);

	it('the SSH session drops (SIGHUP): the same, and the lines are kept in a file for later', async () => {
		const { out, dir } = await stopDuringUnpack('SIGHUP');
		expect(JSON.parse(readFileSync(join(dir, 'morphit', 'release-info.json'), 'utf8')).tag).toBe(
			'v1.21.16'
		);
		expect(readdirSync(dir).filter((n) => n.startsWith('morphit.bak-'))).toEqual([]);
		const note = readdirSync(join(dir, 'steplogs')).find((n) => n.startsWith('upgrade-stopped-'));
		expect(note).toBeDefined();
		const noteText = readFileSync(join(dir, 'steplogs', note!), 'utf8');
		expect(noteText, noteText).toMatch(
			/back on v1\.21\.16[\s\S]*Why: the connection to this server closed/
		);
		expect(out).toMatch(/=== exit code 129/);
	}, 150_000);
});
