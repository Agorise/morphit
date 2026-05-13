import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, unlinkSync, rmSync, existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { KillSwitch } from '../src/policy/killSwitch.ts';

describe('KillSwitch', () => {
	let dataDir: string;
	let switches: KillSwitch[] = [];

	beforeEach(() => {
		dataDir = mkdtempSync(path.join(tmpdir(), 'morphit-kill-switch-'));
		switches = [];
	});

	afterEach(() => {
		for (const s of switches) s.close();
		switches = [];
		rmSync(dataDir, { recursive: true, force: true });
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

	it('detects file creation within ~1s poll interval', async () => {
		const ks = create();
		expect(ks.isActive()).toBe(false);

		// Operator does `touch <file>` mid-flight.
		writeFileSync(path.join(dataDir, 'SIGNUPS_DISABLED'), '');

		// Wait 1.5s for the next poll cycle.  Polling is on a 1s
		// interval; the test gives a margin.
		await new Promise((r) => setTimeout(r, 1500));

		expect(ks.isActive()).toBe(true);
	}, 5000);

	it('detects file removal within ~1s poll interval', async () => {
		const sentinel = path.join(dataDir, 'SIGNUPS_DISABLED');
		writeFileSync(sentinel, '');
		const ks = create();
		expect(ks.isActive()).toBe(true);

		// Operator removes the file (signups resume).
		unlinkSync(sentinel);

		await new Promise((r) => setTimeout(r, 1500));
		expect(ks.isActive()).toBe(false);
	}, 5000);

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
