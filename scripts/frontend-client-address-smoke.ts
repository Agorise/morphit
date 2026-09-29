/**
 * frontend-client-address-smoke (v1.20.0 deep review, wave 5).
 *
 * What client address does the frontend container hand the relay, the indexer
 * and the MCP — for BunkerWeb's requests, and for everything that is NOT
 * BunkerWeb? Run on a REAL nginx with the shipped
 * ops/bunkerweb/frontend/nginx.conf, inside a private network namespace whose
 * loopback carries the peer addresses of real deployments:
 *
 *   BunkerWeb on morphit.io's bridge (172.18.0.0/24) and on the Ansible one
 *   (172.20.0.0/16), connecting to the port bunkerweb.env's REVERSE_PROXY_HOST
 *   names, with X-Real-IP = the visitor (BunkerWeb's reverse-proxy template
 *   always sets it) → the relay/indexer/MCP must see THE VISITOR, alone.
 *
 *   Tor/I2P through the published port (Docker delivers it from the bridge
 *   gateway, 172.18.0.1 / 172.20.0.1, or from 127.0.0.1), an onion-proxy
 *   CONTAINER on the same bridge (morphit.io runs one), and a peer outside
 *   Docker's pool — each forging X-Real-IP and X-Forwarded-For → they must see
 *   the PEER, never the forged value.
 *
 * Widening the old 172.20.0.0/16 geo to Docker's whole pool alone would let the
 * onion container (a bridge peer) and any gateway outside a fixed list choose
 * their address; the edge LISTENER (8088, BunkerWeb only) is what separates
 * them. MORPHIT_FCA_ROOT=<dir containing ops/> runs another tree to watch it
 * fail. Needs root (or unprivileged user namespaces) for the namespace, and
 * an nginx binary; otherwise it says so and skips.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(SELF), '..');
const ROOT = resolve(process.env.MORPHIT_FCA_ROOT ?? REPO);
const PEERS = ['172.18.0.5', '172.18.0.1', '172.18.0.7', '172.20.0.5', '172.20.0.1', '192.0.2.10'];

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
			? `\n✓ all ${pass} frontend-client-address checks passed`
			: `\n✗ ${fail} FAILED, ${pass} passed`
	);
	process.exit(fail === 0 ? 0 : 1);
};

if (process.env.FCA_IN_NETNS !== '1') {
	console.log('\n── frontend client-address smoke (real nginx, private network) ──');
	if (spawnSync('sh', ['-c', 'command -v nginx'], { encoding: 'utf8' }).stdout.trim() === '') {
		check('skipped: no nginx binary here', true);
		finish();
	}
	const env = { ...process.env, FCA_IN_NETNS: '1' };
	const tsx = join(REPO, 'node_modules/.bin/tsx');
	for (const pre of [
		['unshare', '-n'],
		['unshare', '-rn']
	]) {
		const probe = spawnSync(pre[0]!, [...pre.slice(1), 'true'], { encoding: 'utf8' });
		if (probe.status !== 0) continue;
		const r = spawnSync(pre[0]!, [...pre.slice(1), tsx, SELF], { stdio: 'inherit', env });
		process.exit(r.status ?? 1);
	}
	check('skipped: no network namespace available (needs root or user namespaces)', true);
	finish();
}

async function inNamespace(): Promise<void> {
	spawnSync('ip', ['link', 'set', 'lo', 'up']);
	for (const a of PEERS) spawnSync('ip', ['addr', 'add', `${a}/32`, 'dev', 'lo']);
	const envText = readFileSync(join(ROOT, 'ops/bunkerweb/bunkerweb.env.example'), 'utf8');
	const edgePort = Number(
		/^REVERSE_PROXY_HOST=http:\/\/[^:/\s]+(?::(\d+))?/m.exec(envText)?.[1] ?? '80'
	);
	console.log(`  (BunkerWeb targets the frontend on :${edgePort}, per bunkerweb.env.example)`);

	const work = mkdtempSync(join(tmpdir(), 'fca-'));
	const seen: Array<{ port: number; id: string; h: IncomingHttpHeaders }> = [];
	const ups = [8080, 8081, 8124].map((port) =>
		createServer((req, res) => {
			seen.push({ port, id: String(req.headers['x-test-id'] ?? ''), h: req.headers });
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end('{}');
		})
	);
	await Promise.all(
		ups.map(
			(s, i) => new Promise<void>((r) => s.listen([8080, 8081, 8124][i], '127.0.0.1', () => r()))
		)
	);
	writeFileSync(
		join(work, 'morphit.conf'),
		readFileSync(join(ROOT, 'ops/bunkerweb/frontend/nginx.conf'), 'utf8').replace(
			/host\.docker\.internal/g,
			'127.0.0.1'
		)
	);
	writeFileSync(
		join(work, 'nginx.conf'),
		`user root root;\nworker_processes 1;\npid ${work}/nginx.pid;\nerror_log ${work}/error.log;\nevents {}\n` +
			`http { client_body_temp_path ${work}; proxy_temp_path ${work}; fastcgi_temp_path ${work}; uwsgi_temp_path ${work}; scgi_temp_path ${work};\n` +
			`include ${work}/morphit.conf; }\n`
	);
	const start = spawnSync('nginx', ['-c', join(work, 'nginx.conf')], { encoding: 'utf8' });
	check(
		'the frontend config starts on a real nginx',
		start.status === 0,
		(start.stderr ?? '').trim().split('\n').pop()
	);
	if (start.status !== 0) {
		rmSync(work, { recursive: true, force: true });
		finish();
	}
	const get = (
		from: string,
		port: number,
		path: string,
		id: string,
		headers: Record<string, string>
	) =>
		new Promise<number>((res) => {
			const req = httpRequest(
				{
					host: '127.0.0.1',
					port,
					path,
					localAddress: from,
					headers: { ...headers, 'x-test-id': id }
				},
				(r) => {
					r.resume();
					r.on('end', () => res(r.statusCode ?? 0));
				}
			);
			req.on('error', () => res(0));
			req.end();
		});
	const VISITOR = '203.0.113.7';
	const FORGED = { 'x-real-ip': '6.6.6.6', 'x-forwarded-for': '6.6.6.6, 7.7.7.7' };
	const PATHS: Array<[string, number]> = [
		['/v1/health', 8081],
		['/relay/api', 8080],
		['/mcp', 8124]
	];
	/** What each upstream was told the client is. */
	const told = async (from: string, port: number, id: string, headers: Record<string, string>) => {
		const out: string[] = [];
		for (const [path, up] of PATHS) {
			const code = await get(from, port, path, `${id}${path}`, headers);
			const h = seen.find((s) => s.id === `${id}${path}` && s.port === up)?.h;
			out.push(
				!h
					? `${path}:no-request(${code})`
					: up === 8124
						? `${path}:xri=${h['x-real-ip'] ?? '-'},xff=${h['x-forwarded-for'] ?? '-'}`
						: `${path}:xff=${h['x-forwarded-for'] ?? '-'},xri=${h['x-real-ip'] ?? '-'}`
			);
		}
		return out;
	};
	const only = (addr: string, got: string[]): boolean =>
		got.length === 3 &&
		got[0] === `/v1/health:xff=${addr},xri=-` &&
		got[1] === `/relay/api:xff=${addr},xri=-` &&
		got[2] === `/mcp:xri=${addr},xff=${addr}`;

	for (const [label, from] of [
		["BunkerWeb on morphit.io's bridge (172.18.0.5)", '172.18.0.5'],
		['BunkerWeb on the Ansible bridge (172.20.0.5)', '172.20.0.5']
	] as const) {
		const got = await told(from, edgePort, `bw-${from}`, {
			'x-real-ip': VISITOR,
			'x-forwarded-for': `6.6.6.6, ${VISITOR}`
		});
		check(
			`${label}: relay, indexer and MCP see the visitor (${VISITOR}) alone`,
			only(VISITOR, got),
			got.join(' ')
		);
	}
	for (const [label, from, port] of [
		['Tor/I2P via the published port, from the 172.18 gateway', '172.18.0.1', 80],
		['Tor/I2P via the published port, from the 172.20 gateway', '172.20.0.1', 80],
		['Tor/I2P via the published port, from 127.0.0.1', '127.0.0.1', 80],
		['an onion-proxy container on the same bridge (172.18.0.7)', '172.18.0.7', 80],
		["a peer outside Docker's pool on the edge port (192.0.2.10)", '192.0.2.10', edgePort]
	] as const) {
		const got = await told(from, port, `x-${from}-${port}`, FORGED);
		check(
			`${label}: a forged X-Real-IP/X-Forwarded-For is ignored — they see ${from}`,
			only(from, got),
			got.join(' ')
		);
	}
	spawnSync('nginx', ['-c', join(work, 'nginx.conf'), '-s', 'stop']);
	for (const s of ups) s.close();
	rmSync(work, { recursive: true, force: true });
	finish();
}

void inNamespace();
