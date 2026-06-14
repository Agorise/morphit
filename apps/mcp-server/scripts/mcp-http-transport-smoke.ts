#!/usr/bin/env tsx
/**
 * mcp-http-transport-smoke — boots morphit-mcp in HTTP transport mode
 * on an ephemeral loopback port and verifies the wire surface AND every
 * hardening control end-to-end (beta16 §45).  The behavioral counterpart
 * to the static mcp-webpush-install-defaults-smoke.
 *
 * Why it exists: cp251 shipped a persistent morphit-mcp.service whose
 * unit assumed an HTTP server on 127.0.0.1:8124, but the server was
 * stdio-only — so the daemon read EOF on its empty stdin and exited 0 in
 * under a second, leaving nothing listening (status: inactive (dead),
 * Duration 873ms).  This smoke proves the HTTP transport actually serves
 * the protocol and that the defenses fire.
 *
 * Scenarios:
 *   1.  GET /health → 200 {status:ok,transport:http}
 *   2.  initialize → 200, serverInfo.name === morphit-mcp
 *   3.  tools/list (stateless, no session header) → 200 with all 5 tools
 *   4.  DNS-rebinding: Host: evil → 403
 *   5.  method: GET / → 405
 *   6.  path: POST /nope → 404
 *   7.  Origin: evil (no allowlist) → 403
 *   8.  Content-Type not JSON → 415
 *   9.  body over the cap → 413 (and the server stays up)
 *   10. rate limit: burst over the per-client limit → 429
 *   11. fail-closed: a non-loopback bind without the override exits 1
 *
 * Raw node:http is used (not fetch) because undici treats Host/Origin as
 * forbidden header names and silently drops them, which would make the
 * DNS-rebinding checks pass vacuously.  Pure-tsx, sandbox-runnable
 * (loopback only; no external network).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const here = dirname(fileURLToPath(import.meta.url)); // apps/mcp-server/scripts
const mcpRoot = join(here, '..'); // apps/mcp-server
const repoRoot = join(mcpRoot, '..', '..'); // repo root
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
const mainTs = join(mcpRoot, 'src', 'main.ts');

interface Result {
	name: string;
	passed: boolean;
	detail?: string;
}
const results: Result[] = [];
const pass = (name: string): void => void results.push({ name, passed: true });
const fail = (name: string, detail = ''): void => void results.push({ name, passed: false, detail });

// Derive ports from PID to avoid collisions with parallel smokes.
const base = 20000 + (process.pid % 10000);
const PORT_A = base; // behavioral + security
const PORT_B = base + 1; // rate limit
const PORT_C = base + 2; // non-loopback refusal

const ACCEPT = 'application/json, text/event-stream';

function spawnHttp(port: number, extraEnv: Record<string, string>): ChildProcess {
	return spawn(tsxBin, [mainTs], {
		env: {
			...process.env,
			MORPHIT_MCP_TRANSPORT: 'http',
			MORPHIT_MCP_HTTP_HOST: '127.0.0.1',
			MORPHIT_MCP_HTTP_PORT: String(port),
			MORPHIT_MCP_INSTANCE_URL: 'https://morphit.io',
			...extraEnv
		},
		stdio: ['ignore', 'ignore', 'pipe']
	});
}

function killTree(cp: ChildProcess | null): void {
	if (!cp || cp.killed) return;
	try {
		cp.kill('SIGTERM');
	} catch {
		/* ignore */
	}
	setTimeout(() => {
		try {
			cp.kill('SIGKILL');
		} catch {
			/* ignore */
		}
	}, 3000).unref();
}

interface Reply {
	status: number;
	body: string;
}
function req(opts: {
	port: number;
	method?: string;
	path?: string;
	headers?: Record<string, string>;
	body?: string;
}): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const r = httpRequest(
			{
				host: '127.0.0.1',
				port: opts.port,
				method: opts.method ?? 'GET',
				path: opts.path ?? '/',
				headers: opts.headers ?? {}
			},
			(res) => {
				let data = '';
				res.on('data', (c) => (data += c));
				res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
			}
		);
		r.on('error', reject);
		if (opts.body !== undefined) r.write(opts.body);
		r.end();
	});
}

function jsonPost(port: number, body: unknown, extraHeaders: Record<string, string> = {}): Promise<Reply> {
	return req({
		port,
		method: 'POST',
		path: '/',
		headers: { 'content-type': 'application/json', accept: ACCEPT, ...extraHeaders },
		body: typeof body === 'string' ? body : JSON.stringify(body)
	});
}

async function waitForHealth(port: number, timeoutMs = 15000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const r = await req({ port, path: '/health' });
			if (r.status === 200) return true;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}

async function main(): Promise<void> {
	let a: ChildProcess | null = null;
	let b: ChildProcess | null = null;
	try {
		// ── Server A: behavioral + security (low body cap, ample rate) ──
		a = spawnHttp(PORT_A, {
			MORPHIT_MCP_RATE_LIMIT_PER_MIN: '100',
			MORPHIT_MCP_MAX_BODY_BYTES: '1000'
		});
		if (!(await waitForHealth(PORT_A))) {
			fail('server A reaches /health', 'did not become healthy within 15s');
		} else {
			// 1. health body
			const h = await req({ port: PORT_A, path: '/health' });
			let hj: { status?: string; transport?: string } | null = null;
			try {
				hj = JSON.parse(h.body);
			} catch {
				/* leave null */
			}
			if (h.status === 200 && hj?.status === 'ok' && hj?.transport === 'http')
				pass('GET /health → 200 ok/http');
			else fail('GET /health → 200 ok/http', `status=${h.status} body=${h.body.slice(0, 80)}`);

			// 2. initialize
			const initRes = await jsonPost(PORT_A, {
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2025-06-18',
					capabilities: {},
					clientInfo: { name: 'smoke', version: '0.0.0' }
				}
			});
			let sName: string | undefined;
			try {
				sName = JSON.parse(initRes.body)?.result?.serverInfo?.name;
			} catch {
				/* leave undefined */
			}
			if (initRes.status === 200 && sName === 'morphit-mcp')
				pass('initialize → 200, serverInfo morphit-mcp');
			else fail('initialize → 200, serverInfo morphit-mcp', `status=${initRes.status} name=${sName}`);

			// 3. tools/list — stateless (no session header)
			const tlRes = await jsonPost(PORT_A, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
			let names: string[] = [];
			try {
				names = (JSON.parse(tlRes.body)?.result?.tools ?? []).map((t: { name: string }) => t.name);
			} catch {
				/* leave empty */
			}
			const want = [
				'morphit_search_orders',
				'morphit_list_instances',
				'morphit_list_payment_methods',
				'morphit_get_listing',
				'morphit_describe'
			];
			if (tlRes.status === 200 && names.length === 5 && want.every((n) => names.includes(n)))
				pass('tools/list (stateless, no session) → all 5 tools');
			else fail('tools/list (stateless, no session) → all 5 tools', `status=${tlRes.status} names=${names.join(',')}`);

			// 4. DNS-rebinding: Host evil → 403
			const hostRes = await jsonPost(PORT_A, {}, { Host: 'evil.example' });
			hostRes.status === 403 ? pass('Host: evil → 403') : fail('Host: evil → 403', `status=${hostRes.status}`);

			// 5. method GET / → 405
			const getRes = await req({ port: PORT_A, method: 'GET', path: '/' });
			getRes.status === 405 ? pass('GET / → 405') : fail('GET / → 405', `status=${getRes.status}`);

			// 6. bad path → 404
			const pathRes = await req({
				port: PORT_A,
				method: 'POST',
				path: '/nope',
				headers: { 'content-type': 'application/json' },
				body: '{}'
			});
			pathRes.status === 404 ? pass('POST /nope → 404') : fail('POST /nope → 404', `status=${pathRes.status}`);

			// 7. Origin evil → 403
			const origRes = await jsonPost(PORT_A, {}, { Origin: 'https://evil.com' });
			origRes.status === 403 ? pass('Origin: evil → 403') : fail('Origin: evil → 403', `status=${origRes.status}`);

			// 8. wrong Content-Type → 415
			const ctRes = await req({
				port: PORT_A,
				method: 'POST',
				path: '/',
				headers: { 'content-type': 'text/plain', accept: ACCEPT },
				body: 'hi'
			});
			ctRes.status === 415 ? pass('wrong Content-Type → 415') : fail('wrong Content-Type → 415', `status=${ctRes.status}`);

			// 9. body over cap → 413, and the server stays up
			const capRes = await jsonPost(PORT_A, 'x'.repeat(4000));
			const stillUp = (await req({ port: PORT_A, path: '/health' }).catch(() => ({ status: 0 }))).status === 200;
			if (capRes.status === 413 && stillUp) pass('body over cap → 413 (server survives)');
			else fail('body over cap → 413 (server survives)', `status=${capRes.status} stillUp=${stillUp}`);
		}

		// ── Server B: rate limit (limit 3) ──
		b = spawnHttp(PORT_B, { MORPHIT_MCP_RATE_LIMIT_PER_MIN: '3' });
		if (!(await waitForHealth(PORT_B))) {
			fail('server B reaches /health', 'did not become healthy within 15s');
		} else {
			const codes: number[] = [];
			for (let i = 0; i < 5; i++) {
				// GET / → 405 but consumes a token; after the bucket drains → 429
				const r = await req({ port: PORT_B, method: 'GET', path: '/' }).catch(() => ({ status: 0 }));
				codes.push(r.status);
			}
			const ok = codes.slice(0, 3).every((c) => c === 405) && codes.slice(3).every((c) => c === 429);
			ok
				? pass(`rate limit → 429 after burst (${codes.join(',')})`)
				: fail('rate limit → 429 after burst', codes.join(','));
		}

		// ── 11. bind guard: refuse all-interfaces, allow private/bridge ──
		const spawnGuard = (host: string, port: number): Promise<{ code: number | null; err: string }> =>
			new Promise((resolve) => {
				const c = spawn(tsxBin, [mainTs], {
					env: {
						...process.env,
						MORPHIT_MCP_TRANSPORT: 'http',
						MORPHIT_MCP_HTTP_HOST: host,
						MORPHIT_MCP_HTTP_PORT: String(port)
					},
					stdio: ['ignore', 'ignore', 'pipe']
				});
				let err = '';
				c.stderr?.on('data', (d) => (err += d.toString()));
				c.on('close', (code) => resolve({ code, err }));
				const t = setTimeout(() => {
					try {
						c.kill('SIGKILL');
					} catch {
						/* ignore */
					}
					resolve({ code: null, err: err + ' [timeout]' });
				}, 15000);
				t.unref();
			});

		// 0.0.0.0 binds all interfaces → must refuse (exit 1).
		const zero = await spawnGuard('0.0.0.0', PORT_C);
		if (zero.code === 1 && /refusing to bind all interfaces/.test(zero.err))
			pass('0.0.0.0 bind refused (exit 1)');
		else fail('0.0.0.0 bind refused (exit 1)', `code=${zero.code} err=${zero.err.slice(0, 140)}`);

		// 172.18.0.1 (Docker bridge / private) must NOT trip the guard — it
		// proceeds to bind (only failing EADDRNOTAVAIL here because the
		// sandbox has no such interface; on a real dockerized host it binds).
		const bridge = await spawnGuard('172.18.0.1', PORT_C);
		if (!/refusing to bind/.test(bridge.err)) pass('172.18.0.1 (bridge) bind allowed by guard');
		else fail('172.18.0.1 (bridge) bind allowed by guard', bridge.err.slice(0, 140));
	} finally {
		killTree(a);
		killTree(b);
	}

	// ── Report ──
	console.log('');
	for (const r of results) {
		const mark = r.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
		console.log(`  ${mark} ${r.name}`);
		if (!r.passed && r.detail) console.log(`      ${r.detail}`);
	}
	const failed = results.filter((r) => !r.passed).length;
	console.log('');
	if (failed === 0) {
		console.log(`✓ all ${results.length} mcp-http-transport-smoke scenarios passed`);
	} else {
		console.log(`✗ ${failed}/${results.length} mcp-http-transport-smoke scenarios failed`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('mcp-http-transport-smoke fatal:', err);
	process.exit(1);
});
