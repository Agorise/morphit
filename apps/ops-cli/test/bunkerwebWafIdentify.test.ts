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
import { healBunkerWebWaf, restartFrontendContainer } from '../src/commands/upgrade.ts';
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
const done = (c) => { fs.writeFileSync(S, JSON.stringify(st)); process.exit(c); };
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
if (cmd === 'exec') {
	const c = st.containers[args[1]]; if (!c) done(1);
	st.execs.push(args[1]);
	const rest = args.slice(2).join(' ');
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
	'MAX_CLIENT_SIZE=1m\nBAD_BEHAVIOR_STATUS_CODES=401 403 404 405 429 444\nCUSTOM_CONF_MODSEC_morphit_json_api_off=x\n';

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

function morphitIo(
	opts: { containers?: Record<string, Ctr>; env?: string; noEnvFileInModel?: boolean } = {}
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
	writeFileSync(join(w, 'bin/curl'), '#!/bin/sh\nprintf 200\n');
	for (const b of ['docker', 'sleep', 'curl']) chmodSync(join(w, 'bin', b), 0o755);
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
		edgeLive: WIDE,
		cleanLive: CLEAN,
		otherLive: FRONTEND_LIVE,
		calls: [] as string[][],
		compose: [] as Array<{ g: { p: string; d: string; f: string[]; e: string[] }; sub: string[] }>,
		execs: [] as string[],
		restarted: [] as string[]
	};
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
