#!/usr/bin/env tsx
/**
 * installer-preflight-checks-smoke.ts (cp-installer-hardening)
 *
 * Locks the PURE pre-install guards that stop the install hiccups a fresh node
 * admin hits:
 *   - interpretProbeResult: a FAILED `--list-hosts` (missing collection, stray
 *     ansible.cfg, bad Ansible) must surface the REAL error, not the misleading
 *     "0 hosts" — the root cause of the reported installer bug.
 *   - parseListeningPorts / portConflictCheck: an app already on 80/443/5432.
 *   - overlapsMorphitSubnet: a docker network already on 172.20.0.0/16.
 * All PURE; no host state.
 */
import {
	interpretProbeResult,
	extractAnsibleError
} from '../src/init/assembleInstall.ts';
import {
	parseListeningPorts,
	portConflictCheck,
	overlapsMorphitSubnet,
	parseAnsibleVersion,
	ansibleMeetsFloor
} from '../src/init/systemCheck.ts';
import { normalizeDbHostToIpv4 } from '../src/init/steps.ts';

let pass = 0;
const fails: string[] = [];
function check(desc: string, ok: boolean): void {
	if (ok) {
		pass++;
		console.log(`  ✓ ${desc}`);
	} else {
		fails.push(desc);
		console.log(`  ✗ ${desc}`);
	}
}

console.log('\n── installer pre-flight checks smoke ──────────────────\n');

// ── interpretProbeResult: the '0 hosts' root-cause fix ────────────
{
	const r = interpretProbeResult({ exitCode: 0, output: '  play #1\n    hosts (1):\n      localhost' });
	check('a clean 1-host pre-flight passes', r.ok && r.count === 1);
}
{
	const r = interpretProbeResult({ exitCode: 0, output: 'play #1\n  hosts (0):\n\nplay #2\n  hosts (3):' });
	check('takes the MAX host count across plays', r.ok && r.count === 3);
}
{
	const r = interpretProbeResult({
		exitCode: 1,
		output: "ERROR! couldn't resolve module/action 'community.docker.docker_compose_v2'"
	});
	check('a FAILED list-hosts is NOT reported as 0 hosts', !r.ok && r.count === 0);
	check('a failed pre-flight surfaces the REAL ansible error', /Ansible said: ERROR!/.test(r.reason ?? '') && /morphit-node-doctor/.test(r.reason ?? ''));
}
{
	const r = interpretProbeResult({ exitCode: 0, output: 'play #1\n  hosts (0):' });
	check('a clean 0-host match blames the vars file (not a generic bug)', !r.ok && /vars file/.test(r.reason ?? ''));
}

// ── extractAnsibleError ───────────────────────────────────────────
check('extracts an ERROR! line', extractAnsibleError('noise\nERROR! bad thing\nmore').startsWith('ERROR! bad thing'));
check('extracts a fatal: line', extractAnsibleError('x\nfatal: [localhost]: FAILED\ny') === 'fatal: [localhost]: FAILED');
check('extracts undefined-variable', /undefined variable/i.test(extractAnsibleError('AnsibleUndefinedVariable: undefined variable morphit_x')));
check('falls back to the last non-empty line', extractAnsibleError('only line\n\n') === 'only line');

// ── parseListeningPorts ───────────────────────────────────────────
{
	const ss = 'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 128 127.0.0.1:5432 0.0.0.0:*\nLISTEN 0 128 [::]:22 [::]:*';
	const ports = parseListeningPorts(ss);
	check('parses ss -tlnH local ports (v4 + v6)', ports.has(80) && ports.has(5432) && ports.has(22));
	check('does NOT pick up queue/recv columns as ports', !ports.has(4096) && !ports.has(128));
}
{
	const netstat = 'tcp 0 0 0.0.0.0:443 0.0.0.0:* LISTEN\ntcp6 0 0 :::8080 :::* LISTEN';
	const ports = parseListeningPorts(netstat);
	check('parses netstat -tln local ports', ports.has(443) && ports.has(8080));
}
check('empty input → no ports', parseListeningPorts('').size === 0);

// ── portConflictCheck ─────────────────────────────────────────────
check('nothing on our ports → ok', portConflictCheck(new Set([22, 3000])).status === 'ok');
check('80 taken → error (blocks the public site)', portConflictCheck(new Set([80])).status === 'error');
check('5432 taken → error (Postgres)', portConflictCheck(new Set([5432])).status === 'error');
{
	const c = portConflictCheck(new Set([8080]));
	check('a loopback app port (8080) → warn, not a hard block', c.status === 'warn');
}
check('the conflict note mentions the operator runs other apps', /other apps/.test(portConflictCheck(new Set([443])).note ?? ''));

// ── overlapsMorphitSubnet ─────────────────────────────────────────
check('a docker net inside 172.20.x overlaps (172.20.5.0/24)', overlapsMorphitSubnet(['172.18.0.0/16', '172.20.5.0/24']));
check('the exact 172.20.0.0/16 overlaps', overlapsMorphitSubnet(['172.20.0.0/16']));
check('other 172.x nets do NOT overlap', !overlapsMorphitSubnet(['172.17.0.0/16', '172.19.0.0/16', '10.0.0.0/8']));
check('empty → no overlap', !overlapsMorphitSubnet([]));

// ── Ansible version (v1.15.1 — the Ubuntu-22.04 "0 hosts" root cause) ──
check('parses modern "[core 2.16.3]"', (() => { const v = parseAnsibleVersion('ansible-playbook [core 2.16.3]'); return !!v && v.isCore && v.major === 2 && v.minor === 16; })());
check('parses legacy "ansible-playbook 2.10.8"', (() => { const v = parseAnsibleVersion('ansible-playbook 2.10.8'); return !!v && !v.isCore && v.major === 2 && v.minor === 10; })());
check('unparseable version → null', parseAnsibleVersion('not a version') === null);
check('the admin\'s legacy 2.10.8 FAILS the floor (this was the "0 hosts" trap)', !ansibleMeetsFloor(parseAnsibleVersion('ansible-playbook 2.10.8')!));
check('ancient 2.9 legacy fails the floor', !ansibleMeetsFloor(parseAnsibleVersion('ansible-playbook 2.9.27')!));
check('core 2.14 fails the floor (below 2.15)', !ansibleMeetsFloor(parseAnsibleVersion('ansible-playbook [core 2.14.9]')!));
check('core 2.15 meets the floor (boundary)', ansibleMeetsFloor(parseAnsibleVersion('ansible-playbook [core 2.15.0]')!));
check('core 2.16 meets the floor', ansibleMeetsFloor(parseAnsibleVersion('ansible-playbook [core 2.16.3]')!));
check('a future major (core 3.x) meets the floor', ansibleMeetsFloor(parseAnsibleVersion('ansible-playbook [core 3.0.1]')!));

// ── DB host auto-normalize (v1.15.1 — the localhost→::1 trap) ──
check('a localhost DB URL is rewritten to 127.0.0.1', (() => { const r = normalizeDbHostToIpv4('postgres://morphit:secret@localhost:5432/morphit'); return r.changed && r.url === 'postgres://morphit:secret@127.0.0.1:5432/morphit'; })());
check('localhost rewrite preserves user, password, port, db', (() => { const r = normalizeDbHostToIpv4('postgresql://u:p%40x@localhost/db'); return r.changed && r.url.includes('127.0.0.1') && r.url.includes('u:p%40x') && r.url.endsWith('/db'); })());
check('an explicit 127.0.0.1 is left unchanged', !normalizeDbHostToIpv4('postgres://morphit@127.0.0.1:5432/morphit').changed);
check('a remote DB host is left unchanged', !normalizeDbHostToIpv4('postgres://u:p@db.example.com:5432/db').changed);
check('an unparseable value is left as-is (validation handles it)', !normalizeDbHostToIpv4('not-a-url').changed);

const total = pass + fails.length;
console.log('\n──────────────────────────────────────────────────────');
if (fails.length > 0) {
	console.log(`✗ ${fails.length} of ${total} installer-preflight-checks checks FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} installer-preflight-checks scenarios passed`);
