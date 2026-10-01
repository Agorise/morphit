/**
 * v1.20.1 — reading BunkerWeb's own verdict, and keeping one copy of Morphit's
 * API exemption. The log lines below are morphitir's real ones (2026-09-30),
 * trimmed of visitor-free noise.
 */
import { describe, expect, it } from 'vitest';
import {
	nginxRefusal,
	readSchedulerCycle,
	schedulerCycleMs,
	waitForSchedulerCycle,
	type SchedulerCycle
} from '../src/lib/bunkerwebScheduler.ts';
import { copyCount, planRuleDedupe, type RuleRow } from '../src/lib/bunkerwebRuleDedupe.ts';

const MORPHITIR_SCHED = `2026-09-30T19:01:18.247232553Z [2026-09-30 19:01:18 +0000] [SCHEDULER] [22] [❌] - At least one job in run_once() failed
2026-09-30T19:01:19.130424794Z [2026-09-30 19:01:19 +0000] [GENERATOR] [246] [ℹ️ ] - Generator started ...
2026-09-30T19:01:19.634453863Z [2026-09-30 19:01:19 +0000] [GENERATOR] [246] [ℹ️ ] - Generator successfully executed !
2026-09-30T19:01:21.500507745Z [2026-09-30 19:01:21 +0000] [API] [22] [❌] - Error while sending API request to http://bunkerweb:5000/reload : status = error, msg = config check failed
2026-09-30T19:01:21.503551573Z [2026-09-30 19:01:21 +0000] [SCHEDULER] [22] [❌] - Error while reloading bunkerweb, failing over to last working configuration ...
2026-09-30T19:01:23.157396730Z [2026-09-30 19:01:23 +0000] [API] [22] [ℹ️ ] - Successfully sent API request to http://bunkerweb:5000/reload
2026-09-30T19:01:23.173132228Z [2026-09-30 19:01:23 +0000] [SCHEDULER] [22] [ℹ️ ] - Executing job scheduler ...`;
const MORPHITIR_EDGE = `2026-09-30T19:01:20.964503161Z 2026/09/30 19:01:20 [notice] 58#58: *19 [API] Checking Nginx configuration, client: <ip>, server: bwapi
2026-09-30T19:01:21.494933837Z 2026/09/30 19:01:20 [emerg] 162#162: "modsecurity_rules_file" directive Rule id: 1990001 is duplicated
2026-09-30T19:01:21.495023802Z nginx: [emerg] "modsecurity_rules_file" directive Rule id: 1990001 is duplicated`;
const HEALTHY_SCHED = `[GENERATOR] [246] [ℹ️ ] - Generator successfully executed !
[API] [22] [ℹ️ ] - Successfully sent API request to http://bunkerweb:5000/reload
[SCHEDULER] [22] [ℹ️ ] - Executing job scheduler ...`;

describe('readSchedulerCycle — BunkerWeb’s own verdict on the config it built', () => {
	it('morphitir: a refused config is REFUSED even though a reload succeeded after it (the failover)', () => {
		const c = readSchedulerCycle(MORPHITIR_SCHED, MORPHITIR_EDGE);
		expect(c.kind).toBe('refused');
		expect((c as { reason: string }).reason).toContain(
			'"modsecurity_rules_file" directive Rule id: 1990001 is duplicated'
		);
	});
	it('a refusal without the edge log still says the config test failed', () => {
		const c = readSchedulerCycle(MORPHITIR_SCHED);
		expect(c).toEqual({
			kind: 'refused',
			reason: "BunkerWeb's own config test failed, so it kept serving its previous config"
		});
	});
	it('a clean rebuild is LOADED', () => {
		expect(readSchedulerCycle(HEALTHY_SCHED)).toEqual({ kind: 'loaded' });
	});
	it('jobs still running (no reload yet) is PENDING', () => {
		expect(
			readSchedulerCycle('[SCHEDULER] - Executing job mmdb-country from plugin jobs ...')
		).toEqual({
			kind: 'pending'
		});
		expect(readSchedulerCycle('')).toEqual({ kind: 'pending' });
	});
	it('nginxRefusal reads the first [emerg] reason', () => {
		expect(nginxRefusal(MORPHITIR_EDGE)).toBe(
			'"modsecurity_rules_file" directive Rule id: 1990001 is duplicated'
		);
		expect(nginxRefusal('2026/09/30 [notice] fine')).toBeNull();
	});
});

describe('schedulerCycleMs — how long a rebuild takes on THIS box', () => {
	it('morphitir: started 18:59:23.888, config generated 19:01:19.634 → ~116 s', () => {
		const logs = `2026-09-30T18:59:51.543659051Z [SCHEDULER] - Executing job bunkernet-data ...
2026-09-30T19:01:19.634453863Z [2026-09-30 19:01:19 +0000] [GENERATOR] [246] [ℹ️ ] - Generator successfully executed !`;
		expect(schedulerCycleMs('2026-09-30T18:59:23.887935443Z', logs)).toBe(115_747);
	});
	it('unknown when the log has no generated config or the start is unreadable', () => {
		expect(schedulerCycleMs('2026-09-30T18:59:23Z', 'nothing here')).toBeNull();
		expect(schedulerCycleMs('not a date', MORPHITIR_SCHED)).toBeNull();
	});
});

describe('waitForSchedulerCycle — waits for the verdict as long as the budget allows, never silently', () => {
	const clock = () => {
		let t = 0;
		return { now: () => t, sleep: (ms: number) => void (t += ms) };
	};
	it('returns the verdict as soon as it appears, with the time waited', () => {
		const k = clock();
		const seq: SchedulerCycle[] = [{ kind: 'pending' }, { kind: 'pending' }, { kind: 'loaded' }];
		const r = waitForSchedulerCycle({
			scheduler: 's',
			edge: null,
			sinceIso: '',
			budgetMs: 600_000,
			pollMs: 3_000,
			...k,
			read: () => seq.shift() ?? { kind: 'loaded' }
		});
		expect(r).toEqual({ kind: 'loaded', waitedMs: 6_000 });
	});
	it('a two-minute rebuild (morphitir) fits the default budget and prints progress while it waits', () => {
		const k = clock();
		const notes: string[] = [];
		const r = waitForSchedulerCycle({
			scheduler: 's',
			edge: null,
			sinceIso: '',
			budgetMs: 8 * 60_000,
			...k,
			note: (m) => notes.push(m),
			read: () => (k.now() >= 116_000 ? { kind: 'loaded' } : { kind: 'pending' })
		});
		expect(r.kind).toBe('loaded');
		expect(notes.length).toBeGreaterThanOrEqual(3);
		expect(notes[0]).toMatch(/still waiting for BunkerWeb/);
	});
	it('gives up as PENDING at the budget', () => {
		const k = clock();
		const r = waitForSchedulerCycle({
			scheduler: 's',
			edge: null,
			sinceIso: '',
			budgetMs: 30_000,
			...k,
			read: () => ({ kind: 'pending' })
		});
		expect(r.kind).toBe('pending');
		expect(r.waitedMs).toBeGreaterThanOrEqual(30_000);
	});
});

const row = (
	id: number,
	name: string,
	method: string,
	serviceId: string | null = null
): RuleRow => ({
	id,
	serviceId,
	type: 'modsec',
	name,
	method,
	checksum: null,
	data: ''
});

describe('planRuleDedupe — exactly one copy of the API exemption', () => {
	it('morphitir: the setting’s copy stays, the imported file copy goes', () => {
		const p = planRuleDedupe({
			rows: [row(5, 'morphit_json_api_off', 'scheduler'), row(6, 'morphit-json-api-off', 'manual')],
			files: ['/data/configs/modsec/morphit_json_api_off.conf']
		});
		expect(p.keep).toBe('morphit_json_api_off (scheduler)');
		expect(p.removeRows.map((r) => r.id)).toEqual([6]);
		expect(p.removeFiles).toEqual([]);
	});
	it('a stray file (not yet imported) goes; the setting’s rendered file stays', () => {
		const p = planRuleDedupe({
			rows: [row(5, 'morphit_json_api_off', 'scheduler')],
			files: [
				'/data/configs/modsec/morphit_json_api_off.conf',
				'/data/configs/modsec/morphit-json-api-off.conf'
			]
		});
		expect(p.removeRows).toEqual([]);
		expect(p.removeFiles).toEqual(['/data/configs/modsec/morphit-json-api-off.conf']);
	});
	it('without the setting’s copy, the OLDEST other copy stays — the API is never left without one', () => {
		const p = planRuleDedupe({
			rows: [row(9, 'dup-b', 'manual'), row(6, 'morphit-json-api-off', 'manual')],
			files: []
		});
		expect(p.keep).toBe('morphit-json-api-off (manual)');
		expect(p.removeRows.map((r) => r.id)).toEqual([9]);
	});
	it('a per-site copy with the setting’s name is still an extra copy', () => {
		const p = planRuleDedupe({
			rows: [
				row(5, 'morphit_json_api_off', 'scheduler'),
				row(7, 'morphit_json_api_off', 'manual', 'example.org')
			],
			files: []
		});
		expect(p.removeRows.map((r) => r.id)).toEqual([7]);
	});
	it('copyCount: morphit.io (one) vs morphitir (two)', () => {
		expect(
			copyCount({
				rows: [row(5, 'morphit_json_api_off', 'scheduler')],
				files: ['/data/configs/modsec/morphit_json_api_off.conf']
			})
		).toBe(1);
		expect(
			copyCount({
				rows: [
					row(5, 'morphit_json_api_off', 'scheduler'),
					row(6, 'morphit-json-api-off', 'manual')
				],
				files: []
			})
		).toBe(2);
	});
	it('an unreadable database plans nothing from rows', () => {
		expect(planRuleDedupe({ rows: null, files: [] })).toEqual({
			keep: null,
			removeRows: [],
			removeFiles: []
		});
	});
});
