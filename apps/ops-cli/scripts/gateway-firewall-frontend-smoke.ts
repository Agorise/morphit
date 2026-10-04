/**
 * gateway-firewall-frontend-smoke.
 *
 * ops/ipfs/morphit-gateway-firewall-heal.sh must find the frontend container
 * by what it is (the one serving …/apps/web/build), not by the name an Ansible
 * stack gives it: on a hand-made Compose stack it is `bunkerweb-frontend-1`,
 * and the heal used to do nothing there. Runs the real script against a fake
 * `docker` (and `ipfs`) on PATH and checks which container it probes from, and
 * which Docker network's subnet it would open the gateway to.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO } from './ansible-template-render.ts';

const SCRIPT =
	process.env.MORPHIT_GATEWAY_HEAL_SCRIPT ??
	join(REPO, 'ops/ipfs/morphit-gateway-firewall-heal.sh');
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

const run = (frontendName: string, reachable: boolean): { log: string[]; out: string } => {
	const dir = mkdtempSync(join(tmpdir(), 'gwheal-'));
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	const calls = join(dir, 'calls');
	// Two containers: the edge (no web build) and the frontend.
	writeFileSync(
		join(bin, 'docker'),
		`#!/bin/sh
echo "$*" >> ${calls}
case "$1" in
  ps) printf 'aaa111\\nbbb222\\n' ;;
  inspect)
    id="$2"; fmt="$4"
    case "$id" in aaa111|bunkerweb-bunkerweb-1) name=bunkerweb-bunkerweb-1; mount=/var/lib/bw ;;
                  bbb222|${frontendName}) name=${frontendName}; mount=/opt/morphit/apps/web/build ;;
                  *) exit 1 ;; esac
    case "$fmt" in
      *Mounts*) printf '%s\\n' "$mount" ;;
      *.Name*) printf '/%s\\n' "$name" ;;
      *ExtraHosts*) printf 'host.docker.internal:172.18.0.1\\n' ;;
      *Networks*) printf 'bunkerweb_default\\nsomething_else\\n' ;;
      *) echo '[{}]' ;;
    esac ;;
  network)
    case "$3$5" in
      bunkerweb_default*Gateway*) echo '172.18.0.1 ' ;;
      bunkerweb_default*Subnet*) echo '172.18.0.0/24 ' ;;
      something_else*Gateway*) echo '10.5.0.1 ' ;;
      something_else*Subnet*) echo '10.5.0.0/24 ' ;;
      *) exit 1 ;;
    esac ;;
  exec) ${reachable ? "echo 'HTTP/1.1 400 Bad Request'; exit 1" : "echo 'wget: download timed out'; exit 1"} ;;
  restart) exit 0 ;;
esac
exit 0
`
	);
	writeFileSync(join(bin, 'ipfs'), `#!/bin/sh\necho '"/ip4/0.0.0.0/tcp/8082"'\n`);
	for (const n of ['ufw', 'iptables', 'ss'])
		writeFileSync(
			join(bin, n),
			`#!/bin/sh\necho "${n} $*" >> ${calls}\n${n === 'ss' ? "echo 'LISTEN 0 4096 0.0.0.0:8082 0.0.0.0:*'" : ''}\nexit 0\n`
		);
	for (const n of ['docker', 'ipfs', 'ufw', 'iptables', 'ss']) chmodSync(join(bin, n), 0o755);
	const r = spawnSync('sh', [SCRIPT], {
		encoding: 'utf8',
		env: { PATH: `${bin}:/usr/bin:/bin` },
		timeout: 30_000
	});
	let log: string[] = [];
	try {
		log = readFileSync(calls, 'utf8').split('\n').filter(Boolean);
	} catch {
		/* nothing called */
	}
	rmSync(dir, { recursive: true, force: true });
	return { log, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

{
	const r = run('bunkerweb-frontend-1', true);
	const exec = r.log.find((l) => l.startsWith('exec '));
	check(
		'a hand-made stack (frontend called bunkerweb-frontend-1): the heal probes from that container',
		exec !== undefined && exec.startsWith('exec bunkerweb-frontend-1 wget'),
		exec ?? r.out.trim().split('\n').pop()
	);
	check(
		'… and reports the path open without touching the firewall',
		!r.log.some((l) => /^(ufw|iptables) /.test(l)),
		r.log.join(' | ')
	);
}
{
	const r = run('morphit-frontend', true);
	check(
		'an Ansible stack (morphit-frontend): still found',
		r.log.some((l) => l.startsWith('exec morphit-frontend wget'))
	);
}
{
	const r = run('bunkerweb-frontend-1', false);
	const fw = r.log.filter((l) => /^(ufw|iptables) /.test(l) && /\d+\.\d+\.\d+\.\d+\/\d+/.test(l));
	check(
		"blocked: the firewall rule it checks/adds is for the frontend's own network (172.18.0.0/24, whose gateway is its host.docker.internal), not a guessed one",
		fw.length > 0 && fw.every((l) => l.includes('172.18.0.0/24')),
		fw.join(' | ') || r.log.slice(0, 12).join(' | ')
	);
}

console.log('');
if (fail === 0) {
	console.log(`✓ all ${pass} gateway-firewall-frontend checks passed`);
	process.exit(0);
}
console.log(`✗ ${fail} of ${pass + fail} gateway-firewall-frontend checks failed`);
process.exit(1);
