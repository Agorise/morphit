/**
 * An atomic config/keystore replace keeps the file's owner, group and mode
 * (request): the unprivileged services read
 * root:morphit 0640 files, and `morphit-ops edit` used to leave them
 * root:root 0600 until the next service start repaired them.
 */
import { describe, it, expect } from 'vitest';
import { chmodSync, chownSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicEnvWrite } from '../src/commands/edit.ts';

const root = typeof process.getuid === 'function' && process.getuid() === 0;

describe('atomicEnvWrite', () => {
	it('keeps mode 0640 (and, as root, the owner) of the file it replaces', () => {
		const d = mkdtempSync(join(tmpdir(), 'keepown-'));
		const p = join(d, 'morphit.config.env');
		writeFileSync(p, 'MORPHIT_X=1\n');
		chmodSync(p, 0o640);
		if (root) chownSync(p, 0, 4321);
		const r = atomicEnvWrite(p, 'MORPHIT_X=1\n', new Map([['MORPHIT_X', '2']]));
		expect(r.ok).toBe(true);
		expect(readFileSync(p, 'utf8')).toMatch(/MORPHIT_X=2/);
		const st = statSync(p);
		expect(st.mode & 0o777).toBe(0o640);
		if (root) expect(st.gid).toBe(4321);
	});
});

describe('the guided install’s relay keystore write', () => {
	it.skipIf(!root)(
		'keeps the group an existing keystore had (the relay reads it through it)',
		async () => {
			const { writeRelayKeystore } = await import('../src/init/runAnsibleInstall.ts');
			const d = mkdtempSync(join(tmpdir(), 'keepown-'));
			const p = join(d, 'relay.keystore');
			writeFileSync(p, 'old');
			chmodSync(p, 0o640);
			chownSync(p, 0, 4321);
			writeRelayKeystore({ mode: 'plaintext', plaintextWif: '5Kxxx' } as never, p);
			expect(readFileSync(p, 'utf8')).toBe('5Kxxx');
			expect(statSync(p).gid).toBe(4321);
			expect(statSync(p).mode & 0o777).toBe(0o640);
		}
	);
});
