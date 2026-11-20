/**
 * auto-install-exec-smoke (v1.24.7) — ops/scripts/morphit-auto-install.sh,
 * the nightly install of a security release, run for real against a stand-in
 * install whose tsx answers as `morphit-ops` would: the check
 * (`__auto-install-check`, one line of JSON and an exit code) and the upgrade
 * (`upgrade --yes`, which on success writes the new release-info.json).
 *
 * What it must do: nothing (and no alert) when there is nothing to install;
 * run the ordinary upgrade when the check says so, log its output, and alert
 * the digest only when the install READS BACK as the new version; a WARN with
 * the log otherwise; a CRITICAL for a release record that failed its check; and
 * its units must run it early in the morning as root, never on boot.
 *
 * Registered: `.:auto-install-exec-smoke`.
 */
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT =
	process.env.MORPHIT_AUTO_INSTALL_SCRIPT ?? join(REPO, 'ops/scripts/morphit-auto-install.sh');
const UNIT_DIR = join(REPO, 'ops/systemd');

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

console.log('auto-install-exec-smoke');
const work = mkdtempSync(join(tmpdir(), 'morphit-auto-install-'));
try {
	const root = join(work, 'opt-morphit');
	const cliDir = join(root, 'apps/ops-cli/src');
	mkdirSync(cliDir, { recursive: true });
	mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
	writeFileSync(join(cliDir, 'main.ts'), '// stand-in\n');
	const calls = join(work, 'tsx-calls.log');
	const tsx = join(root, 'node_modules/.bin/tsx');
	// The check prints $FAKE_DECISION and exits $FAKE_DECISION_RC; the upgrade
	// prints a line, writes release-info.json with $FAKE_UPGRADE_TAG when given,
	// and exits $FAKE_UPGRADE_RC.
	writeFileSync(
		tsx,
		`#!/bin/sh
printf 'cwd=%s args=%s\\n' "$(pwd)" "$*" >> "${calls}"
case "$*" in
  *__auto-install-check*)
    printf '%s\\n' "$FAKE_DECISION"
    exit "\${FAKE_DECISION_RC:-0}" ;;
  *"upgrade --yes"*)
    echo "upgrade output: Integrity verified (onchain-anchored-sha256)"
    [ -n "\${FAKE_UPGRADE_TAG:-}" ] && printf '{\\n  "tag": "%s",\\n  "commit": "x"\\n}\\n' "$FAKE_UPGRADE_TAG" > "${root}/release-info.json"
    exit "\${FAKE_UPGRADE_RC:-0}" ;;
esac
exit 99
`
	);
	chmodSync(tsx, 0o755);
	const bin = join(work, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'node'), '#!/bin/sh\nexit 0\n');
	chmodSync(join(bin, 'node'), 0o755);
	const log = join(work, 'log/auto-install.log');

	const run = (
		env: Record<string, string>
	): { out: string; events: Array<Record<string, unknown>> } => {
		writeFileSync(join(root, 'release-info.json'), '{\n  "tag": "v1.24.7",\n  "commit": "x"\n}\n');
		rmSync(calls, { force: true });
		const state = mkdtempSync(join(work, 'emit-'));
		const r = spawnSync('sh', [SCRIPT], {
			cwd: '/',
			encoding: 'utf8',
			timeout: 20_000,
			env: {
				PATH: `${bin}:/usr/bin:/bin`,
				HOME: work,
				JOURNAL_STREAM: '1:1',
				MORPHIT_EMIT_STATE_DIR: state,
				MORPHIT_OPS_CLI_PATH: join(cliDir, 'main.ts'),
				MORPHIT_AUTO_INSTALL_LOG: log,
				...env
			}
		});
		const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
		const events = out
			.split('\n')
			.filter((l) => l.includes('"event":'))
			.map((l) => {
				try {
					return JSON.parse(l) as Record<string, unknown>;
				} catch {
					return { unparsed: l };
				}
			});
		return { out, events };
	};
	const tsxCalls = (): string => (existsSync(calls) ? readFileSync(calls, 'utf8') : '');
	const INSTALL = JSON.stringify({
		action: 'install',
		from: 'v1.24.7',
		to: 'v1.24.8',
		security: true
	});

	// 1. Nothing to install: no upgrade, no alert.
	{
		const r = run({
			FAKE_DECISION: JSON.stringify({ action: 'none', why: 'v1.24.7 is the newest release' }),
			FAKE_DECISION_RC: '0'
		});
		check('nothing to install: no alert', r.events.length === 0, r.out.trim());
		check(
			'nothing to install: the upgrade is not run',
			!/upgrade --yes/.test(tsxCalls()),
			tsxCalls()
		);
		check(
			'nothing to install: the reason is in the journal line',
			/nothing to install \(v1\.24\.7 is the newest release\)/.test(r.out),
			r.out.trim()
		);
	}

	// 2. A security release: the ordinary upgrade, then the digest note once it reads back.
	{
		rmSync(log, { force: true });
		const r = run({
			FAKE_DECISION: INSTALL,
			FAKE_DECISION_RC: '10',
			FAKE_UPGRADE_TAG: 'v1.24.8',
			FAKE_UPGRADE_RC: '0'
		});
		const done = r.events.find((e) => e.event === 'auto_install_done') as
			| { context?: Record<string, unknown>; level?: string }
			| undefined;
		check(
			'install: the ordinary `upgrade --yes`, from the ops-cli directory',
			tsxCalls().includes(
				`cwd=${join(root, 'apps/ops-cli')} args=${join(cliDir, 'main.ts')} upgrade --yes`
			),
			tsxCalls()
		);
		check(
			'install: auto_install_done names both versions and the log',
			done?.context?.from === 'v1.24.7' &&
				done?.context?.to === 'v1.24.8' &&
				done?.context?.log === log,
			JSON.stringify(done)
		);
		check('install: only that one alert', r.events.length === 1, r.out.trim());
		const l = existsSync(log) ? readFileSync(log, 'utf8') : '';
		check(
			'install: the log holds a dated header and the upgrade output',
			/== \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ morphit-auto-install: v1\.24\.7 -> v1\.24\.8/.test(l) &&
				/Integrity verified/.test(l),
			l
		);
	}

	// 3. The upgrade exits 0 but the install does not read as the new version.
	{
		const r = run({ FAKE_DECISION: INSTALL, FAKE_DECISION_RC: '10', FAKE_UPGRADE_RC: '0' });
		const f = r.events.find((e) => e.event === 'auto_install_failed') as
			| { context?: Record<string, unknown> }
			| undefined;
		check(
			'an install that does not read back as the new version is a failure, never "done"',
			f !== undefined && !r.events.some((e) => e.event === 'auto_install_done'),
			r.out.trim()
		);
		check(
			'the failure names the version running now and how to see the log',
			f?.context?.running === 'v1.24.7' && /sudo tail -n 80 /.test(String(f?.context?.hint)),
			JSON.stringify(f)
		);
	}

	// 4. The upgrade fails.
	{
		const r = run({ FAKE_DECISION: INSTALL, FAKE_DECISION_RC: '10', FAKE_UPGRADE_RC: '5' });
		const f = r.events.find((e) => e.event === 'auto_install_failed') as
			| { context?: Record<string, unknown> }
			| undefined;
		check(
			'a failed upgrade: auto_install_failed with its exit status and the rollback said',
			/ended with exit status 5/.test(String(f?.context?.hint)) &&
				/puts the previous install back by itself/.test(String(f?.context?.hint)),
			JSON.stringify(f)
		);
	}

	// 5. A record that failed its check: CRITICAL, nothing installed.
	{
		const r = run({
			FAKE_DECISION: JSON.stringify({
				action: 'refused',
				why: "the release record in block 9 is not signed by @morphit's pinned posting key"
			}),
			FAKE_DECISION_RC: '11'
		});
		const e = r.events.find((x) => x.event === 'auto_install_refused') as
			| { level?: string; context?: Record<string, unknown> }
			| undefined;
		check(
			'a record that failed its check: auto_install_refused at error level, saying why',
			e !== undefined &&
				e.level === 'error' &&
				/not signed by @morphit's pinned posting key\. Nothing was installed\./.test(
					String(e.context?.hint)
				),
			JSON.stringify(e)
		);
		check('…and the upgrade is not run', !/upgrade --yes/.test(tsxCalls()), tsxCalls());
	}

	// 6. The check could not run, or ran out of time.
	{
		const r = run({ FAKE_DECISION: '', FAKE_DECISION_RC: '124' });
		check(
			'a check that ran out of time: auto_install_check_failed for the digest',
			r.events.some(
				(e) =>
					e.event === 'auto_install_check_failed' &&
					/did not finish within 15 minutes/.test(JSON.stringify(e))
			),
			r.out.trim()
		);
		const odd = run({ FAKE_DECISION: '', FAKE_DECISION_RC: '3' });
		check(
			'another exit status: auto_install_check_failed, never an install',
			odd.events.some((e) => e.event === 'auto_install_check_failed') &&
				!/upgrade --yes/.test(tsxCalls()),
			odd.out.trim()
		);
	}

	// 7. A broken install: said, never an install.
	{
		const r = run({
			MORPHIT_TSX_PATH: join(work, 'no-such-tsx'),
			FAKE_DECISION: INSTALL,
			FAKE_DECISION_RC: '10'
		});
		check(
			'no tsx in the install: auto_install_check_failed, nothing run',
			r.events.some((e) => e.event === 'auto_install_check_failed') && tsxCalls() === '',
			r.out.trim()
		);
	}

	// 8. The units.
	{
		const svc = readFileSync(join(UNIT_DIR, 'morphit-auto-install.service'), 'utf8');
		const tmr = readFileSync(join(UNIT_DIR, 'morphit-auto-install.timer'), 'utf8');
		check(
			'the service runs this script, as root, with hours for a Tor upgrade',
			/^ExecStart=\/opt\/morphit\/ops\/scripts\/morphit-auto-install\.sh$/m.test(svc) &&
				/^User=root$/m.test(svc) &&
				/^TimeoutStartSec=4h$/m.test(svc)
		);
		check(
			'the service does not set MemoryDenyWriteExecute (Node runs under it)',
			!/^MemoryDenyWriteExecute=yes/m.test(svc)
		);
		check(
			"the timer runs after the night's restart (04:30 by default), and never on boot",
			/^OnCalendar=\*-\*-\* 05:15:00$/m.test(tmr) &&
				/^RandomizedDelaySec=45min$/m.test(tmr) &&
				/^Persistent=false$/m.test(tmr) &&
				!/OnBootSec/m.test(tmr)
		);
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}
console.log(
	fail === 0
		? `\n✓ all ${pass} auto-install-exec checks passed`
		: `\n✗ auto-install-exec: ${pass} passed, ${fail} failed`
);
process.exit(fail === 0 ? 0 : 1);
