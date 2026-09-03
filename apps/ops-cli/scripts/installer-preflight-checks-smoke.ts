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
	ansibleMeetsFloor,
	parsePgMajor,
	MIN_PG_MAJOR,
	interpretDnsResult
} from '../src/init/systemCheck.ts';
import { normalizeDbHostToIpv4 } from '../src/init/steps.ts';
import { summarizePlaybookFailure, describeInstallError, shouldRemindQuiet, QUIET_REMIND_MS } from '../src/init/assembleInstall.ts';
import { checkNobleBase, ubuntuBaseCodename, NOBLE_ONLY_GUIDANCE, assembleInstall } from '../src/init/assembleInstall.ts';
import type { InstallPlan } from '../src/init/assembleInstall.ts';

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
check('the Ubuntu 22.04 default 2.10.8 now MEETS the floor (no upgrade needed)', ansibleMeetsFloor(parseAnsibleVersion('ansible-playbook 2.10.8')!));
check('ancient 2.9 legacy still fails the floor', !ansibleMeetsFloor(parseAnsibleVersion('ansible-playbook 2.9.27')!));
check('core 2.14 meets the floor', ansibleMeetsFloor(parseAnsibleVersion('ansible-playbook [core 2.14.9]')!));
check('core 2.16 meets the floor', ansibleMeetsFloor(parseAnsibleVersion('ansible-playbook [core 2.16.3]')!));
check('a future major (core 3.x) meets the floor', ansibleMeetsFloor(parseAnsibleVersion('ansible-playbook [core 3.0.1]')!));

// ── DB host auto-normalize (v1.15.1 — the localhost→::1 trap) ──
check('a localhost DB URL is rewritten to 127.0.0.1', (() => { const r = normalizeDbHostToIpv4('postgres://morphit:secret@localhost:5432/morphit'); return r.changed && r.url === 'postgres://morphit:secret@127.0.0.1:5432/morphit'; })());
check('localhost rewrite preserves user, password, port, db', (() => { const r = normalizeDbHostToIpv4('postgresql://u:p%40x@localhost/db'); return r.changed && r.url.includes('127.0.0.1') && r.url.includes('u:p%40x') && r.url.endsWith('/db'); })());
check('an explicit 127.0.0.1 is left unchanged', !normalizeDbHostToIpv4('postgres://morphit@127.0.0.1:5432/morphit').changed);
check('uppercase LOCALHOST is also normalized (case-insensitive)', normalizeDbHostToIpv4('postgres://u:p@LOCALHOST:5432/db').url.includes('127.0.0.1'));
check('a remote DB host is left unchanged', !normalizeDbHostToIpv4('postgres://u:p@db.example.com:5432/db').changed);
check('an unparseable value is left as-is (validation handles it)', !normalizeDbHostToIpv4('not-a-url').changed);

// ── playbook-failure summariser (v1.15.2 — never a rage-quit at raw output) ──
{
	const dbLog = 'TASK [indexer : run migrations] ***\nfatal: [localhost]: FAILED! => {"msg": "could not connect to server: Connection refused ... port 5432"}';
	const s = summarizePlaybookFailure(dbLog, 2, '/tmp/x.log');
	check('a failed run names the failed task', /Failed step: indexer : run migrations/.test(s));
	check('a DB-connection failure maps to the Postgres fix', /Postgres/.test(s) && /127\.0\.0\.1/.test(s));
	check('a recognised failure does NOT show the support contact', !s.includes('@agorise:matrix.org'));
	check('the summary always points to the full log', s.includes('/tmp/x.log'));
}
{
	const unknown = 'TASK [x : y] ***\nfatal: [localhost]: FAILED! => {"msg": "a totally novel error"}';
	const s = summarizePlaybookFailure(unknown, 2, '/tmp/x.log');
	check('an UNRECOGNISED failure surfaces support (the true last resort)', s.includes('agorise@pm.me') && s.includes('@agorise:matrix.org'));
}
check('an apt-lock failure maps to the dpkg hint', /dpkg --configure/.test(summarizePlaybookFailure('fatal: FAILED! => {"msg":"Failed to lock apt"}', 2, '/l')));
check('a docker-permission failure maps to the docker-group hint', /docker group/.test(summarizePlaybookFailure('fatal: FAILED! => {"msg":"Got permission denied while trying to connect to the Docker daemon socket"}', 2, '/l')));

// ── OS pre-check: the one-command installer is noble-only (v1.15.4) ──
// The pure verdict mirrors the playbook's `morphit_ubuntu_codename == "noble"`.
check('noble base → ok', checkNobleBase('ID=ubuntu\nUBUNTU_CODENAME=noble\n').ok);
check('a derivative on the noble base → ok', checkNobleBase('ID=linuxmint\nID_LIKE=ubuntu\nUBUNTU_CODENAME=noble\n').ok);
check('jammy (Ubuntu 22.04) → blocked', !checkNobleBase('ID=ubuntu\nVERSION_ID="22.04"\nUBUNTU_CODENAME=jammy\n').ok);
check('no UBUNTU_CODENAME (Debian) → blocked', !checkNobleBase('ID=debian\nVERSION_ID="12"\n').ok);
check('ubuntuBaseCodename unquotes + lowercases', ubuntuBaseCodename('UBUNTU_CODENAME="Noble"\n') === 'noble');
check('ubuntuBaseCodename returns the jammy base verbatim', ubuntuBaseCodename('UBUNTU_CODENAME=jammy\n') === 'jammy');

// The playbook's OS-gate assertion is now a RECOGNISED failure → the noble
// guidance, NOT the support dead-end. This is the exact log the new admin hit.
{
	const osGateLog =
		'TASK [Verify target is Ubuntu 24.04 LTS or an Ubuntu-24.04-based derivative] ***\n' +
		'fatal: [localhost]: FAILED! => {"assertion": "morphit_ubuntu_codename == \\"noble\\"", ' +
		'"evaluated_to": false, "msg": "This playbook targets Ubuntu 24.04 LTS ... Detected Ubuntu 22.04 ... not supported"}';
	const s = summarizePlaybookFailure(osGateLog, 2, '/tmp/x.log');
	check('the OS-gate failure maps to the noble guidance', /24\.04 "noble"/.test(s) && /fresh Ubuntu 24\.04/.test(s));
	check('the OS-gate failure is RECOGNISED (no support dead-end)', !s.includes('agorise@pm.me') && !s.includes('@agorise:matrix.org'));
	check('the OS-gate failure names the failed task', /Verify target is Ubuntu 24\.04/.test(s));
}

// assembleInstall must STOP a non-noble box up front — before writing the
// secret-bearing vars file or spawning Ansible.
{
	let wroteVars = false;
	let spawned = false;
	const plan: InstallPlan = {
		vars: {},
		secretsToSave: [],
		playbookPath: '/opt/morphit/ops/ansible/playbook.yml',
		varsFilePath: '/tmp/morphit-vars.yml'
	};
	const result = await assembleInstall(plan, {
		readOsRelease: () => 'ID=ubuntu\nVERSION_ID="22.04"\nUBUNTU_CODENAME=jammy\n',
		writeVarsFile: () => {
			wroteVars = true;
		},
		removeVarsFile: () => {},
		promptSave: async () => {},
		ensureAnsible: async () => true,
		spawn: async () => {
			spawned = true;
			return 0;
		},
		probeHosts: () => ({ exitCode: 0, output: 'hosts (1):\n  localhost' }),
		print: () => {}
	});
	check('assembleInstall blocks a jammy box (ok:false)', !result.ok);
	check('the block carries the noble guidance', !result.ok && /fresh Ubuntu 24\.04/.test(result.reason));
	check('the block names the detected base', !result.ok && /jammy/.test(result.reason));
	check('NO secret-bearing vars file was written for the blocked box', !wroteVars);
	check('Ansible was NEVER spawned for the blocked box', !spawned);
}

// A noble box passes the pre-check and proceeds to the (mocked) run.
{
	let spawned = false;
	const plan: InstallPlan = {
		vars: {},
		secretsToSave: [],
		playbookPath: '/opt/morphit/ops/ansible/playbook.yml',
		varsFilePath: '/tmp/morphit-vars.yml'
	};
	const result = await assembleInstall(plan, {
		readOsRelease: () => 'ID=ubuntu\nVERSION_ID="24.04"\nUBUNTU_CODENAME=noble\n',
		writeVarsFile: () => {},
		removeVarsFile: () => {},
		promptSave: async () => {},
		ensureAnsible: async () => true,
		spawn: async () => {
			spawned = true;
			return 0;
		},
		probeHosts: () => ({ exitCode: 0, output: 'hosts (1):\n  localhost' }),
		print: () => {}
	});
	check('assembleInstall proceeds on a noble box (ok:true)', result.ok);
	check('the playbook actually ran on the noble box', spawned);
}

// The shared guidance string is the single source of truth used by both paths.
check('NOBLE_ONLY_GUIDANCE names the 24.04 noble base', /24\.04 "noble"/.test(NOBLE_ONLY_GUIDANCE));
check('NOBLE_ONLY_GUIDANCE is not a support dead-end', !NOBLE_ONLY_GUIDANCE.includes('agorise@pm.me'));

// ── describeInstallError: the GLOBAL backstop (any throw → actionable) ──
check('a permission (EACCES) error → the sudo fix', /sudo/.test(describeInstallError(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))));
check('a missing-command (ENOENT) error → the install-prereqs fix', /git|curl|python3/.test(describeInstallError(Object.assign(new Error('spawn psql ENOENT'), { code: 'ENOENT' }))));
check('a port-in-use (EADDRINUSE) error → the port fix', /80\/443/.test(describeInstallError(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }))));
check('a network (ENOTFOUND) error → the network fix', /network|DNS/i.test(describeInstallError(Object.assign(new Error('getaddrinfo ENOTFOUND galaxy.ansible.com'), { code: 'ENOTFOUND' }))));
check('a missing-collection message → the bundled-collections fix', /bundle|collection/i.test(describeInstallError(new Error("couldn't resolve module/action 'community.docker.docker_compose_v2'"))));
check('an UNKNOWN error → support contact (last resort)', describeInstallError(new Error('something nobody has seen')).includes('agorise@pm.me'));
check('every backstop message says a re-run is safe', /re-run|run the installer again/i.test(describeInstallError(new Error('x'))));

// ── Postgres version gate (v1.15.x — Ubuntu 22.04's apt PG 14 < 15) ──
check('parses PG major from "psql (PostgreSQL) 16.3"', parsePgMajor('psql (PostgreSQL) 16.3') === 16);
check("Ubuntu 22.04's PG 14 now MEETS the floor (the distro default)", parsePgMajor('postgres (PostgreSQL) 14.11')! >= MIN_PG_MAJOR);
check('PG 15 meets the floor', parsePgMajor('psql (PostgreSQL) 15.6')! >= MIN_PG_MAJOR);
check('an ancient PG 13 is below the floor', parsePgMajor('psql (PostgreSQL) 13.14')! < MIN_PG_MAJOR);
check('unparseable PG version → null', parsePgMajor('nope') === null);

// ── DNS-points-here pre-check (the #1 real HTTPS-install killer) ──
check('domain resolving to this box → ok', interpretDnsResult(['203.0.113.5'], '203.0.113.5').ok);
check("a domain that doesn't resolve → not ok, actionable", !interpretDnsResult([], '203.0.113.5').ok && /A record/.test(interpretDnsResult([], '203.0.113.5').note));
check('a mismatch → not ok + reminds about the cloud firewall / inbound 80+443', !interpretDnsResult(['1.2.3.4'], '203.0.113.5').ok && /firewall|INBOUND/i.test(interpretDnsResult(['1.2.3.4'], '203.0.113.5').note));
check('a private box IP → flags behind-NAT with port-forward guidance', /NAT/.test(interpretDnsResult(['1.2.3.4'], '192.168.1.9').note));

// ── no-output watchdog (v1.15.2 — a quiet run never looks frozen) ──
check('a fresh run (no silence) does not remind', !shouldRemindQuiet(1_000, 1_000));
check('2 minutes of silence does not remind yet', !shouldRemindQuiet(120_000, 0));
check('3 minutes of silence triggers the reassurance', shouldRemindQuiet(QUIET_REMIND_MS, 0));
check('a long quiet (e.g. a big migration) keeps reminding', shouldRemindQuiet(600_000, 0));

const total = pass + fails.length;
console.log('\n──────────────────────────────────────────────────────');
if (fails.length > 0) {
	console.log(`✗ ${fails.length} of ${total} installer-preflight-checks checks FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} installer-preflight-checks scenarios passed`);
