/**
 * v1.20.1 — morphitir's relay exited with status 0 when its boot awaited a
 * chain call that never settled (Node drained its event loop), and systemd's
 * Restart=on-failure left it down for three days. These run REAL Node
 * processes: a hanging await must now end in status 1 (restarted), a requested
 * shutdown still in 0.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	resolveDataDir,
	DEFAULT_RELAY_DATA_DIR,
	LEGACY_RELAY_DATA_DIR
} from '../src/config/index.ts';
import { withBootTimeout } from '../src/lib/processGuard.ts';

// The relay's shape: `main().catch(…)` whose boot awaits a promise that never
// settles (not a top-level await, which Node reports with its own status 13).
const HANG =
	"async function main() { await new Promise(() => {}); console.log('unreachable'); }\nmain().catch(() => process.exit(1));";
const GUARD = join(import.meta.dirname, '..', 'src', 'lib', 'processGuard.ts');

function runScript(body: string): { status: number | null; out: string } {
	const d = mkdtempSync(join(tmpdir(), 'relay-guard-'));
	try {
		const f = join(d, 'x.mts');
		writeFileSync(f, `import { installDrainGuard } from ${JSON.stringify(GUARD)};\n${body}\n`);
		const r = spawnSync(process.execPath, ['--import', 'tsx', f], {
			encoding: 'utf8',
			timeout: 30_000
		});
		return { status: r.status, out: `${r.stdout}${r.stderr}` };
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
}

describe('the relay never ends quietly (installDrainGuard, real processes)', () => {
	it('an await that never settles (the morphitir boot) → status 1 and a logged reason', () => {
		const r = runScript("installDrainGuard((n) => console.log('LOGGED ' + n));\n" + HANG);
		expect(r.status).toBe(1);
		expect(r.out).toMatch(/LOGGED the relay had nothing left to run/);
	});
	it('without the guard the same process exits 0 — exactly what systemd did not restart', () => {
		const r = runScript('void installDrainGuard;\n' + HANG);
		expect(r.status).toBe(0);
	});
	it('a requested shutdown still ends with status 0', () => {
		const r = runScript(
			"const g = installDrainGuard((n) => console.log('LOGGED ' + n));\ng.shuttingDown();\n" + HANG
		);
		expect(r.status).toBe(0);
		expect(r.out).not.toMatch(/LOGGED/);
	});
});

describe('withBootTimeout', () => {
	it('a boot call that never answers is turned into an error the boot can handle', async () => {
		await expect(
			withBootTimeout(new Promise(() => {}), 50, 'the chain (clock check)')
		).rejects.toThrow(/the chain \(clock check\) did not answer within 0 s/);
	});
	it('an answer passes through', async () => {
		await expect(withBootTimeout(Promise.resolve(7), 1_000, 'x')).resolves.toBe(7);
	});
});

describe('the relay state directory (v1.20.1)', () => {
	it('defaults to /var/lib/morphit-relay — outside /var/lib/morphit, which the relay cannot enter', () => {
		expect(DEFAULT_RELAY_DATA_DIR).toBe('/var/lib/morphit-relay');
		expect(resolveDataDir({})).toBe('/var/lib/morphit-relay');
	});
	it('an install whose env still names the v1.20.0 default gets the new one', () => {
		expect(resolveDataDir({ MORPHIT_RELAY_DATA_DIR: LEGACY_RELAY_DATA_DIR })).toBe(
			DEFAULT_RELAY_DATA_DIR
		);
		expect(resolveDataDir({ MORPHIT_RELAY_DATA_DIR: '/var/lib/morphit/relay/' })).toBe(
			DEFAULT_RELAY_DATA_DIR
		);
	});
	it('an operator’s own path is kept', () => {
		expect(resolveDataDir({ MORPHIT_RELAY_DATA_DIR: '/srv/relay-state' })).toBe('/srv/relay-state');
	});
});
