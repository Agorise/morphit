/**
 * The post-upgrade reverse-proxy heal (v1.20.0: C1 privacy, C2 headers, B11;
 * wave 4: morphit.io's real, hand-made stack).
 *
 * `morphit-ops upgrade` does not re-render Ansible templates and morphit.io's
 * stack is hand-made, so without this heal every INSTALLED box keeps a public
 * edge whose Docker log stores every visitor's address, weak headers, and
 * host.docker.internal on docker0. These run the real heal against real files
 * in a temp dir and a simulated Docker + Compose that:
 *  - merges several `-f` files the way Compose does (extra_hosts concatenate,
 *    env_file resolved, an inline `environment:` wins over an env file);
 *  - recreates ONLY the services an `up` names (and records which);
 *  - keeps a virtual clock, so budgets and deadlines are exact;
 *  - records any blocking call made while no spinner is showing;
 * and assert the resulting bytes, the running state, which containers were
 * recreated, and the checked rollback. The real `docker compose` semantics
 * (model JSON, --no-env-resolution, override merging) are proven separately by
 * scripts/proxy-heal-e2e-smoke.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	mkdtempSync,
	readFileSync,
	writeFileSync,
	existsSync,
	rmSync,
	copyFileSync,
	readdirSync
} from 'node:fs';
import { createRequire } from 'node:module';
import type { SchedulerCycle } from '../src/lib/bunkerwebScheduler.ts';
import { BUNKERWEB_PRIVACY_SETTINGS } from '../src/lib/bunkerwebPrivacy.ts';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import {
	applyAndVerifyProxyConfig,
	composeArgs,
	composeLogDriver,
	crowdsecReadsEdge,
	decodeConfig,
	encodeConfig,
	envFileEntries,
	frontendEdgePort,
	frontendFileMissesAre404,
	frontendForwardsOneAddress,
	frontendCspStrict,
	frontendHidesInternals,
	identifyContainers,
	isMorphitCsp,
	isMorphitFrontendDockerfile,
	FRONTEND_BASE,
	nginxLogFormats,
	parseComposeModel,
	parseDockerInspect,
	planBunkerwebEnv,
	planCompose,
	MORPHIT_CSP,
	MORPHIT_PERMISSIONS_POLICY,
	MORPHIT_LOG_FORMAT,
	HEAL_BUDGET_MS,
	type ContainerInfo,
	type ComposeRef,
	type ProxyHealRuntime
} from '../src/lib/proxyConfigHeal.ts';

const yaml = createRequire(import.meta.url)('js-yaml') as { load(s: string): unknown };
const REPO = join(import.meta.dirname, '..', '..', '..');
const BUILD = '/opt/morphit/apps/web/build';
const BW_DEFAULT_LOG_FORMAT =
	'$host $remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent"';

// ── fixtures ────────────────────────────────────────────────────────────

// A pre-v1.20.0 Ansible-rendered stack, trimmed to what matters.
const OLD_COMPOSE = `services:
  bunkerweb:
    image: bunkerity/bunkerweb:1.5.10
    container_name: bunkerweb
    restart: unless-stopped
    ports:
      - "80:8080"
      - "443:8443"
    env_file:
      - ./bunkerweb.env
    extra_hosts:
      - "host.docker.internal:host-gateway"
    networks:
      - bunkerweb_net

  frontend:
    build:
      context: ./frontend
    container_name: morphit-frontend
    restart: unless-stopped
    volumes:
      - ${BUILD}:/usr/share/nginx/html:ro
    extra_hosts:
      - "host.docker.internal:host-gateway"
    networks:
      - bunkerweb_net

networks:
  bunkerweb_net:
    name: bunkerweb_net
    ipam:
      config:
        - subnet: 172.20.0.0/16
`;
const OLD_ENV = `SERVER_NAME=example.org
USE_REVERSE_PROXY=yes
REVERSE_PROXY_HOST=http://frontend:80
`;

// morphit.io (the project backlog "LIVE VPS TOPOLOGY"): one hand-made
// /opt/bunkerweb project; containers bunkerweb-<service>-1; bridge 172.18.0.0/24.
const MORPHITIO_COMPOSE = `services:
  bunkerweb:
    image: bunkerity/bunkerweb:1.5.10
    ports:
      - "80:8080"
      - "443:8443"
    env_file:
      - ./bunkerweb.env
  bw-scheduler:
    image: bunkerity/bunkerweb-scheduler:1.5.10
    env_file:
      - ./bunkerweb.env
  redis:
    image: redis:7-alpine
  db:
    image: postgres:16-alpine
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
  frontend:
    build:
      context: ./frontend
    volumes:
      - ${BUILD}:/usr/share/nginx/html:ro
    extra_hosts:
      - "host.docker.internal:host-gateway"
networks:
  bunkerweb-net:
    ipam:
      config:
        - subnet: 172.18.0.0/24
`;

// The frontend config this release ships, as `nginx -T` prints it.
const SHIPPED_FE = readFileSync(join(REPO, 'ops/bunkerweb/frontend/nginx.conf'), 'utf8');
const dumpOf = (conf: string): string =>
	'# configuration file /etc/nginx/nginx.conf:\n' +
	'user nginx;\nevents { worker_connections 1024; }\n' +
	'http {\n    include /etc/nginx/mime.types;\n    include /etc/nginx/conf.d/*.conf;\n}\n\n' +
	'# configuration file /etc/nginx/mime.types:\ntypes {\n    text/html html htm;\n}\n\n' +
	`# configuration file /etc/nginx/conf.d/morphit.conf:\n${conf}\n`;
const staleV1 = (conf: string): string =>
	conf.replace(
		/(location \/v1\/ \{[\s\S]*?)proxy_set_header X-Forwarded-For \$morphit_relay_xff;\n\s*proxy_set_header X-Real-IP "";/,
		'$1proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Real-IP $remote_addr;'
	);
const SERVED_OK = dumpOf(SHIPPED_FE);
const SERVED_STALE = dumpOf(staleV1(SHIPPED_FE));
/** The frontend before wave 5: no edge listener. */
const noEdge = (conf: string): string => conf.replace(/\n\s*listen 8088;/, '');
const SERVED_NO_EDGE = dumpOf(noEdge(SHIPPED_FE));
/** The frontend before v1.20.2: a missing file got the app page (200), not 404. */
const no404 = (conf: string): string =>
	conf.replace(
		/\n {4}# ─── Files are files[\s\S]*?\n {4}location ~\* \^\/\(\?:\(\?:fonts[^\n]*\{[\s\S]*?\n {4}\}\n/,
		'\n'
	);
const SERVED_NO_404 = dumpOf(no404(SHIPPED_FE));

// ── a simulated Docker + Compose ────────────────────────────────────────

type Mut<T> = { -readonly [K in keyof T]: T[K] };

interface ModelSvc {
	image: string | null;
	env_file: string[];
	environment: Record<string, string>;
	logging: { driver?: string; options?: Record<string, string> } | null;
	extra_hosts: string[];
	ports: string[];
}

/** Compose's merge, for the shapes these fixtures use. */
function composeModel(files: readonly string[], workDir: string): Record<string, ModelSvc> {
	const out: Record<string, ModelSvc> = {};
	for (const f of files) {
		const doc = yaml.load(readFileSync(f).toString('latin1').replace(/^ï»¿/, '')) as {
			services?: Record<string, Record<string, unknown>>;
		};
		for (const [name, s] of Object.entries(doc?.services ?? {})) {
			const m = (out[name] ??= {
				image: null,
				env_file: [],
				environment: {},
				logging: null,
				extra_hosts: [],
				ports: []
			});
			if (typeof s.image === 'string') m.image = s.image;
			for (const e of (s.env_file as string[] | undefined) ?? [])
				m.env_file.push(isAbsolute(e) ? e : join(workDir, e));
			const env = s.environment;
			if (Array.isArray(env))
				for (const kv of env) {
					const i = String(kv).indexOf('=');
					m.environment[String(kv).slice(0, i)] = String(kv).slice(i + 1);
				}
			else if (env && typeof env === 'object')
				for (const [k, v] of Object.entries(env)) m.environment[k] = String(v);
			if (s.logging && typeof s.logging === 'object') {
				const l = s.logging as { driver?: string; options?: Record<string, unknown> };
				m.logging = {
					driver: l.driver ?? m.logging?.driver,
					options: {
						...(m.logging?.options ?? {}),
						...Object.fromEntries(Object.entries(l.options ?? {}).map(([k, v]) => [k, String(v)]))
					}
				};
			}
			for (const h of (s.extra_hosts as string[] | undefined) ?? [])
				m.extra_hosts.push(String(h).replace(/^([^:=]+):/, '$1='));
			for (const p of (s.ports as string[] | undefined) ?? []) m.ports.push(String(p));
		}
	}
	return out;
}
function modelJson(files: readonly string[], workDir: string, unresolved: boolean): string {
	const m = composeModel(files, workDir);
	const services: Record<string, unknown> = {};
	for (const [name, s] of Object.entries(m)) {
		const o: Record<string, unknown> = {
			image: s.image,
			extra_hosts: s.extra_hosts,
			ports: s.ports
		};
		if (s.logging) o.logging = s.logging;
		if (unresolved) {
			if (s.env_file.length) o.env_file = s.env_file.map((path) => ({ path }));
			if (Object.keys(s.environment).length) o.environment = s.environment;
		} else {
			const env: Record<string, string> = {};
			for (const f of s.env_file)
				for (const [k, v] of envFileEntries(
					readFileSync(f).toString('latin1').replace(/\r\n/g, '\n')
				))
					env[k] = v;
			Object.assign(env, s.environment);
			o.environment = Object.fromEntries(
				Object.entries(env).map(([k, v]) => [k, v.replace(/\$/g, '$$$$')])
			);
		}
		services[name] = o;
	}
	return JSON.stringify({ name: 'x', services });
}

interface SimOpts {
	files: Record<string, string | Buffer>; // relative → contents
	composeFiles: string[]; // relative, in order
	envFiles?: string[]; // project env files (label)
	containers: Array<{
		name: string;
		service: string;
		image: string;
		ports?: string[];
		mounts?: string[];
		gateways?: string[];
		project?: string;
		labels?: Record<string, string>;
		logDriver?: string;
		binds?: Array<{ source: string; destination: string }>;
	}>;
}

class Sim {
	readonly dir = mkdtempSync(join(tmpdir(), 'proxyheal-'));
	t = 1_000_000;
	readonly start = this.t;
	readonly c = new Map<string, Mut<ContainerInfo>>();
	answersOn = new Set(['host-gateway', '172.20.0.1', '172.18.0.1']);
	acquis = new Map<string, string | null>();
	served: string | null = SERVED_OK;
	servedAfterRefresh: string | null = SERVED_OK;
	/** The running frontend image's base label, before and after a rebuild. */
	feBase: string | null = FRONTEND_BASE;
	feBaseAfterRefresh: string | null = FRONTEND_BASE;
	/** A rebuild uses a Dockerfile Morphit shipped (so it sets the label). */
	fePinnable = true;
	/** Hidden-only node; whether the pinned base is here, in the bundle, or
	 *  pullable through Tor; and what each rebuild was allowed to do. */
	hidden = false;
	basePresent = false;
	bundledBase = false;
	torPulls = false;
	loads = 0;
	refreshWithBase: boolean[] = [];
	newerThanStart = false;
	/** The edge's nginx regenerates its log_format from its environment. */
	edgeRegenerates = true;
	edgeDump = new Map<string, string>();
	costs = { up: 20_000, probe: 300, reachFail: 6_000, config: 800, refresh: 20_000 };
	upFails: number[] = []; // which up calls (1-based) fail
	notRunningAfterUp = new Set<string>();
	portsAfterUp = new Map<string, string[]>();
	configFailsAfterWrite = false;
	onUp: ((n: number) => void) | null = null;
	ups: Array<{ files: readonly string[]; envFiles: readonly string[]; services: string[] }> = [];
	recreated: string[] = [];
	refreshes = 0;
	reloads = 0;
	edgePortUnreachable = false;
	silent: string[] = [];
	spinners: string[] = [];
	depth = 0;
	lastCallAt = 0;
	terminate: (() => void) | null = null;
	/** BunkerWeb's scheduler verdict, by time since the last `up` (v1.20.1). */
	verdict: ((sinceUpMs: number) => SchedulerCycle) | null = null;
	lastUpAt = 0;
	/** BunkerWeb's generated /etc/nginx/variables.env per edge: rebuilt
	 *  from the edge's environment on each up unless `settingsFrozen` (a
	 *  scheduler that never pushes); null when it cannot be read. */
	edgeSettings = new Map<string, string>();
	settingsFrozen = false;
	settingsReadable = true;
	info: string[] = [];
	warn: string[] = [];
	readonly project: string;
	rt: ProxyHealRuntime;

	constructor(readonly o: SimOpts) {
		for (const [rel, body] of Object.entries(o.files)) writeFileSync(join(this.dir, rel), body);
		this.project = 'bunkerweb';
		const model = composeModel(this.files(), this.dir);
		for (const k of o.containers) {
			const svc = model[k.service];
			const labels: Record<string, string> = {
				'com.docker.compose.project': k.project ?? this.project,
				'com.docker.compose.service': k.service,
				'com.docker.compose.project.config_files': this.files().join(','),
				'com.docker.compose.project.working_dir': this.dir,
				...(o.envFiles
					? {
							'com.docker.compose.project.environment_file': o.envFiles
								.map((e) => join(this.dir, e))
								.join(',')
						}
					: {}),
				...(k.labels ?? {})
			};
			this.c.set(k.name, {
				name: k.name,
				id: `${k.name}-id-0`,
				image: k.image,
				running: true,
				labels,
				env: [],
				logDriver: k.logDriver ?? 'json-file',
				logOptions: {},
				extraHosts: (svc?.extra_hosts ?? []).map((h) => h.replace('=', ':')),
				ports: [...(k.ports ?? [])].sort(),
				mounts: k.mounts ?? [],
				binds:
					k.binds ??
					(k.mounts ?? []).map((m) => ({ source: m, destination: '/usr/share/nginx/html' })),
				gateways: k.gateways ?? ['172.20.0.1']
			});
			if (svc) this.c.get(k.name)!.env = this.resolvedEnv(k.service);
			if (/bunkerity\/bunkerweb:/.test(k.image))
				this.edgeSettings.set(k.name, this.generated(this.c.get(k.name)!));
		}
		/** A blocking call: it costs `ms`, but like spawnSync it is killed at its
		 *  timeout (then it reports failure). */
		const cost = (ms: number, what: string, timeoutMs = Infinity): boolean => {
			this.t += Math.min(ms, timeoutMs);
			this.lastCallAt = this.t;
			if (this.depth === 0) this.silent.push(what);
			return ms <= timeoutMs;
		};
		this.rt = {
			now: () => this.t,
			containers: (t) => (cost(500, 'containers', t), [...this.c.values()].map((x) => ({ ...x }))),
			inspect: (names, t) => (
				cost(200, 'inspect', t),
				names
					.map((n) => this.c.get(n))
					.filter((x): x is Mut<ContainerInfo> => !!x)
					.map((x) => ({ ...x }))
			),
			composeConfig: (ref, unresolved, t) => {
				if (!cost(this.costs.config, 'composeConfig', t)) return null;
				this.expectRef(ref);
				if (this.configFailsAfterWrite && !unresolved && this.written.length > 0) return null;
				try {
					return modelJson(ref.files, ref.workDir, unresolved);
				} catch {
					return null;
				}
			},
			crowdsecAcquisition: (n, t) => (
				cost(this.costs.probe, 'acquis', t),
				this.acquis.has(n) ? this.acquis.get(n)! : null
			),
			readFile: (p) => (existsSync(p) ? readFileSync(p) : null),
			writeFile: (p, d) => (this.written.push(p), writeFileSync(p, d), true),
			backup: (p) => (copyFileSync(p, `${p}.bak-test`), `${p}.bak-test`),
			composeUp: (ref, svcs, t) => {
				const inTime = cost(this.costs.up, 'composeUp', t);
				this.expectRef(ref);
				this.ups.push({ files: ref.files, envFiles: ref.envFiles, services: [...svcs] });
				const n = this.ups.length;
				this.onUp?.(n);
				if (this.upFails.includes(n) || !inTime) return false;
				for (const s of svcs) this.recreate(s, n);
				this.lastUpAt = this.t;
				return true;
			},
			reachesHost: (n, _p, t) => {
				const h =
					this.c
						.get(n)
						?.extraHosts.find((x) => x.startsWith('host.docker.internal:'))
						?.split(':')[1] ?? '';
				const ok = this.answersOn.has(h);
				return cost(ok ? this.costs.probe : this.costs.reachFail, 'reachesHost', t) && ok;
			},
			edgeProbe: (_s, t) => {
				if (!cost(this.costs.probe, 'edgeProbe', t)) return null;
				const e = [...this.c.values()].find((x) => /bunkerity\/bunkerweb:/.test(x.image));
				if (!e) return null;
				// BunkerWeb answers 502 unless the frontend listens where it sends.
				const target =
					e.env.find((x) => /REVERSE_PROXY_HOST=/.test(x))?.split('=')[1] ?? 'http://frontend:80';
				const port = /:(\d+)(\/|$)/.exec(target.replace(/^http:\/\//, ''))?.[1] ?? '80';
				const listens = new Set([
					'80',
					...[...(this.served ?? '').matchAll(/listen (\d+);/g)].map((m) => m[1]!)
				]);
				const ok = listens.has(port) && !(port !== '80' && this.edgePortUnreachable);
				return {
					status: ok ? 200 : 502,
					headers: {
						'referrer-policy':
							e.env.find((x) => x.startsWith('REFERRER_POLICY='))?.slice(16) ??
							'strict-origin-when-cross-origin'
					}
				};
			},
			frontendBase: () => this.feBase,
			frontendRebuildPinsBase: () => this.fePinnable,
			nginxT: (n, t) => {
				if (!cost(this.costs.probe, 'nginxT', t)) return null;
				const x = this.c.get(n);
				if (!x) return null;
				if (/bunkerity\/bunkerweb:/.test(x.image)) return this.edgeDump.get(n) ?? this.edgeNginx(x);
				return this.served;
			},
			bunkerwebSettings: (n, t) => {
				if (!cost(this.costs.probe, 'bunkerwebSettings', t) || !this.settingsReadable) return null;
				return this.edgeSettings.get(n) ?? null;
			},
			configNewerThanStart: (_n, t) => (cost(this.costs.probe, 'stat', t), this.newerThanStart),
			reloadNginx: (_n, t) => (
				cost(this.costs.probe, 'reload', t),
				this.reloads++,
				(this.newerThanStart = false),
				true
			),
			refreshFrontend: (_r, t, withBase = true) => {
				if (!cost(this.costs.refresh, 'refresh', t)) return false;
				this.refreshes++;
				this.refreshWithBase.push(withBase);
				this.served = this.servedAfterRefresh;
				// Without the new Dockerfile the image keeps its old base.
				if (withBase) this.feBase = this.feBaseAfterRefresh;
				return true;
			},
			hiddenOnly: () => this.hidden,
			baseImagePresent: () => this.basePresent,
			loadBundledBase: () => {
				if (!this.bundledBase) return false;
				this.loads++;
				this.basePresent = true;
				return true;
			},
			dockerPullsThroughTor: () => this.torPulls,
			schedulerCycle: () =>
				this.verdict ? this.verdict(this.t - this.lastUpAt) : { kind: 'loaded' as const },
			onTerminate: (fn) => ((this.terminate = fn), () => (this.terminate = null)),
			sleep: async (ms) => {
				this.t += ms;
			},
			spinner: (label) => {
				this.spinners.push(label);
				this.depth++;
				let open = true;
				return () => {
					if (open) this.depth--;
					open = false;
				};
			}
		};
	}
	written: string[] = [];
	files(): string[] {
		return this.o.composeFiles.map((f) => join(this.dir, f));
	}
	path(rel: string): string {
		return join(this.dir, rel);
	}
	expectRef(ref: ComposeRef): void {
		expect(ref.files).toEqual(this.files());
		expect(ref.project).toBe(this.project);
	}
	resolvedEnv(service: string): string[] {
		const m = JSON.parse(modelJson(this.files(), this.dir, false)).services[service];
		return Object.entries((m?.environment ?? {}) as Record<string, string>).map(
			([k, v]) => `${k}=${v.replace(/\$\$/g, '$')}`
		);
	}
	/** What BunkerWeb 1.5's generator writes: every setting, default or set. */
	generated(x: ContainerInfo): string {
		const vars = new Map<string, string>([
			...BUNKERWEB_PRIVACY_SETTINGS.map((p) => [p.key, p.bunkerwebDefault] as [string, string]),
			['USE_ANTIBOT', 'no'],
			['ANTIBOT_URI', '/challenge']
		]);
		for (const e of x.env) vars.set(e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1));
		return [...vars].map(([k, v]) => `${k}=${v}`).join('\n');
	}
	edgeNginx(x: ContainerInfo): string {
		const lf = x.env.find((e) => e.startsWith('LOG_FORMAT='))?.slice(11) ?? BW_DEFAULT_LOG_FORMAT;
		return `# configuration file /etc/nginx/nginx.conf:\nhttp {\n  log_format logf '${lf}';\n  access_log /var/log/bunkerweb/access.log logf;\n}\n`;
	}
	recreate(service: string, n: number): void {
		const model = composeModel(this.files(), this.dir);
		for (const [name, x] of this.c) {
			if (x.labels['com.docker.compose.service'] !== service) continue;
			const s = model[service]!;
			if (!this.edgeRegenerates && /bunkerity\/bunkerweb:/.test(x.image))
				this.edgeDump.set(name, this.edgeNginx(x));
			x.id = `${name}-id-${n}`;
			x.logDriver = s.logging?.driver ?? 'json-file';
			x.logOptions = { ...(s.logging?.options ?? {}) };
			x.extraHosts = s.extra_hosts.map((h) => h.replace('=', ':'));
			x.env = this.resolvedEnv(service);
			x.running = !this.notRunningAfterUp.has(name);
			if (/bunkerity\/bunkerweb:/.test(x.image) && !this.settingsFrozen)
				this.edgeSettings.set(name, this.generated(x));
			if (this.portsAfterUp.has(name)) x.ports = this.portsAfterUp.get(name)!;
			this.recreated.push(name);
		}
	}
	async run(extra: { hardStopAt?: number; budgetMs?: number; rollbackReserveMs?: number } = {}) {
		return applyAndVerifyProxyConfig({
			runtime: this.rt,
			info: (m) => this.info.push(m),
			warn: (m) => this.warn.push(m),
			buildDir: BUILD,
			pollMs: 3000,
			...extra
		});
	}
	dispose(): void {
		rmSync(this.dir, { recursive: true, force: true });
	}
}

const sims: Sim[] = [];
const sim = (o: SimOpts): Sim => {
	const s = new Sim(o);
	sims.push(s);
	return s;
};
afterEach(() => {
	for (const s of sims.splice(0)) s.dispose();
});

const oldBox = (env: string | Buffer = OLD_ENV, compose: string | Buffer = OLD_COMPOSE): Sim =>
	sim({
		files: { 'docker-compose.yml': compose, 'bunkerweb.env': env },
		composeFiles: ['docker-compose.yml'],
		containers: [
			{
				name: 'bunkerweb',
				service: 'bunkerweb',
				image: 'bunkerity/bunkerweb:1.5.10',
				ports: ['0.0.0.0:443->8443/tcp', '0.0.0.0:80->8080/tcp']
			},
			{
				name: 'morphit-frontend',
				service: 'frontend',
				image: 'bunkerweb-frontend',
				mounts: [BUILD]
			}
		]
	});

const morphitIo = (acquis: string | null = null): Sim => {
	const s = sim({
		files: {
			'docker-compose.yml': MORPHITIO_COMPOSE,
			'bunkerweb.env': 'SERVER_NAME=morphit.io\nUSE_REVERSE_PROXY=yes\n'
		},
		composeFiles: ['docker-compose.yml'],
		containers: [
			{
				name: 'bunkerweb-frontend-1',
				service: 'frontend',
				image: 'bunkerweb-frontend',
				mounts: [BUILD],
				gateways: ['172.18.0.1']
			},
			{
				name: 'bunkerweb-onion-service-1',
				service: 'onion-service',
				image: 'example/tor',
				mounts: ['/opt/bunkerweb/tor-keys'],
				gateways: ['172.18.0.1']
			},
			{
				name: 'bunkerweb-crowdsec-1',
				service: 'crowdsec',
				image: 'crowdsecurity/crowdsec:latest',
				mounts: ['/var/run/docker.sock'],
				gateways: ['172.18.0.1']
			},
			{
				name: 'bunkerweb-bunkerweb-1',
				service: 'bunkerweb',
				image: 'bunkerity/bunkerweb:1.5.10',
				ports: ['0.0.0.0:443->8443/tcp', '0.0.0.0:80->8080/tcp'],
				gateways: ['172.18.0.1']
			},
			{
				name: 'bunkerweb-bw-scheduler-1',
				service: 'bw-scheduler',
				image: 'bunkerity/bunkerweb-scheduler:1.5.10',
				gateways: ['172.18.0.1']
			},
			{
				name: 'bunkerweb-redis-1',
				service: 'redis',
				image: 'redis:7-alpine',
				gateways: ['172.18.0.1']
			},
			{
				name: 'bunkerweb-db-1',
				service: 'db',
				image: 'postgres:16-alpine',
				gateways: ['172.18.0.1']
			}
		]
	});
	s.acquis.set('bunkerweb-crowdsec-1', acquis);
	return s;
};

// ── pure parts ──────────────────────────────────────────────────────────

describe('the canonical values match the shipped BunkerWeb env', () => {
	it('CSP, Permissions-Policy and LOG_FORMAT equal ops/bunkerweb/bunkerweb.env.example', () => {
		const ex = readFileSync(join(REPO, 'ops/bunkerweb/bunkerweb.env.example'), 'utf8');
		expect(/^CONTENT_SECURITY_POLICY=(.*)$/m.exec(ex)?.[1]).toBe(MORPHIT_CSP);
		expect(/^PERMISSIONS_POLICY=(.*)$/m.exec(ex)?.[1]).toBe(MORPHIT_PERMISSIONS_POLICY);
		expect(/^LOG_FORMAT=(.*)$/m.exec(ex)?.[1]).toBe(MORPHIT_LOG_FORMAT);
	});
	it('the shipped compose files need nothing from the heal (a fresh install = the healed state)', () => {
		for (const rel of [
			'ops/bunkerweb/docker-compose.yml',
			'ops/ansible/roles/bunkerweb/templates/docker-compose.yml.j2'
		]) {
			const t = readFileSync(join(REPO, rel), 'utf8');
			expect(
				planCompose(t, { edge: 'bunkerweb', frontend: 'frontend' }, '172.20.0.1').changes
			).toEqual([]);
			expect(composeLogDriver(t, 'bunkerweb')).toBe('none');
			expect(composeLogDriver(t, 'frontend')).toBe('local');
		}
		expect(
			planBunkerwebEnv(
				readFileSync(join(REPO, 'ops/ansible/roles/bunkerweb/templates/bunkerweb.env.j2'), 'utf8')
			).changes
		).toEqual([]);
	});
	it('keeps an operator-set CSP, but replaces a LOG_FORMAT that logs addresses — unless CrowdSec needs it', () => {
		const env = `CONTENT_SECURITY_POLICY=default-src 'self'\nLOG_FORMAT=$remote_addr $request\n`;
		const p = planBunkerwebEnv(env);
		expect(p.text).toContain(`CONTENT_SECURITY_POLICY=default-src 'self'\n`);
		expect(p.text).toContain(`LOG_FORMAT=${MORPHIT_LOG_FORMAT}`);
		expect(p.text).not.toContain('$remote_addr');
		expect(planBunkerwebEnv(env, { keepLogFormat: true }).text).toContain(
			'LOG_FORMAT=$remote_addr $request'
		);
	});
	it('everything the heal inserts is ASCII (it is written back byte for byte)', () => {
		const p = planBunkerwebEnv('');
		const c = planCompose(OLD_COMPOSE, { edge: 'bunkerweb', frontend: 'frontend' }, '172.20.0.1', {
			edgeLog: 'bounded'
		});
		expect(/[^\x00-\x7f]/.test(p.text)).toBe(false);
		expect(/[^\x00-\x7f]/.test(c.text)).toBe(false);
	});
});

describe('bytes survive: decode → edit → encode', () => {
	it('round-trips any bytes (BOM, CRLF, invalid UTF-8) exactly', () => {
		const samples = [
			Buffer.concat([
				Buffer.from([0xef, 0xbb, 0xbf]),
				Buffer.from('A=1\r\nB=p\xe4ss\r\n', 'latin1')
			]),
			Buffer.from('X=caf\xc3\xa9\n# \xff\xfe junk\n', 'latin1'),
			Buffer.from(''),
			Buffer.from('no newline at end', 'latin1')
		];
		for (let i = 0; i < 200; i++) {
			const b = Buffer.from(
				Array.from({ length: 64 }, () => Math.floor(Math.random() * 256)).filter((x) => x !== 13)
			);
			samples.push(b);
		}
		for (const b of samples) {
			const d = decodeConfig(b)!;
			expect(d).not.toBeNull();
			expect(encodeConfig(d.text, d).equals(b)).toBe(true);
		}
	});
	it('an edit keeps the BOM, the CRLF endings and every other byte', () => {
		const b = Buffer.concat([
			Buffer.from([0xef, 0xbb, 0xbf]),
			Buffer.from('SERVER_NAME=a\r\nX=p\xe4ss\r\n', 'latin1')
		]);
		const d = decodeConfig(b)!;
		const out = encodeConfig(planBunkerwebEnv(d.text).text, d);
		expect(out.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
		expect(out.toString('latin1')).toContain('X=p\xe4ss\r\n');
		expect(/[^\r]\n/.test(out.toString('latin1'))).toBe(false);
	});
	it('mixed line endings are left alone', () => {
		expect(decodeConfig(Buffer.from('A=1\r\nB=2\nC=3\r\n'))).toBeNull();
		expect(decodeConfig(Buffer.from('A=1\rB=2'))).toBeNull();
	});
});

describe('which container is which (by mounts, image and port — never by name)', () => {
	const ci = (name: string, image: string, extra: Partial<ContainerInfo> = {}): ContainerInfo => ({
		name,
		id: name,
		image,
		running: true,
		labels: {},
		env: [],
		logDriver: 'json-file',
		logOptions: {},
		extraHosts: [],
		ports: [],
		mounts: [],
		binds: [],
		gateways: [],
		...extra
	});
	it('on morphit.io the onion service, crowdsec, redis and db are never the edge', () => {
		const list = [
			ci('bunkerweb-frontend-1', 'bunkerweb-frontend', { mounts: [BUILD] }),
			ci('bunkerweb-onion-service-1', 'example/tor'),
			ci('bunkerweb-crowdsec-1', 'crowdsecurity/crowdsec', { mounts: ['/var/run/docker.sock'] }),
			ci('bunkerweb-bunkerweb-1', 'docker.io/bunkerity/bunkerweb:1.5.10', {
				ports: ['0.0.0.0:443->8443/tcp']
			}),
			ci('bunkerweb-bw-scheduler-1', 'bunkerity/bunkerweb-scheduler:1.5.10'),
			ci('bunkerweb-redis-1', 'redis:7'),
			ci('bunkerweb-db-1', 'postgres:16-alpine')
		];
		const id = identifyContainers(list, BUILD);
		expect(id.frontend?.name).toBe('bunkerweb-frontend-1');
		expect(id.edge?.name).toBe('bunkerweb-bunkerweb-1');
		expect(id.schedulers.map((c) => c.name)).toEqual(['bunkerweb-bw-scheduler-1']);
		expect(id.crowdsec.map((c) => c.name)).toEqual(['bunkerweb-crowdsec-1']);
	});
	it('a plain nginx edge (morphit.io variant): no BunkerWeb edge, and a calm note', () => {
		const id = identifyContainers(
			[
				ci('bunkerweb-frontend-1', 'fe', { mounts: [BUILD] }),
				ci('bunkerweb-nginx-1', 'nginx:alpine', { ports: ['0.0.0.0:443->443/tcp'] }),
				ci('bunkerweb-onion-service-1', 'example/tor')
			],
			BUILD
		);
		expect(id.edge).toBeNull();
		expect(id.notes.join(' ')).toMatch(/bunkerweb-nginx-1\) is not BunkerWeb/);
	});
	it('several BunkerWeb containers: the one publishing 443; still several: none, with a note', () => {
		const a = ci('bw-a', 'bunkerity/bunkerweb:1.5.10', { ports: ['0.0.0.0:443->8443/tcp'] });
		const b = ci('bw-b', 'bunkerity/bunkerweb:1.5.10');
		expect(identifyContainers([a, b], BUILD).edge?.name).toBe('bw-a');
		const both = identifyContainers([a, { ...b, ports: ['0.0.0.0:443->8443/tcp'] }], BUILD);
		expect(both.edge).toBeNull();
		expect(both.notes.join(' ')).toMatch(/several BunkerWeb containers/);
		const neither = identifyContainers([{ ...a, ports: [] }, b], BUILD);
		expect(neither.edge).toBeNull();
	});
	it('the scheduler, UI and autoconf images are not the edge', () => {
		for (const img of [
			'bunkerity/bunkerweb-scheduler:1.5.10',
			'bunkerity/bunkerweb-ui:1.5.10',
			'bunkerity/bunkerweb-autoconf:1.5.10'
		])
			expect(
				identifyContainers([ci('x', img, { ports: ['0.0.0.0:443->8443/tcp'] })], BUILD).edge
			).toBeNull();
	});
	it('parses real `docker inspect` JSON (name, image, ports, mounts, gateways, log config)', () => {
		const j = JSON.stringify([
			{
				Id: 'abc123',
				Name: '/bunkerweb-bunkerweb-1',
				Config: {
					Image: 'bunkerity/bunkerweb:1.5.10',
					Labels: { 'com.docker.compose.service': 'bunkerweb' },
					Env: ['A=1']
				},
				State: { Running: true },
				HostConfig: {
					LogConfig: { Type: 'local', Config: { 'max-size': '5m' } },
					ExtraHosts: ['host.docker.internal:172.18.0.1']
				},
				NetworkSettings: {
					Ports: { '8443/tcp': [{ HostIp: '0.0.0.0', HostPort: '443' }], '8080/tcp': null },
					Networks: { n: { Gateway: '172.18.0.1' } }
				},
				Mounts: [{ Source: '/etc/letsencrypt' }]
			}
		]);
		const [c] = parseDockerInspect(j);
		expect(c).toMatchObject({
			name: 'bunkerweb-bunkerweb-1',
			image: 'bunkerity/bunkerweb:1.5.10',
			running: true,
			logDriver: 'local',
			ports: ['0.0.0.0:443->8443/tcp'],
			gateways: ['172.18.0.1'],
			mounts: ['/etc/letsencrypt']
		});
	});
});

describe('CrowdSec: does it read the edge?', () => {
	const edge = {
		name: 'bunkerweb-bunkerweb-1',
		id: 'deadbeef1234',
		labels: {}
	} as unknown as ContainerInfo;
	it('docker acquisition naming the edge (name, regexp, id, labels) → yes', () => {
		expect(
			crowdsecReadsEdge(
				'source: docker\ncontainer_name:\n  - bunkerweb-bunkerweb-1\nlabels:\n  type: bunkerweb\n',
				edge
			)
		).toBe(true);
		expect(
			crowdsecReadsEdge('source: docker\ncontainer_name_regexp:\n  - "bunkerweb-.*-1"\n', edge)
		).toBe(true);
		expect(crowdsecReadsEdge('source: docker\ncontainer_id:\n  - deadbeef\n', edge)).toBe(true);
		expect(
			crowdsecReadsEdge('source: docker\nuse_container_labels: true\n', {
				...edge,
				labels: { 'crowdsec.enable': 'true' }
			})
		).toBe(true);
	});
	it('unreadable, or a docker entry naming no container → yes (cannot tell)', () => {
		expect(crowdsecReadsEdge(null, edge)).toBe(true);
		expect(crowdsecReadsEdge('source: docker\nlabels:\n  type: nginx\n', edge)).toBe(true);
	});
	it('a file source for the bunkerweb/nginx access log → yes', () => {
		expect(
			crowdsecReadsEdge(
				'filenames:\n  - /var/log/bunkerweb/access.log\nlabels:\n  type: nginx\n',
				edge
			)
		).toBe(true);
	});
	it('acquisition only for other things (sshd journal, another container) → no', () => {
		const a =
			'source: journalctl\njournalctl_filter:\n  - "_SYSTEMD_UNIT=ssh.service"\nlabels:\n  type: syslog\n---\nsource: docker\ncontainer_name:\n  - bunkerweb-db-1\nlabels:\n  type: postgres\n';
		expect(crowdsecReadsEdge(a, edge)).toBe(false);
	});
});

describe("Compose's model and nginx's log formats (parsers)", () => {
	it('reads env_file, environment ($$ unescaped), logging and host.docker.internal', () => {
		const m = parseComposeModel(
			JSON.stringify({
				services: {
					bw: {
						env_file: [{ path: '/opt/bunkerweb/bunkerweb.env' }],
						environment: { LOG_FORMAT: '$$host [$$time_local]' },
						logging: { driver: 'local', options: { 'max-size': '5m', 'max-file': '1' } },
						extra_hosts: [
							'host.docker.internal=172.18.0.1',
							'other=1.2.3.4',
							'host.docker.internal=host-gateway'
						]
					}
				}
			})
		)!;
		const bw = m.get('bw')!;
		expect(bw.envFiles).toEqual(['/opt/bunkerweb/bunkerweb.env']);
		expect(bw.environment.get('LOG_FORMAT')).toBe('$host [$time_local]');
		expect(bw.logDriver).toBe('local');
		expect(bw.dockerHost).toEqual(['172.18.0.1', 'host-gateway']);
	});
	it("finds BunkerWeb's `log_format logf '…'` in nginx -T", () => {
		const f = nginxLogFormats(
			`http {\n  log_format logf '$host [$time_local] "$request_method $uri" $status $body_bytes_sent';\n}`
		);
		expect(f.get('logf')).toBe(MORPHIT_LOG_FORMAT.slice(1, -1));
	});
});

// ── the heal, end to end in the simulator ───────────────────────────────

describe('an installed pre-v1.20.0 BunkerWeb box', () => {
	it('gets no-address logging, the headers and the real gateway — in ONE compose up — checked', async () => {
		const s = oldBox();
		const out = await s.run();
		expect(out.kind).toBe('applied');
		expect(s.ups.map((u) => u.services)).toEqual([['bunkerweb', 'frontend']]);
		expect(s.c.get('bunkerweb')!.logDriver).toBe('none');
		expect(s.c.get('morphit-frontend')!.logDriver).toBe('local');
		expect(s.c.get('morphit-frontend')!.extraHosts).toEqual(['host.docker.internal:172.20.0.1']);
		const env = readFileSync(s.path('bunkerweb.env'), 'utf8');
		expect(env).toContain(`LOG_FORMAT=${MORPHIT_LOG_FORMAT}`);
		expect(env).toContain(`CONTENT_SECURITY_POLICY=${MORPHIT_CSP}`);
		expect(env).toMatch(/^REFERRER_POLICY=no-referrer$/m);
		expect(env).toMatch(/^REVERSE_PROXY_HOST=http:\/\/frontend:8088$/m);
		expect(env.startsWith(OLD_ENV.trim().replace('frontend:80', 'frontend:8088'))).toBe(true);
		expect(s.c.get('bunkerweb')!.env).toContain('REVERSE_PROXY_HOST=http://frontend:8088');
		expect(existsSync(s.path('docker-compose.yml.bak-test'))).toBe(true);
		expect(s.warn).toEqual([]);
		expect(s.silent).toEqual([]); // every blocking step behind a spinner
	});

	it('runs a second time without touching anything or restarting', async () => {
		const s = oldBox();
		await s.run();
		const again = await s.run();
		expect(again.kind).toBe('already');
		expect(s.ups.length).toBe(1);
	});

	it('leaves host.docker.internal alone when the frontend does not reach the host even before', async () => {
		const s = oldBox();
		s.answersOn = new Set();
		const out = await s.run();
		expect(out.kind).toBe('applied');
		expect(readFileSync(s.path('docker-compose.yml'), 'utf8')).toContain(
			'host.docker.internal:host-gateway'
		);
	});
});

describe("morphit.io's hand-made stack (V1's attack)", () => {
	it('never recreates the onion service, CrowdSec, redis or the database; only edge, its scheduler and frontend, with --no-deps', async () => {
		const s = morphitIo(
			'source: docker\ncontainer_name:\n  - bunkerweb-db-1\nlabels:\n  type: postgres\n'
		);
		const out = await s.run();
		expect(out.kind).toBe('applied');
		expect(s.recreated.sort()).toEqual([
			'bunkerweb-bunkerweb-1',
			'bunkerweb-bw-scheduler-1',
			'bunkerweb-frontend-1'
		]);
		const compose = readFileSync(s.path('docker-compose.yml'), 'utf8');
		// the onion service's own host mapping is untouched
		expect(compose).toMatch(/onion-service:[\s\S]*?host\.docker\.internal:host-gateway/);
		expect(s.c.get('bunkerweb-bunkerweb-1')!.logDriver).toBe('none');
		expect(s.c.get('bunkerweb-frontend-1')!.extraHosts).toEqual([
			'host.docker.internal:172.18.0.1'
		]);
		expect(s.silent).toEqual([]);
	});

	it('CrowdSec reading BunkerWeb through Docker: a small rotating log, the log format left as it is, said calmly', async () => {
		const s = morphitIo(
			'source: docker\ncontainer_name:\n  - bunkerweb-bunkerweb-1\nlabels:\n  type: bunkerweb\n'
		);
		const out = await s.run();
		expect(out.kind).toBe('applied');
		const e = s.c.get('bunkerweb-bunkerweb-1')!;
		expect(e.logDriver).toBe('local');
		expect(e.logOptions).toEqual({ 'max-size': '5m', 'max-file': '1' });
		expect(readFileSync(s.path('bunkerweb.env'), 'utf8')).not.toMatch(/^LOG_FORMAT=/m);
		expect(s.info.join(' ')).toMatch(/CrowdSec \(bunkerweb-crowdsec-1\) reads BunkerWeb's log/);
		expect(s.warn).toEqual([]);
	});

	it('a scheduler that reads another settings file is not recreated', async () => {
		const s = sim({
			files: {
				'docker-compose.yml': MORPHITIO_COMPOSE.replace(
					'  bw-scheduler:\n    image: bunkerity/bunkerweb-scheduler:1.5.10\n    env_file:\n      - ./bunkerweb.env',
					'  bw-scheduler:\n    image: bunkerity/bunkerweb-scheduler:1.5.10\n    env_file:\n      - ./scheduler.env'
				),
				'bunkerweb.env': 'SERVER_NAME=morphit.io\n',
				'scheduler.env': 'X=1\n'
			},
			composeFiles: ['docker-compose.yml'],
			containers: [
				{
					name: 'bunkerweb-frontend-1',
					service: 'frontend',
					image: 'fe',
					mounts: [BUILD],
					gateways: ['172.18.0.1']
				},
				{
					name: 'bunkerweb-bunkerweb-1',
					service: 'bunkerweb',
					image: 'bunkerity/bunkerweb:1.5.10',
					ports: ['0.0.0.0:443->8443/tcp'],
					gateways: ['172.18.0.1']
				},
				{
					name: 'bunkerweb-bw-scheduler-1',
					service: 'bw-scheduler',
					image: 'bunkerity/bunkerweb-scheduler:1.5.10',
					gateways: ['172.18.0.1']
				}
			]
		});
		const out = await s.run();
		expect(out.kind).toBe('applied');
		expect(s.recreated).not.toContain('bunkerweb-bw-scheduler-1');
	});

	it('CrowdSec acquisition that cannot be read counts as reading BunkerWeb (never blind it)', async () => {
		const s = morphitIo(null);
		await s.run();
		expect(s.c.get('bunkerweb-bunkerweb-1')!.logDriver).toBe('local');
	});

	it('another container with the Docker socket also keeps the edge log bounded', async () => {
		const s = oldBox();
		s.c.set('promtail', {
			...s.c.get('morphit-frontend')!,
			name: 'promtail',
			image: 'grafana/promtail',
			mounts: ['/var/run/docker.sock'],
			labels: {}
		});
		await s.run();
		expect(s.c.get('bunkerweb')!.logDriver).toBe('local');
		expect(s.info.join(' ')).toMatch(/promtail can read container logs/);
	});

	it('a plain nginx edge: only the frontend is changed; BunkerWeb settings untouched; a note', async () => {
		const s = sim({
			files: {
				'docker-compose.yml': MORPHITIO_COMPOSE.replace(
					'bunkerity/bunkerweb:1.5.10',
					'nginx:alpine'
				),
				'bunkerweb.env': 'SERVER_NAME=morphit.io\n'
			},
			composeFiles: ['docker-compose.yml'],
			containers: [
				{
					name: 'bunkerweb-frontend-1',
					service: 'frontend',
					image: 'fe',
					mounts: [BUILD],
					gateways: ['172.18.0.1']
				},
				{
					name: 'bunkerweb-nginx-1',
					service: 'bunkerweb',
					image: 'nginx:alpine',
					ports: ['0.0.0.0:443->443/tcp'],
					gateways: ['172.18.0.1']
				},
				{
					name: 'bunkerweb-onion-service-1',
					service: 'onion-service',
					image: 'example/tor',
					gateways: ['172.18.0.1']
				}
			]
		});
		const out = await s.run();
		expect(out.kind).toBe('applied');
		expect(s.recreated).toEqual(['bunkerweb-frontend-1']);
		expect(readFileSync(s.path('bunkerweb.env'), 'utf8')).toBe('SERVER_NAME=morphit.io\n');
		expect(s.info.join(' ')).toMatch(/is not BunkerWeb/);
	});
});

describe('every Compose file and env file the stack uses (P3)', () => {
	it('addresses the project exactly: -p, --project-directory, every -f in order, every --env-file', () => {
		const ref: ComposeRef = {
			project: 'bunkerweb',
			service: 'bunkerweb',
			files: ['/opt/bunkerweb/docker-compose.yml', '/opt/bunkerweb/docker-compose.override.yml'],
			envFiles: ['/opt/bunkerweb/.env.prod'],
			workDir: '/opt/bunkerweb'
		};
		expect(composeArgs(ref, ['up', '-d', '--no-deps', 'frontend'])).toEqual([
			'compose',
			'-p',
			'bunkerweb',
			'--project-directory',
			'/opt/bunkerweb',
			'-f',
			'/opt/bunkerweb/docker-compose.yml',
			'-f',
			'/opt/bunkerweb/docker-compose.override.yml',
			'--env-file',
			'/opt/bunkerweb/.env.prod',
			'up',
			'-d',
			'--no-deps',
			'frontend'
		]);
	});
	const BASE = `services:\n  bunkerweb:\n    image: bunkerity/bunkerweb:1.5.10\n    container_name: bunkerweb\n    env_file:\n      - ./bunkerweb.env\n    extra_hosts:\n      - "host.docker.internal:host-gateway"\n  frontend:\n    image: fe\n    volumes:\n      - ${BUILD}:/usr/share/nginx/html:ro\n    extra_hosts:\n      - "host.docker.internal:host-gateway"\n`;
	const OVERRIDE = `services:\n  bunkerweb:\n    ports:\n      - "80:8080"\n      - "443:8443"\n`;
	const layered = (override = OVERRIDE) =>
		sim({
			files: {
				'docker-compose.yml': BASE,
				'docker-compose.override.yml': override,
				'bunkerweb.env': 'SERVER_NAME=x.org\n',
				'proj.env': 'TAG=1\n'
			},
			composeFiles: ['docker-compose.yml', 'docker-compose.override.yml'],
			envFiles: ['proj.env'],
			containers: [
				{
					name: 'bunkerweb',
					service: 'bunkerweb',
					image: 'bunkerity/bunkerweb:1.5.10',
					ports: ['0.0.0.0:443->8443/tcp']
				},
				{ name: 'fe', service: 'frontend', image: 'fe', mounts: [BUILD] }
			]
		});
	it('passes every -f and the recorded --env-file to up and to the rollback', async () => {
		const s = layered();
		s.answersOn = new Set(['host-gateway']); // the gateway will not answer → rollback
		const out = await s.run();
		expect(out.kind).toBe('rolled-back');
		expect(s.ups.length).toBe(2);
		for (const u of s.ups) {
			expect(u.files).toEqual(s.files());
			expect(u.envFiles).toEqual([s.path('proj.env')]);
		}
	});
	it('an override that also maps host.docker.internal: nothing is restarted, the files are put back', async () => {
		const s = layered(
			`${OVERRIDE}  frontend:\n    extra_hosts:\n      - "host.docker.internal:host-gateway"\n`
		);
		const before = readFileSync(s.path('docker-compose.yml'));
		const out = await s.run();
		expect(out.kind).toBe('invalid-compose');
		expect(s.ups).toEqual([]);
		expect(readFileSync(s.path('docker-compose.yml')).equals(before)).toBe(true);
		expect(s.warn.join(' ')).toMatch(/nothing was restarted/);
	});
	it('an inline `environment:` that sets REFERRER_POLICY wins over the env file: nothing restarted', async () => {
		const s = layered(`${OVERRIDE}    environment:\n      REFERRER_POLICY: same-origin\n`);
		const out = await s.run();
		expect(out.kind).toBe('invalid-compose');
		expect(s.ups).toEqual([]);
		expect(readFileSync(s.path('bunkerweb.env'), 'utf8')).toBe('SERVER_NAME=x.org\n');
	});
	it('the operator configured logging in an override file: it is kept', async () => {
		const s = layered(
			`${OVERRIDE}    logging:\n      driver: json-file\n      options:\n        max-size: "10m"\n`
		);
		const out = await s.run();
		expect(out.kind).toBe('applied');
		expect(readFileSync(s.path('docker-compose.yml'), 'utf8')).not.toMatch(
			/bunkerweb:[\s\S]*?logging:[\s\S]*?frontend:/
		);
		expect(s.c.get('bunkerweb')!.logDriver).toBe('json-file');
	});
});

describe('verify what was changed, not what the operator chose (P4)', () => {
	it("an operator's own Referrer-Policy is kept and never causes a rollback", async () => {
		const env = `SERVER_NAME=example.org\nREFERRER_POLICY=same-origin\nCONTENT_SECURITY_POLICY=x\nPERMISSIONS_POLICY=y\nX_FRAME_OPTIONS=DENY\n`;
		const s = oldBox(env);
		const out = await s.run();
		expect(out.kind).toBe('applied');
		expect(s.ups.length).toBe(1);
		expect(readFileSync(s.path('bunkerweb.env'), 'utf8')).toMatch(/^REFERRER_POLICY=same-origin$/m);
		const again = await s.run();
		expect(again.kind).toBe('already');
	});
	it('the edge not using the new log format (checked in its nginx -T) → rolled back', async () => {
		const s = oldBox();
		s.edgeRegenerates = false;
		const out = await s.run();
		expect(out.kind).toBe('rolled-back');
		expect((out as { reason: string }).reason).toMatch(/does not use the new log format/);
		expect(readFileSync(s.path('bunkerweb.env'), 'utf8')).toBe(OLD_ENV);
	});
	it('published ports that change on recreate → rolled back', async () => {
		const s = oldBox();
		s.portsAfterUp.set('bunkerweb', ['0.0.0.0:8443->8443/tcp']);
		const out = await s.run();
		expect(out.kind).toBe('rolled-back');
		expect((out as { reason: string }).reason).toMatch(/same published ports/);
	});
});

describe('the rollback is byte-identical, checked, and says only what it checked', () => {
	it('restores a BOM + CRLF + non-UTF-8 env and compose exactly, and checks running + ports', async () => {
		const env = Buffer.concat([
			Buffer.from([0xef, 0xbb, 0xbf]),
			Buffer.from('SERVER_NAME=example.org\r\nADMIN_PASSWORD=p\xe4ss\r\n', 'latin1')
		]);
		const compose = Buffer.concat([
			Buffer.from(OLD_COMPOSE, 'latin1'),
			Buffer.from('# caf\xe9\n', 'latin1')
		]);
		const s = oldBox(env, compose);
		s.answersOn = new Set(['host-gateway']);
		const out = await s.run();
		expect(out.kind).toBe('rolled-back');
		expect(readFileSync(s.path('bunkerweb.env')).equals(env)).toBe(true);
		expect(readFileSync(s.path('docker-compose.yml')).equals(compose)).toBe(true);
		expect((out as { restoreVerified: boolean }).restoreVerified).toBe(true);
		const w = s.warn.join(' ');
		expect(w).toMatch(
			/put back and checked: bunkerweb, morphit-frontend run on the same ports as before/
		);
		expect(w).toMatch(/Copies of your original files: .*bunkerweb\.env\.bak-test/);
		expect(w).not.toMatch(/Copies of the edited files/);
		expect(s.silent).toEqual([]);
	});
	it('a rollback whose compose up fails says so, with the exact command — never "keeps working"', async () => {
		const s = oldBox();
		s.answersOn = new Set(['host-gateway']);
		s.upFails = [2];
		const out = await s.run();
		expect(out.kind).toBe('rolled-back');
		expect((out as { restoreVerified: boolean }).restoreVerified).toBe(false);
		const w = s.warn.join(' ');
		expect(w).toMatch(/could not be confirmed \(Docker Compose\)/);
		expect(w).toContain(
			`docker compose -p bunkerweb --project-directory ${s.dir} -f ${s.path('docker-compose.yml')} up -d --no-deps bunkerweb frontend`
		);
		expect(w).not.toMatch(/keeps working/);
	});
	it('stopped (SIGTERM) in the middle of the change: the original files are put back', async () => {
		const s = oldBox();
		const env0 = readFileSync(s.path('bunkerweb.env'));
		const compose0 = readFileSync(s.path('docker-compose.yml'));
		s.onUp = () => s.terminate?.();
		await s.run();
		expect(readFileSync(s.path('bunkerweb.env')).equals(env0)).toBe(true);
		expect(readFileSync(s.path('docker-compose.yml')).equals(compose0)).toBe(true);
	});
});

describe('on time (P5): the self-heal child is killed at 300 s', () => {
	it(`never runs past ${HEAL_BUDGET_MS / 1000} s, and a failing change is rolled back inside it`, async () => {
		const s = oldBox();
		s.answersOn = new Set(['host-gateway']); // forces a rollback
		s.costs.up = 45_000;
		s.costs.reachFail = 6_000;
		const out = await s.run();
		expect(out.kind).toBe('rolled-back');
		expect(s.lastCallAt - s.start).toBeLessThanOrEqual(HEAL_BUDGET_MS);
	});
	it("respects the child's own deadline: with too little time left it changes nothing", async () => {
		const s = oldBox();
		const out = await s.run({ hardStopAt: s.t + 60_000 });
		expect(out.kind).toBe('no-time');
		expect(s.ups).toEqual([]);
		expect(readFileSync(s.path('bunkerweb.env'), 'utf8')).toBe(OLD_ENV);
		expect(s.info.join(' ')).toMatch(/Not enough time was left/);
	});
	it('a slow up is cut off with the rollback still inside the deadline', async () => {
		const s = oldBox();
		const deadline = s.t + 110_000;
		s.costs.up = 30_000;
		s.upFails = [1]; // the (timed-out) first up
		const out = await s.run({ hardStopAt: deadline });
		expect(out.kind).toBe('rolled-back');
		expect(s.lastCallAt).toBeLessThanOrEqual(deadline);
		expect(readFileSync(s.path('bunkerweb.env'), 'utf8')).toBe(OLD_ENV);
	});
});

// v1.20.1 — morphitir (2026-09-30): BunkerWeb's scheduler refused every new
// config (a duplicated ModSecurity rule) and kept its Sep 7 one, while every
// container ran and every setting looked applied; the heal waited out its budget
// on "the new log format" and put the old settings back without saying why. And
// on that network a rebuild takes ~2 minutes, longer than the heal waited.
describe("BunkerWeb's own verdict (v1.20.1)", () => {
	const REFUSAL =
		'BunkerWeb\'s own config test failed ("modsecurity_rules_file" directive Rule id: 1990001 is duplicated), so it kept serving its previous config';
	it('a refused config is rolled back at once, with nginx’s own reason — not after the whole budget', async () => {
		const s = morphitIo();
		const envBefore = readFileSync(s.path('bunkerweb.env'), 'utf8');
		s.verdict = (ms) => (ms < 15_000 ? { kind: 'pending' } : { kind: 'refused', reason: REFUSAL });
		const out = await s.run();
		expect(out.kind).toBe('rolled-back');
		expect((out as { reason: string }).reason).toBe(REFUSAL);
		expect(s.warn.join(' ')).toContain('Rule id: 1990001 is duplicated');
		// stopped waiting as soon as the verdict came, far inside the budget
		expect(s.lastCallAt - s.start).toBeLessThan(HEAL_BUDGET_MS - 20_000);
		expect(readFileSync(s.path('bunkerweb.env'), 'utf8')).toBe(envBefore);
	});
	it('a two-minute rebuild (morphitir) is waited for when the budget allows it, then verified', async () => {
		const s = morphitIo();
		s.verdict = (ms) => (ms < 116_000 ? { kind: 'pending' } : { kind: 'loaded' });
		const out = await s.run({ budgetMs: 15 * 60_000, rollbackReserveMs: 180_000 });
		expect(out.kind).toBe('applied');
	});
	it('the same rebuild inside the in-upgrade budget is NOT called applied while BunkerWeb is still building', async () => {
		const s = morphitIo();
		const envBefore = readFileSync(s.path('bunkerweb.env'), 'utf8');
		s.verdict = (ms) => (ms < 116_000 ? { kind: 'pending' } : { kind: 'loaded' });
		const out = await s.run();
		expect(out.kind).toBe('rolled-back');
		expect((out as { reason: string }).reason).toMatch(/still rebuilding its settings/);
	});
});

describe("each clearnet visitor's own rate-limit bucket: BunkerWeb → the frontend's edge listener (wave 5)", () => {
	it('finds the edge port in what the frontend serves (and only if nginx listens there)', () => {
		expect(frontendEdgePort(SERVED_OK)).toBe(8088);
		expect(frontendEdgePort(SERVED_NO_EDGE)).toBeNull();
		expect(frontendEdgePort(dumpOf(SHIPPED_FE.replace('"8088:1"', '"9999:1"')))).toBeNull();
	});
	it('re-points only a REVERSE_PROXY_HOST that sends to this frontend on :80 (multisite keys too)', () => {
		const env =
			'REVERSE_PROXY_HOST=http://frontend:80\nmorphit.io_REVERSE_PROXY_HOST=http://bunkerweb-frontend-1\nother.org_REVERSE_PROXY_HOST=http://10.0.0.5:80\n';
		const p = planBunkerwebEnv(env, {
			edgeTarget: { hosts: ['frontend', 'bunkerweb-frontend-1'], port: 8088 }
		});
		expect(p.text).toContain('REVERSE_PROXY_HOST=http://frontend:8088\n');
		expect(p.text).toContain('morphit.io_REVERSE_PROXY_HOST=http://bunkerweb-frontend-1:8088\n');
		expect(p.text).toContain('other.org_REVERSE_PROXY_HOST=http://10.0.0.5:80\n');
	});
	it('a frontend on the old config is rebuilt first, then BunkerWeb is switched — in the same run, checked', async () => {
		const s = oldBox();
		s.served = SERVED_NO_EDGE;
		const out = await s.run();
		expect(out.forwarding).toBe('refreshed');
		expect(out.kind).toBe('applied');
		expect(readFileSync(s.path('bunkerweb.env'), 'utf8')).toMatch(
			/^REVERSE_PROXY_HOST=http:\/\/frontend:8088$/m
		);
		expect(s.silent).toEqual([]);
	});
	it('a frontend that still has no edge listener: BunkerWeb stays on :80, a calm note, and the warning names the file it really loads', async () => {
		const s = sim({
			files: { 'docker-compose.yml': OLD_COMPOSE, 'bunkerweb.env': OLD_ENV },
			composeFiles: ['docker-compose.yml'],
			containers: [
				{
					name: 'bunkerweb',
					service: 'bunkerweb',
					image: 'bunkerity/bunkerweb:1.5.10',
					ports: ['0.0.0.0:443->8443/tcp']
				},
				{
					name: 'morphit-frontend',
					service: 'frontend',
					image: 'fe',
					mounts: [BUILD],
					binds: [
						{ source: BUILD, destination: '/usr/share/nginx/html' },
						{
							source: '/opt/bunkerweb/nginx/morphit.conf',
							destination: '/etc/nginx/conf.d/morphit.conf'
						}
					]
				}
			]
		});
		s.served = SERVED_NO_EDGE;
		s.servedAfterRefresh = SERVED_NO_EDGE;
		const out = await s.run();
		expect(out.forwarding).toBe('stale');
		expect(readFileSync(s.path('bunkerweb.env'), 'utf8')).toMatch(
			/^REVERSE_PROXY_HOST=http:\/\/frontend:80$/m
		);
		expect(s.warn.join(' ')).toMatch(
			/It loads \/opt\/bunkerweb\/nginx\/morphit\.conf, not this release's \/opt\/morphit\/ops\/bunkerweb\/frontend\/nginx\.conf/
		);
		expect(s.info.join(' ')).toMatch(/BunkerWeb keeps sending to the frontend's port 80/);
	});
	it('BunkerWeb cannot reach the edge port after the switch → rolled back byte for byte', async () => {
		const s = oldBox();
		s.edgePortUnreachable = true;
		const out = await s.run();
		expect(out.kind).toBe('rolled-back');
		expect((out as { reason: string }).reason).toMatch(/the site does not answer/);
		expect(readFileSync(s.path('bunkerweb.env'), 'utf8')).toBe(OLD_ENV);
	});
	it('a REVERSE_PROXY_HOST that is not recognisably this frontend is left alone, with a note', async () => {
		const s = oldBox(OLD_ENV.replace('http://frontend:80', 'http://10.0.0.5:80'));
		await s.run();
		expect(readFileSync(s.path('bunkerweb.env'), 'utf8')).toMatch(
			/^REVERSE_PROXY_HOST=http:\/\/10\.0\.0\.5:80$/m
		);
		expect(s.info.join(' ')).toMatch(/not recognisably this frontend/);
	});
	it('no SERVER_NAME to probe the site with: not switched, a note', async () => {
		const s = oldBox(OLD_ENV.replace('SERVER_NAME=example.org\n', ''));
		await s.run();
		expect(readFileSync(s.path('bunkerweb.env'), 'utf8')).toMatch(
			/^REVERSE_PROXY_HOST=http:\/\/frontend:80$/m
		);
		expect(s.info.join(' ')).toMatch(/no SERVER_NAME/);
	});
	it('a site that already fails before the change: not switched', async () => {
		const s = oldBox();
		s.c.get('bunkerweb')!.env = ['REVERSE_PROXY_HOST=http://frontend:9'];
		await s.run();
		expect(readFileSync(s.path('bunkerweb.env'), 'utf8')).toMatch(
			/^REVERSE_PROXY_HOST=http:\/\/frontend:80$/m
		);
		expect(s.info.join(' ')).toMatch(/did not answer cleanly before any change/);
	});
});

describe('a tor-only box (frontend only, no BunkerWeb)', () => {
	it('bounds the frontend log and makes no header probe', async () => {
		const tor = OLD_COMPOSE.replace(/  bunkerweb:[\s\S]*?\n\n/, '');
		const s = sim({
			files: { 'docker-compose.yml': tor },
			composeFiles: ['docker-compose.yml'],
			containers: [{ name: 'morphit-frontend', service: 'frontend', image: 'fe', mounts: [BUILD] }]
		});
		let probed = false;
		s.rt = { ...s.rt, edgeProbe: () => ((probed = true), null) };
		const out = await s.run();
		expect(out.kind).toBe('applied');
		expect(s.c.get('morphit-frontend')!.logDriver).toBe('local');
		expect(probed).toBe(false);
		expect(s.ups.map((u) => u.services)).toEqual([['frontend']]);
	});
	it('does nothing where no container serves the site', async () => {
		const s = sim({
			files: { 'docker-compose.yml': OLD_COMPOSE },
			composeFiles: ['docker-compose.yml'],
			containers: []
		});
		expect((await s.run()).kind).toBe('no-proxy');
		expect(s.ups).toEqual([]);
	});
});

describe('the frontend answers a missing file with 404, not the app page (v1.20.2)', () => {
	it('reads it from what nginx serves: the release config does, the v1.20.1 one does not', () => {
		expect(no404(SHIPPED_FE)).not.toBe(SHIPPED_FE);
		expect(no404(SHIPPED_FE)).not.toContain('/.well-known/');
		expect(frontendFileMissesAre404(SERVED_OK)).toBe(true);
		expect(frontendFileMissesAre404(SERVED_NO_404)).toBe(false);
		// The location alone is not enough: it must 404 a miss.
		expect(
			frontendFileMissesAre404(
				SERVED_OK.replace(
					/(location \^~ \/\.well-known\/ \{[\s\S]*?)try_files \$uri =404;/,
					'$1try_files $uri /index.html;'
				)
			)
		).toBe(false);
	});
	it('an otherwise current frontend without it is rebuilt from the release once, and says so', async () => {
		const s = oldBox();
		s.served = SERVED_NO_404;
		const out = await s.run();
		expect(out.forwarding).toBe('refreshed');
		expect(s.refreshes).toBe(1);
		const info = s.info.join(' ');
		expect(info).toMatch(/missing file.*404/);
		expect(info).not.toMatch(/one address/);
		expect(s.silent).toEqual([]);
	});
	it('a zero-clearnet box (frontend only, no BunkerWeb — Tor/I2P reach it directly) is rebuilt too', async () => {
		const s = sim({
			files: {
				'docker-compose.yml':
					'services:\n  frontend:\n    image: fe\n    ports:\n      - "127.0.0.1:8090:80"\n'
			},
			composeFiles: ['docker-compose.yml'],
			containers: [{ name: 'morphit-frontend', service: 'frontend', image: 'fe', mounts: [BUILD] }]
		});
		s.served = SERVED_NO_404;
		const out = await s.run();
		expect(out.forwarding).toBe('refreshed');
		expect(s.refreshes).toBe(1);
		expect(s.info.join(' ')).toMatch(/missing file.*404/);
	});
	it('still without it after the rebuild: a calm warning naming it, with the command', async () => {
		const s = oldBox();
		s.served = SERVED_NO_404;
		s.servedAfterRefresh = SERVED_NO_404;
		const out = await s.run();
		expect(out.forwarding).toBe('stale');
		const w = s.warn.join(' ');
		expect(w).toMatch(/missing file/);
		expect(w).toContain('up -d --no-deps --build --force-recreate frontend');
	});
});

describe('the frontend REALLY sends one address to the indexer (served config, not the file)', () => {
	it('the shipped frontend config passes; each indexer/relay location that loses the header fails, by name', () => {
		expect(frontendForwardsOneAddress(SERVED_OK)).toEqual({ proxied: 6, missing: [] });
		expect(frontendForwardsOneAddress(SERVED_STALE).missing).toEqual(['/v1/']);
		for (const loc of [
			'/v1/broadcast',
			'/v1/federation',
			'~ ^/v1/.*/stream$',
			'/rss/',
			'/relay/'
		]) {
			const esc = loc.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
			const cut = SHIPPED_FE.replace(
				new RegExp(`(location ${esc} \\{[\\s\\S]*?)proxy_set_header X-Real-IP "";`),
				'$1'
			);
			expect(cut).not.toBe(SHIPPED_FE);
			expect(frontendForwardsOneAddress(dumpOf(cut)).missing).toEqual([loc]);
		}
		const inherited = `server {\n  proxy_set_header X-Forwarded-For $morphit_relay_xff;\n  proxy_set_header X-Real-IP "";\n  location /v1/ { proxy_pass http://host.docker.internal:8081; }\n}`;
		expect(frontendForwardsOneAddress(inherited)).toEqual({ proxied: 1, missing: [] });
		const shadowed = inherited.replace('8081;', '8081; proxy_set_header Host $host;');
		expect(frontendForwardsOneAddress(shadowed).missing).toEqual(['/v1/']);
		expect(
			frontendForwardsOneAddress(
				SERVED_OK.replace(
					/(location \/rss\/ \{[\s\S]*?)(proxy_set_header X-Forwarded-For)/,
					'$1# $2'
				)
			).missing
		).toEqual(['/rss/']);
	});
	it('a box that serves the current config: checked, nothing rebuilt', async () => {
		const s = oldBox();
		const out = await s.run();
		expect(out.forwarding).toBe('ok');
		expect(s.refreshes + s.reloads).toBe(0);
		const again = await s.run();
		expect(again.kind).toBe('already');
		expect(again.forwarding).toBe('ok');
	});
	it('a frontend still serving the old forwarding is rebuilt from the release ONCE and then verified', async () => {
		const s = oldBox();
		s.served = SERVED_STALE;
		const out = await s.run();
		expect(out.forwarding).toBe('refreshed');
		expect(s.refreshes).toBe(1);
		expect(s.info.join(' ')).toMatch(/one address/);
		expect(s.silent).toEqual([]);
	});
	it('still stale after the rebuild: a calm warning with the exact command', async () => {
		const s = oldBox();
		s.served = SERVED_STALE;
		s.servedAfterRefresh = SERVED_STALE;
		const out = await s.run();
		expect(out.kind).toBe('applied');
		expect(out.forwarding).toBe('stale');
		expect(s.refreshes).toBe(1);
		const w = s.warn.join(' ');
		expect(w).toMatch(/\/v1\//);
		expect(w).toContain(
			`-f ${s.path('docker-compose.yml')} up -d --no-deps --build --force-recreate frontend`
		);
		expect(w).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
	});
	it('no time left for a rebuild: the command, no rebuild', async () => {
		const s = oldBox();
		s.served = SERVED_STALE;
		const out = await s.run({ budgetMs: 50_000 });
		expect(out.forwarding).toBe('stale');
		expect(s.refreshes).toBe(0);
	});
	it('a config file newer than the running nginx is loaded with a graceful reload', async () => {
		const s = oldBox();
		await s.run();
		s.newerThanStart = true;
		const out = await s.run();
		expect(out.forwarding).toBe('ok');
		expect(s.reloads).toBe(1);
		expect(s.refreshes).toBe(0);
	});
	it('cannot read the served config: skipped quietly', async () => {
		const s = oldBox();
		s.served = null;
		const out = await s.run();
		expect(out.forwarding).toBe('unknown');
		expect(s.refreshes).toBe(0);
		expect(s.warn).toEqual([]);
	});
});

// v1.21.1 review: a country list that reaches BunkerWeb another way (a compose
// `environment:` entry this heal does not edit) failed the check of the heal's
// own changes, so every upgrade put all of them back.
describe('a country list this heal cannot edit', () => {
	it('the privacy changes are applied and kept; the list is named with what to do', async () => {
		const s = oldBox();
		const gen = s.generated.bind(s);
		s.generated = (x) => `${gen(x)}\nshop.example.org_BLACKLIST_COUNTRY=CN`;
		for (const [n, x] of s.c)
			if (/bunkerity\/bunkerweb:/.test(x.image)) s.edgeSettings.set(n, s.generated(x));
		const out = await s.run();
		expect(out.kind).toBe('applied');
		expect(s.warn.join(' ')).toMatch(/country list \(shop\.example\.org_BLACKLIST_COUNTRY=CN\)/);
		const again = await s.run();
		expect(again.kind).toBe('left-alone');
		expect('reason' in again ? again.reason : '').toMatch(/No Morphit instance blocks by country/);
	});
});

describe('BunkerWeb stops sending visitor data to third parties', () => {
	const PRIVACY = [
		'USE_BUNKERNET=no',
		'USE_DNSBL=no',
		'USE_BLACKLIST=no',
		'USE_WHITELIST=no',
		'SEND_ANONYMOUS_REPORT=no'
	];
	const runs = (s: Sim, name: string): string[] => s.edgeSettings.get(name)!.split('\n');
	it('an installed box: every disclosing feature off, live in what BunkerWeb runs with', async () => {
		const s = oldBox();
		expect(runs(s, 'bunkerweb')).toContain('USE_BUNKERNET=yes'); // the 1.5.10 default
		const out = await s.run();
		expect(out.kind).toBe('applied');
		const env = readFileSync(s.path('bunkerweb.env'), 'utf8');
		for (const kv of PRIVACY) {
			expect(env.split('\n')).toContain(kv);
			expect(s.c.get('bunkerweb')!.env).toContain(kv);
			expect(runs(s, 'bunkerweb')).toContain(kv);
		}
		expect(runs(s, 'bunkerweb')).toContain('USE_GREYLIST=no');
		expect(s.info.join('\n')).toMatch(/Seen in the settings BunkerWeb runs with/);
		expect(s.warn).toEqual([]);
		expect((await s.run()).kind).toBe('already');
	});
	it("morphit.io's stack: the scheduler (which runs the BunkerNet and report jobs) gets them too", async () => {
		const s = morphitIo('source: docker\ncontainer_name:\n  - bunkerweb-db-1\n');
		const out = await s.run();
		expect(out.kind).toBe('applied');
		for (const kv of PRIVACY) {
			expect(s.c.get('bunkerweb-bw-scheduler-1')!.env).toContain(kv);
			expect(runs(s, 'bunkerweb-bunkerweb-1')).toContain(kv);
		}
	});
	it('values set to "yes" (as OPERATIONS once advised for USE_DNSBL) are turned off, every line', async () => {
		const s = oldBox(`${OLD_ENV}USE_DNSBL=yes\nUSE_BUNKERNET=yes\nUSE_DNSBL="yes"\n`);
		expect((await s.run()).kind).toBe('applied');
		const env = readFileSync(s.path('bunkerweb.env'), 'utf8');
		expect(env).not.toMatch(/^USE_(DNSBL|BUNKERNET)=("?)yes\2$/m);
		expect(runs(s, 'bunkerweb')).toContain('USE_DNSBL=no');
	});
	it('a scheduler that never brings the new settings live: not reported as done, the previous file back', async () => {
		const s = oldBox();
		s.settingsFrozen = true;
		const before = readFileSync(s.path('bunkerweb.env'));
		const out = await s.run();
		expect(out.kind).toBe('rolled-back');
		expect(s.warn.join(' ')).toMatch(/BunkerWeb still runs with USE_BUNKERNET=yes/);
		expect(readFileSync(s.path('bunkerweb.env')).equals(before)).toBe(true);
	});
	it("BunkerWeb's generated settings unreadable: checked in the containers' environment, and said so", async () => {
		const s = oldBox();
		s.settingsReadable = false;
		expect((await s.run()).kind).toBe('applied');
		expect(s.info.join('\n')).toMatch(/containers' environment/);
	});
	it('anti-bot: a third-party challenge or one on a live path goes off; a dedicated local one stays', async () => {
		const a = oldBox(`${OLD_ENV}USE_ANTIBOT=captcha\nANTIBOT_URI=/relay/v1/account/invite\n`);
		await a.run();
		expect(runs(a, 'bunkerweb')).toContain('USE_ANTIBOT=no');
		const b = oldBox(`${OLD_ENV}USE_ANTIBOT=turnstile\nANTIBOT_URI=/__antibot\n`);
		await b.run();
		expect(runs(b, 'bunkerweb')).toContain('USE_ANTIBOT=no');
		const c = oldBox(`${OLD_ENV}USE_ANTIBOT=cookie\nANTIBOT_URI=/__antibot\n`);
		await c.run();
		expect(runs(c, 'bunkerweb')).toContain('USE_ANTIBOT=cookie');
	});
});

describe('the frontend sends a strict page CSP, hides its version and drops visitor-set internal headers', () => {
	/** The frontend before this release: inline script and eval allowed, the
	 *  nginx version shown, internal headers passed through. */
	const loose = (conf: string): string =>
		conf
			.replace(
				/script-src 'self' 'wasm-unsafe-eval'/g,
				"script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'"
			)
			.replace(/\n\s*server_tokens off;/g, '')
			.replace(/\n\s*proxy_set_header (X-Morphit-Local-Health|X-I2P-Dest(B64|B32|Hash)) "";/g, '');
	const SERVED_LOOSE = dumpOf(loose(SHIPPED_FE));
	it('reads it from what nginx serves: the release config passes, the older one fails each part', () => {
		expect(loose(SHIPPED_FE)).not.toBe(SHIPPED_FE);
		expect(frontendCspStrict(SERVED_OK)).toBe(true);
		expect(frontendHidesInternals(SERVED_OK)).toEqual({ tokensOff: true, uncleared: [] });
		expect(frontendCspStrict(SERVED_LOOSE)).toBe(false);
		const h = frontendHidesInternals(SERVED_LOOSE);
		expect(h.tokensOff).toBe(false);
		expect(h.uncleared).toContain('/relay/');
		expect(h.uncleared).toContain('/v1/');
		// one header missing in one location is enough to fail, by name
		const one = SHIPPED_FE.replace(
			/(location \/relay\/ \{[\s\S]*?)\n\s*proxy_set_header X-I2P-DestB32 "";/,
			'$1'
		);
		expect(one).not.toBe(SHIPPED_FE);
		expect(frontendHidesInternals(dumpOf(one)).uncleared).toEqual(['/relay/']);
	});
	it('an older frontend is rebuilt from the release once, and says so', async () => {
		const s = oldBox();
		s.served = SERVED_LOOSE;
		const out = await s.run();
		expect(out.forwarding).toBe('refreshed');
		expect(s.refreshes).toBe(1);
		const info = s.info.join(' ');
		expect(info).toMatch(/no inline script and no eval/);
		expect(info).toMatch(/hides its nginx version/);
		expect(s.silent).toEqual([]);
	});
	it('still loose after the rebuild: a calm warning naming what, with the command', async () => {
		const s = oldBox();
		s.served = SERVED_LOOSE;
		s.servedAfterRefresh = SERVED_LOOSE;
		const out = await s.run();
		expect(out.forwarding).toBe('stale');
		const w = s.warn.join(' ');
		expect(w).toMatch(/inline script and eval/);
		expect(w).toMatch(/nginx version/);
		expect(w).toContain('up -d --no-deps --build --force-recreate frontend');
	});
	it("BunkerWeb's env: an older Morphit CSP is replaced, an operator's own is kept", () => {
		const older = MORPHIT_CSP.replace(
			"script-src 'self' 'wasm-unsafe-eval'",
			"script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'"
		).replace("connect-src 'self'", "connect-src 'self' https://rpc.blurt.one");
		expect(isMorphitCsp(older)).toBe(true);
		const p = planBunkerwebEnv(`CONTENT_SECURITY_POLICY=${older}\n`);
		expect(p.text).toContain(`CONTENT_SECURITY_POLICY=${MORPHIT_CSP}\n`);
		expect(p.text).not.toContain("'unsafe-eval'");
		const own = `${MORPHIT_CSP.replace("img-src 'self' data: blob:", "img-src 'self' data: blob: https://img.example.org")}`;
		expect(isMorphitCsp(own)).toBe(false);
		expect(planBunkerwebEnv(`CONTENT_SECURITY_POLICY=${own}\n`).text).toContain(
			`CONTENT_SECURITY_POLICY=${own}\n`
		);
	});
});

describe("the frontend is built from this release's pinned nginx base", () => {
	const DOCKERFILE = readFileSync(join(REPO, 'ops/bunkerweb/frontend/Dockerfile'), 'utf8');
	it('the Dockerfile pins the base by digest and labels it with the value the heal expects', () => {
		expect(DOCKERFILE).toMatch(
			new RegExp(`^FROM ${FRONTEND_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm')
		);
		expect(DOCKERFILE).toContain(`LABEL org.morphit.frontend-base="${FRONTEND_BASE}"`);
		expect(FRONTEND_BASE).toMatch(/@sha256:[0-9a-f]{64}$/);
	});
	it('only a Dockerfile Morphit shipped (this one or an earlier `FROM nginx:alpine` one) is replaced on a rebuild', () => {
		expect(isMorphitFrontendDockerfile(DOCKERFILE)).toBe(true);
		const older = DOCKERFILE.replace(/^FROM .*$/m, 'FROM nginx:alpine').replace(/^LABEL .*\n/m, '');
		expect(isMorphitFrontendDockerfile(older)).toBe(true);
		expect(isMorphitFrontendDockerfile(`${older}RUN apk add curl\n`)).toBe(false);
		expect(
			isMorphitFrontendDockerfile(
				older.replace('FROM nginx:alpine', 'FROM openresty/openresty:alpine')
			)
		).toBe(false);
	});
	it('a frontend built from an older base is rebuilt once, and says so', async () => {
		const s = oldBox();
		s.feBase = '';
		const out = await s.run();
		expect(out.forwarding).toBe('refreshed');
		expect(s.refreshes).toBe(1);
		expect(s.info.join(' ')).toMatch(
			/pinned base image \(nginx:1\.30\.5-alpine, label read back\)/
		);
	});
	it('still on an older base after the rebuild: a calm warning with the command', async () => {
		const s = oldBox();
		s.feBase = '';
		s.feBaseAfterRefresh = '';
		const out = await s.run();
		expect(out.forwarding).toBe('stale');
		expect(s.warn.join(' ')).toMatch(/older nginx base image/);
	});
	it("a frontend a rebuild cannot re-base (the operator's own Dockerfile, or an image-only service): not judged on it, not rebuilt for it", async () => {
		const s = oldBox();
		s.feBase = '';
		s.feBaseAfterRefresh = '';
		s.fePinnable = false;
		const out = await s.run();
		expect(out.forwarding).toBe('ok');
		expect(s.refreshes).toBe(0);
		expect(s.warn).toEqual([]);
	});
	it('a hidden-only node without the base image and without Docker over Tor: not rebuilt for the base (no Docker Hub pull), and said calmly', async () => {
		const s = oldBox();
		s.feBase = '';
		s.hidden = true;
		const out = await s.run();
		expect(out.forwarding).toBe('ok');
		expect(s.refreshes).toBe(0);
		expect(s.warn).toEqual([]);
	});
	it('a hidden-only node whose offline bundle carries the base: it is loaded, then the rebuild uses it', async () => {
		const s = oldBox();
		s.feBase = '';
		s.hidden = true;
		s.bundledBase = true;
		const out = await s.run();
		expect(s.loads).toBe(1);
		expect(out.forwarding).toBe('refreshed');
		expect(s.refreshWithBase).toEqual([true]);
	});
	it('a hidden-only node whose Docker pulls through Tor: rebuilt on the pinned base', async () => {
		const s = oldBox();
		s.feBase = '';
		s.hidden = true;
		s.torPulls = true;
		expect((await s.run()).forwarding).toBe('refreshed');
		expect(s.refreshWithBase).toEqual([true]);
	});
	it('a hidden-only node that needs a rebuild for its config but cannot get the base: rebuilt WITHOUT the new base', async () => {
		const s = oldBox();
		s.feBase = '';
		s.feBaseAfterRefresh = '';
		s.hidden = true;
		s.served = SERVED_STALE;
		await s.run();
		expect(s.refreshes).toBe(1);
		expect(s.refreshWithBase).toEqual([false]);
	});
	it('the label cannot be read: not judged on it', async () => {
		const s = oldBox();
		s.feBase = null;
		expect((await s.run()).forwarding).toBe('ok');
	});
});

// keep the simulator honest: its `docker inspect` state stays parseable
it('the simulator writes nothing outside its temp dir', () => {
	expect(readdirSync(tmpdir()).some((f) => f === 'docker-compose.yml')).toBe(false);
});
