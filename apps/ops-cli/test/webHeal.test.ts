/**
 * v1.20.1 — the web-proxy heals run in the background on a BunkerWeb box
 * (lib/webHeal.ts): the upgrade's heal child is killed at 300 s, and a slow
 * BunkerWeb needs minutes per rebuild (morphitir, 2026-09-30).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	WEB_HEAL_SUBCOMMAND,
	WEB_HEAL_UNIT,
	describeWebHeal,
	followWebHeal,
	launchWebHeal,
	readWebHealState,
	writeWebHealState,
	webHealStatusRow,
	type WebHealState
} from '../src/lib/webHeal.ts';
import { readFileSync } from 'node:fs';

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	delete process.env.MORPHIT_WEB_HEAL_STATE;
	delete process.env.MORPHIT_WEB_HEAL_LOG;
});
const tmp = (): string => {
	const d = mkdtempSync(join(tmpdir(), 'webheal-'));
	dirs.push(d);
	process.env.MORPHIT_WEB_HEAL_STATE = join(d, 'web-heal.json');
	process.env.MORPHIT_WEB_HEAL_LOG = join(d, 'web-heal.log');
	return d;
};

type Call = [string, readonly string[]];
const fakeRun = (answers: Record<string, number>, calls: Call[]) =>
	((cmd: string, args: readonly string[]) => {
		calls.push([cmd, args]);
		return { status: answers[cmd] ?? 0, stdout: '', stderr: '' };
	}) as never;

describe('launchWebHeal — its own short-lived systemd unit', () => {
	it('starts `morphit-ops __web-heal` as morphit-web-heal, bounded, removed when done, logging to the progress file', () => {
		tmp();
		const calls: Call[] = [];
		const r = launchWebHeal({
			run: fakeRun({ systemctl: 3, 'systemd-run': 0 }, calls),
			nodePath: '/usr/bin/node',
			cliPath: '/opt/morphit/apps/ops-cli/dist/main.js'
		});
		expect(r).toBe('launched');
		const sr = calls.find(([c]) => c === 'systemd-run')![1];
		expect(sr).toContain(`--unit=${WEB_HEAL_UNIT}`);
		expect(sr).toContain('--collect');
		expect(sr.some((a) => /^--property=RuntimeMaxSec=\d+$/.test(a))).toBe(true);
		expect(sr.some((a) => a.startsWith('--property=StandardOutput=append:'))).toBe(true);
		expect(sr.slice(-3)).toEqual([
			'/usr/bin/node',
			'/opt/morphit/apps/ops-cli/dist/main.js',
			WEB_HEAL_SUBCOMMAND
		]);
	});
	it('one already at work is followed, never started twice', () => {
		tmp();
		const calls: Call[] = [];
		expect(launchWebHeal({ run: fakeRun({ systemctl: 0 }, calls), cliPath: '/x.js' })).toBe(
			'already-running'
		);
		expect(calls.some(([c]) => c === 'systemd-run')).toBe(false);
	});
	it('no systemd-run → unavailable (the upgrade then runs the heals itself)', () => {
		tmp();
		expect(
			launchWebHeal({ run: fakeRun({ systemctl: 3, 'systemd-run': 127 }, []), cliPath: '/x.js' })
		).toBe('unavailable');
	});
});

describe('followWebHeal — shows the progress, stops at the result or the deadline', () => {
	it('echoes each new log line once and returns the finished state', async () => {
		const d = tmp();
		const log = join(d, 'web-heal.log');
		writeFileSync(log, '');
		let t = 0;
		const started = new Date(1_000).toISOString();
		const seen: string[] = [];
		const steps = [
			() => appendFileSync(log, 'WAF: removed 1 extra copy\nWAF: BunkerWeb is rebuil'),
			() => appendFileSync(log, 'ding its settings…\n\u001b[?25l  ⠋ spinner\r\u001b[K'),
			() =>
				writeWebHealState({
					state: 'done',
					startedAt: started,
					finishedAt: started,
					result: 'applied'
				})
		];
		const s = await followWebHeal(600_000, 1_000, {
			now: () => t,
			sleep: async (ms) => {
				t += ms;
				steps.shift()?.();
			},
			info: (m) => seen.push(m),
			spinner: () => () => {}
		});
		expect(s?.result).toBe('applied');
		expect(seen).toEqual([
			'WAF: removed 1 extra copy',
			'WAF: BunkerWeb is rebuilding its settings…',
			'  ⠋ spinner'
		]);
	});
	it('a previous run’s finished state is not mistaken for this one', async () => {
		tmp();
		writeWebHealState({ state: 'done', startedAt: new Date(0).toISOString(), result: 'applied' });
		let t = 0;
		const s = await followWebHeal(10_000, 600_000, {
			now: () => t,
			sleep: async (ms) => void (t += ms),
			info: () => {},
			spinner: () => () => {}
		});
		expect(s).toBeNull();
	});
	it('returns null at the deadline while it is still running', async () => {
		tmp();
		writeWebHealState({ state: 'running', startedAt: new Date(5_000).toISOString() });
		let t = 0;
		const s = await followWebHeal(20_000, 5_000, {
			now: () => t,
			sleep: async (ms) => void (t += ms),
			info: () => {},
			spinner: () => () => {}
		});
		expect(s).toBeNull();
		expect(t).toBeGreaterThanOrEqual(20_000);
	});
});

describe('the state file and its one line in `morphit-ops status`', () => {
	it('round-trips, and a torn or foreign file reads as unknown', () => {
		const d = tmp();
		const s: WebHealState = { state: 'running', startedAt: '2026-09-30T20:00:00.000Z' };
		writeWebHealState(s);
		expect(readWebHealState()).toEqual(s);
		writeFileSync(join(d, 'web-heal.json'), '{"state":"weird"');
		expect(readWebHealState()).toBeNull();
	});
	it('says what happened, calmly, with the reason when it was not applied', () => {
		const now = Date.parse('2026-09-30T20:10:00Z');
		expect(describeWebHeal({ state: 'running', startedAt: '2026-09-30T20:07:00Z' }, now)).toBe(
			'being applied in the background (started 3 min ago)'
		);
		expect(
			describeWebHeal(
				{
					state: 'done',
					startedAt: '2026-09-30T20:00:00Z',
					finishedAt: '2026-09-30T20:09:30Z',
					result: 'applied'
				},
				now
			)
		).toBe('applied and checked (just now)');
		expect(
			describeWebHeal(
				{
					state: 'done',
					startedAt: '2026-09-30T20:00:00Z',
					finishedAt: '2026-09-30T20:05:00Z',
					result: 'rolled-back',
					detail: "BunkerWeb's own config test failed (x)"
				},
				now
			)
		).toBe(
			"not applied — BunkerWeb's own config test failed (x); the previous settings were put back (5 min ago)"
		);
	});
});

// v1.21.1 review (D-2): a country list left in BunkerWeb read "not applied
// (left-alone: …)" — an internal token, and "not applied" although every
// privacy setting was in place — and `morphit-ops status` said "Privacy
// settings: not applied" for ever after.
describe('every outcome is said in words, and status says what is in place (D-2)', () => {
	const t = '2026-10-06T12:00:00.000Z';
	const done = (result: string, detail?: string): WebHealState => ({
		state: 'done',
		startedAt: t,
		finishedAt: t,
		result,
		...(detail ? { detail } : {})
	});
	const KINDS = [
		'applied',
		'already',
		'no-proxy',
		'country-list',
		'unchecked',
		'left-alone',
		'invalid-compose',
		'no-time',
		'rolled-back',
		'apply-failed',
		'error'
	];
	it('no outcome shows its internal name', () => {
		for (const k of KINDS) {
			const line = describeWebHeal(done(k, 'why'), Date.parse(t));
			if (k.includes('-')) expect(line, k).not.toContain(k);
			expect(line, k).not.toMatch(
				/\((?:left-alone|invalid-compose|no-time|apply-failed|error|unknown)\b/
			);
		}
	});
	it('a country list BunkerWeb still runs with: in place, except that list — never "not applied"', () => {
		const s = done(
			'country-list',
			'BunkerWeb still turns away visitors from CN, IR (BLACKLIST_COUNTRY=CN IR)'
		);
		const line = describeWebHeal(s, Date.parse(t));
		expect(line).not.toMatch(/not applied/);
		expect(line).toMatch(/BLACKLIST_COUNTRY=CN IR/);
		const row = webHealStatusRow(s);
		expect(row.value).not.toMatch(/not applied/);
		expect(row.status).toBe('warn');
	});
	it('a check that could not run is shown, calmly: not ok, not a failure', () => {
		const row = webHealStatusRow(done('unchecked', 'x'));
		expect(row.status).toBe('info');
		expect(row.value).not.toMatch(/not applied|ok/);
	});
	it('applied, already and no web containers stay ok; a roll-back is "not applied"', () => {
		for (const k of ['applied', 'already', 'no-proxy'])
			expect(webHealStatusRow(done(k))).toEqual({ value: 'ok', status: 'ok' });
		expect(webHealStatusRow(done('rolled-back', 'x'))).toEqual({
			value: 'not applied',
			status: 'warn'
		});
		expect(webHealStatusRow({ state: 'running', startedAt: t }).value).toBe('applying');
	});
	it('`morphit-ops status` renders its row from webHealStatusRow (the call site)', () => {
		const src = readFileSync(new URL('../src/commands/status.ts', import.meta.url), 'utf8');
		const block = src.slice(
			src.indexOf("label: 'Privacy settings:'"),
			src.indexOf("label: 'Privacy settings:'") + 400
		);
		expect(src).toMatch(/const whRow = webHealStatusRow\(wh\);/);
		expect(block).toMatch(/value: whRow\.value/);
		expect(block).toMatch(/status: whRow\.status/);
		expect(block).not.toMatch(/'not applied'/);
	});
});
