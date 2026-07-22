/**
 * Morphit ops CLI — backup freshness in `morphit-ops health` (v1.8.9).
 *
 * WHAT THIS PROTECTS. The built-in daily backup shipped in v1.8.4 and produced
 * nothing at all on Debian/Ubuntu for three releases: the script ran
 * `set -o pipefail` under dash, which kills the shell on the spot, so it died
 * silently before pg_dump every night. Nothing surfaced it, because `health`
 * checked the indexer, the relay, price feeds and the canary — and never once
 * looked at whether a backup existed.
 *
 * The states below are therefore not decoration. `failing` is the one that
 * would have caught that bug on day one: the timer fires, and leaves nothing
 * newer behind.
 *
 * The distinction that matters most for trust: `unreadable` must NEVER be
 * reported as `missing`. Telling an operator they have no backups because the
 * CLI lacked permission to look would be worse than saying nothing.
 */

import { describe, it, expect } from 'vitest';
import {
	checkBackups,
	formatBackupAge,
	formatBackupSize,
	BACKUP_STALE_AFTER_MS,
	BACKUP_TRIGGER_SLACK_MS,
	type BackupFacts
} from '../src/commands/health.ts';

const NOW = new Date('2026-07-22T18:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function facts(over: Partial<BackupFacts> = {}): BackupFacts {
	return {
		configured: true,
		readable: true,
		dir: '/home/morphit/backups',
		newest: {
			name: 'morphit-20260722-042219.sql.gz',
			atMs: NOW.getTime() - 13 * HOUR,
			bytes: 407487
		},
		lastTriggerMs: NOW.getTime() - 13 * HOUR,
		serviceFailed: false,
		...over
	};
}

describe('checkBackups', () => {
	it('reports a recent dump as fresh, carrying its name, age and size', () => {
		const s = checkBackups(facts(), NOW);
		expect(s.state).toBe('fresh');
		expect(s.newestName).toBe('morphit-20260722-042219.sql.gz');
		expect(s.bytes).toBe(407487);
		expect(s.ageMs).toBe(13 * HOUR);
	});

	it('an absent env file is "not configured", NOT a failure', () => {
		// Opting out of the built-in backup is a legitimate choice (an operator
		// may run their own). It must not be shouted about in red.
		const s = checkBackups(facts({ configured: false }), NOW);
		expect(s.state).toBe('not-configured');
	});

	it('cannot-look is "unreadable" and never "missing"', () => {
		// backup.env is 640 root:morphit and the dump dir is 700 morphit:morphit,
		// so another user genuinely cannot inspect either. Claiming "no backups"
		// on a permission error would be a false alarm about the operator's most
		// important disaster-recovery artefact.
		const s = checkBackups(facts({ readable: false, newest: null }), NOW);
		expect(s.state).toBe('unreadable');
		expect(s.state).not.toBe('missing');
	});

	it('flags a FAILED unit ahead of everything else, pointing at the journal', () => {
		const s = checkBackups(facts({ serviceFailed: true }), NOW);
		expect(s.state).toBe('failing');
		expect(s.detail).toContain('journalctl');
	});

	it('THE DASH-BUG CASE: the timer fired but left nothing newer behind', () => {
		// Exactly what three releases of silent failure looked like: a timer
		// firing nightly, a dump three days old, and no complaint anywhere.
		const s = checkBackups(
			facts({
				newest: { name: 'old.sql.gz', atMs: NOW.getTime() - 72 * HOUR, bytes: 400000 },
				lastTriggerMs: NOW.getTime() - 13 * HOUR
			}),
			NOW
		);
		expect(s.state).toBe('failing');
	});

	it('does not cry failure when a HAND-RUN dump is newer than the last trigger', () => {
		// `systemctl start` does not update the timer's LastTrigger, so a manual
		// run legitimately leaves a dump newer than it. That is health, not fault.
		const s = checkBackups(
			facts({
				newest: { name: 'manual.sql.gz', atMs: NOW.getTime() - 1 * HOUR, bytes: 414367 },
				lastTriggerMs: NOW.getTime() - 13 * HOUR
			}),
			NOW
		);
		expect(s.state).toBe('fresh');
	});

	it('tolerates a dump written slightly after its trigger (within the slack)', () => {
		const s = checkBackups(
			facts({
				newest: {
					name: 'slow.sql.gz',
					atMs: NOW.getTime() - 13 * HOUR + BACKUP_TRIGGER_SLACK_MS - 60_000,
					bytes: 400000
				},
				lastTriggerMs: NOW.getTime() - 13 * HOUR
			}),
			NOW
		);
		expect(s.state).toBe('fresh');
	});

	it('no dump at all, and the timer has fired → says it is running and failing', () => {
		const s = checkBackups(facts({ newest: null }), NOW);
		expect(s.state).toBe('missing');
		expect(s.detail).toContain('failing');
	});

	it('no dump and no trigger yet → tells the operator how to prove one', () => {
		const s = checkBackups(facts({ newest: null, lastTriggerMs: null }), NOW);
		expect(s.state).toBe('missing');
		expect(s.detail).toContain('systemctl start morphit-backup.service');
	});

	it('goes stale once a nightly run has clearly been missed', () => {
		const atMs = NOW.getTime() - (BACKUP_STALE_AFTER_MS + HOUR);
		const s = checkBackups(facts({ newest: { name: 'old.sql.gz', atMs, bytes: 1 }, lastTriggerMs: atMs }), NOW);
		expect(s.state).toBe('stale');
	});

	it('the stale window absorbs the timer jitter of a normal daily run', () => {
		// A daily timer with up to 30m randomised delay can legitimately land ~24.5h
		// apart. That must not read as stale, or the signal becomes noise operators
		// learn to ignore.
		const atMs = NOW.getTime() - 25 * HOUR;
		const s = checkBackups(facts({ newest: { name: 'ok.sql.gz', atMs, bytes: 1 }, lastTriggerMs: atMs }), NOW);
		expect(s.state).toBe('fresh');
		expect(BACKUP_STALE_AFTER_MS).toBeGreaterThan(24.5 * HOUR);
	});
});

describe('backup formatting', () => {
	it('formats ages the way an operator scans them', () => {
		expect(formatBackupAge(30_000)).toBe('just now');
		expect(formatBackupAge(45 * 60 * 1000)).toBe('45m ago');
		expect(formatBackupAge(13 * HOUR)).toBe('13h ago');
		expect(formatBackupAge(72 * HOUR)).toBe('3d ago');
	});

	it('formats sizes to match the `ls -lh` operators already read', () => {
		expect(formatBackupSize(512)).toBe('512B');
		expect(formatBackupSize(407487)).toBe('398K');
		expect(formatBackupSize(5 * 1024 * 1024)).toBe('5.0M');
	});
});
