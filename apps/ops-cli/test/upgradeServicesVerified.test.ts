/**
 * "Every service restarted on it (checked)." in the upgrade's last lines
 * follows what the restart step SAW (v1.21.4 review): each service restarted on
 * the new version and seen to stay up. A service that was down before and
 * could not be started, or no service restarted at all, is not "every service
 * restarted". Driven through the real restart step with a stand-in `systemctl`
 * on PATH.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { restartServicesOnNewVersion } = await import('../src/commands/upgrade.ts');

const SVCS = ['morphit-indexer.service', 'morphit-relay.service'];
let d = '';
const saved: Record<string, string | undefined> = {};
const KEYS = ['PATH', 'CALLS', 'FAKE_ACTIVE', 'FAKE_ENABLED', 'FAKE_FAIL_RESTART'];

beforeEach(() => {
	d = mkdtempSync(join(tmpdir(), 'svc-verified-'));
	for (const k of KEYS) saved[k] = process.env[k];
	writeFileSync(
		join(d, 'systemctl'),
		[
			'#!/bin/sh',
			'echo "$*" >> "$CALLS"',
			'case "$1" in',
			'  is-active) for u in $FAKE_ACTIVE; do [ "$u" = "$3" ] && exit 0; done; exit 3 ;;',
			'  is-enabled) for u in $FAKE_ENABLED; do [ "$u" = "$2" ] && { echo enabled; exit 0; }; done; echo disabled; exit 1 ;;',
			'  restart) for u in $FAKE_FAIL_RESTART; do [ "$u" = "$2" ] && exit 1; done; exit 0 ;;',
			'  show) case "$3" in ActiveState) echo active ;; NRestarts) echo 0 ;; esac; exit 0 ;;',
			'esac',
			'exit 0',
			''
		].join('\n'),
		{ mode: 0o755 }
	);
	process.env.PATH = `${d}:${saved.PATH ?? ''}`;
	process.env.CALLS = join(d, 'calls');
	writeFileSync(process.env.CALLS, '');
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	rmSync(d, { recursive: true, force: true });
});

const restarts = (): string[] =>
	readFileSync(join(d, 'calls'), 'utf8')
		.split('\n')
		.filter((l) => l.startsWith('restart '));

describe('the restart step tells the last lines what it saw', () => {
	it('each service restarted and seen to stay up: verified', async () => {
		process.env.FAKE_ACTIVE = SVCS.join(' ');
		const r = await restartServicesOnNewVersion(SVCS);
		expect(r).toEqual({ verified: true });
		expect(restarts().length).toBe(2);
	}, 60_000);

	it('no service restarted at all (none running or enabled): not verified', async () => {
		process.env.FAKE_ACTIVE = '';
		process.env.FAKE_ENABLED = '';
		const r = await restartServicesOnNewVersion(SVCS);
		expect(r).toEqual({ verified: false });
		expect(restarts()).toEqual([]);
	}, 60_000);

	it('one down before the upgrade that could not be started: not verified, and no roll-back', async () => {
		process.env.FAKE_ACTIVE = 'morphit-relay.service';
		process.env.FAKE_ENABLED = 'morphit-indexer.service';
		process.env.FAKE_FAIL_RESTART = 'morphit-indexer.service';
		const r = await restartServicesOnNewVersion(SVCS);
		expect(r).toEqual({ verified: false });
		expect(restarts().length).toBe(2);
	}, 60_000);

	it('a running service that cannot be restarted on the new version: roll back', async () => {
		process.env.FAKE_ACTIVE = SVCS.join(' ');
		process.env.FAKE_FAIL_RESTART = 'morphit-relay.service';
		const r = await restartServicesOnNewVersion(SVCS);
		expect('rollback' in r && r.rollback instanceof Error).toBe(true);
	}, 60_000);
});
