/**
 * proxy-heal-e2e-smoke (v1.20.0 deep review, wave 4).
 *
 * Runs the REAL `healProxyConfig` (the entry `morphit-ops upgrade` calls)
 * against morphit.io's real stack shape — one hand-made /opt/bunkerweb Compose
 * project with bunkerweb, its scheduler, CrowdSec, redis, postgres, an onion
 * service and the frontend, containers named bunkerweb-<service>-1, bridge
 * 172.18.0.0/24 (docs/REVISIT-LIST.md "LIVE VPS TOPOLOGY") — through a fake
 * `docker` on PATH:
 *  - `docker compose … config` is answered by the REAL Docker Compose CLI when
 *    one is installed (it needs no daemon), so the merge of several -f files,
 *    env_file resolution and --no-env-resolution are Compose's own; otherwise a
 *    small JS model stands in (and the smoke says which);
 *  - `docker compose … up` recreates exactly the services Compose would: the
 *    named ones, plus — without --no-deps — any dependency whose config has
 *    drifted (as the database's has here);
 *  - `docker inspect` / `exec` / `ps` answer from that state; curl reports the
 *    edge's Referrer-Policy.
 * It asserts which containers were recreated (never the onion service, whose
 * re-creation can change the .onion address, nor the database), that every
 * Compose call named every -f file and the recorded --env-file, that CrowdSec
 * reading BunkerWeb's log keeps a bounded log instead of none, that a plain
 * nginx edge is left alone, and that a failed change is restored byte for byte.
 *
 * MORPHIT_PROXYHEAL_SRC=<path to a proxyConfigHeal.ts> runs another version
 * (e.g. the pre-wave-4 one) to watch it fail; MORPHIT_E2E_STANDIN_COMPOSE=1
 * uses the JS stand-in even where Docker Compose is installed.
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
const SRC = resolve(
	process.env.MORPHIT_PROXYHEAL_SRC ?? join(REPO, 'apps/ops-cli/src/lib/proxyConfigHeal.ts')
);

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

const realDocker = spawnSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).stdout.trim();
const realCompose =
	process.env.MORPHIT_E2E_STANDIN_COMPOSE !== '1' &&
	realDocker !== '' &&
	spawnSync(realDocker, ['compose', 'version'], { encoding: 'utf8' }).status === 0;

// ── the fake docker ─────────────────────────────────────────────────────
const FAKE = String.raw`#!/usr/bin/env node
const fs = require('fs');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const STATE = process.env.FAKE_DOCKER_STATE;
const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
const args = process.argv.slice(2);
st.calls.push(args);
const out = (s) => process.stdout.write(s);
const done = (code) => { save(); process.exit(code); };
const BW_DEFAULT = '$host $remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent"';

function model(g, unresolved) {
	const a = ['compose', '-p', g.p, ...(g.d ? ['--project-directory', g.d] : []), ...g.f.flatMap((f) => ['-f', f]), ...g.e.flatMap((e) => ['--env-file', e]), 'config', '--format', 'json', ...(unresolved ? ['--no-env-resolution'] : [])];
	if (st.realDocker) {
		try { return execFileSync(st.realDocker, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
	}
	return require(st.miniModel).model(g, unresolved);
}
function hashOf(svc) { return crypto.createHash('sha1').update(JSON.stringify(svc ?? {})).digest('hex'); }
function recreate(name, svc, env) {
	const c = st.containers[name];
	c.logType = svc.logging?.driver ?? 'json-file';
	c.logConfig = svc.logging?.options ?? {};
	c.extraHosts = (svc.extra_hosts ?? []).map((h) => h.replace('=', ':'));
	c.env = Object.entries(env ?? {}).map(([k, v]) => k + '=' + String(v).replace(/\$\$/g, '$'));
	c.hash = hashOf(svc);
	c.gen = (c.gen ?? 0) + 1;
	st.recreated.push(name);
}
function inspectJson(c) {
	const ports = {};
	for (const p of c.ports) { const m = /^(.*):(\d+)->(.*)$/.exec(p); (ports[m[3]] ??= []).push({ HostIp: m[1], HostPort: m[2] }); }
	return {
		Id: c.name + '-id-' + (c.gen ?? 0), Name: '/' + c.name,
		Config: { Image: c.image, Labels: c.labels, Env: c.env },
		State: { Running: c.running, StartedAt: '2026-09-27T00:00:00Z' },
		HostConfig: { LogConfig: { Type: c.logType, Config: c.logConfig }, ExtraHosts: c.extraHosts },
		NetworkSettings: { Ports: ports, Networks: { net: { Gateway: c.gateway } } },
		Mounts: c.mounts.map((s) => ({ Source: s, Destination: '/mnt' + s }))
	};
}
const names = () => Object.keys(st.containers).filter((n) => st.containers[n].running);
const cmd = args[0];
if (cmd === 'version') { out('29.0.0\n'); done(0); }
if (cmd === 'ps') { out(names().join('\n') + '\n'); done(0); }
if (cmd === 'inspect') {
	const fi = args.indexOf('--format');
	const fmt = fi >= 0 ? args[fi + 1] : null;
	const targets = args.slice(1).filter((a, i) => a !== '--format' && args[i] !== '--format');
	const cs = targets.map((n) => st.containers[n]).filter(Boolean);
	if (!fmt) { out(JSON.stringify(cs.map(inspectJson))); done(cs.length ? 0 : 1); }
	const c = cs[0]; if (!c) done(1);
	const lab = /index \.Config\.Labels "([^"]+)"/.exec(fmt);
	if (lab) out((c.labels[lab[1]] ?? '') + '\n');
	else if (fmt.includes('.Mounts')) out(c.mounts.join('\n') + '\n');
	else if (fmt.includes('State.Running')) out(String(c.running) + '\n');
	else if (fmt.includes('LogConfig.Type')) out(c.logType + '\n');
	else if (fmt.includes('Gateway')) out(c.gateway + ' \n');
	else if (fmt.includes('StartedAt')) out('2026-09-27T00:00:00Z\n');
	done(0);
}
if (cmd === 'logs') {
	// BunkerWeb 1.5: after its scheduler (re)starts it runs its jobs, builds the
	// config, and the edge tests it: loaded, or refused and the old one kept.
	const c = st.containers[args[args.length - 1]]; if (!c) done(1);
	if (/bunkerweb-scheduler/.test(c.image) && (c.gen ?? 0) > 0) {
		out('[GENERATOR] Generator successfully executed !\n');
		if (st.refuses) out('[API] Error while sending API request to http://bunkerweb:5000/reload : status = error, msg = config check failed\n[SCHEDULER] Error while reloading bunkerweb, failing over to last working configuration ...\n');
		out('[API] Successfully sent API request to http://bunkerweb:5000/reload\n');
	}
	if (/bunkerity\/bunkerweb:/.test(c.image) && st.refuses && (c.gen ?? 0) > 0) out('2026/09/30 19:01:20 [emerg] 162#162: "modsecurity_rules_file" directive Rule id: 1990001 is duplicated\n');
	done(0);
}
if (cmd === 'exec') {
	const c = st.containers[args[1]]; if (!c) done(1);
	const rest = args.slice(2).join(' ');
	if (rest === 'nginx -T') {
		if (/bunkerity\/bunkerweb:/.test(c.image)) { const lf = (c.env.find((e) => e.startsWith('LOG_FORMAT=')) ?? '').slice(11) || BW_DEFAULT; out("http {\n log_format logf '" + lf + "';\n}\n"); done(0); }
		if (c.frontendConf) { out('# configuration file /etc/nginx/conf.d/morphit.conf:\n' + fs.readFileSync(c.frontendConf, 'utf8')); done(0); }
		done(1);
	}
	if (rest.startsWith('wget')) { const h = (c.extraHosts.find((x) => x.startsWith('host.docker.internal:')) ?? '').split(':')[1]; done(st.answersOn.includes(h) ? 0 : 1); }
	if (rest.includes('crowdsec/acquis')) { if (st.acquis[c.name] == null) done(1); out(st.acquis[c.name]); done(0); }
	if (rest.includes('stat -c')) { out('0\n'); done(0); }
	if (rest === 'nginx -s reload') done(0);
	done(1);
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
	st.composeCalls.push({ g, sub: args.slice(i) });
	const sub = args[i];
	if (sub === 'config') {
		const m = model(g, args.includes('--no-env-resolution'));
		if (m === null) done(1);
		if (!args.includes('-q')) out(m);
		done(0);
	}
	if (sub === 'up') {
		const flags = args.slice(i + 1).filter((a) => a.startsWith('-'));
		const svcs = args.slice(i + 1).filter((a) => !a.startsWith('-'));
		const m = JSON.parse(model(g, false) ?? 'null');
		if (!m) done(1);
		const want = new Set(svcs);
		if (!flags.includes('--no-deps')) {
			// Compose also brings up dependencies, recreating any whose config drifted.
			const q = [...svcs];
			while (q.length) { const s = q.pop(); for (const d of Object.keys(m.services[s]?.depends_on ?? {})) if (!want.has(d)) { want.add(d); q.push(d); } }
		}
		for (const s of want) {
			for (const [name, c] of Object.entries(st.containers)) {
				if (c.labels['com.docker.compose.service'] !== s || c.labels['com.docker.compose.project'] !== g.p) continue;
				const svc = m.services[s];
				if (svcs.includes(s) ? true : c.hash !== hashOf(svc)) recreate(name, svc, svc.environment);
			}
		}
		done(0);
	}
	done(0);
}
st.unhandled.push(args);
done(1);
`;

const CURL = String.raw`#!/usr/bin/env node
const fs = require('fs');
const st = JSON.parse(fs.readFileSync(process.env.FAKE_DOCKER_STATE, 'utf8'));
const e = Object.values(st.containers).find((c) => /bunkerity\/bunkerweb:/.test(c.image));
if (!e) process.exit(7);
const rp = (e.env.find((x) => x.startsWith('REFERRER_POLICY=')) ?? '').slice(16) || 'strict-origin-when-cross-origin';
// BunkerWeb answers 502 unless the frontend's config listens where it sends.
const target = (e.env.find((x) => /REVERSE_PROXY_HOST=/.test(x)) ?? 'REVERSE_PROXY_HOST=http://frontend:80').split('=')[1];
const port = (/:(\d+)(\/|$)/.exec(target.replace(/^http:\/\//, '')) ?? [])[1] ?? '80';
const fe = Object.values(st.containers).find((c) => c.frontendConf);
const listens = new Set(['80', ...[...(fe ? fs.readFileSync(fe.frontendConf, 'utf8') : '').matchAll(/listen (\d+);/g)].map((m) => m[1])]);
const status = listens.has(port) ? 200 : 502;
process.stdout.write('HTTP/2 ' + status + '\r\nreferrer-policy: ' + rp + '\r\n\r\n');
`;

// A stand-in for `docker compose config` where no real Compose exists.
const MINI = String.raw`
const fs = require('fs'); const path = require('path');
const yaml = require(${JSON.stringify(require.resolve('js-yaml'))});
exports.model = (g, unresolved) => {
	const dir = g.d || path.dirname(g.f[0]);
	const services = {};
	for (const f of g.f) {
		const doc = yaml.load(fs.readFileSync(f, 'latin1').replace(/^ï»¿/, '')) || {};
		for (const [n, s] of Object.entries(doc.services || {})) {
			const m = (services[n] ??= { extra_hosts: [], env_file: [], environment: {} });
			for (const k of ['image', 'depends_on', 'ports']) if (s[k] !== undefined) m[k] = s[k];
			if (s.logging) m.logging = { ...(m.logging || {}), ...s.logging };
			for (const h of s.extra_hosts || []) m.extra_hosts.push(String(h).replace(/^([^:=]+):/, '$1='));
			for (const e of s.env_file || []) m.env_file.push(path.resolve(dir, e));
			if (s.environment) Object.assign(m.environment, s.environment);
		}
	}
	for (const m of Object.values(services)) {
		if (Array.isArray(m.depends_on)) m.depends_on = Object.fromEntries(m.depends_on.map((d) => [d, {}]));
		if (unresolved) { m.env_file = m.env_file.map((p) => ({ path: p })); continue; }
		const env = {};
		for (const f of m.env_file) for (const line of fs.readFileSync(f, 'latin1').replace(/\r\n/g, '\n').split('\n')) {
			const x = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line); if (!x) continue;
			let v = x[2].trim(); if (/^'.*'$/.test(v) || /^".*"$/.test(v)) v = v.slice(1, -1);
			env[x[1]] = v.replace(/\$/g, '$$$$');
		}
		m.environment = { ...env, ...m.environment }; delete m.env_file;
	}
	return JSON.stringify({ name: g.p, services });
};
`;

interface Ctr {
	service: string;
	image: string;
	ports?: string[];
	mounts?: string[];
	frontendConf?: string;
	drifted?: boolean;
}

async function scenario(
	title: string,
	files: Record<string, string | Buffer>,
	composeFiles: string[],
	containers: Record<string, Ctr>,
	opts: {
		acquis?: Record<string, string | null>;
		answersOn?: string[];
		envFile?: string;
		refuses?: boolean;
	},
	assertions: (r: {
		st: any;
		out: any;
		info: string[];
		warn: string[];
		dir: string;
		bw: string;
	}) => void
): Promise<void> {
	console.log(`\n${title}`);
	const w = mkdtempSync(join(tmpdir(), 'proxyheal-e2e-'));
	const bw = join(w, 'opt/bunkerweb');
	const build = join(w, 'opt/morphit/apps/web/build');
	mkdirSync(bw, { recursive: true });
	mkdirSync(build, { recursive: true });
	mkdirSync(join(w, 'bin'));
	for (const [rel, body] of Object.entries(files))
		writeFileSync(
			join(bw, rel),
			typeof body === 'string'
				? body.replace(/@BUILD@/g, build)
				: Buffer.from(body.toString('latin1').replace(/@BUILD@/g, build), 'latin1')
		);
	writeFileSync(join(w, 'bin/docker'), FAKE);
	writeFileSync(join(w, 'bin/curl'), CURL);
	writeFileSync(join(w, 'mini.cjs'), MINI);
	chmodSync(join(w, 'bin/docker'), 0o755);
	chmodSync(join(w, 'bin/curl'), 0o755);
	const labelsFor = (service: string): Record<string, string> => ({
		'com.docker.compose.project': 'bunkerweb',
		'com.docker.compose.service': service,
		'com.docker.compose.project.config_files': composeFiles.map((f) => join(bw, f)).join(','),
		'com.docker.compose.project.working_dir': bw,
		...(opts.envFile
			? { 'com.docker.compose.project.environment_file': join(bw, opts.envFile) }
			: {})
	});
	const state: any = {
		realDocker: realCompose ? realDocker : '',
		miniModel: join(w, 'mini.cjs'),
		answersOn: opts.answersOn ?? ['host-gateway', '172.18.0.1'],
		refuses: opts.refuses ?? false,
		acquis: opts.acquis ?? {},
		containers: {},
		calls: [],
		composeCalls: [],
		recreated: [],
		unhandled: []
	};
	for (const [name, c] of Object.entries(containers))
		state.containers[name] = {
			name,
			image: c.image,
			running: true,
			labels: labelsFor(c.service),
			env: [],
			logType: 'json-file',
			logConfig: {},
			extraHosts: [],
			ports: c.ports ?? [],
			mounts: (c.mounts ?? []).map((m) => (m === '@BUILD@' ? build : m)),
			gateway: '172.18.0.1',
			frontendConf: c.frontendConf,
			hash: c.drifted ? 'drifted' : undefined,
			gen: 0
		};
	const statePath = join(w, 'state.json');
	writeFileSync(statePath, JSON.stringify(state));
	const oldPath = process.env.PATH;
	process.env.PATH = `${join(w, 'bin')}:${oldPath}`;
	process.env.FAKE_DOCKER_STATE = statePath;
	// Initialise each container from Compose's model (as `up` once did), keeping
	// a drifted one's old hash.
	const init = spawnSync(
		join(w, 'bin/docker'),
		[
			'compose',
			'-p',
			'bunkerweb',
			'--project-directory',
			bw,
			...composeFiles.flatMap((f) => ['-f', join(bw, f)]),
			...(opts.envFile ? ['--env-file', join(bw, opts.envFile)] : []),
			'config',
			'--format',
			'json'
		],
		{ encoding: 'utf8', env: process.env }
	);
	const model = JSON.parse(init.stdout || '{"services":{}}');
	const s0 = JSON.parse(readFileSync(statePath, 'utf8'));
	for (const c of Object.values(s0.containers) as any[]) {
		const svc = model.services[c.labels['com.docker.compose.service']] ?? {};
		c.extraHosts = (svc.extra_hosts ?? []).map((h: string) => h.replace('=', ':'));
		c.env = Object.entries(svc.environment ?? {}).map(
			([k, v]) => `${k}=${String(v).replace(/\$\$/g, '$')}`
		);
		if (c.hash !== 'drifted')
			c.hash = require('node:crypto').createHash('sha1').update(JSON.stringify(svc)).digest('hex');
	}
	s0.calls = [];
	s0.composeCalls = [];
	writeFileSync(statePath, JSON.stringify(s0));
	const info: string[] = [];
	const warn: string[] = [];
	let out: any;
	try {
		const mod = (await import(SRC)) as { healProxyConfig: (d: any) => Promise<any> };
		out = await mod.healProxyConfig({
			info: (m: string) => info.push(m),
			warn: (m: string) => warn.push(m),
			spinner: () => () => {},
			buildDir: build
		});
	} catch (e) {
		out = { kind: 'threw', error: String(e) };
	} finally {
		process.env.PATH = oldPath;
	}
	const st = JSON.parse(readFileSync(statePath, 'utf8'));
	try {
		assertions({ st, out, info, warn, dir: w, bw });
	} finally {
		rmSync(w, { recursive: true, force: true });
	}
}

const FE_CONF = join(REPO, 'ops/bunkerweb/frontend/nginx.conf');
const MORPHITIO = `services:
  bunkerweb:
    image: bunkerity/bunkerweb:1.5.10
    ports:
      - "80:8080"
      - "443:8443"
    env_file:
      - ./bunkerweb.env
    depends_on:
      - bw-scheduler
      - db
  bw-scheduler:
    image: bunkerity/bunkerweb-scheduler:1.5.10
    env_file:
      - ./bunkerweb.env
  redis:
    image: redis:7-alpine
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: morphit_indexer
  crowdsec:
    image: crowdsecurity/crowdsec
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
  onion-service:
    image: example/tor
    volumes:
      - ./tor-keys:/var/lib/tor/hidden_service
    extra_hosts:
      - "host.docker.internal:host-gateway"
    depends_on:
      - frontend
  frontend:
    image: bunkerweb-frontend
    volumes:
      - @BUILD@:/usr/share/nginx/html:ro
    extra_hosts:
      - "host.docker.internal:host-gateway"
`;
const MORPHITIO_CTRS: Record<string, Ctr> = {
	'bunkerweb-frontend-1': {
		service: 'frontend',
		image: 'bunkerweb-frontend',
		mounts: ['@BUILD@'],
		frontendConf: FE_CONF
	},
	'bunkerweb-onion-service-1': { service: 'onion-service', image: 'example/tor' },
	'bunkerweb-crowdsec-1': {
		service: 'crowdsec',
		image: 'crowdsecurity/crowdsec:latest',
		mounts: ['/var/run/docker.sock']
	},
	'bunkerweb-bunkerweb-1': {
		service: 'bunkerweb',
		image: 'bunkerity/bunkerweb:1.5.10',
		ports: ['0.0.0.0:443->8443/tcp', '0.0.0.0:80->8080/tcp']
	},
	'bunkerweb-bw-scheduler-1': {
		service: 'bw-scheduler',
		image: 'bunkerity/bunkerweb-scheduler:1.5.10'
	},
	'bunkerweb-redis-1': { service: 'redis', image: 'redis:7-alpine' },
	// Its service was edited in the file and never applied: a plain `up` of a
	// service that depends on it would recreate the database.
	'bunkerweb-db-1': { service: 'db', image: 'postgres:16-alpine', drifted: true }
};
const everyCallNamesTheProject = (st: any, files: string[], envFile: string | null): boolean =>
	st.composeCalls.length > 0 &&
	st.composeCalls.every(
		(c: any) =>
			JSON.stringify(c.g.f) === JSON.stringify(files) &&
			(envFile === null || JSON.stringify(c.g.e) === JSON.stringify([envFile]))
	);

async function main(): Promise<void> {
	console.log('\n── proxy-heal e2e smoke ─────────────────────────────────');
	console.log(
		`  (heal: ${SRC.replace(REPO + '/', '')}; compose model: ${realCompose ? `the real Docker Compose (${realDocker})` : 'the JS stand-in — no docker CLI here'})`
	);

	await scenario(
		"morphit.io: BunkerWeb + scheduler + CrowdSec (reading BunkerWeb's log) + onion service + db",
		{
			'docker-compose.yml': MORPHITIO,
			'bunkerweb.env':
				'SERVER_NAME=morphit.io\nUSE_REVERSE_PROXY=yes\nREVERSE_PROXY_HOST=http://bunkerweb-frontend-1:80\n',
			'.env.prod': 'COMPOSE_X=1\n'
		},
		['docker-compose.yml'],
		MORPHITIO_CTRS,
		{
			acquis: {
				'bunkerweb-crowdsec-1':
					'source: docker\ncontainer_name:\n  - bunkerweb-bunkerweb-1\nlabels:\n  type: bunkerweb\n'
			},
			envFile: '.env.prod'
		},
		({ st, out, warn, bw, info }) => {
			const rec = [...new Set<string>(st.recreated)].sort();
			check(
				'the heal finished the change',
				out.kind === 'applied',
				JSON.stringify(out) + ' ' + warn.join(' | ')
			);
			check(
				'the onion service, CrowdSec, redis and the database were NOT recreated',
				!rec.some((n) => /onion|crowdsec|redis|db-1/.test(n)),
				rec.join(', ')
			);
			check(
				'recreated exactly: the edge, its scheduler (same env file) and the frontend',
				JSON.stringify(rec) ===
					JSON.stringify([
						'bunkerweb-bunkerweb-1',
						'bunkerweb-bw-scheduler-1',
						'bunkerweb-frontend-1'
					]),
				rec.join(', ')
			);
			check(
				'every `up` used --no-deps',
				st.composeCalls
					.filter((c: any) => c.sub[0] === 'up')
					.every((c: any) => c.sub.includes('--no-deps')),
				JSON.stringify(st.composeCalls.filter((c: any) => c.sub[0] === 'up').map((c: any) => c.sub))
			);
			check(
				'every Compose call named the project file and its recorded --env-file',
				everyCallNamesTheProject(st, [join(bw, 'docker-compose.yml')], join(bw, '.env.prod')),
				JSON.stringify(st.composeCalls.map((c: any) => c.g))
			);
			const e = st.containers['bunkerweb-bunkerweb-1'];
			check(
				'CrowdSec reads BunkerWeb: its log is local 5 MB × 1, not none',
				e.logType === 'local' &&
					e.logConfig['max-size'] === '5m' &&
					e.logConfig['max-file'] === '1',
				`${e.logType} ${JSON.stringify(e.logConfig)}`
			);
			const env = readFileSync(join(bw, 'bunkerweb.env'), 'utf8');
			check(
				'…and LOG_FORMAT is left as it is (CrowdSec parses addresses)',
				!/^LOG_FORMAT=/m.test(env)
			);
			check('…and it is said calmly', /CrowdSec \(bunkerweb-crowdsec-1\)/.test(info.join(' ')));
			check(
				"BunkerWeb now sends to the frontend's edge listener (by container name), and the site answers",
				e.env.includes('REVERSE_PROXY_HOST=http://bunkerweb-frontend-1:8088'),
				JSON.stringify(e.env.filter((x: string) => /REVERSE/.test(x)))
			);
			check(
				'BunkerWeb got the headers (in its environment)',
				e.env.includes('REFERRER_POLICY=no-referrer') && e.env.includes('X_FRAME_OPTIONS=DENY')
			);
			const f = st.containers['bunkerweb-frontend-1'];
			check(
				'the frontend: bounded log, host.docker.internal → 172.18.0.1',
				f.logType === 'local' &&
					JSON.stringify(f.extraHosts) === JSON.stringify(['host.docker.internal:172.18.0.1']),
				`${f.logType} ${JSON.stringify(f.extraHosts)}`
			);
			check('no warnings', warn.length === 0, warn.join(' | '));
			check(
				'the fake saw only commands it models',
				st.unhandled.length === 0,
				JSON.stringify(st.unhandled)
			);
		}
	);

	await scenario(
		'morphit.io variant: a plain nginx edge (no BunkerWeb)',
		{
			'docker-compose.yml': MORPHITIO.replace('bunkerity/bunkerweb:1.5.10', 'nginx:alpine'),
			'bunkerweb.env': 'SERVER_NAME=morphit.io\n'
		},
		['docker-compose.yml'],
		{
			...MORPHITIO_CTRS,
			'bunkerweb-bunkerweb-1': {
				service: 'bunkerweb',
				image: 'nginx:alpine',
				ports: ['0.0.0.0:443->443/tcp']
			}
		},
		{},
		({ st, out, info, bw }) => {
			const rec = [...new Set<string>(st.recreated)].sort();
			check(
				'only the frontend was recreated',
				JSON.stringify(rec) === JSON.stringify(['bunkerweb-frontend-1']),
				rec.join(', ')
			);
			check(
				'the env file was not touched',
				readFileSync(join(bw, 'bunkerweb.env'), 'utf8') === 'SERVER_NAME=morphit.io\n'
			);
			check(
				'a calm note says the entry point is not BunkerWeb',
				/is not BunkerWeb/.test(info.join(' ')),
				info.join(' | ')
			);
			check('the heal finished', out.kind === 'applied', JSON.stringify(out));
		}
	);

	const BASE = `services:\n  bunkerweb:\n    image: bunkerity/bunkerweb:1.5.10\n    env_file:\n      - ./bunkerweb.env\n  frontend:\n    image: fe\n    volumes:\n      - @BUILD@:/usr/share/nginx/html:ro\n    extra_hosts:\n      - "host.docker.internal:host-gateway"\n`;
	const OVR = `services:\n  bunkerweb:\n    ports:\n      - "80:8080"\n      - "443:8443"\n`;
	await scenario(
		'a base + override Compose pair',
		{
			'docker-compose.yml': BASE,
			'docker-compose.override.yml': OVR,
			'bunkerweb.env': 'SERVER_NAME=x.org\n'
		},
		['docker-compose.yml', 'docker-compose.override.yml'],
		{
			bw: {
				service: 'bunkerweb',
				image: 'bunkerity/bunkerweb:1.5.10',
				ports: ['0.0.0.0:443->8443/tcp', '0.0.0.0:80->8080/tcp']
			},
			fe: { service: 'frontend', image: 'fe', mounts: ['@BUILD@'], frontendConf: FE_CONF }
		},
		{},
		({ st, out, bw, warn }) => {
			check('applied', out.kind === 'applied', JSON.stringify(out) + ' ' + warn.join(' | '));
			check(
				'every Compose call named BOTH files, in order',
				everyCallNamesTheProject(
					st,
					[join(bw, 'docker-compose.yml'), join(bw, 'docker-compose.override.yml')],
					null
				),
				JSON.stringify(st.composeCalls.map((c: any) => c.g.f))
			);
			check(
				'the edge keeps no Docker log',
				st.containers.bw.logType === 'none',
				st.containers.bw.logType
			);
		}
	);

	const envBytes = Buffer.concat([
		Buffer.from([0xef, 0xbb, 0xbf]),
		Buffer.from('SERVER_NAME=x.org\r\nADMIN_PASSWORD=p\xe4ss\r\n', 'latin1')
	]);
	// A BOM, CRLF endings and a UTF-8 é (Compose rejects a compose file that
	// is not UTF-8, so a running stack's file never has a stray byte).
	const composeBytes = Buffer.concat([
		Buffer.from([0xef, 0xbb, 0xbf]),
		Buffer.from(
			`${BASE.replace('    env_file:\n', '    ports:\n      - "80:8080"\n      - "443:8443"\n    env_file:\n')}# café\n`.replace(
				/\n/g,
				'\r\n'
			),
			'utf8'
		)
	]);
	await scenario(
		'a change that does not check out (the gateway does not answer): restored byte for byte',
		{ 'docker-compose.yml': composeBytes, 'bunkerweb.env': envBytes },
		['docker-compose.yml'],
		{
			bw: {
				service: 'bunkerweb',
				image: 'bunkerity/bunkerweb:1.5.10',
				ports: ['0.0.0.0:443->8443/tcp', '0.0.0.0:80->8080/tcp']
			},
			fe: { service: 'frontend', image: 'fe', mounts: ['@BUILD@'], frontendConf: FE_CONF }
		},
		{ answersOn: ['host-gateway'] },
		({ out, bw, warn }) => {
			check('rolled back', out.kind === 'rolled-back', JSON.stringify(out));
			check(
				'bunkerweb.env is byte-identical (BOM, CRLF, a non-UTF-8 byte)',
				readFileSync(join(bw, 'bunkerweb.env')).equals(envBytes)
			);
			check(
				'the compose file is byte-identical (BOM, CRLF, UTF-8)',
				readFileSync(join(bw, 'docker-compose.yml')).equals(
					Buffer.from(
						composeBytes
							.toString('latin1')
							.replace(/@BUILD@/g, join(dirname(bw), 'morphit/apps/web/build')),
						'latin1'
					)
				)
			);
			check(
				'the message reports what was checked, and labels the copies as originals',
				/put back and checked/.test(warn.join(' ')) &&
					/Copies of your original files/.test(warn.join(' ')),
				warn.join(' | ')
			);
		}
	);

	// v1.20.1 — morphitir: BunkerWeb refused every rebuilt config (a duplicated
	// ModSecurity rule) and silently kept the old one. The heal must stop at
	// BunkerWeb's verdict, put the settings back, and say nginx's own reason.
	await scenario(
		"BunkerWeb refuses the rebuilt config: rolled back, with nginx's reason",
		{
			'docker-compose.yml': MORPHITIO,
			'bunkerweb.env':
				'SERVER_NAME=morphit.io\nUSE_REVERSE_PROXY=yes\nREVERSE_PROXY_HOST=http://bunkerweb-frontend-1:80\n',
			'.env.prod': 'COMPOSE_X=1\n'
		},
		['docker-compose.yml'],
		MORPHITIO_CTRS,
		{ envFile: '.env.prod', refuses: true },
		({ out, warn }) => {
			check('rolled back', out.kind === 'rolled-back', JSON.stringify(out));
			check(
				"the reason is BunkerWeb's own config test, with nginx's words",
				/own config test failed \("modsecurity_rules_file" directive Rule id: 1990001 is duplicated\)/.test(
					(out as { reason?: string }).reason ?? ''
				),
				JSON.stringify(out)
			);
			check(
				'the operator is told',
				/Rule id: 1990001 is duplicated/.test(warn.join(' ')),
				warn.join(' | ')
			);
		}
	);

	console.log(
		fail === 0
			? `\n✓ all ${pass} proxy-heal-e2e checks passed`
			: `\n✗ ${fail} FAILED, ${pass} passed`
	);
	process.exit(fail === 0 ? 0 : 1);
}

void main();
