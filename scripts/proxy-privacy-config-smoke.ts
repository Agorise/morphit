/**
 * proxy-privacy-config-smoke (v1.20.0 deep review: C1, C7, C14, B11).
 *
 * The shipped reverse-proxy configs must not keep visitor addresses, must give
 * the indexer one trustworthy client address, must cache like web.conf, and
 * must reach the host through the pinned bridge:
 *
 *  A. every `server` block of every shipped nginx config turns the access log
 *     off at SERVER level (C1 — a location-level `access_log off` left the rest
 *     of the site logging each visitor's address to disk);
 *  B. both BunkerWeb env files set a LOG_FORMAT that names no client address,
 *     single-quoted so `docker compose` cannot substitute its $variables away
 *     (read here with compose's own rule: only single quotes keep `$` literal);
 *  C. both compose files: the public edge (bunkerweb) keeps no Docker log, the
 *     frontend's is bounded, host.docker.internal is the pinned bridge gateway
 *     (not docker0's host-gateway), the subnet is pinned (B11);
 *  D. every frontend location that proxies to the indexer sends ONE
 *     X-Forwarded-For value from the $morphit_relay_xff map and clears
 *     X-Real-IP (C7 — the indexer used to see one shared bucket, or a value the
 *     visitor typed);
 *  E. cache policy: hashed bundles immutable, pages (incl. the @spa fallback)
 *     no-cache, in the frontend config AND web.conf, with one Cache-Control
 *     header only (C14); and every live stream the browser holds open (the
 *     sign-in pairing wait too) is relayed with proxy buffering off, in the
 *     frontend config, web.conf and indexer.conf;
 *  F. BEHAVIOUR, when an `nginx` binary is present: the frontend config, run
 *     under the official nginx image's own top-level config (which logs
 *     "$http_x_forwarded_for"), writes NOTHING to the access log, forwards the
 *     proxy's address instead of a forged X-Forwarded-For, sends no X-Real-IP,
 *     and serves the headers/caching above, and passes a live stream's
 *     `X-Accel-Buffering: no` on to the edge (BunkerWeb buffers otherwise —
 *     v1.21.14, chat a minute late). Skipped (and said so) without nginx.
 *     A clearnet, an .onion and an I2P request (exactly as i2pd forwards it)
 *     all get the SAME page CSP, whose connect-src is 'self' alone: since
 *     v1.21.14 the browser contacts nothing but this site, on every name.
 *  G. I2P visitors are recognised by their Host (wave 4). i2pd's HTTP server
 *     tunnel passes the visitor's Host through unchanged UNLESS `hostoverride`
 *     is set (I2PTunnel.cpp, I2PServerTunnelConnectionHTTP::Write, the same in
 *     2.40.0, 2.45.1, 2.49.0 and master: m_Host = hostoverride, default "",
 *     "forward as is"), and the visitor's i2pd HTTP proxy sets
 *     `Host: <dest>.i2p` (HTTPProxy.cpp). Both tunnel definitions Morphit writes
 *     (the Ansible role and ops-cli's i2pTunnelStanza) stay `type = http`
 *     without a hostoverride. The page CSP no longer depends on the Host
 *     (v1.21.14: one policy, connect-src 'self', for every name), and G checks
 *     that too: every entry of the frontend's `$host` CSP map is that policy.
 *
 * MORPHIT_PROXY_CONF_ROOT=<dir containing ops/…> runs it against another tree
 * (e.g. an older release) to watch it fail.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { addHeaders, direct, findBlocks, parseNginx, type NginxDirective } from './lib/nginx-conf';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.env.MORPHIT_PROXY_CONF_ROOT ?? REPO;
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

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

const FRONTEND = 'ops/bunkerweb/frontend/nginx.conf';
/** The sources a CSP lets the browser connect to: connect-src, or default-src
 *  when connect-src is absent (the browser's own fallback). Null: neither. */
const connectSources = (csp: string): string[] | null => {
	const dirs = new Map(
		csp
			.split(';')
			.map((d) => d.trim().split(/\s+/))
			.filter((t) => t[0])
			.map((t) => [t[0]!.toLowerCase(), t.slice(1)] as const)
	);
	return dirs.get('connect-src') ?? dirs.get('default-src') ?? null;
};
const sameOnly = (src: string[] | null): boolean => src?.length === 1 && src[0] === "'self'";
const NGINX_CONFS = [
	FRONTEND,
	'ops/nginx/web.conf',
	'ops/nginx/indexer.conf',
	'ops/nginx/relay.conf'
];
const BW_ENVS = [
	'ops/bunkerweb/bunkerweb.env.example',
	'ops/ansible/roles/bunkerweb/templates/bunkerweb.env.j2'
];
const COMPOSES = [
	'ops/bunkerweb/docker-compose.yml',
	'ops/ansible/roles/bunkerweb/templates/docker-compose.yml.j2'
];
const ADDRESS_VARS =
	/\$(remote_addr|binary_remote_addr|http_x_forwarded_for|http_x_real_ip|realip_remote_addr|proxy_add_x_forwarded_for)\b/;

console.log('\n── proxy-privacy-config smoke ───────────────────────────\n');

// ── A. access_log off at server level ──
for (const rel of NGINX_CONFS) {
	const servers = findBlocks(parseNginx(read(rel)), 'server');
	const bad = servers
		.map((s, i) => ({ i, off: direct(s.block, 'access_log').some((d) => d.args[0] === 'off') }))
		.filter((x) => !x.off);
	check(
		`${rel}: all ${servers.length} server block(s) turn the access log off at server level`,
		servers.length > 0 && bad.length === 0,
		`server block(s) #${bad.map((b) => b.i + 1).join(', #')} log visitors`
	);
}

// ── B. BunkerWeb LOG_FORMAT ──
/** compose's env_file rule for one value: single quotes keep `$` literal; an
 *  unquoted or double-quoted value has its $vars substituted (to '' here). */
function composeEnvValue(text: string, key: string): string | null {
	const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
	if (!m) return null;
	const raw = m[1]!.trim();
	if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) return raw.slice(1, -1);
	const body = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
	return body.replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, '');
}
for (const rel of BW_ENVS) {
	const v = composeEnvValue(read(rel), 'LOG_FORMAT');
	check(`${rel}: LOG_FORMAT is set (BunkerWeb's default starts with $remote_addr)`, v !== null);
	if (v !== null) {
		check(`${rel}: LOG_FORMAT names no client address`, !ADDRESS_VARS.test(v), v);
		check(
			`${rel}: LOG_FORMAT survives compose's $-substitution (still has $time_local after loading)`,
			v.includes('$time_local') && v.includes('$status'),
			`loads as: ${JSON.stringify(v)}`
		);
	}
}

// ── C. compose: logging, host.docker.internal, pinned subnet ──
function loadCompose(rel: string): Record<string, any> {
	// The .j2 is a Jinja template: drop control lines, stand in for expressions.
	const text = read(rel)
		.split('\n')
		.filter((l) => !/^\s*\{%.*%\}\s*$/.test(l))
		.join('\n')
		.replace(/\{\{[^}]*\}\}/g, 'X');
	return yaml.load(text) as Record<string, any>;
}
for (const rel of COMPOSES) {
	const c = loadCompose(rel);
	const svc = c.services ?? {};
	check(
		`${rel}: bunkerweb keeps no Docker log (driver none)`,
		svc.bunkerweb?.logging?.driver === 'none',
		JSON.stringify(svc.bunkerweb?.logging ?? null)
	);
	const fe = svc.frontend?.logging;
	check(
		`${rel}: frontend's Docker log is off or bounded`,
		fe?.driver === 'none' ||
			(fe?.driver === 'local' && typeof fe?.options?.['max-size'] === 'string'),
		JSON.stringify(fe ?? null)
	);
	for (const name of ['bunkerweb', 'frontend']) {
		const hosts: string[] = (svc[name]?.extra_hosts ?? []).map(String);
		check(
			`${rel}: ${name} maps host.docker.internal to the bunkerweb_net gateway 172.20.0.1`,
			hosts.includes('host.docker.internal:172.20.0.1') &&
				!hosts.some((h) => h.includes('host-gateway')),
			hosts.join(', ')
		);
	}
	const subnet = c.networks?.bunkerweb_net?.ipam?.config?.[0]?.subnet;
	check(
		`${rel}: bunkerweb_net subnet pinned to 172.20.0.0/16`,
		subnet === '172.20.0.0/16',
		String(subnet)
	);
}

// ── D. frontend → indexer client address ──
const fe = parseNginx(read(FRONTEND));
const feServer = findBlocks(fe, 'server')[0];
const locations = findBlocks(feServer?.block ?? [], 'location');
const indexerLocs = locations.filter((l) =>
	direct(l.block, 'proxy_pass').some((d) => /:8081\b/.test(d.args[0] ?? ''))
);
check(
	'frontend: found the indexer-bound locations',
	indexerLocs.length >= 5,
	`${indexerLocs.length}`
);
for (const l of indexerLocs) {
	const psh = new Map(
		direct(l.block, 'proxy_set_header').map((d) => [(d.args[0] ?? '').toLowerCase(), d.args[1]])
	);
	check(
		`frontend location ${l.args.join(' ')}: X-Forwarded-For = $morphit_relay_xff, X-Real-IP cleared`,
		psh.get('x-forwarded-for') === '$morphit_relay_xff' && psh.get('x-real-ip') === '',
		`XFF=${psh.get('x-forwarded-for')} X-Real-IP=${JSON.stringify(psh.get('x-real-ip'))}`
	);
}

// ── E. cache policy ──
function loc(tree: NginxDirective[], ...args: string[]): NginxDirective | undefined {
	return findBlocks(tree, 'location').find((l) => l.args.join(' ') === args.join(' '));
}
for (const rel of [FRONTEND, 'ops/nginx/web.conf']) {
	const t = parseNginx(read(rel));
	const imm = loc(t, '/_app/immutable/');
	const cc = (l: NginxDirective | undefined) =>
		direct(l?.block ?? null, 'add_header').filter(
			(d) => (d.args[0] ?? '').toLowerCase() === 'cache-control'
		);
	check(
		`${rel}: /_app/immutable/ is cached immutable, with ONE Cache-Control header`,
		cc(imm).length === 1 &&
			/immutable/.test(cc(imm)[0]?.args[1] ?? '') &&
			direct(imm?.block ?? null, 'expires').length === 0,
		imm
			? JSON.stringify(cc(imm).map((d) => d.args[1])) +
					(direct(imm.block, 'expires').length ? ' + expires' : '')
			: 'no such location'
	);
	for (const name of ['/', '@spa']) {
		const l = loc(t, name);
		check(
			`${rel}: location ${name} (pages) is served no-cache`,
			cc(l).some((d) => d.args[1] === 'no-cache'),
			l ? 'no no-cache header' : 'no such location'
		);
	}
}

// ── E2. live streams are relayed unbuffered ──
// The paths the browser holds open (chat, inbox, orderbook, instance
// directory, and the sign-in pairing wait): in every server that serves /v1/,
// the location nginx picks for each (the first matching regex, else /v1/) must
// turn proxy buffering off, or events arrive late, in batches.
const STREAM_PATHS = [
	'/v1/chat-activity/alice/stream',
	'/v1/chat/alice/bob/stream',
	'/v1/orderbook/stream',
	'/v1/instances/stream',
	'/v1/login-pairing/p1/wait'
];
for (const rel of [FRONTEND, 'ops/nginx/web.conf', 'ops/nginx/indexer.conf']) {
	for (const server of findBlocks(parseNginx(read(rel)), 'server')) {
		const locs = (server.block ?? []).filter((d) => d.name === 'location');
		const prefix = locs.find((l) => l.args.length === 1 && l.args[0] === '/v1/');
		if (!prefix) continue;
		const regexes = locs.filter((l) => l.args[0] === '~' || l.args[0] === '~*');
		const buffered = STREAM_PATHS.filter((path) => {
			const l =
				regexes.find((r) =>
					new RegExp(r.args[1] ?? '', r.args[0] === '~*' ? 'i' : '').test(path)
				) ?? prefix;
			return !direct(l.block, 'proxy_buffering').some((d) => d.args[0] === 'off');
		});
		check(
			`${rel}: every live stream (incl. the sign-in pairing wait) is relayed unbuffered`,
			buffered.length === 0,
			buffered.join(', ')
		);
	}
}

async function main(): Promise<void> {
	// ── G. the i2pd tunnels leave the visitor's Host alone ──
	{
		/** i2pd's tunnels.conf: `[section]` + `key = value` (# and ; comment). */
		const sections = (ini: string): Map<string, Map<string, string>> => {
			const out = new Map<string, Map<string, string>>();
			let cur: Map<string, string> | null = null;
			for (const raw of ini.split('\n')) {
				const line = raw.replace(/[#;].*$/, '').trim();
				const sec = /^\[(.+)\]$/.exec(line);
				if (sec) out.set(sec[1]!, (cur = new Map()));
				else if (cur && line.includes('='))
					cur.set(
						line.slice(0, line.indexOf('=')).trim().toLowerCase(),
						line.slice(line.indexOf('=') + 1).trim()
					);
			}
			return out;
		};
		const passesHost = (label: string, ini: string): void => {
			const t = sections(ini).get('morphit-web');
			check(
				`G: ${label}: the I2P server tunnel forwards the visitor's Host (type = http, no hostoverride)`,
				t !== undefined && t.get('type') === 'http' && !t.has('hostoverride'),
				t ? JSON.stringify([...t]) : 'no [morphit-web] section'
			);
		};
		const tasks = yaml.load(read('ops/ansible/roles/i2pd/tasks/main.yml')) as Array<
			Record<string, unknown>
		>;
		const block = tasks
			.map((t) => t['ansible.builtin.blockinfile'] as { block?: string } | undefined)
			.find((b) => b?.block?.includes('[morphit-web]'))?.block;
		passesHost('the Ansible i2pd role', block ?? '');
		const gen = (await import(join(ROOT, 'apps/ops-cli/src/init/i2pGenerate.ts'))) as {
			i2pTunnelStanza: (keys: string, port: number) => string;
		};
		passesHost("ops-cli's i2pTunnelStanza", gen.i2pTunnelStanza('morphit-web.dat', 8090));
		const map = findBlocks(parseNginx(read(FRONTEND)), 'map').find(
			(m) => m.args[0] === '$host' && m.args[1] === '$morphit_csp'
		);
		const policies = (map?.block ?? []).map((d) => d.args.join(' ').replace(/^"|"$/g, ''));
		check(
			"G: the frontend's CSP is the same for every Host, and its connect-src is 'self' alone",
			policies.length > 0 &&
				policies.every((p) => p === policies[0]) &&
				sameOnly(connectSources(policies[0]!)),
			JSON.stringify(map?.block?.map((d) => [d.name, connectSources(d.args.join(' '))]))
		);
	}

	// ── F. behaviour on a real nginx ──
	const haveNginx = spawnSync('nginx', ['-v'], { encoding: 'utf8' }).status === 0;
	if (!haveNginx) {
		console.log('  (nginx not installed here — the behavioural scenarios are skipped)');
	} else {
		const work = mkdtempSync(join(tmpdir(), 'morphit-proxy-privacy-'));
		try {
			const html = join(work, 'html');
			mkdirSync(join(html, '_app', 'immutable'), { recursive: true });
			writeFileSync(join(html, 'index.html'), '<!doctype html><title>t</title>');
			writeFileSync(join(html, '_app', 'immutable', 'a.js'), 'x');
			const port = 18000 + Math.floor(Math.random() * 1000);
			const upPort = port + 1000;
			const conf = read(FRONTEND)
				.replace(/listen 80;/, `listen 127.0.0.1:${port};`)
				.replace(/host\.docker\.internal:8081/g, `127.0.0.1:${upPort}`)
				.replace(/host\.docker\.internal/g, '127.0.0.1')
				.replace(/\/usr\/share\/nginx\/html/g, html);
			writeFileSync(join(work, 'morphit.conf'), conf);
			const log = join(work, 'access.log');
			writeFileSync(log, '');
			// The official nginx image's top-level config (nginx.org package), verbatim
			// where it matters: the `main` format and the http-level access_log.
			writeFileSync(
				join(work, 'nginx.conf'),
				`${process.getuid?.() === 0 ? 'user root; ' : ''}pid ${work}/nginx.pid; error_log ${work}/error.log notice; worker_processes 1; daemon on;\n` +
					`events { worker_connections 64; }\n` +
					`http { include /etc/nginx/mime.types; default_type application/octet-stream;\n` +
					`client_body_temp_path ${work}; proxy_temp_path ${work}; fastcgi_temp_path ${work}; uwsgi_temp_path ${work}; scgi_temp_path ${work};\n` +
					`log_format main '$remote_addr - $remote_user [$time_local] "$request" ' '$status $body_bytes_sent "$http_referer" ' '"$http_user_agent" "$http_x_forwarded_for"';\n` +
					`access_log ${log} main;\n` +
					`include ${work}/morphit.conf; }\n`
			);
			const seen: IncomingHttpHeaders[] = [];
			const up = createServer((req, res) => {
				seen.push(req.headers);
				// The indexer marks every live stream unbuffered.
				if ((req.url ?? '').split('?')[0]!.endsWith('/stream'))
					res.setHeader('x-accel-buffering', 'no');
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end('{"ok":true}');
			});
			await new Promise<void>((r) => up.listen(upPort, '127.0.0.1', () => r()));
			const start = spawnSync('nginx', ['-c', join(work, 'nginx.conf')], { encoding: 'utf8' });
			check(
				'F: the frontend config starts on a real nginx',
				start.status === 0,
				(start.stderr ?? '').trim().split('\n').pop()
			);
			// node:http, not fetch: fetch will not send a caller-chosen Host header,
			// and the .onion case below needs one.
			const get = (path: string, headers: Record<string, string> = {}) =>
				new Promise<{ headers: { get(n: string): string | null } }>((res, rej) => {
					const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (r) => {
						r.resume();
						r.on('end', () =>
							res({
								headers: {
									get: (n: string) => {
										const v = r.headers[n.toLowerCase()];
										return v === undefined ? null : Array.isArray(v) ? v.join(', ') : v;
									}
								}
							})
						);
					});
					req.on('error', rej);
					req.end();
				});
			if (start.status === 0) {
				const forged = { 'x-forwarded-for': '198.51.100.9', 'x-real-ip': '198.51.100.9' };
				const home = await get('/', forged);
				await get('/offers', forged);
				await get('/v1/health', forged);
				const stream = await get('/v1/orderbook/stream', forged);
				const onion = await get('/', {
					host: 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv.onion'
				});
				// Exactly what i2pd's server tunnel forwards (see G): the visitor's
				// Host, the X-I2P-* headers it adds, Connection: close.
				const i2p = await get('/', {
					host: 'ukeu3k5oycgaauneqgtnvselmt4yemvoilkln7jpvamvfx7dnkdq.b32.i2p',
					'x-i2p-destb32': 'yxetbtgl2x6f5ttp5rr7hqbqw6mw4vctlsbn2nk3vp5vg6m7dnfa.b32.i2p',
					connection: 'close'
				});
				const imm = await get('/_app/immutable/a.js');
				spawnSync('nginx', ['-c', join(work, 'nginx.conf'), '-s', 'quit']);
				await new Promise((r) => setTimeout(r, 300));
				const logged = readFileSync(log, 'utf8');
				check(
					'F: 6 requests (incl. forged X-Forwarded-For) left the access log EMPTY',
					logged.trim() === '',
					logged.split('\n')[0]
				);
				check(
					'F: the indexer got X-Forwarded-For = the proxy peer (not the forged value) and no X-Real-IP',
					seen.length === 2 &&
						seen.every((h) => h['x-forwarded-for'] === '127.0.0.1' && h['x-real-ip'] === undefined),
					JSON.stringify(seen.map((h) => [h['x-forwarded-for'], h['x-real-ip']]))
				);
				// BunkerWeb buffers what it relays unless the response says not to;
				// nginx drops X-Accel-* headers from its upstream on its own, so
				// without proxy_pass_header the edge held every chat event (v1.21.14).
				check(
					"F: a live stream passes the indexer's X-Accel-Buffering: no on to the edge",
					stream.headers.get('x-accel-buffering') === 'no',
					String(stream.headers.get('x-accel-buffering'))
				);
				check(
					'F: pages are no-cache',
					home.headers.get('cache-control') === 'no-cache',
					String(home.headers.get('cache-control'))
				);
				check(
					'F: hashed bundles are immutable',
					/immutable/.test(imm.headers.get('cache-control') ?? ''),
					String(imm.headers.get('cache-control'))
				);
				const cspClear = home.headers.get('content-security-policy') ?? '';
				const cspOnion = onion.headers.get('content-security-policy') ?? '';
				const cspI2p = i2p.headers.get('content-security-policy') ?? '';
				check(
					'F: a clearnet, an .onion and an I2P page (as i2pd forwards it) carry the identical CSP',
					cspClear !== '' && cspOnion === cspClear && cspI2p === cspClear,
					JSON.stringify([cspClear, cspOnion, cspI2p].map(connectSources))
				);
				check(
					"F: on every one of those Hosts the CSP's connect-src is 'self' alone",
					[cspClear, cspOnion, cspI2p].every((c) => sameOnly(connectSources(c))),
					JSON.stringify([cspClear, cspOnion, cspI2p].map(connectSources))
				);
				check(
					'F: security headers present, no HSTS on this plain-http hop',
					home.headers.get('x-frame-options') === 'DENY' &&
						home.headers.get('referrer-policy') === 'no-referrer' &&
						home.headers.get('x-content-type-options') === 'nosniff' &&
						/camera=\(self\)/.test(home.headers.get('permissions-policy') ?? '') &&
						home.headers.get('strict-transport-security') === null
				);
			}
			up.close();
		} finally {
			spawnSync('nginx', ['-c', join(work, 'nginx.conf'), '-s', 'stop'], { stdio: 'ignore' });
			if (existsSync(work)) rmSync(work, { recursive: true, force: true });
		}
	}
}

void main().then(() => {
	console.log(
		fail === 0
			? `\n✓ all ${pass} proxy-privacy-config checks passed`
			: `\n✗ proxy-privacy-config: ${pass} passed, ${fail} failed`
	);
	process.exit(fail === 0 ? 0 : 1);
});
