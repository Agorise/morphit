/**
 * The canary lines of `morphit-ops health` give a command that works where the
 * canary is signed (review, 2026-10-12): signed on this server (the install
 * wizard runs setup.sh as root), its refresh script is root's; `bash
 * ~/.morphit/update-canary.sh`, typed by the operator, found nothing.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCanary } from '../src/commands/health.ts';

const now = new Date('2026-10-12T12:00:00Z');
const dir = mkdtempSync(join(tmpdir(), 'canary-hint-'));
const soon = join(dir, 'canary.txt');
writeFileSync(soon, 'Generated: 2026-10-01T00:00:00Z\nValid through: 2026-10-13T00:00:00Z\n');

describe('the canary refresh command health gives', () => {
	it('signed on this server: root’s script, with sudo', () => {
		expect(checkCanary(join(dir, 'none.txt'), now, true).detail).toContain(
			'sudo bash /root/.morphit/update-canary.sh'
		);
		expect(checkCanary(soon, now, true).detail).toContain(
			'sudo bash /root/.morphit/update-canary.sh'
		);
	});
	it('signed elsewhere: on that computer', () => {
		const d = checkCanary(soon, now, false).detail;
		expect(d).toContain('bash ~/.morphit/update-canary.sh');
		expect(d).not.toContain('/root/');
	});
});
