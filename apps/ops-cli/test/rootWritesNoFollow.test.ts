/**
 * Review G1 (a regression of review B5): root code wrote with plain
 * writeFileSync into directories the unprivileged `morphit` account owns, so a
 * link that account planted made root overwrite the file it named. Each real
 * writer is pointed at a planted link here; the file the link names must come
 * out untouched.
 */
import {
	chownSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
	existsSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeWebHealState } from '../src/lib/webHeal.ts';
import { launchAfterRestartHeals } from '../src/lib/afterRestartHeal.ts';
import { writeNoticeMarker } from '../src/lib/journalNotice.ts';
import { healRelayStateDir } from '../src/lib/relayStateHeal.ts';
import { EndpointPool } from '@morphit/rpc-pool';

function planted() {
	const dir = mkdtempSync(join(tmpdir(), 'g1-'));
	const victim = join(dir, 'shadow');
	writeFileSync(victim, 'root:SECRET\n');
	return { dir, victim, intact: () => readFileSync(victim, 'utf8') === 'root:SECRET\n' };
}

describe('root writers never write through a planted link', () => {
	it('the web-heal state file', () => {
		const { dir, victim, intact } = planted();
		const p = join(dir, 'web-heal.json');
		symlinkSync(victim, p);
		writeWebHealState({ state: 'running', startedAt: new Date().toISOString() }, p);
		expect(intact()).toBe(true);
	});

	it('the after-restart log (created before systemd appends to it)', () => {
		const { dir, victim, intact } = planted();
		const p = join(dir, 'after-upgrade-heal.log');
		symlinkSync(victim, p);
		const old = process.env.MORPHIT_AFTER_RESTART_LOG;
		process.env.MORPHIT_AFTER_RESTART_LOG = p;
		try {
			const r = launchAfterRestartHeals({
				run: ((cmd: string) => ({ status: cmd === 'systemctl' ? 3 : 0 })) as never,
				cliPath: '/x/main.js',
				sinceUs: 1
			});
			expect(r).toBe('launched');
		} finally {
			if (old === undefined) delete process.env.MORPHIT_AFTER_RESTART_LOG;
			else process.env.MORPHIT_AFTER_RESTART_LOG = old;
		}
		expect(intact()).toBe(true);
		// …and systemd will append to a real file root made, not to the link.
		expect(readFileSync(p, 'utf8')).toBe('');
	});

	it('the journal notice marker', () => {
		const { dir, victim, intact } = planted();
		const p = join(dir, '.journal-signup-prefix-notice-done');
		symlinkSync(victim, p);
		try {
			writeNoticeMarker(p, 'done\n');
		} catch {
			/* refusing is fine; writing through is not */
		}
		expect(intact()).toBe(true);
	});

	it('the RPC health file (saved through a .tmp name)', () => {
		const { dir, victim, intact } = planted();
		const p = join(dir, 'rpc-health.json');
		symlinkSync(victim, `${p}.tmp`);
		const pool = new EndpointPool({
			endpoints: ['https://a.example'],
			healthStatePath: p
		} as never);
		pool.saveHealthState();
		expect(intact()).toBe(true);
	});

	it('the relay state move takes nothing from a directory the morphit account made', () => {
		const root = mkdtempSync(join(tmpdir(), 'g1r-'));
		mkdirSync(join(root, 'var/lib/morphit/relay'), { recursive: true });
		writeFileSync(join(root, 'var/lib/morphit/relay/SIGNUPS_DISABLED'), '');
		chownSync(join(root, 'var/lib/morphit/relay'), 65534, 65534);
		const r = healRelayStateDir(root);
		expect(r.kind).toBe('left-alone');
		expect(existsSync(join(root, 'var/lib/morphit-relay/SIGNUPS_DISABLED'))).toBe(false);
	});
});
