/**
 * apt-monitor-exec-smoke (v1.24.7) — ops/scripts/morphit-apt-monitor.sh run for
 * real, with apt, apt-get, apt-config and unattended-upgrades answering as a
 * server would, its log and the restart flag given dates.
 *
 * The owner's goal: admins are not told about every security fix while the
 * server installs them by itself — only when that stops working. So: pending
 * security fixes with a successful automatic run in the last 2 days go to the
 * digest only; with none for 2 days (or ever), a WARN that says when the last
 * one was and how to look; with automatic updates off, the old alerts; and a
 * restart needed for 2 days or more goes to the digest, with the packages.
 *
 * Registered: `.:apt-monitor-exec-smoke`.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT =
	process.env.MORPHIT_APT_MONITOR_SCRIPT ?? join(REPO, 'ops/scripts/morphit-apt-monitor.sh');

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};

const DAY = 86_400_000;
const stamp = (msAgo: number): string =>
	new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);

console.log('apt-monitor-exec-smoke');
const work = mkdtempSync(join(tmpdir(), 'morphit-apt-monitor-'));
try {
	const bin = join(work, 'bin');
	mkdirSync(bin);
	const tool = (name: string, body: string): void => {
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	};
	tool('apt', 'printf "Listing...\\n%s" "$FAKE_UPGRADABLE"');
	tool('apt-get', 'exit 0');
	tool('apt-config', 'printf \'APT::Periodic::Unattended-Upgrade "%s";\\n\' "${FAKE_AUTO:-1}"');
	tool('unattended-upgrade', 'exit 0');
	const SEC2 =
		'libssl3t64/noble-updates,noble-security 3.0.13-0ubuntu3.17 amd64 [upgradable from: 3.0.13-0ubuntu3.16]\n' +
		'openssl/noble-updates,noble-security 3.0.13-0ubuntu3.17 amd64 [upgradable from: 3.0.13-0ubuntu3.16]\n' +
		'vim/noble-updates 2:9.1.0016-1ubuntu7.9 amd64 [upgradable from: 2:9.1.0016-1ubuntu7.8]\n';
	const uuLog = join(work, 'unattended-upgrades.log');
	const flag = join(work, 'reboot-required');

	const run = (o: {
		upgradable?: string;
		auto?: string;
		lastSuccess?: number | null;
		flagAge?: number | null;
		noUU?: boolean;
	}) => {
		rmSync(flag, { force: true });
		rmSync(`${flag}.pkgs`, { force: true });
		if (o.flagAge !== undefined && o.flagAge !== null) {
			writeFileSync(flag, '*** System restart required ***\n');
			writeFileSync(`${flag}.pkgs`, 'linux-image-6.8.0-149-generic\nlibc6\n');
			const t = (Date.now() - o.flagAge) / 1000;
			utimesSync(flag, t, t);
		}
		writeFileSync(
			uuLog,
			o.lastSuccess === null || o.lastSuccess === undefined
				? `${stamp(DAY)},000 INFO Starting unattended upgrades script\n`
				: `${stamp(o.lastSuccess + 60_000)},000 INFO Starting unattended upgrades script\n${stamp(o.lastSuccess)},017 INFO No packages found that can be upgraded unattended and no pending auto-removals\n`
		);
		if (o.noUU) rmSync(join(bin, 'unattended-upgrade'), { force: true });
		else tool('unattended-upgrade', 'exit 0');
		const state = mkdtempSync(join(work, 'emit-'));
		const r = spawnSync('sh', [SCRIPT], {
			encoding: 'utf8',
			timeout: 20_000,
			env: {
				PATH: `${bin}:/usr/bin:/bin`,
				JOURNAL_STREAM: '1:1',
				MORPHIT_EMIT_STATE_DIR: state,
				MORPHIT_APT_UU_LOG: uuLog,
				MORPHIT_APT_REBOOT_FLAG: flag,
				// This machine may have the real one: the stand-in is asked for by name.
				MORPHIT_APT_UU_CMD: join(bin, 'unattended-upgrade'),
				FAKE_UPGRADABLE: o.upgradable ?? SEC2,
				FAKE_AUTO: o.auto ?? '1'
			}
		});
		const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
		const events = out
			.split('\n')
			.filter((l) => l.includes('"event":'))
			.map(
				(l) => JSON.parse(l) as { level: string; event: string; context: Record<string, unknown> }
			);
		return { out, events, names: events.map((e) => e.event).join(',') };
	};

	{
		const r = run({ lastSuccess: 5 * 3_600_000 });
		check(
			'automatic updates working (a successful run 5 hours ago): only the digest line, no alert',
			r.names === 'updates_pending_info',
			r.out.trim()
		);
	}
	{
		const r = run({ lastSuccess: 3 * DAY });
		const e = r.events.find((x) => x.event === 'automatic_updates_stalled');
		check(
			'no successful run for 3 days: automatic_updates_stalled (WARN), and nothing else',
			r.names === 'automatic_updates_stalled' && e?.level === 'warn',
			r.out.trim()
		);
		check(
			'…saying when the last one was and how to look',
			e?.context.last_success === '3 day(s) ago' &&
				/sudo unattended-upgrade -v --dry-run/.test(String(e?.context.hint)) &&
				e?.context.security_updates === 2,
			JSON.stringify(e)
		);
	}
	{
		const r = run({ lastSuccess: null });
		const e = r.events.find((x) => x.event === 'automatic_updates_stalled');
		check(
			'never a successful run: stalled, "never"',
			e?.context.last_success === 'never (no successful run in its log)',
			r.out.trim()
		);
	}
	{
		const r = run({ auto: '0', lastSuccess: 5 * 3_600_000 });
		check(
			'automatic updates off: pending security fixes are reported as before (security_updates_warn)',
			r.names === 'security_updates_warn',
			r.out.trim()
		);
		const n = run({ noUU: true, lastSuccess: 5 * 3_600_000 });
		check(
			'unattended-upgrades not installed: reported as before',
			n.names === 'security_updates_warn',
			n.out.trim()
		);
	}
	{
		const r = run({
			upgradable: 'vim/noble-updates 2:9.1 amd64 [upgradable from: 2:9.0]\n',
			lastSuccess: 3 * DAY
		});
		check(
			'no security fix waiting: a stalled log alone is not reported',
			r.names === 'updates_pending_info',
			r.out.trim()
		);
	}
	{
		const r = run({ lastSuccess: 5 * 3_600_000, flagAge: 3 * DAY });
		const e = r.events.find((x) => x.event === 'restart_pending');
		check(
			'a restart needed for 3 days: restart_pending for the digest (INFO), with the packages',
			e?.level === 'info' &&
				e?.context.days === 3 &&
				e?.context.packages === 'linux-image-6.8.0-149-generic libc6',
			JSON.stringify(e)
		);
		check(
			'…saying it restarts by itself (not with someone logged in), and how to now',
			/unless someone is logged in when the day's updates finish\. To restart now, on this server: sudo reboot/.test(
				String(e?.context.hint)
			),
			String(e?.context.hint)
		);
		const fresh = run({ lastSuccess: 5 * 3_600_000, flagAge: DAY / 2 });
		check(
			'a restart needed since today: not reported (tonight handles it)',
			!fresh.names.includes('restart_pending'),
			fresh.out.trim()
		);
		const quiet = run({ upgradable: '', flagAge: 3 * DAY });
		check(
			'nothing to update but a restart overdue: still reported (before the early exit)',
			quiet.names === 'restart_pending',
			quiet.out.trim()
		);
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}
console.log(
	fail === 0
		? `\n✓ all ${pass} apt-monitor-exec checks passed`
		: `\n✗ apt-monitor-exec: ${pass} passed, ${fail} failed`
);
process.exit(fail === 0 ? 0 : 1);
