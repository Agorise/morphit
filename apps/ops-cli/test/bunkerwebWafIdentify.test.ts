/**
 * Wave 5 (B-from-C §4, HIGH): the upgrade's BunkerWeb heals must find BunkerWeb
 * by IMAGE (bunkerity/bunkerweb, tie-broken by host port 443), never by name,
 * and must only ever touch BunkerWeb's own services with `up -d --no-deps`.
 *
 * morphit.io runs a hand-made /opt/bunkerweb stack whose containers are ALL
 * named bunkerweb-<service>-1 (frontend, onion-service, crowdsec, db, redis…),
 * listed frontend-first. The old name match picked bunkerweb-frontend-1 as
 * "BunkerWeb", checked the WAF inside it, and fell back to a whole-stack
 * `docker compose -f … up -d` (which can recreate the database) and to
 * restarting that wrongly chosen container.
 *
 * This drives the REAL healBunkerWebWaf / restartFrontendContainer against a
 * fake `docker` on PATH shaped like morphit.io, and asserts on what it RAN.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { join } from 'node:path';
import {
	classifyRepeatProbe,
	healBunkerWebWaf,
	restartFrontendContainer,
	selfHealSteps
} from '../src/commands/upgrade.ts';
import { spinnerFrames } from './helpers/pty.ts';
import { runBunkerWeb } from '../src/commands/bunkerweb.ts';
import {
	collectInstallSummary,
	containerRunningNow,
	type SummaryProbe
} from '../src/init/installSummary.ts';

// The fake docker. State (JSON) in $FAKE_DOCKER_STATE; every call is recorded.
const FAKE = String.raw`#!/usr/bin/env node
const fs = require('fs');
const S = process.env.FAKE_DOCKER_STATE;
const st = JSON.parse(fs.readFileSync(S, 'utf8'));
const args = process.argv.slice(2);
st.calls.push(args);
const out = (s) => process.stdout.write(s);
// Written to a side file and renamed into place: the status command runs
// several docker calls at once, and a reader catching the file half-written
// read a container as absent (an intermittent "partial", v1.21.8).
const done = (c) => { const t = S + '.' + process.pid; fs.writeFileSync(t, JSON.stringify(st)); fs.renameSync(t, S); process.exit(c); };
const running = () => Object.keys(st.containers).filter((n) => st.containers[n].running);
const isEdge = (c) => /(^|\/)bunkerity\/bunkerweb(:|$)/.test(c.image);
function inspectJson(c) {
	const ports = {};
	for (const p of c.ports) { const m = /^(.*):(\d+)->(.*)$/.exec(p); (ports[m[3]] = ports[m[3]] || []).push({ HostIp: m[1], HostPort: m[2] }); }
	return { Id: c.name + '-id', Name: '/' + c.name, Config: { Image: c.image, Labels: c.labels, Env: [] },
		State: { Running: c.running }, HostConfig: { LogConfig: { Type: 'json-file', Config: {} }, ExtraHosts: [] },
		NetworkSettings: { Ports: ports, Networks: { n: { Gateway: '172.18.0.1' } } }, Mounts: c.mounts.map((s) => ({ Source: s })) };
}
const cmd = args[0];
if (cmd === 'version') { out('29.0.0\n'); done(0); }
if (cmd === 'ps') {
	const fi = args.indexOf('--format');
	const fmt = fi >= 0 ? args[fi + 1] : '{{.Names}}';
	const list = args.includes('-a') ? Object.keys(st.containers) : running();
	if (!fmt.includes('{{.Image}}')) { out(list.join('\n') + '\n'); done(0); }
	out(list.map((n) => { const c = st.containers[n]; return [n, c.image, c.ports.join(', '), c.running ? 'Up 2 hours' : 'Exited (0) 1 hour ago', c.labels['com.docker.compose.project'] || '', c.labels['com.docker.compose.service'] || ''].join('\t'); }).join('\n') + '\n');
	done(0);
}
if (cmd === 'inspect') {
	const fi = args.indexOf('--format');
	const fmt = fi >= 0 ? args[fi + 1] : null;
	const cs = args.slice(1).filter((a, i) => a !== '--format' && args[i] !== '--format').map((n) => st.containers[n]).filter(Boolean);
	if (!fmt) { out(JSON.stringify(cs.map(inspectJson))); done(cs.length ? 0 : 1); }
	const c = cs[0]; if (!c) done(1);
	const lab = /index \.Config\.Labels "([^"]+)"/.exec(fmt);
	if (lab) out((c.labels[lab[1]] || '') + '\n');
	else if (fmt.includes('State.Status')) out((c.running ? 'running' : 'exited') + '|none\n');
	else if (fmt.includes('.Mounts')) out(c.mounts.join('\n') + '\n');
	done(0);
}
if (cmd === 'restart') { st.restarted.push(args[1]); done(st.containers[args[1]] ? 0 : 1); }
if (cmd === 'logs') {
	// BunkerWeb's verdict appears only after something restarted it.
	const name = args[args.length - 1];
	const kicked = st.restarted.length > 0 || st.compose.some((c) => c.sub[0] === 'up');
	if (!kicked) done(0);
	if (/scheduler/.test(st.containers[name] ? st.containers[name].image : '')) out(st.schedLog);
	else out(st.edgeLog);
	done(0);
}
if (cmd === 'exec') {
	let k = 1; const envs = {};
	while (args[k] && args[k].startsWith('-')) {
		if (args[k] === '-e') { const [a, ...b] = args[k + 1].split('='); envs[a] = b.join('='); k += 2; } else k++;
	}
	const c = st.containers[args[k]]; if (!c) done(1);
	st.execs.push(args[k]);
	if (args[k + 1] === 'python3') {
		if (envs.MODE === 'list') { out(JSON.stringify(st.ruleCopies)); done(0); }
		if (envs.MODE === 'remove') {
			const ids = envs.IDS.split(',').filter(Boolean).map(Number);
			st.ruleCopies.rows = st.ruleCopies.rows.filter((r) => !ids.includes(r.id));
			st.removedIds.push(...ids);
			out(JSON.stringify({ backup: '/data/lib/db.pre-morphit-dedupe.sqlite3', rows: ids.length, moved: [] }));
			done(0);
		}
		if (envs.MODE === 'restore') { st.restoredCount++; out('ok'); done(0); }
		done(1);
	}
	const rest = args.slice(k + 1).join(' ');
	if (rest.includes('nginx -T')) { out(isEdge(c) ? st.edgeLive : st.otherLive); done(0); }
	if (rest.includes('for d in')) { out('/data/configs\n'); done(0); }
	if (rest.includes('test -s')) { out('yes\n'); done(0); }
	if (rest.includes('grep -rl')) { out('/data/configs/modsec/morphit-json-api-off.conf\n'); done(0); }
	done(0);
}
if (cmd === 'compose') {
	const g = { p: '', d: '', f: [], e: [] };
	let i = 1;
	for (; i < args.length; i++) {
		const a = args[i];
		if (a === '-p') g.p = args[++i];
		else if (a === '--project-directory') g.d = args[++i];
		else if (a === '-f') g.f.push(args[++i]);
		else if (a === '--env-file') g.e.push(args[++i]);
		else break;
	}
	const sub = args.slice(i);
	st.compose.push({ g, sub });
	if (sub[0] === 'config') { if (st.model === null) done(1); out(JSON.stringify(st.model)); done(0); }
	if (sub[0] === 'up') {
		const svcs = sub.slice(1).filter((a) => !a.startsWith('-'));
		// Only a recreate of the edge re-reads its env file.
		if ((svcs.length === 0 || svcs.includes(st.edgeService)) && /^USE_REAL_IP=no$/m.test(fs.readFileSync(st.envPath, 'utf8'))) st.edgeLive = st.cleanLive;
		if ((svcs.length === 0 || svcs.includes(st.edgeService)) && !st.edgeKeepsOldLimit) st.limitLoaded = /^LIMIT_REQ_URL=\^\/\(\?:ipfs\|ipns\|rss\)\/\|\^\/mcp$/m.test(fs.readFileSync(st.envPath, 'utf8'));
		done(0);
	}
	done(0);
}
done(0);
`;

const WIDE =
	'http {\n  server {\n    set_real_ip_from 0.0.0.0/0;\n    real_ip_header X-Forwarded-For;\n  }\n}\n';
const CLEAN = 'http {\n  server {\n    listen 8443 ssl;\n  }\n}\n';
// The frontend behind BunkerWeb legitimately trusts BunkerWeb's forwarding.
const FRONTEND_LIVE = 'http {\n  server {\n    set_real_ip_from 172.16.0.0/12;\n  }\n}\n';
const STEADY_ABC =
	'MAX_CLIENT_SIZE=1m\nBAD_BEHAVIOR_STATUS_CODES=401 403 404 405 429 444\nCUSTOM_CONF_MODSEC_morphit_json_api_off=x\n' +
	'LIMIT_REQ_URL=^/(?:ipfs|ipns|rss)/|^/mcp\nLIMIT_REQ_RATE=2r/s\nLIMIT_CONN_MAX_HTTP2=256\n';

interface Ctr {
	service: string;
	image: string;
	ports?: string[];
	mounts?: string[];
	project?: string;
	running?: boolean;
}

const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ruleRow = (id: number, name: string, method: string) => ({
	id,
	serviceId: null,
	type: 'modsec',
	name,
	method,
	checksum: String(id),
	data: Buffer.from('SecRule REQUEST_URI "@rx ^/(v1|relay)/" "id:1990001,phase:1"').toString(
		'base64'
	)
});

function morphitIo(
	opts: {
		containers?: Record<string, Ctr>;
		env?: string;
		noEnvFileInModel?: boolean;
		schedLog?: string;
		edgeLog?: string;
		ruleCopies?: { rows: ReturnType<typeof ruleRow>[]; files: string[] };
		edgeLive?: string;
		/** BunkerWeb keeps its old nginx config even when recreated. */
		edgeKeepsOldConfig?: boolean;
		/** BunkerWeb keeps its old request limit even when recreated. */
		edgeKeepsOldLimit?: boolean;
		/** What curl writes for the three-fetch probe instead (e.g. no answer). */
		repeatAnswer?: string;
		/** How long the three-fetch probe takes, in ms. */
		repeatDelayMs?: number;
	} = {}
) {
	const w = mkdtempSync(join(tmpdir(), 'bw-identify-'));
	dirs.push(w);
	const bw = join(w, 'opt/bunkerweb');
	const build = join(w, 'opt/morphit/apps/web/build');
	const install = join(w, 'opt/morphit');
	mkdirSync(join(bw, 'frontend'), { recursive: true });
	mkdirSync(build, { recursive: true });
	mkdirSync(join(install, 'ops/bunkerweb/frontend'), { recursive: true });
	writeFileSync(join(install, 'ops/bunkerweb/frontend/nginx.conf'), 'server {}\n');
	mkdirSync(join(w, 'bin'));
	const files = [join(bw, 'docker-compose.yml'), join(bw, 'docker-compose.override.yml')];
	for (const f of files) writeFileSync(f, 'services: {}\n');
	const envPath = join(bw, 'bunkerweb.env');
	const projEnv = join(bw, '.env');
	writeFileSync(projEnv, 'TZ=UTC\n');
	writeFileSync(
		envPath,
		opts.env ?? `SERVER_NAME=morphit.io\n${STEADY_ABC}USE_REAL_IP=yes\nREAL_IP_FROM=0.0.0.0/0\n`
	);
	writeFileSync(join(w, 'bin/docker'), FAKE);
	writeFileSync(join(w, 'bin/sleep'), '#!/bin/sh\nexit 0\n');
	// curl: the three-fetch probe (three `-o /dev/null <url>`) answers like
	// BunkerWeb — its old request limit 429s the third fetch until it has been
	// recreated with Morphit's rule; every other probe answers as before.
	writeFileSync(
		join(w, 'bin/curl'),
		String.raw`#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(process.env.FAKE_DOCKER_STATE, 'utf8'));
const urls = a.filter((x, i) => /^https?:/.test(x) && a[i - 1] === '/dev/null');
if (urls.length === 3) { st.repeatProbes = (st.repeatProbes || 0) + 1; const t = process.env.FAKE_DOCKER_STATE + '.' + process.pid; fs.writeFileSync(t, JSON.stringify(st)); fs.renameSync(t, process.env.FAKE_DOCKER_STATE); if (st.repeatDelayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, st.repeatDelayMs); process.stdout.write(st.repeatAnswer ?? (st.limitLoaded ? '200 200 200 ' : '200 200 429 ')); process.exit(st.repeatAnswer === undefined ? 0 : 7); }
process.stdout.write(a.join(' ').includes('v1/health') ? (process.env.FAKE_CURL_API || '200') : (process.env.FAKE_CURL_HOME || '200'));
`
	);
	writeFileSync(
		join(w, 'bin/systemd-run'),
		`#!/bin/sh\nprintf '%s\\n' "$@" > ${join(w, 'systemd-run.args')}\nexit 0\n`
	);
	writeFileSync(join(w, 'bin/systemctl'), '#!/bin/sh\nexit 3\n');
	for (const b of ['docker', 'sleep', 'curl', 'systemd-run', 'systemctl'])
		chmodSync(join(w, 'bin', b), 0o755);
	const ctrs: Record<string, Ctr> = opts.containers ?? {
		// docker ps order: frontend FIRST (the order that fooled the name match).
		'bunkerweb-frontend-1': { service: 'frontend', image: 'bunkerweb-frontend', mounts: [build] },
		'bunkerweb-onion-service-1': { service: 'onion-service', image: 'example/tor' },
		'bunkerweb-crowdsec-1': {
			service: 'crowdsec',
			image: 'crowdsecurity/crowdsec:latest',
			mounts: ['/var/run/docker.sock']
		},
		'bunkerweb-db-1': { service: 'db', image: 'postgres:16-alpine' },
		'bunkerweb-redis-1': { service: 'redis', image: 'redis:7-alpine' },
		'bunkerweb-bunkerweb-1': {
			service: 'bunkerweb',
			image: 'bunkerity/bunkerweb:1.5.10',
			ports: ['0.0.0.0:443->8443/tcp', '0.0.0.0:80->8080/tcp']
		},
		'bunkerweb-bw-scheduler-1': {
			service: 'bw-scheduler',
			image: 'bunkerity/bunkerweb-scheduler:1.5.10'
		}
	};
	const containers: Record<string, unknown> = {};
	for (const [name, c] of Object.entries(ctrs))
		containers[name] = {
			name,
			image: c.image,
			running: c.running ?? true,
			ports: c.ports ?? [],
			mounts: c.mounts ?? [],
			labels: {
				'com.docker.compose.project': c.project ?? 'bunkerweb',
				'com.docker.compose.service': c.service,
				'com.docker.compose.project.config_files': files.join(','),
				'com.docker.compose.project.working_dir': bw,
				'com.docker.compose.project.environment_file': projEnv
			}
		};
	const envFile = opts.noEnvFileInModel ? [] : [{ path: envPath }];
	const state = {
		containers,
		model: {
			name: 'bunkerweb',
			services: {
				bunkerweb: {
					image: 'bunkerity/bunkerweb:1.5.10',
					env_file: envFile,
					depends_on: { 'bw-scheduler': {}, db: {} }
				},
				'bw-scheduler': { image: 'bunkerity/bunkerweb-scheduler:1.5.10', env_file: envFile },
				db: { image: 'postgres:16-alpine' },
				frontend: { image: 'bunkerweb-frontend' }
			}
		},
		edgeService: 'bunkerweb',
		envPath,
		edgeLive: opts.edgeLive ?? WIDE,
		cleanLive: opts.edgeKeepsOldConfig ? WIDE : CLEAN,
		edgeKeepsOldLimit: opts.edgeKeepsOldLimit ?? false,
		repeatAnswer: opts.repeatAnswer,
		repeatDelayMs: opts.repeatDelayMs ?? 0,
		// Loaded at start when the env already carries Morphit's rule.
		limitLoaded: false as boolean,
		repeatProbes: 0,
		otherLive: FRONTEND_LIVE,
		calls: [] as string[][],
		compose: [] as Array<{ g: { p: string; d: string; f: string[]; e: string[] }; sub: string[] }>,
		execs: [] as string[],
		restarted: [] as string[],
		schedLog: opts.schedLog ?? 'Successfully sent API request to http://bunkerweb:5000/reload\n',
		edgeLog: opts.edgeLog ?? '',
		ruleCopies: opts.ruleCopies ?? {
			rows: [ruleRow(5, 'morphit_json_api_off', 'scheduler')],
			files: []
		},
		removedIds: [] as number[],
		restoredCount: 0
	};
	state.limitLoaded = /^LIMIT_REQ_URL=\^\/\(\?:ipfs\|ipns\|rss\)\/\|\^\/mcp$/m.test(
		readFileSync(envPath, 'utf8')
	);
	const statePath = join(w, 'state.json');
	writeFileSync(statePath, JSON.stringify(state));
	return {
		w,
		bw,
		build,
		install,
		files,
		envPath,
		projEnv,
		async run(fn: () => unknown) {
			const out: string[] = [];
			vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
				out.push(String(s));
				return true;
			});
			vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
				out.push(`${a.map(String).join(' ')}\n`);
			});
			vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => {
				out.push(`ERR ${String(s)}`);
				return true;
			});
			const oldPath = process.env.PATH;
			const oldState = process.env.FAKE_DOCKER_STATE;
			process.env.PATH = `${join(w, 'bin')}:${oldPath ?? ''}`;
			process.env.FAKE_DOCKER_STATE = statePath;
			let threw: unknown = null;
			try {
				await fn();
			} catch (e) {
				threw = e;
			} finally {
				process.env.PATH = oldPath;
				if (oldState === undefined) delete process.env.FAKE_DOCKER_STATE;
				else process.env.FAKE_DOCKER_STATE = oldState;
				vi.restoreAllMocks();
			}
			const st = JSON.parse(readFileSync(statePath, 'utf8')) as typeof state;
			return { st, out: out.join(''), threw, env: readFileSync(envPath, 'utf8') };
		}
	};
}

const EDGE = 'bunkerweb-bunkerweb-1';
const SCHED = 'bunkerweb-bw-scheduler-1';
const ups = (st: {
	compose: Array<{ g: { p: string; f: string[]; e: string[] }; sub: string[] }>;
}) => st.compose.filter((c) => c.sub[0] === 'up');

describe('healBunkerWebWaf on a morphit.io-shaped stack (all containers named bunkerweb-*)', () => {
	it('checks and reloads BunkerWeb itself — never the frontend, onion service, crowdsec or db', async () => {
		const box = morphitIo();
		const r = await box.run(() => healBunkerWebWaf(box.envPath, box.build));
		expect(r.threw).toBeNull();
		// Every exec/restart lands on BunkerWeb's own containers.
		expect(r.st.execs.length).toBeGreaterThan(0);
		for (const n of r.st.execs) expect([EDGE, SCHED]).toContain(n);
		for (const n of r.st.restarted) expect([EDGE, SCHED]).toContain(n);
		// Its nginx was checked (the edge's `nginx -T`), not the frontend's.
		expect(r.st.execs).toContain(EDGE);
		expect(r.st.execs).not.toContain('bunkerweb-frontend-1');
		// Fix D took, verified on the edge.
		expect(r.env).toMatch(/^USE_REAL_IP=no$/m);
		expect(r.st.edgeLive).toBe(CLEAN);
		expect(r.out).toMatch(/real-IP verified live/);
	});

	// v1.21.1 review A-F2: the line asking the operator to recreate BunkerWeb
	// was printed as info, so the last word said "Nothing else to do." after it.
	it('BunkerWeb still running the old real-IP setting after its recreate: a warning (counted) with the command', async () => {
		const { warningCount } = await import('../src/render/term.ts');
		const box = morphitIo({ edgeKeepsOldConfig: true });
		const before = warningCount();
		const r = await box.run(() => healBunkerWebWaf(box.envPath, box.build));
		expect(r.threw).toBeNull();
		expect(r.env).toMatch(/^USE_REAL_IP=no$/m);
		expect(r.out).toMatch(
			/ERR \[WARN\] WAF: BunkerWeb still has the old real-IP setting loaded\. When convenient, run on this server: sudo docker compose -p bunkerweb .* up -d --no-deps --force-recreate bunkerweb bw-scheduler/
		);
		expect(r.out).not.toMatch(/real-IP verified live/);
		expect(warningCount() - before).toBeGreaterThanOrEqual(1);
	});

	it('every `compose up` is --no-deps, names only BunkerWeb’s services, and addresses the whole project', async () => {
		const box = morphitIo();
		const r = await box.run(() => healBunkerWebWaf(box.envPath, box.build));
		const u = ups(r.st);
		expect(u.length).toBeGreaterThan(0);
		for (const c of u) {
			expect(c.sub).toContain('--no-deps');
			const svcs = c.sub.slice(1).filter((a) => !a.startsWith('-'));
			expect(svcs.length).toBeGreaterThan(0);
			for (const s of svcs) expect(['bunkerweb', 'bw-scheduler']).toContain(s);
			expect(c.g.p).toBe('bunkerweb');
			expect(c.g.f).toEqual(box.files);
			expect(c.g.e).toEqual([box.projEnv]);
		}
		// No plain whole-stack `up` anywhere, with either binary.
		expect(
			r.st.calls.some((a) => a[0] === 'compose' && a.includes('up') && !a.includes('--no-deps'))
		).toBe(false);
	});

	it('finds the env file BunkerWeb reads from Compose, even when the default path is absent', async () => {
		const box = morphitIo();
		const r = await box.run(() =>
			healBunkerWebWaf(join(box.w, 'etc/bunkerweb/bunkerweb.env'), box.build)
		);
		expect(r.env).toMatch(/^USE_REAL_IP=no$/m);
		expect(existsSync(join(box.w, 'etc/bunkerweb/bunkerweb.env'))).toBe(false);
		for (const n of r.st.execs) expect([EDGE, SCHED]).toContain(n);
	});

	it('two BunkerWeb containers and no 443 tie-break → changes nothing, says so calmly', async () => {
		const box = morphitIo({
			containers: {
				'bunkerweb-frontend-1': { service: 'frontend', image: 'bunkerweb-frontend' },
				'bw-a': { service: 'bunkerweb', image: 'bunkerity/bunkerweb:1.5.10' },
				'bw-b': { service: 'bunkerweb2', image: 'bunkerity/bunkerweb:1.5.10' },
				'bunkerweb-db-1': { service: 'db', image: 'postgres:16-alpine' }
			}
		});
		const before = readFileSync(box.envPath, 'utf8');
		const r = await box.run(() => healBunkerWebWaf(box.envPath, box.build));
		expect(r.threw).toBeNull();
		expect(r.env).toBe(before);
		expect(r.st.execs).toEqual([]);
		expect(r.st.restarted).toEqual([]);
		expect(ups(r.st)).toEqual([]);
		expect(r.out).toMatch(/could not tell which one is the public one/);
		expect(r.out).not.toMatch(/ERR/);
	});

	it('Compose cannot say which env file BunkerWeb reads, and the given one is not in its project → left alone', async () => {
		const box = morphitIo({ noEnvFileInModel: true });
		const elsewhere = join(box.w, 'etc/bunkerweb');
		mkdirSync(elsewhere, { recursive: true });
		const other = join(elsewhere, 'bunkerweb.env');
		writeFileSync(other, 'USE_REAL_IP=yes\nREAL_IP_FROM=0.0.0.0/0\n');
		const before = readFileSync(box.envPath, 'utf8');
		const r = await box.run(() => healBunkerWebWaf(other, box.build));
		expect(readFileSync(other, 'utf8')).toBe('USE_REAL_IP=yes\nREAL_IP_FROM=0.0.0.0/0\n');
		expect(r.env).toBe(before);
		expect(ups(r.st)).toEqual([]);
		expect(r.st.restarted).toEqual([]);
		expect(r.out).not.toMatch(/ERR/);
	});

	it('no BunkerWeb at all → no-op, silent', async () => {
		const box = morphitIo({
			containers: {
				'web-1': { service: 'web', image: 'nginx:alpine', ports: ['0.0.0.0:443->443/tcp'] }
			}
		});
		const before = readFileSync(box.envPath, 'utf8');
		const r = await box.run(() => healBunkerWebWaf(box.envPath, box.build));
		expect(r.env).toBe(before);
		expect(r.st.execs).toEqual([]);
		expect(ups(r.st)).toEqual([]);
		expect(r.out).not.toMatch(/ERR/);
	});
});

// v1.20.1 — morphitir (2026-09-30): the exemption stored twice made BunkerWeb
// refuse every new config for three weeks while every container looked healthy.
describe('healBunkerWebWaf keeps ONE copy of the API exemption and reads BunkerWeb’s own verdict', () => {
	const STEADY = `SERVER_NAME=morphitir.com\n${STEADY_ABC}USE_REAL_IP=no\n`;
	const TWO = () => ({
		rows: [
			ruleRow(5, 'morphit_json_api_off', 'scheduler'),
			ruleRow(6, 'morphit-json-api-off', 'manual')
		],
		files: []
	});
	const withCurl = async <T>(api: string, home: string, fn: () => Promise<T>): Promise<T> => {
		process.env.FAKE_CURL_API = api;
		process.env.FAKE_CURL_HOME = home;
		try {
			return await fn();
		} finally {
			delete process.env.FAKE_CURL_API;
			delete process.env.FAKE_CURL_HOME;
		}
	};

	it('removes the extra copy, rebuilds BunkerWeb, and proves the API passes while the site stays guarded', async () => {
		const box = morphitIo({ env: STEADY, ruleCopies: TWO(), edgeLive: CLEAN });
		const r = await withCurl('200', '403', () =>
			box.run(() => healBunkerWebWaf(box.envPath, box.build))
		);
		expect(r.threw).toBeNull();
		expect(r.st.removedIds).toEqual([6]);
		expect(r.st.ruleCopies.rows.map((x) => x.name)).toEqual(['morphit_json_api_off']);
		expect(r.st.restarted).toContain(SCHED);
		expect(r.out).toMatch(/removed 1 extra copy/);
		expect(r.out).toMatch(/built, tested and loaded its new settings/);
		expect(r.out).toMatch(/exemption verified live .*stored 1 time/);
		expect(r.st.restoredCount).toBe(0);
	});

	it('BunkerWeb refusing the rebuilt config is reported with nginx’s own reason — never as success', async () => {
		const box = morphitIo({
			env: STEADY,
			ruleCopies: TWO(),
			edgeLive: CLEAN,
			schedLog:
				'[API] Error while sending API request to http://bunkerweb:5000/reload : status = error, msg = config check failed\n' +
				'[SCHEDULER] Error while reloading bunkerweb, failing over to last working configuration ...\n' +
				'[API] Successfully sent API request to http://bunkerweb:5000/reload\n',
			edgeLog:
				'2026/09/30 19:01:20 [emerg] 162#162: "modsecurity_rules_file" directive Rule id: 1990001 is duplicated\n'
		});
		const r = await withCurl('200', '403', () =>
			box.run(() => healBunkerWebWaf(box.envPath, box.build))
		);
		expect(r.out).toMatch(
			/own config test failed \("modsecurity_rules_file" directive Rule id: 1990001 is duplicated\)/
		);
		expect(r.out).not.toMatch(/built, tested and loaded/);
	});

	it('puts the copies back when the API is blocked after removing one (never leaves /v1/ without its exemption)', async () => {
		const box = morphitIo({ env: STEADY, ruleCopies: TWO(), edgeLive: CLEAN });
		const r = await withCurl('403', '403', () =>
			box.run(() => healBunkerWebWaf(box.envPath, box.build))
		);
		expect(r.st.removedIds).toEqual([6]);
		expect(r.st.restoredCount).toBe(1);
		expect(r.out).toMatch(/so it was put back/);
	});

	it('one copy → nothing removed, nothing restarted', async () => {
		const box = morphitIo({ env: STEADY, edgeLive: CLEAN });
		const r = await withCurl('200', '403', () =>
			box.run(() => healBunkerWebWaf(box.envPath, box.build))
		);
		expect(r.st.removedIds).toEqual([]);
		expect(r.st.restarted).toEqual([]);
		expect(ups(r.st)).toEqual([]);
		expect(r.out).toMatch(/exemption verified live .*stored 1 time/);
	});

	it('never writes the exemption as a second, file-based copy', async () => {
		const box = morphitIo();
		const r = await withCurl('200', '403', () =>
			box.run(() => healBunkerWebWaf(box.envPath, box.build))
		);
		expect(r.st.calls.some((a) => a.join(' ').includes('morphit-json-api-off.conf'))).toBe(false);
		expect(r.env).toMatch(/^CUSTOM_CONF_MODSEC_morphit_json_api_off=/m);
	});
});

describe('v1.20.1: on a BunkerWeb box the web-proxy heals run in the background', () => {
	it('the post-upgrade step starts `__web-heal` as the morphit-web-heal unit and changes nothing itself', async () => {
		const box = morphitIo();
		process.env.MORPHIT_WEB_HEAL_STATE = join(box.w, 'web-heal.json');
		process.env.MORPHIT_WEB_HEAL_LOG = join(box.w, 'web-heal.log');
		const before = readFileSync(box.envPath, 'utf8');
		try {
			const step = selfHealSteps().find(([n]) => n === 'the web-proxy heals')!;
			const r = await box.run(() => step[1]());
			expect(r.threw).toBeNull();
			const args = readFileSync(join(box.w, 'systemd-run.args'), 'utf8').split('\n');
			expect(args).toContain('--unit=morphit-web-heal');
			expect(args).toContain('__web-heal');
			expect(r.env).toBe(before);
			expect(ups(r.st)).toEqual([]);
			expect(r.st.restarted).toEqual([]);
			expect(r.out).toMatch(/checked in the background/);
		} finally {
			delete process.env.MORPHIT_WEB_HEAL_STATE;
			delete process.env.MORPHIT_WEB_HEAL_LOG;
		}
	});
});

describe('restartFrontendContainer on a morphit.io-shaped stack', () => {
	it('rebuilds ONLY the frontend service, addressing the whole Compose project', async () => {
		const box = morphitIo();
		const r = await box.run(() => restartFrontendContainer('bunkerweb-frontend-1', box.install));
		const u = ups(r.st);
		expect(u.length).toBe(1);
		const c = u[0]!;
		expect(c.sub).toEqual(['up', '-d', '--no-deps', '--build', '--force-recreate', 'frontend']);
		expect(c.g.p).toBe('bunkerweb');
		expect(c.g.f).toEqual(box.files);
		expect(c.g.e).toEqual([box.projEnv]);
		expect(r.st.restarted).toEqual([]);
		expect(readFileSync(join(box.bw, 'frontend/nginx.conf'), 'utf8')).toBe('server {}\n');
	});
});

describe('morphit-ops bunkerweb (status) on a morphit.io-shaped stack', () => {
	it('--json reports the real BunkerWeb containers (found by image), running', async () => {
		const box = morphitIo();
		const r = await box.run(() =>
			runBunkerWeb({ flags: { json: 'true' }, positional: [], colorEnabled: false })
		);
		const j = JSON.parse(r.out.slice(r.out.indexOf('{'))) as {
			state: string;
			containers: Array<{ name: string }>;
		};
		expect(j.state).toBe('running');
		expect(j.containers.map((c) => c.name)).toEqual([EDGE, SCHED]);
	});

	it('its stack stopped → never offers a second /etc/bunkerweb stack; names this project’s own start command', async () => {
		const box = morphitIo({
			containers: {
				'bunkerweb-frontend-1': { service: 'frontend', image: 'bunkerweb-frontend' },
				'bunkerweb-db-1': { service: 'db', image: 'postgres:16-alpine' },
				'bunkerweb-bunkerweb-1': {
					service: 'bunkerweb',
					image: 'bunkerity/bunkerweb:1.5.10',
					running: false
				},
				'bunkerweb-bw-scheduler-1': {
					service: 'bw-scheduler',
					image: 'bunkerity/bunkerweb-scheduler:1.5.10',
					running: false
				}
			}
		});
		const r = await box.run(() =>
			runBunkerWeb({ flags: { status: 'true' }, positional: [], colorEnabled: false })
		);
		expect(r.out).not.toMatch(/cp -r ops\/bunkerweb \/etc\/bunkerweb/);
		expect(r.out).not.toMatch(/cd \/etc\/bunkerweb/);
		expect(r.out).toMatch(/on this server/);
		expect(r.out).toMatch(/docker compose -p bunkerweb .* up -d --no-deps bunkerweb bw-scheduler/);
		expect(r.out).toContain(EDGE);
		expect(ups(r.st)).toEqual([]);
	});

	it('its stack running → live view and restart/stop name THIS stack, never a whole-stack down', async () => {
		const box = morphitIo();
		const r = await box.run(() =>
			runBunkerWeb({ flags: { status: 'true' }, positional: [], colorEnabled: false })
		);
		expect(r.out).toContain(`docker attach --no-stdin --sig-proxy=false ${EDGE}`);
		expect(r.out).not.toMatch(/docker compose down/);
		expect(r.out).not.toMatch(/cd \/etc\/bunkerweb/);
		expect(r.out).toMatch(/restart bunkerweb bw-scheduler/);
	});
});

describe('install summary (wave 6): BunkerWeb + front-end rows are checked by image/mount, not by name', () => {
	/** A probe that answers the way morphit.io's box would: its containers are
	 *  bunkerweb-<service>-1, so NO container is named `bunkerweb` or
	 *  `morphit-frontend`. Everything else is up. */
	const morphitIoProbe = (build: string): SummaryProbe => ({
		serviceActive: () => true,
		failedUnits: () => [],
		containerRunning: (m: unknown) =>
			typeof m === 'object' &&
			m !== null &&
			((m as { image?: string }).image === 'bunkerity/bunkerweb' ||
				(m as { mounts?: string }).mounts === build),
		firewallActive: () => true,
		pathExists: () => true,
		readText: () => 'x',
		indexerHealth: async () => ({ reachable: true, synced: true, rpcOk: true, fxOk: true }),
		relayReachable: async () => true,
		relayBalanceBlurt: async () => 2500,
		systemHealth: () => ({ ok: true })
	});
	it('a running BunkerWeb + front end with non-shipped names are ✓, not a false ✗', async () => {
		const rows = await collectInstallSummary(
			{
				domain: 'morphit.io',
				mode: 'vps',
				torOnly: false,
				enableBunkerweb: true,
				repoPath: '/opt/morphit',
				relayAccount: 'x'
			},
			morphitIoProbe('/opt/morphit/apps/web/build')
		);
		expect(rows.find((r) => /Web firewall/.test(r.label))?.ok).toBe(true);
		expect(rows.find((r) => /Website \(front end\)/.test(r.label))?.ok).toBe(true);
	});
	it('the real probe finds them on a morphit.io-shaped docker, and says no when they are stopped', async () => {
		const box = morphitIo();
		const r = await box.run(() => [
			containerRunningNow({ image: 'bunkerity/bunkerweb' }),
			containerRunningNow({ mounts: box.build }),
			containerRunningNow({ image: 'bunkerity/bunkerweb-ui' })
		]);
		expect(r.threw).toBeNull();
		const stopped = morphitIo({
			containers: {
				'bunkerweb-frontend-1': {
					service: 'frontend',
					image: 'bunkerweb-frontend',
					running: false
				},
				'bunkerweb-bunkerweb-1': {
					service: 'bunkerweb',
					image: 'bunkerity/bunkerweb:1.5.10',
					running: false
				}
			}
		});
		let got: boolean[] = [];
		await box.run(() => {
			got = [
				containerRunningNow({ image: 'bunkerity/bunkerweb' }),
				containerRunningNow({ mounts: box.build }),
				containerRunningNow({ image: 'bunkerity/bunkerweb-ui' })
			];
		});
		expect(got).toEqual([true, true, false]);
		let got2: boolean[] = [];
		await stopped.run(() => {
			got2 = [
				containerRunningNow({ image: 'bunkerity/bunkerweb' }),
				containerRunningNow({ mounts: stopped.build })
			];
		});
		expect(got2).toEqual([false, false]);
	});
});

// vigilante.trading, v1.21.8: BunkerWeb's default request limit (2 per second
// per visitor AND per file, on every address) answered the third fetch of a
// script file with 429 — the page, the offline cache and the tamper check each
// fetch it on a first visit — and "Failed to fetch dynamically imported module".
describe('healBunkerWebWaf: the site’s own files are not request-limited', () => {
	// The edge already runs without the real-IP trust (CLEAN): only the request
	// limit is under test here.
	const LIMITLESS = `SERVER_NAME=vigilante.trading\nMAX_CLIENT_SIZE=1m\nBAD_BEHAVIOR_STATUS_CODES=401 405 444\nCUSTOM_CONF_MODSEC_morphit_json_api_off=x\nUSE_REAL_IP=no\nUSE_LIMIT_REQ=yes\nLIMIT_REQ_URL_1=/v1/\nLIMIT_REQ_RATE_1=1800r/m\nLIMIT_REQ_URL_2=/relay/\nLIMIT_REQ_RATE_2=120r/m\n`;
	const line = (env: string, k: string): string | null =>
		new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1] ?? null;

	it('a box installed with BunkerWeb’s default: the rule is narrowed, recreated, and verified live', async () => {
		const box = morphitIo({ env: LIMITLESS, edgeLive: CLEAN });
		const r = await box.run(() => healBunkerWebWaf(box.envPath, box.build));
		expect(r.threw).toBeNull();
		expect(line(r.env, 'LIMIT_REQ_URL')).toBe('^/(?:ipfs|ipns|rss)/|^/mcp');
		expect(line(r.env, 'LIMIT_REQ_RATE')).toBe('2r/s');
		expect(line(r.env, 'LIMIT_CONN_MAX_HTTP2')).toBe('256');
		// The API rules are left as they were.
		expect(line(r.env, 'LIMIT_REQ_URL_1')).toBe('/v1/');
		expect(line(r.env, 'LIMIT_REQ_RATE_2')).toBe('120r/m');
		// BunkerWeb's own services were recreated so they read it…
		expect(ups(r.st).some((u) => u.sub.includes('--force-recreate'))).toBe(true);
		// …and the running edge answers three fetches in a second without a 429.
		expect(r.st.limitLoaded).toBe(true);
		expect(r.st.repeatProbes).toBeGreaterThan(0);
		expect(r.out).toMatch(/request limit verified live/);
		expect(r.out).not.toMatch(/still limits the site/);
	});

	it('BunkerWeb still answering 429 after its recreate: recreated once more, then a counted warning with the command', async () => {
		const { warningCount } = await import('../src/render/term.ts');
		const box = morphitIo({ env: LIMITLESS, edgeLive: CLEAN, edgeKeepsOldLimit: true });
		const before = warningCount();
		const r = await box.run(() => healBunkerWebWaf(box.envPath, box.build));
		expect(r.threw).toBeNull();
		expect(line(r.env, 'LIMIT_REQ_URL')).toBe('^/(?:ipfs|ipns|rss)/|^/mcp');
		expect(r.st.repeatProbes).toBe(2);
		expect(ups(r.st).filter((u) => u.sub.includes('--force-recreate')).length).toBe(2);
		expect(r.out).toMatch(
			/ERR \[WARN\] WAF: BunkerWeb still limits the site's own files .*sudo docker compose -p bunkerweb .* up -d --no-deps --force-recreate bunkerweb bw-scheduler/
		);
		expect(r.out).not.toMatch(/request limit verified live/);
		expect(warningCount() - before).toBeGreaterThanOrEqual(1);
	});

	it('an operator’s own rule, rate and download count are kept, and nothing is probed', async () => {
		const own = LIMITLESS + 'LIMIT_REQ_URL=/\nLIMIT_REQ_RATE=10r/s\nLIMIT_CONN_MAX_HTTP2=50\n';
		const box = morphitIo({ env: own, edgeLive: CLEAN });
		const r = await box.run(() => healBunkerWebWaf(box.envPath, box.build));
		expect(r.threw).toBeNull();
		expect(r.env).toBe(own);
		expect(ups(r.st)).toEqual([]);
		expect(r.st.repeatProbes).toBe(0);
	});

	it('request and connection limits turned off by the operator: left off', async () => {
		const off =
			LIMITLESS.replace('USE_LIMIT_REQ=yes\n', 'USE_LIMIT_REQ=no\n') + 'USE_LIMIT_CONN=no\n';
		const box = morphitIo({ env: off, edgeLive: CLEAN });
		const r = await box.run(() => healBunkerWebWaf(box.envPath, box.build));
		expect(r.threw).toBeNull();
		expect(r.env).toBe(off);
		expect(ups(r.st)).toEqual([]);
	});

	it('already healed: no rewrite, no restart, still verified live; a second run changes nothing', async () => {
		const box = morphitIo({ env: LIMITLESS, edgeLive: CLEAN });
		const first = await box.run(() => healBunkerWebWaf(box.envPath, box.build));
		const second = await box.run(() => healBunkerWebWaf(box.envPath, box.build));
		expect(second.threw).toBeNull();
		expect(second.env).toBe(first.env);
		expect(ups(second.st).length).toBe(ups(first.st).length);
		expect(second.out).toMatch(/request limit verified live/);
		expect(second.out).not.toMatch(/no longer count toward/);
	});

	// Review B9: a probe that got no answer from this server's own edge proves
	// nothing — never "verified", never a warning about a limit not seen.
	it('no answer to the three-fetch probe: not called verified, said plainly', async () => {
		for (const answer of ['000 000 000 ', '200 200 000 ', '200 ', '']) {
			const box = morphitIo({ env: LIMITLESS, edgeLive: CLEAN, repeatAnswer: answer });
			const r = await box.run(() => healBunkerWebWaf(box.envPath, box.build));
			expect(r.threw, answer).toBeNull();
			expect(r.st.repeatProbes, answer).toBeGreaterThan(0);
			expect(r.out, answer).not.toMatch(/request limit verified live/);
			expect(r.out, answer).not.toMatch(/still limits the site/);
			expect(r.out, answer).toMatch(
				/request-limit check got no answer from this server, so it could not be checked; the WAF settings were applied\. To check again later, on this server: sudo morphit-ops upgrade --heals/
			);
		}
	});

	it('classifyRepeatProbe: only three answers without a 429 are "free"', () => {
		expect(classifyRepeatProbe('200 200 200 ')).toBe('free');
		expect(classifyRepeatProbe('200 304 200')).toBe('free');
		expect(classifyRepeatProbe('200 200 429 ')).toBe('limited');
		expect(classifyRepeatProbe('000 000 000 ')).toBeNull();
		expect(classifyRepeatProbe('200 200 000 ')).toBeNull();
		expect(classifyRepeatProbe('200 200 ')).toBeNull();
		expect(classifyRepeatProbe('')).toBeNull();
	});

	// Review R5 #8: curl may take up to 25 s; the spinner must turn meanwhile.
	it('the braille spinner turns while the three-fetch probe runs', async () => {
		const box = morphitIo({ env: LIMITLESS, edgeLive: CLEAN, repeatDelayMs: 700 });
		const tty = process.stdout.isTTY;
		process.stdout.isTTY = true;
		try {
			const r = await box.run(() => healBunkerWebWaf(box.envPath, box.build));
			expect(r.threw).toBeNull();
			expect(r.out).toMatch(/request limit verified live/);
			expect(
				spinnerFrames(r.out, 'Checking a page can be fetched three times in a second…')
			).toBeGreaterThanOrEqual(4);
		} finally {
			process.stdout.isTTY = tty;
		}
	}, 30_000);
});
