/**
 * A rollback puts back what the upgrade changed OUTSIDE the install dir
 * (v1.18.0 deep-deep, ops-5).
 *
 * The self-heal phase edits /etc/morphit/relay.env (the relay hidden-RPC heal,
 * which keeps a `.before-v1.18.0-relay-heal` copy) and the upgrade refreshes
 * systemd units (keeping `<unit>.bak`). A later service-restart failure rolled
 * /opt/morphit back but left those files on the NEW version's settings — an
 * old relay then starting on a config it may not understand. rollback() now
 * restores every file the run recorded, before restarting services.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	copyFileSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rollback, selfHealRestoreList, snapshotSelfHealBackups } from '../src/commands/upgrade.ts';

let root = '';
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'morphit-rollback-'));
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

describe('rollback restores the self-heal backups this run made', () => {
	it('relay.env and a refreshed unit are put back exactly', () => {
		const installDir = join(root, 'opt-morphit');
		const backupDir = `${installDir}.bak-1`;
		const tmp = join(root, 'tmp');
		mkdirSync(installDir);
		mkdirSync(backupDir);
		mkdirSync(tmp);
		writeFileSync(join(backupDir, 'release-info.json'), '{"tag":"v1.17.15"}');
		writeFileSync(join(installDir, 'release-info.json'), '{"tag":"v1.18.0"}');

		const etc = join(root, 'etc');
		mkdirSync(etc);
		const relayEnv = join(etc, 'relay.env');
		writeFileSync(relayEnv, 'MORPHIT_RELAY_ACCOUNT=x\n');
		const before = readFileSync(relayEnv, 'utf8');

		// What the run records before the self-heal phase…
		const snap = snapshotSelfHealBackups([relayEnv]);
		// …what the heal then did…
		copyFileSync(relayEnv, `${relayEnv}.before-v1.18.0-relay-heal`);
		writeFileSync(relayEnv, `${before}\nMORPHIT_RELAY_BLURT_RPC=''\n`);
		// …and a unit refreshed from the new template.
		const unit = join(root, 'morphit-relay.service');
		writeFileSync(`${unit}.bak`, '[Service]\nOLD\n');
		writeFileSync(unit, '[Service]\nNEW\n');

		const restore = [
			...selfHealRestoreList(snap, installDir),
			{ target: unit, backup: `${unit}.bak`, isUnit: true }
		];
		const rc = rollback(
			installDir,
			backupDir,
			tmp,
			new Error('restart failed'),
			undefined,
			restore
		);

		expect(rc).toBe(3);
		expect(readFileSync(join(installDir, 'release-info.json'), 'utf8')).toContain('v1.17.15');
		expect(readFileSync(relayEnv, 'utf8'), 'the relay was left on the new settings').toBe(before);
		expect(readFileSync(unit, 'utf8'), 'the unit was left on the new template').toBe(
			'[Service]\nOLD\n'
		);
	});

	it('a heal backup left by an EARLIER upgrade is not restored', () => {
		const etc = join(root, 'etc');
		mkdirSync(etc);
		const relayEnv = join(etc, 'relay.env');
		writeFileSync(relayEnv, 'healed-long-ago\n');
		writeFileSync(`${relayEnv}.before-v1.18.0-relay-heal`, 'pre-heal\n');
		const snap = snapshotSelfHealBackups([relayEnv]);
		// This run's heal found nothing to do: the backup is untouched.
		expect(selfHealRestoreList(snap, join(root, 'opt'))).toEqual([]);
	});

	it('a file inside the install dir is left to the directory swap', () => {
		const installDir = join(root, 'opt-morphit');
		mkdirSync(installDir);
		const envInside = join(installDir, 'morphit.env');
		writeFileSync(envInside, 'x\n');
		const snap = snapshotSelfHealBackups([envInside]);
		copyFileSync(envInside, `${envInside}.before-v1.18.0-relay-heal`);
		expect(selfHealRestoreList(snap, installDir)).toEqual([]);
		expect(existsSync(`${envInside}.before-v1.18.0-relay-heal`)).toBe(true);
	});
});
