import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, unlinkSync, rmSync, existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { KillSwitch } from '../src/policy/killSwitch.ts';

describe('KillSwitch', () => {
	let dataDir: string;
	let switches: KillSwitch[] = [];

	beforeEach(() => {
		// cp76-D16: replaced real-time setTimeout(1500) with fake timers
		// to eliminate the CI-flake class.  The poll interval is 1000ms;
		// 1500ms real-time wait gave only 500ms margin under CPU contention,
		// which sometimes vanished on slow runners.  Fake timers advance
		// the poll deterministically without any real-time sensitivity.
		//
		// Fake timers MUST be installed BEFORE `new KillSwitch(...)` runs
		// so its constructor's `setInterval()` uses the fake scheduler.
		vi.useFakeTimers();
		dataDir = mkdtempSync(path.join(tmpdir(), 'morphit-kill-switch-'));
		switches = [];
	});

	afterEach(() => {
		for (const s of switches) s.close();
		switches = [];
		rmSync(dataDir, { recursive: true, force: true });
		// Restore real timers so the next test's beforeEach starts clean
		// and any timer-using test that didn't opt into fakes works.
		vi.useRealTimers();
	});

	function create(): KillSwitch {
		const ks = new KillSwitch(dataDir);
		switches.push(ks);
		return ks;
	}

	it('inactive when sentinel file does not exist', () => {
		const ks = create();
		expect(ks.isActive()).toBe(false);
	});

	it('active immediately at startup if sentinel file exists', () => {
		const sentinel = path.join(dataDir, 'SIGNUPS_DISABLED');
		writeFileSync(sentinel, '');
		const ks = create();
		// Initial poll is synchronous in the constructor — no
		// polling-window wait required for startup state.
		expect(ks.isActive()).toBe(true);
	});

	it('exposes the sentinel path for operator-facing logs', () => {
		const ks = create();
		expect(ks.getPath()).toBe(path.join(dataDir, 'SIGNUPS_DISABLED'));
	});

	it('detects file creation within ~1s poll interval', () => {
		const ks = create();
		expect(ks.isActive()).toBe(false);

		// Operator does `touch <file>` mid-flight.
		writeFileSync(path.join(dataDir, 'SIGNUPS_DISABLED'), '');

		// Advance the fake clock past the 1s poll interval.  The poll
		// callback runs synchronously when the timer fires (checkFile()
		// + assignment), so the assertion below sees the updated state
		// without any await.  No real-time sensitivity.
		vi.advanceTimersByTime(1100);

		expect(ks.isActive()).toBe(true);
	});

	it('detects file removal within ~1s poll interval', () => {
		const sentinel = path.join(dataDir, 'SIGNUPS_DISABLED');
		writeFileSync(sentinel, '');
		const ks = create();
		expect(ks.isActive()).toBe(true);

		// Operator removes the file (signups resume).
		unlinkSync(sentinel);

		vi.advanceTimersByTime(1100);
		expect(ks.isActive()).toBe(false);
	});

	it('close() stops the polling timer', () => {
		const ks = create();
		// No assertion needed beyond "doesn't throw" — afterEach
		// would also call close(), so calling here twice should
		// be idempotent and silent.
		ks.close();
		ks.close();
	});

	it('handles non-existent dataDir gracefully (treated as inactive)', () => {
		const ghost = path.join(dataDir, 'does-not-exist-and-never-will');
		const ks = new KillSwitch(ghost);
		switches.push(ks);
		// No throw on construction; just inactive.  The KillSwitch
		// is permissive about its dataDir not existing — the
		// operator may not have created the dir yet, and that
		// shouldn't crash the relay.
		expect(ks.isActive()).toBe(false);
	});
});
