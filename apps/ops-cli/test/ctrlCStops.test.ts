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

import { abortError, askPassword } from '../src/init/prompt.ts';
import { commandFailed } from '../src/lib/commandFailed.ts';
import { realSpawn } from '../src/init/assembleInstall.ts';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('Ctrl+C', () => {
	it('at the passphrase prompt: an AbortError, the terminal left as it was', async () => {
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
		const p = askPassword('Passphrase');
		process.stdin.emit('data', 'ab\u0003');
		await expect(p).rejects.toMatchObject({ name: 'AbortError' });
		expect(exit).not.toHaveBeenCalled();
		expect(process.stdin.listenerCount('data')).toBe(0);
	});

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
