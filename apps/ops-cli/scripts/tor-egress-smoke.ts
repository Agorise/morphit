/**
 * tor-egress-smoke.
 *
 * The tor-only egress rule (ops/tor-only/morphit-tor-egress.sh) loaded into a
 * REAL kernel, inside a private network namespace (`unshare -n`, so the host
 * is untouched) with a veth pair as the default route, and observed:
 *   - a program running as an allowed user (standing in for debian-tor /
 *     i2pd) may open a connection out;
 *   - root and an ordinary user may not — their first packet is refused
 *     and the rule's counter rises;
 *   - loopback still works for everyone; a LAN host (RFC 1918) is reachable,
 *     a LAN DNS resolver is not;
 *   - egress-probe (what the heal runs) sees the refusal; egress-check accepts
 *     the loaded table; after egress-revert the table is gone and the probe
 *     says so.
 * And, on file fixtures: the i2pd reseed proxy is written inside [reseed]
 * (and nothing else in i2pd.conf changes), the Docker drop-in, and the unit
 * masking against a fake systemctl.
 * Needs root, unshare, nft, bash and setpriv for the kernel part; otherwise
 * it says so and runs the file checks only.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO } from './ansible-template-render.ts';

const SCRIPT =
	process.env.MORPHIT_TOR_EGRESS_SCRIPT ?? join(REPO, 'ops/tor-only/morphit-tor-egress.sh');
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
const has = (b: string): boolean => spawnSync('sh', ['-c', `command -v ${b}`]).status === 0;
const root = typeof process.getuid === 'function' && process.getuid() === 0;
const work = mkdtempSync(join(tmpdir(), 'tor-egress-'));

if (root && ['unshare', 'nft', 'bash', 'setpriv', 'ip'].every(has)) {
	const ALLOWED = 5917;
	const inner = `
set -u
S='${SCRIPT}'
export MORPHIT_OS_ROOT='${work}/os' MORPHIT_EGRESS_UIDS='${ALLOWED}'
ip link set lo up
ip link add v0 type veth peer name v1 && ip link set v0 up && ip link set v1 up && ip addr add 10.99.0.1/24 dev v0 && ip route add default via 10.99.0.2 dev v0
count() { nft list counter inet morphit_egress blocked 2>/dev/null | sed -n 's/.*packets \\([0-9]*\\).*/\\1/p' | head -n1; }
try() { # try <uid> <host> <port>: "refused" when the rule stopped it (its counter rose), "left" when not
	a=$(count); setpriv --reuid="$1" --regid="$1" --clear-groups timeout 2 bash -c "exec 3<>/dev/tcp/$2/$3" >/dev/null 2>&1; b=$(count)
	[ -n "$b" ] && [ "\${b}" -gt "\${a:-0}" ] && echo refused || echo left
}
tryu() { # the same with one UDP datagram (DNS is mostly UDP)
	a=$(count); setpriv --reuid="$1" --regid="$1" --clear-groups timeout 2 bash -c "exec 3<>/dev/udp/$2/$3; printf q >&3" >/dev/null 2>&1; b=$(count)
	[ -n "$b" ] && [ "\${b}" -gt "\${a:-0}" ] && echo refused || echo left
}
echo "before-allowed=$(try ${ALLOWED} 192.0.2.1 9)"
echo "before-root=$(try 0 192.0.2.1 9)"
sh "$S" egress-apply '${work}/bk' >/dev/null 2>&1; echo "apply=$?"
echo "check=$(sh "$S" egress-check >/dev/null 2>&1; echo $?)"
c0=$(count)
echo "allowed=$(try ${ALLOWED} 192.0.2.1 9)"
echo "root=$(try 0 192.0.2.1 9)"
echo "user=$(try 65534 192.0.2.1 9)"
echo "dns=$(try 65534 9.9.9.9 53)"
echo "lan=$(try 0 192.168.1.20 80)"
echo "lan-dns=$(try 65534 192.168.1.1 53)"
echo "lan-dns-udp=$(tryu 0 192.168.1.1 53)"
echo "ll=$(try 0 169.254.7.1 80)"
echo "ll-dns=$(try 0 169.254.7.1 53)"
echo "ll-dns-udp=$(tryu 0 169.254.7.1 53)"
echo "ll-dot=$(try 0 169.254.7.1 853)"
echo "allowed-dns=$(tryu ${ALLOWED} 9.9.9.9 53)"
echo "allowed-dns-tcp=$(try ${ALLOWED} 9.9.9.9 53)"
echo "lo-dns=$(tryu 65534 127.0.0.53 53)"
# A container behind a Docker-style bridge (its traffic is FORWARDED)
unshare -n sleep 20 & cpid=$!; sleep 0.3
ip link add br-t0 type veth peer name c0 netns $cpid && ip link set br-t0 up && ip addr add 172.30.0.1/24 dev br-t0
sysctl -qw net.ipv4.ip_forward=1
nsenter -t $cpid -n sh -c 'ip link set lo up; ip link set c0 up; ip addr add 172.30.0.2/24 dev c0; ip route add default via 172.30.0.1'
ctry() { # ctry tcp|udp <host> <port>: from inside the container
	a=$(count)
	if [ "$1" = udp ]; then nsenter -t $cpid -n timeout 2 bash -c "exec 3<>/dev/udp/$2/$3; printf q >&3" >/dev/null 2>&1
	else nsenter -t $cpid -n timeout 2 bash -c "exec 3<>/dev/tcp/$2/$3" >/dev/null 2>&1; fi
	b=$(count); [ -n "$b" ] && [ "\${b}" -gt "\${a:-0}" ] && echo refused || echo left
}
echo "ct-lan=$(ctry tcp 192.168.1.20 80)"
echo "ct-net=$(ctry tcp 192.0.2.1 9)"
echo "ct-lan-dns=$(ctry udp 192.168.1.1 53)"
echo "ct-ll-dns=$(ctry udp 169.254.7.1 53)"
kill $cpid 2>/dev/null
# IPv6, when this kernel has it (a kernel booted with ipv6.disable=1 has not)
if [ -e /proc/net/if_inet6 ]; then
	ip -6 addr add fd00:99::1/64 dev v0 nodad && ip -6 route add default via fd00:99::2 dev v0
	echo "v6=yes"
	echo "v6-root=$(try 0 2001:db8::1 9)"
	echo "v6-ula=$(try 0 fd00:99::20 80)"
	echo "v6-ula-dns=$(tryu 0 fd00:99::2 53)"
	echo "v6-ll=$(try 0 fe80::2%v0 80)"
	echo "v6-ll-dns=$(tryu 0 fe80::2%v0 53)"
	echo "v6-ll-dns-tcp=$(try 0 fe80::2%v0 53)"
	echo "v6-allowed-dns=$(tryu ${ALLOWED} 2001:db8::53 53)"
	echo "v6-lo-dns=$(tryu 65534 ::1 53)"
else
	echo "v6=no"
fi
c1=$(count)
echo "counted=$((c1 - c0))"
python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",48613));s.listen(1);import time;time.sleep(3)' &
sleep 0.5
echo "loopback=$(setpriv --reuid=65534 --regid=65534 --clear-groups timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/48613' >/dev/null 2>&1 && echo ok || echo blocked)"
echo "probe=$(sh "$S" egress-probe >/dev/null 2>&1; echo $?)"
sh "$S" egress-revert '${work}/bk' >/dev/null 2>&1
echo "after-revert-table=$(nft list table inet morphit_egress >/dev/null 2>&1 && echo present || echo gone)"
echo "after-revert-probe=$(sh "$S" egress-probe >/dev/null 2>&1; echo $?)"
echo "after-revert-root=$(try 0 192.0.2.1 9)"
wait
`;
	mkdirSync(join(work, 'os/etc/morphit'), { recursive: true });
	const r = spawnSync('unshare', ['-n', 'sh', '-c', inner], { encoding: 'utf8', timeout: 90_000 });
	const got = new Map(
		(r.stdout ?? '')
			.split('\n')
			.map((l) => /^([a-z0-9-]+)=(.*)$/.exec(l))
			.filter((m): m is RegExpExecArray => m !== null)
			.map((m) => [m[1]!, m[2]!])
	);
	const g = (k: string): string => got.get(k) ?? `(none; ${(r.stderr ?? '').slice(0, 200)})`;
	check(
		'without the rule, root could reach the internet (the case the rule is for)',
		g('before-root') === 'left',
		g('before-root')
	);
	check('egress-apply loads the table', g('apply') === '0', g('apply'));
	check('egress-check accepts the loaded table', g('check') === '0', g('check'));
	check('the allowed user (Tor / i2pd) still reaches out', g('allowed') === 'left', g('allowed'));
	check('root is stopped (refused at once, counted)', g('root') === 'refused', g('root'));
	check(
		'an ordinary user is stopped (refused at once, counted)',
		g('user') === 'refused',
		g('user')
	);
	check('no DNS to the outside from an ordinary user', g('dns') === 'refused', g('dns'));
	// The local network is not the internet: a LAN host (an IP literal, as
	// Morphit's own hidden-only policy treats it) is reachable. Its DNS is not:
	// a LAN resolver forwards names to the internet.
	check('root reaches a LAN host (RFC 1918)', g('lan') === 'left', g('lan'));
	check('no DNS to a LAN resolver either', g('lan-dns') === 'refused', g('lan-dns'));
	check(
		'no DNS to a LAN resolver over UDP, even as root',
		g('lan-dns-udp') === 'refused',
		g('lan-dns-udp')
	);
	// Link-local (IPv4LL, a cloud's metadata address) stays reachable; its DNS
	// does not: a router advertises such an address as the resolver and
	// forwards every name to the internet.
	check('root reaches a link-local host (not DNS)', g('ll') === 'left', g('ll'));
	check('no DNS to a link-local resolver (TCP)', g('ll-dns') === 'refused', g('ll-dns'));
	check('no DNS to a link-local resolver (UDP)', g('ll-dns-udp') === 'refused', g('ll-dns-udp'));
	check('no DNS-over-TLS to a link-local resolver', g('ll-dot') === 'refused', g('ll-dot'));
	// Tor and i2pd resolve nothing themselves (Tor resolves at the exit; i2pd
	// hands the reseed name to Tor's SOCKS port), so not even they may.
	check(
		'no DNS to the outside from Tor / i2pd either (UDP)',
		g('allowed-dns') === 'refused',
		g('allowed-dns')
	);
	check(
		'no DNS to the outside from Tor / i2pd either (TCP)',
		g('allowed-dns-tcp') === 'refused',
		g('allowed-dns-tcp')
	);
	check('DNS to a loopback resolver still works', g('lo-dns') === 'left', g('lo-dns'));
	check('a container reaches a LAN host', g('ct-lan') === 'left', g('ct-lan'));
	check('a container is stopped from the internet', g('ct-net') === 'refused', g('ct-net'));
	check(
		'no DNS from a container to a LAN resolver',
		g('ct-lan-dns') === 'refused',
		g('ct-lan-dns')
	);
	check(
		'no DNS from a container to a link-local resolver',
		g('ct-ll-dns') === 'refused',
		g('ct-ll-dns')
	);
	if (g('v6') === 'yes') {
		check('IPv6: root is stopped', g('v6-root') === 'refused', g('v6-root'));
		check('IPv6: root reaches a ULA host', g('v6-ula') === 'left', g('v6-ula'));
		check('IPv6: no DNS to a ULA resolver', g('v6-ula-dns') === 'refused', g('v6-ula-dns'));
		check('IPv6: root reaches a link-local host (not DNS)', g('v6-ll') === 'left', g('v6-ll'));
		check(
			'IPv6: no DNS to a link-local resolver (UDP)',
			g('v6-ll-dns') === 'refused',
			g('v6-ll-dns')
		);
		check(
			'IPv6: no DNS to a link-local resolver (TCP)',
			g('v6-ll-dns-tcp') === 'refused',
			g('v6-ll-dns-tcp')
		);
		check(
			'IPv6: no DNS to the outside from Tor / i2pd',
			g('v6-allowed-dns') === 'refused',
			g('v6-allowed-dns')
		);
		check('IPv6: DNS to ::1 still works', g('v6-lo-dns') === 'left', g('v6-lo-dns'));
	} else {
		check('skipped the IPv6 part: this kernel has no IPv6', g('v6') === 'no', g('v6'));
	}
	check(
		"every stopped attempt is counted by the rule's counter",
		Number(g('counted')) >= 3,
		g('counted')
	);
	check('loopback still works for an ordinary user', g('loopback') === 'ok', g('loopback'));
	check("egress-probe (the heal's check) sees the refusal", g('probe') === '0', g('probe'));
	check(
		'egress-revert removes the table',
		g('after-revert-table') === 'gone',
		g('after-revert-table')
	);
	check(
		'egress-probe after the revert: not refused, says so',
		g('after-revert-probe') === '1',
		g('after-revert-probe')
	);
	check(
		'after the revert root reaches out again',
		g('after-revert-root') === 'left',
		g('after-revert-root')
	);
} else {
	check('skipped the kernel part: needs root, unshare, nft, bash, setpriv, ip', true);
}

// ── files: i2pd, docker, units ───────────────────────────────────────────────
{
	const os = join(work, 'files');
	mkdirSync(join(os, 'etc/i2pd'), { recursive: true });
	const CONF =
		'## i2pd\nlog = file\n\n[http]\nenabled = true\n\n[reseed]\nverify = true\n## proxy = socks://...\n\n[addressbook]\ndefaulturl = x\n';
	writeFileSync(join(os, 'etc/i2pd/i2pd.conf'), CONF);
	const bin = join(work, 'bin');
	mkdirSync(bin);
	const sysLog = join(work, 'systemctl.log');
	writeFileSync(
		join(bin, 'systemctl'),
		`#!/bin/sh\necho "$*" >> ${sysLog}\ncase "$1" in\n cat) case "$2" in snapd.service|pollinate.service|docker.service) exit 0;; *) exit 1;; esac;;\n is-enabled) grep -q "^mask $2$" ${sysLog} && { echo masked; exit 0; }; echo enabled; exit 0;;\n *) exit 0;;\nesac\n`
	);
	chmodSync(join(bin, 'systemctl'), 0o755);
	const env = { ...process.env, MORPHIT_OS_ROOT: os, MORPHIT_SYSTEMCTL: join(bin, 'systemctl') };
	const run = (...a: string[]) => spawnSync('sh', [SCRIPT, ...a], { encoding: 'utf8', env });
	check('i2pd-check: reseeding directly is reported', run('i2pd-check').status === 1);
	run('i2pd-apply', join(work, 'bk2'));
	const conf = readFileSync(join(os, 'etc/i2pd/i2pd.conf'), 'utf8');
	check(
		'i2pd-apply: reseed.proxy = socks://127.0.0.1:9050 inside [reseed], the rest unchanged',
		conf === CONF.replace('## proxy = socks://...\n', 'proxy = socks://127.0.0.1:9050\n') &&
			run('i2pd-check').status === 0,
		conf
	);
	run('i2pd-revert', join(work, 'bk2'));
	check(
		'i2pd-revert: byte for byte',
		readFileSync(join(os, 'etc/i2pd/i2pd.conf'), 'utf8') === CONF
	);
	check('docker-check: direct pulls reported', run('docker-check').status === 1);
	run('docker-apply', join(work, 'bk2'));
	const drop = readFileSync(
		join(os, 'etc/systemd/system/docker.service.d/morphit-tor-proxy.conf'),
		'utf8'
	);
	check(
		'docker-apply: the daemon pulls through Tor',
		/HTTPS_PROXY=socks5:\/\/127\.0\.0\.1:9050/.test(drop) && run('docker-check').status === 0
	);
	// Every node (a clearnet one too): only the units no server needs.
	check('quiet-check: an unmasked pollinate is reported', run('quiet-check').status === 1);
	run('quiet-apply', join(work, 'bk3'));
	const quiet = readFileSync(sysLog, 'utf8')
		.split('\n')
		.filter((l) => l.startsWith('mask '));
	check(
		'quiet-apply masks pollinate and leaves snapd alone (installed snaps need it)',
		quiet.join(',') === 'mask pollinate.service' && run('quiet-check').status === 0,
		quiet.join(',')
	);
	run('quiet-revert', join(work, 'bk3'));
	writeFileSync(sysLog, '');
	check('units-check: unmasked snapd / pollinate reported', run('units-check').status === 1);
	run('units-apply', join(work, 'bk2'));
	const masked = readFileSync(sysLog, 'utf8')
		.split('\n')
		.filter((l) => l.startsWith('mask '));
	check(
		'units-apply masks exactly the ones present',
		masked.join(',') === 'mask snapd.service,mask pollinate.service',
		masked.join(',')
	);
	check('units-check then passes', run('units-check').status === 0);
}
rmSync(work, { recursive: true, force: true });

console.log('');
if (fail === 0) {
	console.log(`✓ all ${pass} tor-egress checks passed`);
	process.exit(0);
}
console.log(`✗ ${fail} of ${pass + fail} tor-egress checks failed`);
process.exit(1);
