/**
 * Morphit ops CLI — smoke runner.
 *
 * Exercises the pure-logic helpers that every subcommand depends
 * on:
 *   - parseDurationSpec / formatDuration / relativeTime /
 *     ageSeconds / utcMidnightToday from lib/time.ts
 *   - applyThreshold from config.ts
 *
 * Doesn't exercise commands themselves (those need a live DB)
 * or the main.ts arg parser (separate scope).
 *
 * Usage (from apps/ops-cli):
 *   tsx scripts/ops-cli-smoke.ts
 */

import {
	parseDurationSpec,
	formatDuration,
	relativeTime,
	ageSeconds,
	utcMidnightToday
} from '../src/lib/time.ts';
import { applyThreshold } from '../src/config.ts';
import type { Threshold } from '../src/config.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${label}: expected ${e}, got ${a}`);
	}
}

// ─── parseDurationSpec ───────────────────────────────────────────

scenario('parseDurationSpec: seconds', () => {
	assertEqual(parseDurationSpec('30s'), 30, '30s');
	assertEqual(parseDurationSpec('0s'), 0, '0s');
});

scenario('parseDurationSpec: minutes', () => {
	assertEqual(parseDurationSpec('5m'), 300, '5m');
});

scenario('parseDurationSpec: hours', () => {
	assertEqual(parseDurationSpec('1h'), 3600, '1h');
	assertEqual(parseDurationSpec('24h'), 86400, '24h');
});

scenario('parseDurationSpec: days', () => {
	assertEqual(parseDurationSpec('7d'), 7 * 86400, '7d');
});

scenario('parseDurationSpec: case-insensitive unit', () => {
	assertEqual(parseDurationSpec('5M'), 300, '5M');
	assertEqual(parseDurationSpec('1H'), 3600, '1H');
	assertEqual(parseDurationSpec('1D'), 86400, '1D');
});

scenario('parseDurationSpec: whitespace tolerated', () => {
	assertEqual(parseDurationSpec('5 m'), 300, '5 m');
	assertEqual(parseDurationSpec('1  h'), 3600, '1  h');
});

scenario('parseDurationSpec: rejects empty', () => {
	assertEqual(parseDurationSpec(''), null, 'empty');
});

scenario('parseDurationSpec: rejects bare number', () => {
	assertEqual(parseDurationSpec('5'), null, '5');
});

scenario('parseDurationSpec: rejects bare unit', () => {
	assertEqual(parseDurationSpec('m'), null, 'm');
});

scenario('parseDurationSpec: rejects unknown unit', () => {
	assertEqual(parseDurationSpec('5x'), null, '5x');
	assertEqual(parseDurationSpec('5min'), null, '5min');
});

scenario('parseDurationSpec: rejects negative', () => {
	assertEqual(parseDurationSpec('-5m'), null, '-5m');
});

scenario('parseDurationSpec: rejects non-numeric', () => {
	assertEqual(parseDurationSpec('abc'), null, 'abc');
});

// ─── formatDuration ──────────────────────────────────────────────

scenario('formatDuration: zero and negative', () => {
	assertEqual(formatDuration(0), '0s', '0');
	assertEqual(formatDuration(-1), '0s', '-1');
});

scenario('formatDuration: sub-minute', () => {
	assertEqual(formatDuration(1), '1s', '1');
	assertEqual(formatDuration(59), '59s', '59');
});

scenario('formatDuration: minutes with seconds', () => {
	assertEqual(formatDuration(60), '1m', '60');
	assertEqual(formatDuration(90), '1m 30s', '90');
	assertEqual(formatDuration(125), '2m 5s', '125');
});

scenario('formatDuration: hours with minutes', () => {
	assertEqual(formatDuration(3600), '1h', '3600');
	assertEqual(formatDuration(3660), '1h 1m', '3660');
	assertEqual(formatDuration(7320), '2h 2m', '7320');
});

scenario('formatDuration: days with hours', () => {
	assertEqual(formatDuration(86400), '1d', '86400');
	assertEqual(formatDuration(86400 + 3600), '1d 1h', '1d1h');
	assertEqual(formatDuration(86400 * 3 + 3600 * 5), '3d 5h', '3d5h');
});

scenario('formatDuration: floors fractional', () => {
	assertEqual(formatDuration(59.9), '59s', '59.9');
	assertEqual(formatDuration(120.7), '2m', '120.7');
});

// ─── relativeTime ────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-04-26T12:00:00Z');

scenario('relativeTime: just now', () => {
	const then = new Date('2026-04-26T11:59:58Z');
	assertEqual(relativeTime(then, FIXED_NOW), 'just now', 'just now');
});

scenario('relativeTime: seconds ago', () => {
	const then = new Date('2026-04-26T11:59:30Z');
	assertEqual(relativeTime(then, FIXED_NOW), '30s ago', '30s');
});

scenario('relativeTime: minutes ago', () => {
	const then = new Date('2026-04-26T11:55:00Z');
	assertEqual(relativeTime(then, FIXED_NOW), '5m ago', '5m');
});

scenario('relativeTime: hours ago', () => {
	const then = new Date('2026-04-26T08:00:00Z');
	assertEqual(relativeTime(then, FIXED_NOW), '4h ago', '4h');
});

scenario('relativeTime: days ago', () => {
	const then = new Date('2026-04-23T12:00:00Z');
	assertEqual(relativeTime(then, FIXED_NOW), '3d ago', '3d');
});

scenario('relativeTime: months ago', () => {
	const then = new Date('2026-02-01T00:00:00Z');
	assertEqual(relativeTime(then, FIXED_NOW), '2mo ago', '2mo');
});

scenario('relativeTime: future date', () => {
	const then = new Date('2026-04-26T12:01:00Z');
	assertEqual(relativeTime(then, FIXED_NOW), 'in the future', 'future');
});

// ─── ageSeconds ──────────────────────────────────────────────────

scenario('ageSeconds: positive seconds', () => {
	const now = new Date('2026-04-26T12:00:00Z');
	const then = new Date('2026-04-26T11:59:30Z');
	assertEqual(ageSeconds(then, now), 30, '30');
});

scenario('ageSeconds: floors to integer', () => {
	const now = new Date('2026-04-26T12:00:00.500Z');
	const then = new Date('2026-04-26T11:59:59.000Z');
	assertEqual(ageSeconds(then, now), 1, '1');
});

// ─── utcMidnightToday ────────────────────────────────────────────

scenario('utcMidnightToday: returns UTC 00:00:00 of given date', () => {
	const now = new Date('2026-04-26T15:30:00Z');
	const midnight = utcMidnightToday(now);
	assertEqual(midnight.toISOString(), '2026-04-26T00:00:00.000Z', 'mid');
});

scenario('utcMidnightToday: handles late-evening UTC', () => {
	const now = new Date('2026-04-26T23:59:59Z');
	const midnight = utcMidnightToday(now);
	assertEqual(midnight.toISOString(), '2026-04-26T00:00:00.000Z', 'late');
});

// ─── applyThreshold ──────────────────────────────────────────────

scenario('applyThreshold: lower_worse — value above warn is ok', () => {
	const t: Threshold = { warn: 100, error: 30, direction: 'lower_worse' };
	assertEqual(applyThreshold(150, t), 'ok', '150');
	assertEqual(applyThreshold(101, t), 'ok', '101');
});

scenario('applyThreshold: lower_worse — value at warn is warn', () => {
	const t: Threshold = { warn: 100, error: 30, direction: 'lower_worse' };
	assertEqual(applyThreshold(100, t), 'warn', '100');
	assertEqual(applyThreshold(50, t), 'warn', '50');
});

scenario('applyThreshold: lower_worse — value at or below error is error', () => {
	const t: Threshold = { warn: 100, error: 30, direction: 'lower_worse' };
	assertEqual(applyThreshold(30, t), 'error', '30');
	assertEqual(applyThreshold(0, t), 'error', '0');
});

scenario('applyThreshold: higher_worse — small value is ok', () => {
	const t: Threshold = { warn: 5, error: 30, direction: 'higher_worse' };
	assertEqual(applyThreshold(0, t), 'ok', '0');
	assertEqual(applyThreshold(4, t), 'ok', '4');
});

scenario('applyThreshold: higher_worse — value at warn is warn', () => {
	const t: Threshold = { warn: 5, error: 30, direction: 'higher_worse' };
	assertEqual(applyThreshold(5, t), 'warn', '5');
	assertEqual(applyThreshold(20, t), 'warn', '20');
});

scenario('applyThreshold: higher_worse — value at or above error is error', () => {
	const t: Threshold = { warn: 5, error: 30, direction: 'higher_worse' };
	assertEqual(applyThreshold(30, t), 'error', '30');
	assertEqual(applyThreshold(100, t), 'error', '100');
});

// ─── cp186 — wizard-UX surface (edit reminder, init re-run guard, main menu) ───
// Source-invariant checks: these pin the operator-facing UX so the
// affordances (re-register reminder, Edit/Overwrite/Cancel guard,
// the menu) can't silently regress.  Runtime behaviour is exercised
// by hand; here we lock the structural guarantees.
import { readFileSync as _rf } from 'node:fs';
import { fileURLToPath as _fu } from 'node:url';
import { dirname as _dn, join as _jn } from 'node:path';
const _cmd = _jn(_dn(_fu(import.meta.url)), '..', 'src', 'commands');
const _src = (f: string): string => _rf(_jn(_cmd, f), 'utf-8');

scenario('cp186: edit reminds operator to re-register after an origin/tag change', () => {
	const e = _src('edit.ts');
	assertEqual(e.includes('originChanged = true'), true, 'edit tracks origin change');
	assertEqual(e.includes('tagChanged = true'), true, 'edit tracks tag change');
	assertEqual(/if \(originChanged \|\| tagChanged\)/.test(e), true, 'edit gates reminder on origin/tag change');
	assertEqual(e.includes('morphit-ops register'), true, 'edit names the re-register command');
	assertEqual(
		e.includes('record other Morphit') || e.includes('reach the federation'),
		true,
		'edit explains WHY (federation visibility)'
	);
});

scenario('cp186: init re-run guard offers Edit/Overwrite/Cancel and can hand off to edit', () => {
	const i = _src('init.ts');
	assertEqual(i.includes('This instance is already set up'), true, 'init detects existing config with a heading');
	assertEqual(i.includes('Edit a few settings (recommended)'), true, 'init offers Edit (recommended)');
	assertEqual(i.includes('Overwrite EVERYTHING'), true, 'init offers Overwrite');
	assertEqual(i.includes('return await runEdit('), true, 'init hands off to edit in-process');
	// The destructive path must still double-confirm before overwriting.
	assertEqual(/Are you sure\? This replaces your entire instance config/.test(i), true, 'init double-confirms overwrite');
});

scenario('cp186: bare morphit-ops opens a menu on a TTY but keeps help+exit1 for scripts', () => {
	const m = _src('mainMenu.ts');
	assertEqual(m.includes('export async function runMainMenu'), true, 'runMainMenu exported');
	// Menu must offer the high-value actions the operator asked for.
	for (const sub of ['edit', 'upgrade', 'register', 'init', 'status', 'harden']) {
		assertEqual(new RegExp(`subcommand: '${sub}'`).test(m), true, `menu offers '${sub}'`);
	}
	const main = _rf(_jn(_dn(_fu(import.meta.url)), '..', 'src', 'main.ts'), 'utf-8');
	assertEqual(
		main.includes("process.stdin.isTTY === true && args.flags['no-menu'] !== 'true'"),
		true,
		'main gates the menu on an interactive TTY (and --no-menu opt-out)'
	);
	assertEqual(/if \(!interactive\) \{\s*printHelp\(\);\s*return 1;/.test(main), true, 'non-interactive keeps help+exit1');
});

scenario('cp187: harden is a standalone subcommand that reuses the shared checklist renderer', () => {
	const h = _src('harden.ts');
	assertEqual(h.includes('export async function runHarden'), true, 'runHarden exported');
	// It must REUSE the init step functions + the shared renderer, not
	// re-implement hardening guidance (no drift from setup).
	assertEqual(h.includes("from '../init/steps.ts'"), true, 'harden reuses init step functions');
	assertEqual(h.includes('renderHardeningChecklist'), true, 'harden reuses the shared checklist renderer');
	assertEqual(h.includes('stepBunkerWeb') && h.includes('stepHardening') && h.includes('stepBackup'), true, 'harden walks BunkerWeb + host + backups');
	// The renderer must be exported from render.ts for harden to import.
	const r = _rf(_jn(_cmd, '..', 'init', 'render.ts'), 'utf-8');
	assertEqual(r.includes('export function renderHardeningChecklist'), true, 'renderHardeningChecklist is exported');
	assertEqual(r.includes('export interface HardeningChecklistInput'), true, 'minimal checklist input type exported');
	// main.ts must dispatch harden BEFORE loadConfig (no DB needed).
	const main = _rf(_jn(_dn(_fu(import.meta.url)), '..', 'src', 'main.ts'), 'utf-8');
	assertEqual(main.includes("args.subcommand === 'harden'"), true, 'main dispatches harden');
});

// ─── Summary ─────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
