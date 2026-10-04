/**
 * nginx-served-hardening-smoke.
 *
 * Runs a REAL nginx on each shipped config — ops/bunkerweb/frontend/nginx.conf,
 * ops/nginx/web.conf, ops/nginx/relay.conf, ops/nginx/indexer.conf — with only
 * the certificate paths, document roots and upstream ports swapped (TLS and
 * `http2` listeners are kept, so the config is checked as the distro nginx
 * would load it), and checks what visitors and the upstreams really get:
 *   - `nginx -t` accepts each config (relay.conf once used `http2 on;`, which
 *     the nginx 1.24 that Ubuntu 24.04 ships does not know);
 *   - no nginx version in the Server header or in an error page, on every
 *     server, the HTTP→HTTPS redirect included;
 *   - the page CSP allows no inline script and no eval ('wasm-unsafe-eval'
 *     stays);
 *   - a visitor's X-Morphit-Local-Health and X-I2P-Dest{B64,B32,Hash} never
 *     reach the relay or indexer;
 *   - after a failed upstream (502) and a rate-limit rejection, nginx's error
 *     log holds no line naming a client;
 *   - the indexer's health and stream answers carry the security headers;
 *   - web.conf's /ipfs/ asks the gateway for 127.0.0.1, not the visitor's Host.
 * MORPHIT_NGX_ROOT=<dir containing ops/> runs another tree to watch it fail.
 * Needs nginx and openssl; otherwise it says so and skips.
 */
import { spawnSync } from 'node:child_process';
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(process.env.MORPHIT_NGX_ROOT ?? REPO);

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
const finish = (): never => {
	console.log(
		fail === 0
			? `\n✓ all ${pass} nginx-served-hardening checks passed`
			: `\n✗ ${fail} of ${pass + fail} nginx-served-hardening checks failed`
	);
	process.exit(fail === 0 ? 0 : 1);
};

console.log('\n── nginx-served-hardening smoke (real nginx, all four shipped configs) ──');
const has = (bin: string): boolean =>
	spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).stdout.trim() !== '';
if (!has('nginx') || !has('openssl')) {
	check('skipped: no nginx or openssl binary here', true);
	finish();
}

/** A free 127.0.0.1 port in 8700–8799. */
const taken = new Set<number>();
const freePort = async (): Promise<number> => {
	for (let p = 8700; p < 8800; p++) {
		if (taken.has(p)) continue;
		const ok = await new Promise<boolean>((res) => {
			const s = createNetServer();
			s.once('error', () => res(false));
			s.listen(p, '127.0.0.1', () => s.close(() => res(true)));
		});
		if (ok) {
			taken.add(p);
			return p;
		}
	}
	throw new Error('no free port in 8700-8799');
};

interface Got {
	status: number;
	headers: IncomingHttpHeaders;
	body: string;
}
const get = (
	port: number,
	path: string,
	opts: { tls?: boolean; host?: string; headers?: Record<string, string> } = {}
): Promise<Got> =>
	new Promise((res) => {
		const host = opts.host ?? 'morphit.test';
		const o = {
			host: '127.0.0.1',
			port,
			path,
			headers: { host, ...(opts.headers ?? {}) },
			servername: host,
			rejectUnauthorized: false,
			agent: false as const
		};
		const done = (r: import('node:http').IncomingMessage): void => {
			const chunks: Buffer[] = [];
			r.on('data', (c: Buffer) => chunks.push(c));
			r.on('end', () =>
				res({
					status: r.statusCode ?? 0,
					headers: r.headers,
					body: Buffer.concat(chunks).toString('utf8')
				})
			);
		};
		const req = opts.tls ? httpsRequest(o, done) : httpRequest(o, done);
		req.setTimeout(10_000, () => req.destroy());
		req.on('error', () => res({ status: 0, headers: {}, body: '' }));
		req.end();
	});

const FORGED = {
	'X-Morphit-Local-Health': '1',
	'X-I2P-DestB64': 'forged-b64',
	'X-I2P-DestB32': 'forgedforgedforgedforgedforgedforgedforgedforgedfor.b32.i2p',
	'X-I2P-DestHash': 'forged-hash'
};
const INTERNAL = Object.keys(FORGED).map((h) => h.toLowerCase());
const scriptSrcStrict = (csp: string): boolean => {
	const m = /(?:^|;)\s*script-src\s+([^;]*)/.exec(csp);
	const vals = (m?.[1] ?? '').trim().split(/\s+/);
	return m !== null && !vals.includes("'unsafe-inline'") && !vals.includes("'unsafe-eval'");
};

interface Seen {
	url: string;
	headers: IncomingHttpHeaders;
}

async function main(): Promise<void> {
	const work = mkdtempSync(join(tmpdir(), 'ngx-hard-'));
	const site = join(work, 'site');
	mkdirSync(join(site, '.well-known'), { recursive: true });
	writeFileSync(join(site, 'index.html'), '<!doctype html><title>shell</title>SPA-SHELL');
	const cert = join(work, 'cert.pem');
	const key = join(work, 'key.pem');
	const ssl = spawnSync(
		'openssl',
		[
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-days',
			'2',
			'-subj',
			'/CN=morphit.test',
			'-keyout',
			key,
			'-out',
			cert
		],
		{ encoding: 'utf8' }
	);
	if (ssl.status !== 0) {
		check('a test certificate could be made', false, ssl.stderr);
		finish();
	}

	// The relay/indexer/IPFS stand-in: records what it is sent; /…boom closes
	// the connection (nginx answers 502), /…slow holds it open.
	const upPort = await freePort();
	const deadPort = await freePort(); // nothing listens: a failed upstream
	const seen: Seen[] = [];
	const up = createServer((req, res) => {
		seen.push({ url: req.url ?? '', headers: req.headers });
		if ((req.url ?? '').includes('boom')) {
			req.socket.destroy();
			return;
		}
		const reply = (): void => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end('{"status":"ok"}');
		};
		if ((req.url ?? '').includes('slow')) setTimeout(reply, 1500);
		else reply();
	});
	await new Promise<void>((r) => up.listen(upPort, '127.0.0.1', () => r()));

	const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
	const configs = [
		{
			label: 'BunkerWeb frontend',
			file: 'ops/bunkerweb/frontend/nginx.conf',
			page: true,
			tls: false
		},
		{ label: 'bare-metal web.conf', file: 'ops/nginx/web.conf', page: true, tls: true },
		{ label: 'relay.conf', file: 'ops/nginx/relay.conf', page: false, tls: true },
		{ label: 'indexer.conf', file: 'ops/nginx/indexer.conf', page: false, tls: true }
	] as const;
	let i = 0;
	for (const c of configs) {
		const dir = join(work, `c${i++}`);
		mkdirSync(dir);
		const main = await freePort();
		const spare = await freePort();
		let text = readFileSync(join(ROOT, c.file), 'utf8')
			// :8124 (the MCP) has nothing behind it here: a failed upstream.
			.replace(
				/(?:127\.0\.0\.1|host\.docker\.internal|localhost):(\d+)/g,
				(_m, p: string) => `127.0.0.1:${p === '8124' ? deadPort : upPort}`
			)
			.replace(/^(\s*)root\s+[^;]+;/gm, `$1root ${site};`)
			.replace(/^(\s*)ssl_certificate\s+[^;]+;/gm, `$1ssl_certificate ${cert};`)
			.replace(/^(\s*)ssl_certificate_key\s+[^;]+;/gm, `$1ssl_certificate_key ${key};`)
			.replace(/^\s*ssl_(?!certificate\b|certificate_key\b)[a-z_]+\s+[^;]*;\s*$/gm, '')
			.replace(/^\s*include\s+\/etc\/letsencrypt\/[^;]*;\s*$/gm, '')
			// ngx_brotli is not in every nginx build (it is not in Ubuntu's).
			.replace(/^\s*brotli[a-z_]*\s+[^;]*;\s*$/gm, '')
			.replace(/^\s*listen\s+\[::\][^;]*;\s*$/gm, '');
		// The site's own listener (443, or the frontend's :80) gets `main`; any
		// other (the frontend's :8088 edge port, the :80 redirect) gets `spare`.
		const sitePort = c.tls ? '443' : '80';
		const listens: string[] = [];
		text = text.replace(
			/^(\s*)listen\s+(\d+)([^;]*);/gm,
			(_m, ws: string, port: string, flags: string) => {
				listens.push(port);
				return `${ws}listen 127.0.0.1:${port === sitePort ? main : spare}${flags};`;
			}
		);
		writeFileSync(join(dir, 'site.conf'), text);
		const errorLog = join(dir, 'error.log');
		writeFileSync(
			join(dir, 'nginx.conf'),
			`${asRoot ? 'user root root;\n' : ''}worker_processes 1;\npid ${dir}/nginx.pid;\n` +
				// The distro default: the main error log at level "error".
				`error_log ${errorLog};\nevents {}\n` +
				`http { include /etc/nginx/mime.types; default_type application/octet-stream;\n` +
				`client_body_temp_path ${dir}; proxy_temp_path ${dir}; fastcgi_temp_path ${dir}; uwsgi_temp_path ${dir}; scgi_temp_path ${dir};\n` +
				`include ${dir}/site.conf; }\n`
		);
		const conf = join(dir, 'nginx.conf');
		const t = spawnSync('nginx', ['-t', '-c', conf], { encoding: 'utf8' });
		check(
			`${c.label}: nginx ${nginxVersion()} accepts it (nginx -t)`,
			t.status === 0,
			(t.stderr ?? '')
				.trim()
				.split('\n')
				.find((l) => /emerg|error/.test(l)) ?? ''
		);
		if (t.status !== 0) continue;
		// Where `error_log stderr` goes: a file here (the journal on a box),
		// which also keeps the daemon from holding this process's pipe open.
		const stderrFile = join(dir, 'stderr.log');
		const fd = openSync(stderrFile, 'w');
		const start = spawnSync('nginx', ['-c', conf], { stdio: ['ignore', fd, fd] });
		closeSync(fd);
		if (start.status !== 0) {
			check(`${c.label}: starts`, false, readFileSync(stderrFile, 'utf8').trim());
			continue;
		}
		try {
			await runChecks(c, main, listens.includes(c.tls ? '80' : '8088') ? spare : null, seen, [
				errorLog,
				stderrFile
			]);
		} finally {
			spawnSync('nginx', ['-c', conf, '-s', 'stop'], { stdio: 'ignore' });
		}
	}
	up.close();
	rmSync(work, { recursive: true, force: true });
	finish();
}

function nginxVersion(): string {
	const v = spawnSync('nginx', ['-v'], { encoding: 'utf8' });
	return /nginx\/(\S+)/.exec(`${v.stderr ?? ''}${v.stdout ?? ''}`)?.[1] ?? '';
}

async function runChecks(
	c: { label: string; file: string; page: boolean; tls: boolean },
	port: number,
	sparePort: number | null,
	seen: Seen[],
	errorLogs: readonly string[]
): Promise<void> {
	const tls = c.tls;
	const L = c.label;
	const versionShown = (g: Got): boolean =>
		/\d/.test(String(g.headers.server ?? '')) || /nginx\/\d/.test(g.body);

	// Server header and error pages.
	const probes: Array<[string, Got]> = [];
	probes.push(['an ordinary answer', await get(port, c.page ? '/' : '/v1/health', { tls })]);
	probes.push(['an error page', await get(port, c.page ? '/.env' : '/nope', { tls })]);
	if (sparePort !== null) probes.push(['the second listener', await get(sparePort, '/x', {})]);
	for (const [what, g] of probes)
		check(
			`${L}: ${what} shows no nginx version`,
			g.status > 0 && !versionShown(g),
			`${g.status} Server: ${String(g.headers.server ?? '')}`
		);

	// The page CSP.
	if (c.page) {
		const g = await get(port, '/', { tls });
		const csp = String(g.headers['content-security-policy'] ?? '');
		check(
			`${L}: the page CSP allows no inline script and no eval`,
			csp !== '' && scriptSrcStrict(csp),
			csp.slice(0, 90)
		);
		check(
			`${L}: the page CSP keeps 'wasm-unsafe-eval' for the WebAssembly crypto`,
			csp.includes("'wasm-unsafe-eval'")
		);
	}

	// Visitor-set internal headers never reach the upstream.
	const paths = c.file.endsWith('relay.conf')
		? ['/v1/health']
		: c.file.endsWith('indexer.conf')
			? ['/v1/health', '/v1/orders', '/v1/x/stream', '/v1/other', '/rss/feed.xml']
			: [
					'/relay/v1/health',
					'/v1/health',
					'/v1/broadcast',
					'/v1/x/stream',
					'/rss/feed.xml',
					'/ipfs/bafy'
				];
	for (const p of paths) {
		const before = seen.length;
		const g = await get(port, p, { tls, headers: FORGED });
		const got = seen.slice(before);
		const leaked = got.flatMap((s) => INTERNAL.filter((h) => s.headers[h] !== undefined));
		check(
			`${L}: ${p} — the relay/indexer never see a visitor's internal headers`,
			got.length > 0 && leaked.length === 0,
			got.length === 0
				? `not proxied (${g.status})`
				: `passed on: ${[...new Set(leaked)].join(', ')}`
		);
	}

	// web.conf: the IPFS gateway is asked for 127.0.0.1, not the visitor's Host.
	if (c.file.endsWith('web.conf')) {
		const before = seen.length;
		await get(port, '/ipfs/bafyhost', { tls, host: 'visitor-chosen.example' });
		const h = seen.slice(before).find((s) => s.url.includes('bafyhost'))?.headers.host;
		check(
			`${L}: /ipfs/ asks the gateway for 127.0.0.1, not the visitor's Host`,
			h === '127.0.0.1',
			String(h)
		);
	}

	// The indexer's own-header locations keep the security headers.
	if (c.file.endsWith('indexer.conf'))
		for (const p of ['/v1/health', '/v1/x/stream']) {
			const g = await get(port, p, { tls });
			const missing = [
				'strict-transport-security',
				'x-content-type-options',
				'referrer-policy',
				'x-frame-options',
				'content-security-policy'
			].filter((h) => g.headers[h] === undefined);
			check(
				`${L}: ${p} carries the security headers`,
				g.status === 200 && missing.length === 0,
				missing.join(', ')
			);
		}

	// A failed upstream and a rate-limit rejection: nothing in the error log
	// names the client. (The frontend only ever sees BunkerWeb or the Tor/I2P
	// daemons as its client, so this is about the bare-metal configs.)
	const b = await get(port, c.page ? '/mcp' : '/v1/boom', { tls });
	check(`${L}: a failed upstream answers 502`, b.status === 502, String(b.status));
	if (c.file.endsWith('frontend/nginx.conf')) return;
	const all = await Promise.all(Array.from({ length: 60 }, () => get(port, '/v1/slow', { tls })));
	const limited = all.filter((g) => g.status === 429 || g.status === 503).length;
	check(
		`${L}: 60 parallel connections from one address hit the limit`,
		limited > 0,
		`${limited} limited`
	);
	await new Promise((r) => setTimeout(r, 300));
	const log = errorLogs.map((f) => (existsSync(f) ? readFileSync(f, 'utf8') : '')).join('\n');
	const naming = log.split('\n').filter((l) => /\bclient: /.test(l));
	check(
		`${L}: the error log names no client after a 502 and a limit hit`,
		naming.length === 0,
		`${naming.length} line(s), e.g. ${naming[0]?.replace(/^.*?\[\w+\]/, '').slice(0, 110) ?? ''}`
	);
}

main().catch((e: unknown) => {
	check('ran to the end', false, String(e));
	finish();
});
