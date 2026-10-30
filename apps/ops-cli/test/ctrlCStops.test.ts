/**
 * Ctrl+C is a stop, said plainly, at every layer that turns it into an exit
 * code (v1.21.7, review 2026-10-12):
 *  - at the passphrase prompt (raw mode: the terminal sends ^C as a byte), the
 *    prompt rejects with an AbortError — it used to exit the process right
 *    there, skipping every clean-up;
 *  - a command stopped that way exits 130 with one plain line, not "Error"
 *    and 3, which callers treat as a fault;
 *  - Ctrl+C during the playbook is reported as a stop once Ansible has ended.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { abortError } from '../src/init/prompt.ts';
import { commandFailed } from '../src/lib/commandFailed.ts';
import { realSpawn } from '../src/init/assembleInstall.ts';

afterEach(() => {
	vi.restoreAllMocks();
});

const OPS = resolve(import.meta.dirname, '..');
const TSX = resolve(OPS, '..', '..', 'node_modules', '.bin', 'tsx');

/** Run `body` (ask / askPassword in scope) in a real pseudo-terminal, typing
 *  each step's keys once its pattern shows; everything the terminal got. */
function passphraseAtTerminal(body: string, steps: [string, string][]): string {
	const dir = mkdtempSync(join(tmpdir(), 'morphit-ctrlc-'));
	const file = join(dir, 'run.ts');
	writeFileSync(
		file,
		`import { ask, askPassword } from ${JSON.stringify(join(OPS, 'src/init/prompt.ts'))};\n` +
			`(async () => {\n${body}\nprocess.exit(0);\n})();\n`
	);
	const driver = join(dir, 'drive.py');
	writeFileSync(
		driver,
		[
			'import json, os, pty, re, select, sys, time, signal',
			'spec = json.loads(sys.argv[1])',
			'pid, fd = pty.fork()',
			'if pid == 0:',
			'    os.execvp(spec["cmd"][0], spec["cmd"])',
			'buf, steps, deadline = b"", list(spec["steps"]), time.time() + 45',
			'while time.time() < deadline:',
			'    r, _, _ = select.select([fd], [], [], 0.1)',
			'    if r:',
			'        try:',
			'            data = os.read(fd, 65536)',
			'        except OSError:',
			'            data = b""',
			'        if not data:',
			'            break',
			'        buf += data',
			'    if steps and re.search(steps[0][0], buf.decode("utf-8", "replace"), re.S):',
			'        time.sleep(0.2)',
			'        os.write(fd, steps.pop(0)[1].encode())',
			'else:',
			'    os.kill(pid, signal.SIGKILL)',
			'os.waitpid(pid, 0)',
			'sys.stdout.write(buf.decode("utf-8", "replace"))'
		].join('\n')
	);
	const r = spawnSync('python3', ['-I', driver, JSON.stringify({ cmd: [TSX, file], steps })], {
		encoding: 'utf8',
		timeout: 60_000
	});
	return r.stdout ?? '';
}

describe('Ctrl+C', () => {
	it('at the passphrase prompt: an AbortError, the terminal left as it was', () => {
		// A real terminal (the masked reader is for one; piped answers have
		// their own reader). After the stop, the next question reads a normal,
		// echoed line: raw mode is off and the masked reader let go of stdin.
		const out = passphraseAtTerminal(
			`const exit = process.exit; let exited = false;\n` +
				`(process as { exit: unknown }).exit = () => { exited = true; };\n` +
				`try { await askPassword('Passphrase'); console.log('NO STOP'); }\n` +
				`catch (e) { console.log('STOP ' + (e as Error).name); }\n` +
				`console.log('EXITED ' + String(exited)); process.exit = exit;\n` +
				`console.log('NEXT ' + (await ask('next')));`,
			[
				['> ', 'ab\u0003'],
				['next', 'okay\r']
			]
		);
		expect(out).toContain('STOP AbortError');
		expect(out).toContain('EXITED false');
		expect(out).toMatch(/okay\r?\n/); // echoed as typed
		expect(out).toContain('NEXT okay');
	}, 60_000);

	it('a command stopped by it: 130 and one plain line', () => {
		const out: string[] = [];
		expect(commandFailed(abortError(), (s) => void out.push(s))).toBe(130);
		expect(out.join('\n')).toMatch(/Stopped — you pressed Ctrl\+C/);
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.spyOn(console, 'log').mockImplementation(() => undefined);
		expect(commandFailed(new Error('boom'))).toBe(3);
	});

	it('during the playbook: once it has ended, a stop (AbortError), not a failed install', async () => {
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const before = process.listenerCount('SIGINT');
		const run = realSpawn(['bash', '-c', 'sleep 0.4; exit 130']);
		// Its listener is on as soon as it is called; the playbook is running.
		process.emit('SIGINT');
		await expect(run).rejects.toMatchObject({ name: 'AbortError' });
		expect(process.listenerCount('SIGINT')).toBe(before);
		// Without a Ctrl+C, its exit code.
		await expect(realSpawn(['bash', '-c', 'exit 2'])).resolves.toBe(2);
	});
});
