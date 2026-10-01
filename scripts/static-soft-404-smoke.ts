/**
 * static-soft-404-smoke (v1.20.2, PageSpeed).
 *
 * A missing FILE must be a real 404, not the app's page. Before v1.20.2 every
 * path nginx could not find fell back to the SvelteKit shell (index.html,
 * 200, text/html) — right for a page link (/en/orders/…), wrong for a file:
 * PageSpeed fetched /.well-known/ai-catalog.json, got the shell and reported
 * "malformed JSON"; crawlers that probe /.well-known/*, /ads.txt, /foo.json
 * were told every such file exists and is HTML.
 *
 * Runs a REAL nginx on BOTH shipped web configs (ops/bunkerweb/frontend/
 * nginx.conf and ops/nginx/web.conf, TLS swapped for plain listeners) over a
 * small build directory, and checks:
 *   - /.well-known/<missing> → 404; a file that IS there → 200;
 *   - a missing root-level or /fonts|icons|splash|brand file → 404, a present
 *     one → 200 with no-cache and the security headers (a 404 keeps them too);
 *   - page links (/en, /en/orders/x) still get the page / the app shell;
 *   - /v1/…json, /rss/…xml and /ipfs/…png still reach their upstreams (the
 *     new rule must not steal API paths).
 * MORPHIT_SS404_ROOT=<dir containing ops/> runs another tree to watch it fail.
 * Needs an nginx binary; otherwise it says so and skips.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(process.env.MORPHIT_SS404_ROOT ?? REPO);

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
			? `\n✓ all ${pass} static-soft-404 checks passed`
			: `\n✗ ${fail} FAILED, ${pass} passed`
	);
	process.exit(fail === 0 ? 0 : 1);
};

console.log('\n── static-soft-404 smoke (real nginx, both web configs) ──');
if (spawnSync('sh', ['-c', 'command -v nginx'], { encoding: 'utf8' }).stdout.trim() === '') {
	check('skipped: no nginx binary here', true);
	finish();
}

const freePort = (): Promise<number> =>
	new Promise((res, rej) => {
		const s = createNetServer();
		s.once('error', rej);
		s.listen(0, '127.0.0.1', () => {
			const p = (s.address() as AddressInfo).port;
			s.close(() => res(p));
		});
	});

interface Got {
	status: number;
	headers: IncomingHttpHeaders;
	body: string;
}
const get = (port: number, path: string): Promise<Got> =>
	new Promise((res) => {
		const req = httpRequest(
			{ host: '127.0.0.1', port, path, headers: { host: 'morphit.test' } },
			(r) => {
				const chunks: Buffer[] = [];
				r.on('data', (c: Buffer) => chunks.push(c));
				r.on('end', () =>
					res({
						status: r.statusCode ?? 0,
						headers: r.headers,
						body: Buffer.concat(chunks).toString('utf8')
					})
				);
			}
		);
		req.on('error', () => res({ status: 0, headers: {}, body: '' }));
		req.end();
	});

const SHELL = '<!doctype html><title>shell</title>SPA-SHELL';

async function main(): Promise<void> {
	const work = mkdtempSync(join(tmpdir(), 'ss404-'));
	const site = join(work, 'site');
	for (const d of ['fonts', 'icons', 'splash', 'brand', '.well-known', 'en']) {
		mkdirSync(join(site, d), { recursive: true });
	}
	writeFileSync(join(site, 'index.html'), SHELL);
	writeFileSync(join(site, 'en.html'), '<!doctype html>EN-PAGE');
	writeFileSync(join(site, 'robots.txt'), 'User-agent: *\n');
	writeFileSync(join(site, 'og-image.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
	writeFileSync(join(site, 'fonts', 'present.woff2'), 'wOF2');
	writeFileSync(join(site, '.well-known', 'security.txt'), 'Contact: mailto:x@example.org\n');

	const upPort = await freePort();
	const upstreamSaw: string[] = [];
	const up = createServer((req, res) => {
		upstreamSaw.push(req.url ?? '');
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end('{"from":"upstream"}');
	});
	await new Promise<void>((r) => up.listen(upPort, '127.0.0.1', () => r()));

	const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
	const configs: Array<{ label: string; file: string; port: number }> = [
		{
			label: 'BunkerWeb frontend',
			file: 'ops/bunkerweb/frontend/nginx.conf',
			port: await freePort()
		},
		{ label: 'bare-metal web.conf', file: 'ops/nginx/web.conf', port: await freePort() }
	];
	let i = 0;
	for (const c of configs) {
		const dir = join(work, `c${i++}`);
		mkdirSync(dir);
		const spares = [await freePort(), await freePort(), await freePort()];
		let text = readFileSync(join(ROOT, c.file), 'utf8')
			.replace(/(?:127\.0\.0\.1|host\.docker\.internal|localhost):\d+/g, `127.0.0.1:${upPort}`)
			.replace(/^\s*root\s+[^;]+;/m, `    root ${site};`)
			.replace(/^\s*ssl_[a-z_]+\s+[^;]*;\s*$/gm, '')
			// ngx_brotli is not in every nginx build (it is not in the test host's).
			.replace(/^\s*brotli[a-z_]*\s+[^;]*;\s*$/gm, '')
			.replace(/^\s*listen\s+\[::\][^;]*;\s*$/gm, '');
		// The first listener serves the site; every other one (the frontend's
		// :8088 edge port, web.conf's :80 redirect) gets a spare port.
		let n = 0;
		text = text.replace(/^(\s*)listen\s+[^;]+;/gm, (_m, ws: string) => {
			const port = n === 0 ? c.port : spares[(n - 1) % spares.length]!;
			n++;
			return `${ws}listen 127.0.0.1:${port};`;
		});
		writeFileSync(join(dir, 'site.conf'), text);
		writeFileSync(
			join(dir, 'nginx.conf'),
			`${asRoot ? 'user root root;\n' : ''}worker_processes 1;\npid ${dir}/nginx.pid;\nerror_log ${dir}/error.log;\nevents {}\n` +
				`http { include /etc/nginx/mime.types; default_type application/octet-stream;\n` +
				`client_body_temp_path ${dir}; proxy_temp_path ${dir}; fastcgi_temp_path ${dir}; uwsgi_temp_path ${dir}; scgi_temp_path ${dir};\n` +
				`include ${dir}/site.conf; }\n`
		);
		const start = spawnSync('nginx', ['-c', join(dir, 'nginx.conf')], { encoding: 'utf8' });
		check(
			`${c.label}: starts on a real nginx`,
			start.status === 0,
			(start.stderr ?? '').trim().split('\n').pop()
		);
		if (start.status !== 0) continue;
		try {
			await runChecks(c.label, c.port, upstreamSaw);
		} finally {
			spawnSync('nginx', ['-c', join(dir, 'nginx.conf'), '-s', 'stop']);
		}
	}
	up.close();
	rmSync(work, { recursive: true, force: true });
	finish();
}

async function runChecks(label: string, port: number, upstreamSaw: string[]): Promise<void> {
	const isShell = (g: Got): boolean => g.body.includes('SPA-SHELL');
	const missing = [
		'/.well-known/ai-catalog.json',
		'/.well-known/ard.json',
		'/ads.txt',
		'/nope.json',
		'/apple-app-site-association.json',
		'/fonts/missing.woff2',
		'/icons/missing.png',
		'/splash/missing.png',
		'/brand/missing.svg'
	];
	for (const p of missing) {
		const g = await get(port, p);
		check(
			`${label}: missing ${p} → 404, not the app shell`,
			g.status === 404 && !isShell(g),
			`${g.status} ${g.headers['content-type'] ?? ''}`
		);
	}
	const nf = await get(port, '/nope.json');
	check(
		`${label}: the 404 still carries the security headers`,
		nf.headers['x-content-type-options'] === 'nosniff' &&
			typeof nf.headers['content-security-policy'] === 'string',
		JSON.stringify({
			n: nf.headers['x-content-type-options'],
			csp: Boolean(nf.headers['content-security-policy'])
		})
	);

	for (const [p, type] of [
		['/.well-known/security.txt', 'text/plain'],
		['/robots.txt', 'text/plain'],
		['/og-image.png', 'image/png']
	] as const) {
		const g = await get(port, p);
		check(
			`${label}: present ${p} → 200 ${type}, no-cache, security headers`,
			g.status === 200 &&
				String(g.headers['content-type'] ?? '').startsWith(type) &&
				g.headers['cache-control'] === 'no-cache' &&
				g.headers['x-content-type-options'] === 'nosniff' &&
				g.headers['x-frame-options'] === 'DENY' &&
				typeof g.headers['content-security-policy'] === 'string',
			`${g.status} ${g.headers['content-type'] ?? ''} cc=${g.headers['cache-control'] ?? '-'}`
		);
	}

	// v1.20.2 (PageSpeed "no COOP"): every answer, in every location block
	// (an nginx location with its own add_header loses the server's), isolates
	// the page from windows of other sites (Cross-Origin-Opener-Policy).
	{
		const paths = [
			'/en',
			'/en/orders/x',
			'/robots.txt',
			'/nope.json',
			'/.well-known/security.txt',
			'/fonts/present.woff2',
			'/brand/missing.svg',
			'/service-worker.js',
			'/verify.json',
			'/_app/immutable/x.js'
		];
		const without: string[] = [];
		for (const p of paths) {
			const g = await get(port, p);
			if (g.headers['cross-origin-opener-policy'] !== 'same-origin')
				without.push(`${p} (${g.status})`);
		}
		check(
			`${label}: Cross-Origin-Opener-Policy: same-origin on every answer`,
			without.length === 0,
			`missing on ${without.join(', ')}`
		);
	}

	// v1.20.2 (PageSpeed "cache lifetimes"): the fonts never change within a
	// release and are on every page; a month in the browser's cache instead of a
	// revalidation per page (a round trip, slow over Tor).
	{
		const g = await get(port, '/fonts/present.woff2');
		check(
			`${label}: /fonts/present.woff2 → 200 font/woff2, cached a month, security headers`,
			g.status === 200 &&
				String(g.headers['content-type'] ?? '').startsWith('font/woff2') &&
				g.headers['cache-control'] === 'public, max-age=2592000' &&
				g.headers['x-content-type-options'] === 'nosniff' &&
				typeof g.headers['content-security-policy'] === 'string',
			`${g.status} cc=${g.headers['cache-control'] ?? '-'}`
		);
	}

	const en = await get(port, '/en');
	check(
		`${label}: /en still serves the prerendered page`,
		en.status === 200 && en.body.includes('EN-PAGE'),
		`${en.status}`
	);
	const deep = await get(port, '/en/orders/alice/some-order');
	check(
		`${label}: a deep page link still gets the app shell`,
		deep.status === 200 && isShell(deep),
		`${deep.status}`
	);

	for (const p of ['/v1/orderbook.json', '/rss/feed.xml', '/ipfs/bafyfake/logo.png']) {
		const before = upstreamSaw.length;
		const g = await get(port, p);
		check(
			`${label}: ${p} still reaches its upstream`,
			g.status === 200 && g.body.includes('"upstream"') && upstreamSaw.length > before,
			`${g.status} ${g.body.slice(0, 60)}`
		);
	}
}

void main();
