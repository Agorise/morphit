/**
 * v1.21.15 — a node that keeps clearnet NTP gets the clock fallback: when NTP
 * cannot keep the clock, it is set from onion time sources over Tor.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
	CLOCK_FALLBACK_UNITS,
	healClockFallback,
	realClockFallbackRuntime
} from '../src/lib/clockFallbackHeal.ts';
import { selfHealSteps } from '../src/commands/upgrade.ts';
import { disableAndRemoveUnits } from '../src/lib/installUnits.ts';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const ctx = { info: () => {}, warn: () => {}, spinner: () => () => {} };
const saved = { ...process.env };
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
	Object.assign(process.env, saved);
});

function box(): { systemd: string; helpers: string } {
	const root = mkdtempSync(join(tmpdir(), 'clock-fallback-'));
	dirs.push(root);
	process.env.MORPHIT_SYSTEMD_DIR = join(root, 'systemd');
	process.env.MORPHIT_HELPER_DIR = join(root, 'helpers');
	process.env.MORPHIT_HEAL_NO_SYSTEMD = '1';
	mkdirSync(process.env.MORPHIT_SYSTEMD_DIR, { recursive: true });
	return { systemd: process.env.MORPHIT_SYSTEMD_DIR, helpers: process.env.MORPHIT_HELPER_DIR };
}

describe('the clock fallback heal', () => {
	it('on a node that keeps clearnet: installs both scripts and the units, runs the fallback script, then is a no-op', () => {
		const { systemd, helpers } = box();
		const rt = { ...realClockFallbackRuntime(REPO), hiddenOnly: () => false };
		const r = healClockFallback(ctx, rt);
		expect(r.strategy).toBe('installed');
		// The fallback script runs the time check from its own directory: both.
		for (const name of ['morphit-tor-timesync.sh', 'morphit-clock-fallback.sh']) {
			const script = join(helpers, name);
			expect(readFileSync(script, 'utf8')).toBe(
				readFileSync(join(REPO, 'ops/tor-only', name), 'utf8')
			);
			expect(statSync(script).mode & 0o111).not.toBe(0);
		}
		for (const u of CLOCK_FALLBACK_UNITS) {
			expect(readFileSync(join(systemd, u), 'utf8')).toBe(
				readFileSync(join(REPO, 'ops/systemd', u), 'utf8')
			);
		}
		expect(readFileSync(join(systemd, 'morphit-clock-fallback.service'), 'utf8')).toMatch(
			// No option the time check of an older release would not know.
			/^ExecStart=\/usr\/local\/lib\/morphit\/morphit-clock-fallback\.sh$/m
		);
		expect(readFileSync(join(systemd, 'morphit-clock-fallback.timer'), 'utf8')).toMatch(
			/^Unit=morphit-clock-fallback\.service$/m
		);
		// Not started with the timer at boot: NTP gets its first 30 minutes.
		expect(readFileSync(join(systemd, 'morphit-clock-fallback.timer'), 'utf8')).not.toMatch(
			/^Requires=/m
		);
		expect(readFileSync(join(systemd, 'morphit-clock-fallback.timer'), 'utf8')).toMatch(
			/^OnBootSec=30min$/m
		);
		expect(healClockFallback(ctx, rt)).toMatchObject({ strategy: 'already', routine: true });
	});

	it('on a hidden-only node: nothing (its own Tor time check keeps the clock)', () => {
		const { systemd } = box();
		const r = healClockFallback(ctx, { ...realClockFallbackRuntime(REPO), hiddenOnly: () => true });
		expect(r.strategy).toBe('skipped-hidden-only');
		expect(() => statSync(join(systemd, 'morphit-clock-fallback.timer'))).toThrow();
	});

	it('a node switched to hidden-only after it got the fallback: the fallback units are removed (never both timers)', () => {
		const { systemd } = box();
		const rt = realClockFallbackRuntime(REPO);
		expect(healClockFallback(ctx, { ...rt, hiddenOnly: () => false }).strategy).toBe('installed');
		for (const u of CLOCK_FALLBACK_UNITS) expect(statSync(join(systemd, u)).isFile()).toBe(true);
		const r = healClockFallback(ctx, { ...rt, hiddenOnly: () => true });
		expect(r).toMatchObject({ strategy: 'removed-hidden-only', verified: true });
		for (const u of CLOCK_FALLBACK_UNITS) expect(() => statSync(join(systemd, u))).toThrow();
		// Then quiet.
		expect(healClockFallback(ctx, { ...rt, hiddenOnly: () => true })).toMatchObject({
			strategy: 'skipped-hidden-only',
			routine: true
		});
	});

	it('stops and disables the timer before removing the files (systemd)', () => {
		const { systemd } = box();
		const calls: string[] = [];
		healClockFallback(ctx, { ...realClockFallbackRuntime(REPO), hiddenOnly: () => false });
		const r = disableAndRemoveUnits({
			systemdDir: systemd,
			units: CLOCK_FALLBACK_UNITS,
			timer: 'morphit-clock-fallback.timer',
			exec: (cmd, args) => {
				calls.push(`${cmd} ${args.join(' ')}`);
				return { status: 0, stdout: '' };
			}
		});
		expect(r.ok).toBe(true);
		expect(calls).toEqual([
			'systemctl disable --now morphit-clock-fallback.timer',
			'systemctl daemon-reload'
		]);
	});

	it('says what to run when the units cannot be removed on a hidden-only node', () => {
		const r = healClockFallback(ctx, {
			hiddenOnly: () => true,
			installScripts: () => true,
			installUnits: () => ({ ok: true, written: [], timerRunning: true }),
			removeUnits: () => ({ ok: false, removed: [], detail: 'EACCES' })
		});
		expect(r.verified).toBe(false);
		expect(r.detail).toMatch(/sudo systemctl disable --now morphit-clock-fallback\.timer/);
	});

	it('says what to run when a script cannot be installed', () => {
		const r = healClockFallback(ctx, {
			hiddenOnly: () => false,
			installScripts: () => false,
			installUnits: () => ({ ok: true, written: [], timerRunning: true }),
			removeUnits: () => ({ ok: true, removed: [] })
		});
		expect(r.verified).toBe(false);
		expect(r.detail).toMatch(/sudo morphit-ops upgrade --heals/);
	});

	it('says what to run when the timer cannot be turned on', () => {
		const r = healClockFallback(ctx, {
			hiddenOnly: () => false,
			installScripts: () => true,
			removeUnits: () => ({ ok: true, removed: [] }),
			installUnits: () => ({
				ok: false,
				written: [],
				timerRunning: false,
				detail: 'timer not active'
			})
		});
		expect(r.verified).toBe(false);
		expect(r.detail).toMatch(/sudo systemctl enable --now morphit-clock-fallback\.timer/);
	});

	it('runs in the upgrade, among the self-heals', () => {
		expect(selfHealSteps().map(([n]) => n)).toContain('the clock fallback heal');
	});
});
