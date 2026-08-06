/**
 * fetchJson body-cap smoke (cp151 F-mcp-5).
 *
 * Verifies the response-body size cap in `fetchJson()`:
 *
 *   1. Normal under-cap response → returns parsed JSON cleanly.
 *   2. Honest server declares Content-Length exceeding the cap
 *      → fetchJson throws BEFORE reading any body bytes.
 *   3. Dishonest server streams chunks past the cap without
 *      declaring Content-Length → fetchJson throws once the
 *      running total crosses the cap, aborts the fetch.
 *
 * The cap is configurable via `MORPHIT_MCP_MAX_BODY_BYTES`.
 * This smoke sets a low cap (8 KB) so we can simulate the
 * over-cap cases without allocating actual MB of memory.
 *
 * Threat: a malicious instance operator returns a multi-GB
 * response, exhausting Charlie's heap.  cp146 fixed
 * redirect-follow + URL-redaction; cp151 closes the last
 * size-vector by capping the body.
 */

import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { fetchJson, buildV1Url } from '../src/indexerClient.js';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

interface Result {
	name: string;
	passed: boolean;
	detail?: string;
}
const results: Result[] = [];
function pass(name: string) {
	results.push({ name, passed: true });
}
function fail(name: string, detail: string) {
	results.push({ name, passed: false, detail });
}

const CAP_FOR_TEST = 8 * 1024; // 8 KB — small enough to trigger fast

/**
 * Spin up a one-shot HTTP server that responds with the
 * given handler.  Returns the server + base URL.  Caller is
 * responsible for `server.close()` at the end of each scenario.
 */
async function startServer(
	handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
): Promise<{ server: Server; baseUrl: string }> {
	const server = createServer(handler);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const addr = server.address();
	if (!addr || typeof addr !== 'object') {
		throw new Error('server.address() returned non-object');
	}
	const baseUrl = `http://127.0.0.1:${addr.port}`;
	return { server, baseUrl };
}

async function main() {
	// Override env var so getInstanceUrl() and the cap respect
	// our test values.  Restore at end.
	const originalUrl = process.env.MORPHIT_MCP_INSTANCE_URL;
	const originalCap = process.env.MORPHIT_MCP_MAX_BODY_BYTES;
	const originalAllowPrivate = process.env.MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE;
	process.env.MORPHIT_MCP_MAX_BODY_BYTES = String(CAP_FOR_TEST);
	// cp154 F-mcp-1 — startServer binds to 127.0.0.1 which is in
	// the private-address denylist getInstanceUrl() enforces by
	// default.  Opt in to allow the loopback URL.
	process.env.MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE = '1';

	try {
		/* ============= Scenario 1: normal under-cap response ============= */

		{
			const { server, baseUrl } = await startServer((_req, res) => {
				const body = JSON.stringify({ orders: [{ asset: 'BTC', side: 'sell' }] });
				res.writeHead(200, {
					'Content-Type': 'application/json',
					'Content-Length': String(Buffer.byteLength(body))
				});
				res.end(body);
			});
			process.env.MORPHIT_MCP_INSTANCE_URL = baseUrl;
			try {
				const url = buildV1Url('/orders');
				const data = (await fetchJson(url)) as { orders: Array<{ asset: string }> };
				if (data?.orders?.[0]?.asset === 'BTC') {
					pass('normal under-cap response returns parsed JSON');
				} else {
					fail(
						'normal under-cap response returns parsed JSON',
						`expected orders[0].asset === 'BTC', got: ${JSON.stringify(data)}`
					);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				fail(
					'normal under-cap response returns parsed JSON',
					`unexpected throw: ${msg}`
				);
			} finally {
				server.close();
				await once(server, 'close');
			}
		}

		/* ============= Scenario 2: Content-Length pre-check ============= */

		{
			let bytesWritten = 0;
			const { server, baseUrl } = await startServer((_req, res) => {
				// Claim a size 10× our cap.  Body itself isn't read
				// because the pre-check should fire first.
				res.writeHead(200, {
					'Content-Type': 'application/json',
					'Content-Length': String(CAP_FOR_TEST * 10)
				});
				// Don't actually send the body; the client should
				// abort before reading any.  We end immediately so
				// the connection closes cleanly.
				bytesWritten = 0;
				res.end();
			});
			process.env.MORPHIT_MCP_INSTANCE_URL = baseUrl;
			try {
				const url = buildV1Url('/orders');
				await fetchJson(url);
				fail(
					'Content-Length pre-check rejects over-cap declaration',
					'fetchJson resolved when it should have thrown'
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes('declares') && msg.includes('cap is')) {
					pass(
						'Content-Length pre-check rejects over-cap declaration'
					);
				} else {
					fail(
						'Content-Length pre-check rejects over-cap declaration',
						`expected cap-violation error, got: ${msg}`
					);
				}
			} finally {
				server.close();
				await once(server, 'close');
				void bytesWritten;
			}
		}

		/* ============= Scenario 3: streaming overflow ============= */

		{
			const { server, baseUrl } = await startServer((_req, res) => {
				// Use chunked transfer (no Content-Length) so the
				// pre-check can't catch this; the streaming reader
				// must catch it.
				res.writeHead(200, { 'Content-Type': 'application/json' });
				// Send chunks of 1 KB until we exceed the cap.
				// Cap is 8 KB; we send 12 KB total.
				let sent = 0;
				const chunk = Buffer.alloc(1024, 0x20); // spaces
				const interval = setInterval(() => {
					if (sent >= 12 * 1024) {
						clearInterval(interval);
						res.end();
						return;
					}
					res.write(chunk);
					sent += 1024;
				}, 5);
			});
			process.env.MORPHIT_MCP_INSTANCE_URL = baseUrl;
			try {
				const url = buildV1Url('/orders');
				await fetchJson(url);
				fail(
					'streaming-overflow check rejects body exceeding cap',
					'fetchJson resolved when it should have thrown'
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes('exceeded body cap') || msg.includes('cap is')) {
					pass('streaming-overflow check rejects body exceeding cap');
				} else {
					fail(
						'streaming-overflow check rejects body exceeding cap',
						`expected cap-violation error, got: ${msg}`
					);
				}
			} finally {
				server.close();
				await once(server, 'close');
			}
		}
	} finally {
		if (originalUrl === undefined) delete process.env.MORPHIT_MCP_INSTANCE_URL;
		else process.env.MORPHIT_MCP_INSTANCE_URL = originalUrl;
		if (originalCap === undefined) delete process.env.MORPHIT_MCP_MAX_BODY_BYTES;
		else process.env.MORPHIT_MCP_MAX_BODY_BYTES = originalCap;
		if (originalAllowPrivate === undefined) delete process.env.MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE;
		else process.env.MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE = originalAllowPrivate;
	}

	/* ============= report ============= */

	let failed = 0;
	for (const r of results) {
		if (r.passed) {
			console.log(`  ${ANSI_GREEN}✓${ANSI_RESET} ${r.name}`);
		} else {
			console.log(`  ${ANSI_RED}✗${ANSI_RESET} ${r.name}`);
			if (r.detail) console.log(`      ${r.detail}`);
			failed++;
		}
	}

	console.log();
	console.log('──────────────────────────────────────────────────────');
	if (failed > 0) {
		console.log(`✗ ${failed} of ${results.length} scenarios failed`);
		process.exit(1);
	} else {
		console.log(`✓ all ${results.length} scenarios passed`);
	}
}

void main();
