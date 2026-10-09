/**
 * The guided install: the Ansible pre-flight (`--list-hosts`, several silent
 * seconds) shows the braille spinner, and the playbook run — whose output
 * streams live — shows the spinner on its own line during a silent stretch,
 * clearing it before the next output so the stream is never corrupted. It
 * never draws over a partial line (a password prompt waiting for input).
 *
 * `ansible-playbook` is a stand-in on PATH.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CLEAR, currentLine, fakeTerminal, frameRe, type FakeTerminal } from './helpers/screen.ts';
import { spinnerFrames } from './helpers/pty.ts';
import { assembleInstall } from '../src/init/assembleInstall.ts';

let dir = '';
let term: FakeTerminal | null = null;
const PATH = process.env.PATH;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'install-spin-'));
	writeFileSync(join(dir, 'screen'), '');
	writeFileSync(
		join(dir, 'ansible-playbook'),
		[
			'#!/bin/sh',
			`D=${dir}`,
			'for a in "$@"; do',
			'  if [ "$a" = "--list-hosts" ]; then',
			'    cp "$D/screen" "$D/at-list-hosts"; sleep 0.3',
			'    printf "  play #1 (localhost): x\\n    hosts (1):\\n      localhost\\n"; exit 0',
			'  fi',
			'done',
			'printf "TASK [one] ***\\n"; sleep 2.7',
			'printf "BECOME password: "; sleep 2.7',
			'printf "\\nTASK [two] ***\\n"',
			'exit 0',
			''
		].join('\n'),
		{ mode: 0o755 }
	);
	process.env.PATH = `${dir}:${PATH}`;
});
afterEach(() => {
	term?.restore();
	term = null;
	process.env.PATH = PATH;
	rmSync(dir, { recursive: true, force: true });
});

describe('guided install: the pre-flight and the playbook’s silent stretches show the spinner', () => {
	it('spinner during --list-hosts; during a quiet stretch; cleared before the next output; never over a prompt', async () => {
		term = fakeTerminal({ mirror: join(dir, 'screen') });
		const r = await assembleInstall(
			{
				vars: {},
				secretsToSave: [],
				playbookPath: join(dir, 'playbook.yml'),
				varsFilePath: join(dir, 'vars.yml')
			},
			{
				writeVarsFile: () => {},
				removeVarsFile: () => {},
				promptSave: async () => {},
				ensureAnsible: async () => true,
				readOsRelease: () => '',
				print: () => {}
			}
		);
		const screen = term.out();
		term.restore();
		term = null;
		expect(r.ok).toBe(true);

		// The pre-flight ran under the spinner.
		expect(currentLine(readFileSync(join(dir, 'at-list-hosts'), 'utf8'))).toMatch(
			frameRe('Checking the install plan (Ansible pre-flight)…')
		);

		const one = screen.indexOf('TASK [one] ***\n');
		const prompt = screen.indexOf('BECOME password: ');
		const two = screen.indexOf('TASK [two] ***');
		expect(one).toBeGreaterThan(-1);
		expect(prompt).toBeGreaterThan(one);
		expect(two).toBeGreaterThan(prompt);
		// The quiet stretch after a complete line: the spinner turned, on its own line…
		const quiet = screen.slice(one, prompt);
		expect(spinnerFrames(quiet, 'Still working on this step…')).toBeGreaterThanOrEqual(2);
		// …and was cleared before the next output was written.
		expect(screen.slice(0, prompt).endsWith(`${CLEAR}\u001b[?25h`)).toBe(true);
		// The stretch after a partial line (a prompt waiting for input): no spinner,
		// the prompt stays intact on the screen.
		expect(screen.slice(prompt, two)).toBe('BECOME password: \n');
	}, 30_000);
});
