/**
 * ansible-notify-reachable-smoke (v1.20.0 deep review, C12).
 *
 * Ansible runs a handler only when a task that notifies it reports CHANGED. A
 * task with `notify:` and `changed_when: false` can therefore never run its
 * handler — its change silently waits for some unrelated restart. That is how
 * the ipfs role's "Keep the node small" task wrote Kubo's config (e.g. the
 * gateway bind that lets the frontend reach it) without ever restarting Kubo.
 *
 *  A. STRUCTURE: no task in ops/ansible notifies a handler while pinning
 *     changed_when to false.
 *  B. BEHAVIOUR (when ansible-playbook is installed): the real ipfs-role task,
 *     lifted out of roles/ipfs/tasks/main.yml, is run against a stub `ipfs`
 *     whose config lives in a JSON file. First run (a value differs): the
 *     config is written AND the handler runs. Second run (nothing differs): no
 *     change, no handler.
 *
 * MORPHIT_ANSIBLE_ROOT=<dir containing ops/ansible> checks another tree.
 */
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.env.MORPHIT_ANSIBLE_ROOT ?? REPO;
const ANSIBLE = join(ROOT, 'ops', 'ansible');

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

function walk(dir: string, out: string[] = []): string[] {
	for (const n of readdirSync(dir)) {
		const p = join(dir, n);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (/\.ya?ml$/.test(n)) out.push(p);
	}
	return out;
}

type Task = Record<string, unknown>;
function tasksOf(node: unknown): Task[] {
	if (!Array.isArray(node)) return [];
	const out: Task[] = [];
	for (const t of node) {
		if (t === null || typeof t !== 'object') continue;
		const task = t as Task;
		out.push(task);
		for (const k of ['block', 'rescue', 'always', 'tasks', 'pre_tasks', 'post_tasks', 'handlers'])
			out.push(...tasksOf(task[k]));
	}
	return out;
}

console.log('\n── ansible-notify-reachable smoke ──────────────────────\n');

// ── A. structure ──
const offenders: string[] = [];
let scanned = 0;
for (const f of walk(ANSIBLE)) {
	let doc: unknown;
	try {
		doc = yaml.load(readFileSync(f, 'utf8'));
	} catch {
		continue;
	}
	for (const t of tasksOf(doc)) {
		scanned++;
		const cw = t['changed_when'];
		if (t['notify'] !== undefined && (cw === false || cw === 'false' || cw === 'no')) {
			offenders.push(`${relative(ROOT, f)}: "${String(t['name'] ?? '?')}"`);
		}
	}
}
check(`scanned the Ansible tree (${scanned} tasks)`, scanned > 50);
check(
	'no task notifies a handler it can never trigger (notify + changed_when: false)',
	offenders.length === 0,
	offenders.join('; ')
);

// ── B. behaviour of the real ipfs-role task ──
const have = spawnSync('ansible-playbook', ['--version'], { encoding: 'utf8' }).status === 0;
if (!have) {
	console.log('  (ansible-playbook not installed here — the behavioural scenarios are skipped)');
} else {
	const role = yaml.load(
		readFileSync(join(ANSIBLE, 'roles', 'ipfs', 'tasks', 'main.yml'), 'utf8')
	) as Task[];
	const task = role.find((t) => String(t['name'] ?? '').startsWith('Keep the node small'));
	check('found the ipfs role "Keep the node small" task', task !== undefined);
	if (task) {
		const work = mkdtempSync(join(tmpdir(), 'morphit-notify-'));
		try {
			const bin = join(work, 'bin');
			mkdirSync(bin);
			// Stub Kubo CLI: `config <key>` prints, `config --json <key> <v>` sets.
			writeFileSync(
				join(bin, 'ipfs'),
				`#!/usr/bin/env node
const fs=require('fs'),p=process.env.IPFS_PATH+'/config';const a=process.argv.slice(2);const c=JSON.parse(fs.readFileSync(p,'utf8'));
const w=(k)=>k.split('.');
if(a[0]==='config'&&a[1]==='--json'){let o=c;const ks=w(a[2]);for(const k of ks.slice(0,-1)){if(typeof o[k]!=='object'||o[k]===null)o[k]={};o=o[k];}o[ks[ks.length-1]]=JSON.parse(a[3]);fs.writeFileSync(p,JSON.stringify(c));process.exit(0);}
if(a[0]==='config'){let o=c;for(const k of w(a[1])){if(o===null||typeof o!=='object'||!(k in o)){console.error('Error: key has no attributes');process.exit(1);}o=o[k];}console.log(typeof o==='string'?o:JSON.stringify(o));process.exit(0);}
`
			);
			chmodSync(join(bin, 'ipfs'), 0o755);
			const repo = join(work, 'repo');
			mkdirSync(repo);
			// An older install: gateway on loopback, everything else already right.
			writeFileSync(
				join(repo, 'config'),
				JSON.stringify({
					Addresses: { API: '/ip4/127.0.0.1/tcp/5001', Gateway: '/ip4/127.0.0.1/tcp/8082' },
					Gateway: { NoFetch: true },
					Swarm: { ConnMgr: { HighWater: 80, LowWater: 20 } },
					Routing: { Type: 'auto' }
				})
			);
			const t = { ...task } as Task;
			delete t['become'];
			delete t['become_user'];
			const play = [
				{
					hosts: 'localhost',
					gather_facts: false,
					vars: {
						morphit_ipfs_repo: repo,
						morphit_ipfs_api_addr: '/ip4/127.0.0.1/tcp/5001',
						morphit_ipfs_gateway_expose: true,
						morphit_ipfs_gateway_expose_addr: '/ip4/0.0.0.0/tcp/8082',
						morphit_ipfs_gateway_addr: '/ip4/127.0.0.1/tcp/8082',
						morphit_ipfs_connmgr_high: 80,
						morphit_ipfs_connmgr_low: 20,
						morphit_tor_only: false
					},
					tasks: [t],
					handlers: [
						{ name: 'Restart ipfs', 'ansible.builtin.debug': { msg: 'HANDLER-RESTART-IPFS-RAN' } }
					]
				}
			];
			writeFileSync(join(work, 'play.yml'), yaml.dump(play, { lineWidth: 400 }));
			const runPlay = () =>
				spawnSync('ansible-playbook', ['-i', 'localhost,', '-c', 'local', join(work, 'play.yml')], {
					encoding: 'utf8',
					timeout: 300_000,
					env: {
						...process.env,
						PATH: `${bin}:${process.env.PATH}`,
						ANSIBLE_NOCOLOR: '1',
						ANSIBLE_STDOUT_CALLBACK: 'default'
					}
				});
			const r1 = runPlay();
			const cfg = JSON.parse(readFileSync(join(repo, 'config'), 'utf8'));
			check(
				'behaviour: the play runs',
				r1.status === 0,
				(r1.stdout + r1.stderr)
					.split('\n')
					.filter((l) => /fatal|ERROR/.test(l))
					.join(' ')
					.slice(0, 300)
			);
			check(
				'behaviour: a differing value (gateway bind) is written',
				cfg.Addresses?.Gateway === '/ip4/0.0.0.0/tcp/8082',
				JSON.stringify(cfg.Addresses)
			);
			check(
				'behaviour: …and the Restart ipfs handler RUNS, so Kubo picks it up',
				/HANDLER-RESTART-IPFS-RAN/.test(r1.stdout ?? '')
			);
			const r2 = runPlay();
			check(
				'behaviour: a second run with nothing to change reports no change and runs no handler',
				r2.status === 0 &&
					!/HANDLER-RESTART-IPFS-RAN/.test(r2.stdout ?? '') &&
					/changed=0/.test(r2.stdout ?? ''),
				(r2.stdout ?? '')
					.split('\n')
					.filter((l) => /changed=|HANDLER/.test(l))
					.join(' | ')
			);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}
}

console.log(
	fail === 0
		? `\n✓ all ${pass} ansible-notify-reachable checks passed`
		: `\n✗ ansible-notify-reachable: ${pass} passed, ${fail} failed`
);
process.exit(fail === 0 ? 0 : 1);
