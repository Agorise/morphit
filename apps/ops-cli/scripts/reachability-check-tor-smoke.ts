/**
 * reachability-check-tor-smoke.
 *
 * ops/scripts/morphit-reachability-check.sh runs after a home install. It
 * used to check "is this box online?" by fetching https://morphit.io/verify.json
 * straight from the operator's home address (telling that site the address
 * runs a node) and then said "no internet connection" for any failure. Runs
 * the real script with fake curl / ss / systemctl and checks: every curl goes
 * through Tor (--socks5-hostname), a failure names the host it could not
 * reach, and with Tor down nothing is fetched at all.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO } from './ansible-template-render.ts';

const SCRIPT =
	process.env.MORPHIT_REACH_SCRIPT ?? join(REPO, 'ops/scripts/morphit-reachability-check.sh');
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

const run = (o: { torUp: boolean; curlOk: boolean }): { calls: string[]; out: string } => {
	const dir = mkdtempSync(join(tmpdir(), 'reach-'));
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	const log = join(dir, 'curl.log');
	const stub = (n: string, body: string) => {
		writeFileSync(join(bin, n), `#!/bin/sh\n${body}\n`);
		chmodSync(join(bin, n), 0o755);
	};
	stub(
		'curl',
		`echo "$*" >> ${log}\n${o.curlOk ? 'case "$*" in *-w*) printf 200 ;; esac; exit 0' : 'case "$*" in *-w*) printf 000 ;; esac; exit 7'}`
	);
	stub(
		'ss',
		`echo 'LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*'\n${o.torUp ? "echo 'LISTEN 0 4096 127.0.0.1:9050 0.0.0.0:*'" : ''}`
	);
	stub('systemctl', o.torUp ? 'exit 0' : 'exit 3');
	stub('timeout', 'shift; exec "$@"');
	stub('hostname', 'echo 192.168.1.20');
	const r = spawnSync('bash', [SCRIPT, 'node.example.org', 'abc.onion'], {
		encoding: 'utf8',
		env: { PATH: `${bin}:/usr/bin:/bin` },
		timeout: 30_000
	});
	let calls: string[] = [];
	try {
		calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
	} catch {
		/* none */
	}
	rmSync(dir, { recursive: true, force: true });
	return { calls, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

{
	const r = run({ torUp: true, curlOk: true });
	check('Tor up: it probes', r.calls.length > 0);
	check(
		'every request goes through Tor (--socks5-hostname)',
		r.calls.every((c) => c.includes('--socks5-hostname')),
		r.calls.filter((c) => !c.includes('--socks5-hostname')).join(' | ')
	);
	check('a reachable node is reported reachable', /REACHABLE/.test(r.out));
}
{
	const r = run({ torUp: true, curlOk: false });
	check(
		'nothing fetched outside Tor when it fails either',
		r.calls.every((c) => c.includes('--socks5-hostname')),
		r.calls.join(' | ')
	);
	check(
		'a failure names the host it could not reach, without claiming "no internet"',
		/Couldn't reach morphit\.io through Tor/.test(r.out) && !/no internet connection/i.test(r.out),
		r.out.split('\n').slice(4, 9).join(' / ')
	);
}
{
	const r = run({ torUp: false, curlOk: true });
	check(
		'Tor down: nothing is fetched at all (only the manual test is suggested)',
		r.calls.length === 0,
		r.calls.join(' | ')
	);
}

console.log('');
if (fail === 0) {
	console.log(`✓ all ${pass} reachability-check-tor checks passed`);
	process.exit(0);
}
console.log(`✗ ${fail} of ${pass + fail} reachability-check-tor checks failed`);
process.exit(1);
