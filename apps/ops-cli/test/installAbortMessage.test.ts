/**
 * Ctrl+C during the guided install says what happened and what to type next.
 *
 * 2026-10-12, a live install: the operator selected the database password on
 * the "save these" screen and pressed Ctrl+C by habit (copy). The wizard
 * printed "The install hit an unexpected problem and stopped", told them to
 * email support, and never said how to start again.
 */
import { describe, expect, it } from 'vitest';
import { createInterface } from 'node:readline/promises';
import { PassThrough } from 'node:stream';

import { describeInstallError, installRestartCommand } from '../src/init/assembleInstall.ts';
import { formatSecretsToSave } from '../src/init/saveSecrets.ts';

/** The error a readline prompt rejects with when it is aborted — a real one. */
async function realAbortError(): Promise<unknown> {
	const input = new PassThrough();
	const rl = createInterface({ input, output: new PassThrough() });
	const ac = new AbortController();
	const pending = rl.question('Type SAVED', { signal: ac.signal });
	ac.abort();
	try {
		await pending;
		return null;
	} catch (err) {
		return err;
	} finally {
		rl.close();
	}
}

const RESTART = 'cd /root/morphit && sudo bash morphit-setup.sh';

describe('the install stopped by Ctrl+C', () => {
	it('says it was stopped, not that something broke, and gives the command to start again', async () => {
		const err = await realAbortError();
		expect(err).not.toBeNull();
		const msg = describeInstallError(err, false, RESTART);
		expect(msg).toMatch(/Ctrl\+C/);
		expect(msg).not.toMatch(/unexpected problem/i);
		expect(msg).not.toContain('agorise@pm.me');
		expect(msg).toContain(RESTART);
	});

	it('the message readline uses for Ctrl+C itself is recognised too', () => {
		const err = Object.assign(new Error('Aborted with Ctrl+C'), {
			name: 'AbortError',
			code: 'ABORT_ERR'
		});
		const msg = describeInstallError(err, false, RESTART);
		expect(msg).not.toMatch(/unexpected problem/i);
		expect(msg).toContain(RESTART);
	});

	it('any other failure also names the command to run again', () => {
		const msg = describeInstallError(new Error('something nobody has seen'), false, RESTART);
		expect(msg).toMatch(/unexpected problem/i);
		expect(msg).toContain(RESTART);
	});
});

describe('installRestartCommand', () => {
	it('from the downloaded folder: back into it, then the setup script', () => {
		expect(installRestartCommand('install', '/root/morphit', true)).toBe(RESTART);
	});
	it('a folder name with a space or quote is quoted for the shell', () => {
		expect(installRestartCommand('install', "/srv/a b/it's", true)).toBe(
			"cd '/srv/a b/it'\\''s' && sudo bash morphit-setup.sh"
		);
	});
	it('without the setup script there: the installed command', () => {
		expect(installRestartCommand('install', '/opt/morphit', false)).toBe(
			'sudo morphit-ops install'
		);
		expect(installRestartCommand('init', '/opt/morphit', false)).toBe('sudo morphit-ops init');
	});
});

describe('the "save these" screen', () => {
	it('says how to copy without stopping the installer', () => {
		const block = formatSecretsToSave([{ label: 'Database password', value: 'x'.repeat(30) }]);
		expect(block).toMatch(/Ctrl\+Shift\+C/);
		expect(block).toMatch(/Ctrl\+C (alone )?stops the installer/);
	});
});
