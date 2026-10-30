/**
 * Step 12b of an upgrade: the snapshot timers. On morphit.io (v1.21.17) it
 * printed "This box is configured as the federation snapshot publisher (timer
 * armed)." whatever systemd did, and the weekly mirror timer had not run for
 * over a month (last 25 September, next 5 November) because it relied on
 * Persistent=, which systemd honours only for calendar timers (v1.21.17 audit,
 * M4/L9). The real armSnapshotTimers runs with a stand-in systemctl; the timer
 * file is read the way systemd reads its schedule (systemd-analyze).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO, stub } from './helpers/pty.ts';

const dirs: string[] = [];
const savedPath = process.env.PATH;
afterEach(() => {
	process.env.PATH = savedPath;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	vi.restoreAllMocks();
});

async function arm(active: boolean, next: string): Promise<{ out: string; calls: string }> {
	const d = mkdtempSync(join(tmpdir(), 'snap-timers-'));
	dirs.push(d);
	const bin = join(d, 'bin');
	mkdirSync(bin);
	const calls = join(d, 'calls');
	writeFileSync(calls, '');
	stub(
		bin,
		'systemctl',
		[
			`echo "$*" >> '${calls}'`,
			'case "$1" in',
			`  is-active) exit ${active ? 0 : 3} ;;`,
			`  show) echo '${next}' ;;`,
			'esac',
			'exit 0'
		].join('\n')
	);
	process.env.PATH = `${bin}:${savedPath}`;
	const install = join(d, 'opt');
	mkdirSync(join(install, 'ops', 'systemd'), { recursive: true });
	for (const u of ['morphit-snapshot-mirror.timer', 'morphit-snapshot-publish.timer'])
		writeFileSync(
			join(install, 'ops', 'systemd', u),
			readFileSync(join(REPO, 'ops', 'systemd', u), 'utf8')
		);
	const systemdDir = join(d, 'systemd');
	mkdirSync(systemdDir);
	writeFileSync(join(d, 'publish.env'), '');
	vi.resetModules();
	const { armSnapshotTimers } = await import('../src/commands/upgrade.ts');
	let out = '';
	const grab = (c: unknown): boolean => ((out += String(c)), true);
	vi.spyOn(process.stdout, 'write').mockImplementation(grab as never);
	vi.spyOn(process.stderr, 'write').mockImplementation(grab as never);
	await armSnapshotTimers(install, { systemdDir, publishEnv: join(d, 'publish.env') });
	vi.restoreAllMocks();
	return { out, calls: readFileSync(calls, 'utf8') };
}

describe('the publish timer is read back, not assumed', () => {
	it('running: said, with its next run', async () => {
		const { out, calls } = await arm(true, 'Thu 2026-10-30 00:14:39 UTC');
		expect(out).toMatch(
			/This box publishes the federation snapshot: its daily job is on \(checked; next run Thu 2026-10-30 00:14:39 UTC\)/
		);
		// a timer whose file changed is restarted so its new schedule counts
		expect(calls).toMatch(/restart morphit-snapshot-mirror\.timer/);
	});
	// v1.21.18 audit, M7: it had just run `enable --now`; advising the same
	// command again was circular. What systemd says about it is the next step.
	it('not running: a warning with where to look, never "armed" or "on", never the command that just failed', async () => {
		const { out, calls } = await arm(false, 'n/a');
		expect(calls).toMatch(/enable --now morphit-snapshot-publish\.timer/);
		expect(out).toMatch(
			/its daily timer did not start .*To see why, on this server: sudo systemctl status morphit-snapshot-publish\.timer and sudo journalctl -u morphit-snapshot-publish\.service -n 50 --no-pager/
		);
		expect(out).toMatch(
			/weekly snapshot mirror timer did not start .*To see why, on this server: sudo systemctl status morphit-snapshot-mirror\.timer and sudo journalctl -u morphit-snapshot-mirror\.service -n 50 --no-pager/
		);
		expect(out).not.toMatch(/enable --now/);
		expect(out).not.toMatch(/timer armed|daily job is on/);
	});
	// L7: it promised that "the mirror line below says how old the anchored
	// one is", which that line does not always say.
	it('running: promises nothing about another line', async () => {
		const { out } = await arm(true, 'Thu 2026-10-30 00:14:39 UTC');
		expect(out).not.toMatch(/line below/);
	});
});

/** L1: `Requires=` on the service made systemd start the mirror job the
 *  moment the timer started — at every boot, and at the upgrade's own
 *  `enable --now` / restart of the timer, alongside the upgrade's mirror step
 *  (systemd.unit(5): "If this unit gets activated, the units listed will be
 *  activated as well"). `Unit=` is all a timer needs (systemd.timer(5)). */
describe('the publish timer starts its job only on its schedule too', () => {
	const text = readFileSync(join(REPO, 'ops', 'systemd', 'morphit-snapshot-publish.timer'), 'utf8');
	const unit = text.slice(0, text.indexOf('[Timer]'));
	it('no Requires= / Wants= on its service', () => {
		expect(unit).not.toMatch(
			/^\s*(?:Requires|Wants|BindsTo|Requisite)=.*morphit-snapshot-publish\.service/m
		);
		expect(text).toMatch(/^Unit=morphit-snapshot-publish\.service$/m);
	});
});

describe('the mirror timer starts its job only on its schedule', () => {
	const text = readFileSync(join(REPO, 'ops', 'systemd', 'morphit-snapshot-mirror.timer'), 'utf8');
	const unit = text.slice(0, text.indexOf('[Timer]'));
	it('no Requires= / Wants= on its service (either starts it with the timer)', () => {
		expect(unit).not.toMatch(
			/^\s*(?:Requires|Wants|BindsTo|Requisite)=.*morphit-snapshot-mirror\.service/m
		);
	});
	it('Unit= names the job it runs', () => {
		expect(text).toMatch(/^Unit=morphit-snapshot-mirror\.service$/m);
	});
	it('systemd accepts the files as they are', () => {
		const d = mkdtempSync(join(tmpdir(), 'snap-units-'));
		dirs.push(d);
		for (const u of ['morphit-snapshot-mirror.timer', 'morphit-snapshot-mirror.service'])
			writeFileSync(join(d, u), readFileSync(join(REPO, 'ops', 'systemd', u), 'utf8'));
		const r = spawnSync('systemd-analyze', ['verify', join(d, 'morphit-snapshot-mirror.timer')], {
			encoding: 'utf8'
		});
		if (r.error) return; // no systemd-analyze here
		// Only what it says about the timer itself (the service's ExecStart
		// path does not exist on this machine).
		expect(`${r.stdout}${r.stderr}`).not.toMatch(/morphit-snapshot-mirror\.timer:\d+/);
	});
});

describe('the weekly mirror timer, as systemd reads it', () => {
	const text = readFileSync(join(REPO, 'ops', 'systemd', 'morphit-snapshot-mirror.timer'), 'utf8');
	const timer = new Map(
		text
			.slice(text.indexOf('[Timer]'))
			.split('\n')
			.filter((l) => /^\w+=/.test(l))
			.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const)
	);
	it('a calendar schedule (the only kind Persistent= keeps across downtime), a week apart', () => {
		expect(timer.get('Persistent')).toBe('true');
		expect(timer.has('OnUnitActiveSec')).toBe(false);
		const cal = timer.get('OnCalendar');
		expect(cal).toBeDefined();
		const r = spawnSync('systemd-analyze', ['calendar', '--iterations=2', cal!], {
			encoding: 'utf8',
			env: { ...process.env, TZ: 'UTC' }
		});
		if (r.error) return; // no systemd-analyze here
		const at = [...r.stdout.matchAll(/(?:Next elapse|Iteration #2): \w+ (\S+ \S+) UTC/g)].map((m) =>
			Date.parse(`${m[1]!.replace(' ', 'T')}Z`)
		);
		expect(at.length).toBe(2);
		expect(at[1]! - at[0]!).toBe(7 * 86_400_000);
	});
	it('its description says how often it runs: weekly', () => {
		expect(text).toMatch(/^Description=.*\bweekly\b/m);
		expect(text).not.toMatch(/^Description=.*\bmonthly\b/m);
	});
});
