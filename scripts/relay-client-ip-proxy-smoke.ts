/**
 * Morphit smoke — the relay sees the REAL client, on every shipped proxy path.
 * (v1.18.0 deep-deep, H1)
 *
 * The relay keys every per-IP signup defense (hourly/daily limits, spacing,
 * invite binding, the ALTCHA trigger) on the address its proxy forwards. Three
 * shipped configs forwarded a value the visitor could type:
 *   - ops/nginx/web.conf and ops/bunkerweb/frontend/nginx.conf sent
 *     `X-Forwarded-For $proxy_add_x_forwarded_for` — the visitor's own header
 *     with the real address appended — and the relay read the leftmost entry;
 *   - ops/nginx/relay.conf didn't set X-Forwarded-For at all, so the visitor's
 *     header went straight through;
 *   - BunkerWeb (the public edge) ran USE_REAL_IP=yes with
 *     REAL_IP_FROM=0.0.0.0/0, believing that header from the whole internet.
 *
 * Part 1 (always): reads the shipped configs and evaluates, for each way a
 * request can arrive, which header value the relay is handed — including the
 * frontend's geo/map switch, evaluated the way nginx does (longest prefix).
 * Part 2 (when an nginx binary is available — $MORPHIT_SMOKE_NGINX or `nginx`
 * on PATH): RUNS the shipped /relay/ blocks in a real nginx in front of a tiny
 * upstream that calls the relay's real clientIp(), and checks the answer.
 *
 * Output contract: emits `✓ all N ... passed` on the last line.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from 'hono';

import { clientIp, configureTrustedProxies } from '../apps/relay/src/middleware/ip.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

let pass = 0;
let fail = 0;
const check = (m: string, okay: boolean, detail = ''): void => {
	if (okay) {
		pass++;
		console.log(`  ✓ ${m}`);
	} else {
		fail++;
		console.log(`  ✗ ${m}`);
		if (detail) console.log(`      ${detail}`);
	}
};

/** Strip `#` comments (none of these configs put `#` inside a quoted value). */
const uncomment = (conf: string): string =>
	conf
		.split('\n')
		.map((l) => l.replace(/#.*$/, ''))
		.join('\n');

/** The body of the first `<head> {` block (brace-matched), or null. */
function block(conf: string, head: RegExp): string | null {
	const src = uncomment(conf);
	const m = head.exec(src);
	if (!m) return null;
	let depth = 0;
	for (let i = m.index + m[0].length - 1; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}' && --depth === 0) return src.slice(m.index + m[0].length, i);
	}
	return null;
}

function headers(body: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const m of body.matchAll(/proxy_set_header\s+(\S+)\s+("[^"]*"|\S+?)\s*;/g))
		out.set(m[1]!.toLowerCase(), m[2]!);
	return out;
}

/** Variables a visitor controls outright. */
const CLIENT_CONTROLLED = new Set(['$proxy_add_x_forwarded_for', '$http_x_forwarded_for']);

// ─── Part 1: the shipped configs ────────────────────────────────────────────
console.log('\n── relay client IP: shipped proxy configs ───────────\n');

{
	const b = block(read('ops/nginx/web.conf'), /location\s+\/relay\/\s*\{/);
	const h = headers(b ?? '');
	check(
		'web.conf /relay/ overwrites X-Forwarded-For with $remote_addr',
		h.get('x-forwarded-for') === '$remote_addr',
		`got ${h.get('x-forwarded-for')}`
	);
	check('web.conf /relay/ sets X-Real-IP $remote_addr', h.get('x-real-ip') === '$remote_addr');
}
{
	// The `location /` that proxies to the relay (the :80 server's only redirects).
	const conf = read('ops/nginx/relay.conf');
	let b: string | null = null;
	for (let rest = conf; ; ) {
		const at = /location\s+\/\s*\{/.exec(uncomment(rest));
		if (!at) break;
		const body = block(rest, /location\s+\/\s*\{/);
		if (body !== null && /proxy_pass\s+http:\/\/127\.0\.0\.1:8080/.test(body)) {
			b = body;
			break;
		}
		rest = uncomment(rest).slice(at.index + at[0].length);
	}
	const h = headers(b ?? '');
	check(
		'relay.conf overwrites X-Forwarded-For with $remote_addr',
		h.get('x-forwarded-for') === '$remote_addr',
		`got ${h.get('x-forwarded-for')}`
	);
	check('relay.conf sets X-Real-IP $remote_addr', h.get('x-real-ip') === '$remote_addr');
}

// The frontend container: evaluate geo → map for each way a request arrives.
const FRONTEND = read('ops/bunkerweb/frontend/nginx.conf');
{
	// The MCP limits per client the same way (its clientKey prefers X-Real-IP,
	// then the rightmost entry): neither proxy may append the visitor's own
	// X-Forwarded-For claim in front of the real address.
	const web = headers(block(read('ops/nginx/web.conf'), /location\s+\/mcp\s*\{/) ?? '');
	check(
		'web.conf /mcp overwrites X-Forwarded-For with $remote_addr',
		web.get('x-forwarded-for') === '$remote_addr',
		`got ${web.get('x-forwarded-for')}`
	);
	const fe = headers(block(FRONTEND, /location\s+\/mcp\s*\{/) ?? '');
	check(
		'frontend /mcp sends the one-entry client address, never an appended chain',
		fe.get('x-forwarded-for') === '$morphit_relay_xff' &&
			fe.get('x-real-ip') === '$morphit_relay_xff',
		`got xff=${fe.get('x-forwarded-for')} real=${fe.get('x-real-ip')}`
	);
}
function evalFrontendXff(peer: string): string | null {
	const relay = headers(block(FRONTEND, /location\s+\/relay\/\s*\{/) ?? '');
	const xff = relay.get('x-forwarded-for');
	if (xff === undefined) return null;
	if (!xff.startsWith('$morphit_')) return xff;
	// map <src> <var> { ... }
	const mapHead = new RegExp(`map\\s+(\\$\\S+)\\s+\\${xff}\\s*\\{`);
	const src = mapHead.exec(uncomment(FRONTEND))?.[1];
	const mapBody = block(FRONTEND, mapHead);
	if (!src || mapBody === null) return null;
	const entries = [...mapBody.matchAll(/^\s*(\S+)\s+(\S+?)\s*;/gm)].map(
		(m) => [m[1]!, m[2]!] as const
	);
	// geo <var> { ... } — longest-prefix match on the peer
	const geoBody = block(FRONTEND, new RegExp(`geo\\s+\\${src}\\s*\\{`));
	if (geoBody === null) return null;
	const toInt = (ip: string): number =>
		ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
	let geoVal: string | null = null;
	let best = -1;
	for (const m of geoBody.matchAll(/^\s*(\S+)\s+(\S+?)\s*;/gm)) {
		const [key, val] = [m[1]!, m[2]!];
		if (key === 'default') {
			if (best < 0) geoVal = val;
			continue;
		}
		const [net, bitsStr] = key.split('/');
		const bits = Number(bitsStr ?? 32);
		const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
		if ((toInt(peer) & mask) >>> 0 === (toInt(net!) & mask) >>> 0 && bits > best) {
			best = bits;
			geoVal = val;
		}
	}
	const hit = entries.find(([k]) => k === geoVal) ?? entries.find(([k]) => k === 'default');
	return hit ? hit[1] : null;
}
{
	const gateway = evalFrontendXff('172.20.0.1');
	check(
		'frontend: Tor/I2P (via the bridge gateway) → X-Forwarded-For is $remote_addr',
		gateway === '$remote_addr',
		`got ${gateway}`
	);
	const bw = evalFrontendXff('172.20.0.2');
	check(
		"frontend: from BunkerWeb → the one address BunkerWeb wrote (its X-Real-IP), not the visitor's header",
		bw === '$http_x_real_ip',
		`got ${bw}`
	);
	for (const peer of ['127.0.0.1', '203.0.113.9', '10.0.0.5']) {
		const v = evalFrontendXff(peer);
		check(`frontend: from ${peer} → $remote_addr`, v === '$remote_addr', `got ${v}`);
	}
	const all = ['172.20.0.1', '172.20.0.2', '172.20.255.254', '127.0.0.1', '8.8.8.8'].map(
		evalFrontendXff
	);
	check(
		'frontend: no path forwards a client-controlled X-Forwarded-For',
		all.every((v) => v !== null && !CLIENT_CONTROLLED.has(v))
	);
	const relay = headers(block(FRONTEND, /location\s+\/relay\/\s*\{/) ?? '');
	check('frontend /relay/ clears X-Real-IP', relay.get('x-real-ip') === '""');
}

for (const f of [
	'ops/bunkerweb/bunkerweb.env.example',
	'ops/ansible/roles/bunkerweb/templates/bunkerweb.env.j2'
]) {
	const env = read(f);
	const use = /^USE_REAL_IP=(.*)$/m.exec(env)?.[1]?.trim() ?? 'no';
	const from = /^REAL_IP_FROM=(.*)$/m.exec(env)?.[1]?.trim() ?? '';
	const wide = use === 'yes' && (from === '' || from.split(/\s+/).some((e) => e.endsWith('/0')));
	check(
		`${f}: the public edge does not trust X-Forwarded-For from everyone`,
		!wide,
		`USE_REAL_IP=${use} REAL_IP_FROM=${from}`
	);
}

// ─── Part 2: the shipped /relay/ blocks in a real nginx ─────────────────────
function findNginx(): string | null {
	const fromEnv = process.env.MORPHIT_SMOKE_NGINX;
	const candidates = [fromEnv, 'nginx', '/usr/sbin/nginx'].filter((x): x is string => !!x);
	for (const c of candidates) {
		const r = spawnSync(c, ['-v'], { encoding: 'utf8' });
		if (r.status === 0) return c;
	}
	return null;
}

function get(port: number, hdrs: Record<string, string>): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = request({ host: '127.0.0.1', port, path: '/relay/v1/x', headers: hdrs }, (res) => {
			let body = '';
			res.on('data', (d) => (body += d));
			res.on('end', () => resolve(body));
		});
		req.on('error', reject);
		req.end();
	});
}

async function waitUp(port: number): Promise<void> {
	for (let i = 0; i < 200; i++) {
		try {
			await get(port, {});
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 10));
		}
	}
	throw new Error(`nginx on ${port} never came up`);
}

async function part2(nginx: string): Promise<void> {
	console.log(`\n── relay client IP: shipped /relay/ blocks in a real nginx (${nginx}) ──\n`);
	const dir = mkdtempSync(join(tmpdir(), 'relay-ip-ngx-'));
	mkdirSync(join(dir, 'tmp'));
	let upstream: Server | null = null;
	let proc: ChildProcess | null = null;
	try {
		// Upstream: the relay's real clientIp() on the real socket + headers.
		upstream = createServer((req, res) => {
			const c = {
				env: { incoming: req },
				req: { header: (n: string) => req.headers[n.toLowerCase()] as string | undefined }
			} as unknown as Context;
			res.end(clientIp(c));
		});
		await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', r));
		const up = (upstream.address() as { port: number }).port;

		// The test can't connect from 172.20.0.x, so each server trusts a
		// test-only header from 127.0.0.1 to set $remote_addr (the realip
		// module) — it plays the peer each path really has.
		const shim = `set_real_ip_from 127.0.0.1; real_ip_header X-Test-Peer;`;
		const webRelay = block(read('ops/nginx/web.conf'), /location\s+\/relay\/\s*\{/)!.replace(
			/proxy_pass\s+\S+;/,
			`proxy_pass http://127.0.0.1:${up};`
		);
		const frontend = uncomment(FRONTEND)
			.replace(/host\.docker\.internal:\d+/g, `127.0.0.1:${up}`)
			.replace(/listen\s+80\s*;/, `listen 127.0.0.1:${0};`);
		// Pick two free ports.
		const free = async (): Promise<number> => {
			const s = createServer();
			await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
			const p = (s.address() as { port: number }).port;
			await new Promise<void>((r) => s.close(() => r()));
			return p;
		};
		const pWeb = await free();
		const pFe = await free();
		const site =
			`server { listen 127.0.0.1:${pWeb}; ${shim} location /relay/ {${webRelay}} }\n` +
			frontend.replace(`listen 127.0.0.1:0;`, `listen 127.0.0.1:${pFe}; ${shim}`);
		writeFileSync(join(dir, 'site.conf'), site);
		const t = join(dir, 'tmp');
		writeFileSync(
			join(dir, 'nginx.conf'),
			`user root; worker_processes 1; daemon off; pid ${dir}/nginx.pid; error_log ${dir}/error.log;\n` +
				`events {}\nhttp { access_log off; client_body_temp_path ${t}; proxy_temp_path ${t}; fastcgi_temp_path ${t}; uwsgi_temp_path ${t}; scgi_temp_path ${t};\n` +
				`include ${dir}/site.conf; }\n`
		);
		const test = spawnSync(
			nginx,
			['-t', '-e', join(dir, 'error.log'), '-p', dir, '-c', join(dir, 'nginx.conf')],
			{ encoding: 'utf8' }
		);
		check('the shipped /relay/ blocks load in nginx', test.status === 0, test.stderr);
		if (test.status !== 0) return;
		proc = spawn(nginx, ['-e', join(dir, 'error.log'), '-p', dir, '-c', join(dir, 'nginx.conf')], {
			stdio: 'ignore'
		});
		await waitUp(pWeb);
		await waitUp(pFe);

		const REAL = '198.51.100.9';
		// Bare metal, loopback-trusted relay.
		configureTrustedProxies([]);
		const seen = new Set<string>();
		for (let i = 0; i < 5; i++)
			seen.add(await get(pWeb, { 'X-Test-Peer': REAL, 'X-Forwarded-For': `10.${i}.0.1` }));
		check(
			'web.conf: a clearnet visitor rotating X-Forwarded-For is always their real address',
			seen.size === 1 && seen.has(REAL),
			[...seen].join(' ')
		);
		const tor = await get(pWeb, { 'X-Forwarded-For': '10.7.0.1', 'X-Real-IP': '10.8.0.1' });
		check(
			'web.conf: a Tor/I2P visitor (nginx sees 127.0.0.1) cannot forge an address',
			tor === '127.0.0.1',
			tor
		);

		// BunkerWeb topology: the relay trusts the bridge.
		configureTrustedProxies(['172.20.0.0/16']);
		const viaBw = new Set<string>();
		for (let i = 0; i < 5; i++) {
			// What BunkerWeb (USE_REAL_IP=no) sends: X-Real-IP = the real visitor,
			// X-Forwarded-For = the visitor's own header + the real visitor.
			viaBw.add(
				await get(pFe, {
					'X-Test-Peer': '172.20.0.2',
					'X-Real-IP': REAL,
					'X-Forwarded-For': `10.${i}.0.1, ${REAL}`
				})
			);
		}
		check(
			'frontend: via BunkerWeb, a rotating X-Forwarded-For is always the real address',
			viaBw.size === 1 && viaBw.has(REAL),
			[...viaBw].join(' ')
		);
		const viaTor = new Set<string>();
		for (let i = 0; i < 5; i++) {
			viaTor.add(
				await get(pFe, {
					'X-Test-Peer': '172.20.0.1',
					'X-Real-IP': `10.${i}.9.9`,
					'X-Forwarded-For': `10.${i}.0.1`
				})
			);
		}
		check(
			'frontend: via Tor/I2P (bridge gateway) nothing typed gets through — one shared bucket',
			viaTor.size === 1 && viaTor.has('172.20.0.1'),
			[...viaTor].join(' ')
		);
	} finally {
		configureTrustedProxies([]);
		proc?.kill('SIGTERM');
		upstream?.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const nginx = findNginx();
	if (nginx === null) {
		console.log(
			'\n  (no nginx binary here — the live-nginx part runs where one is installed; set MORPHIT_SMOKE_NGINX to point at one)'
		);
	} else {
		await part2(nginx);
	}

	console.log('\n──────────────────────────────────────────────────────');
	if (fail > 0) {
		console.log(`✗ ${fail} of ${pass + fail} relay client-IP checks FAILED`);
		process.exit(1);
	}
	console.log(`✓ all ${pass} relay client-IP scenarios passed`);
}

main().catch((err: unknown) => {
	console.log(
		`✗ relay client-IP smoke crashed: ${err instanceof Error ? err.message : String(err)}`
	);
	process.exit(1);
});
