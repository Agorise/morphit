/**
 * Smoke test for morphit-mcp.
 *
 * Boots the MCP server as a child process, speaks the stdio
 * protocol directly (no SDK client — we want to verify the wire
 * surface), and checks the five core invariants:
 *
 *   1. ListTools advertises exactly 5 tools with stable names
 *   2. Each tool has a valid JSON Schema input
 *   3. CallTool with a bogus name returns isError=true
 *   4. CallTool with valid input but unreachable instance returns
 *      isError=true (with a useful error message)
 *   5. CallTool with describe + a working instance URL (mocked
 *      via an HTTP stub) returns content with the expected fields
 *
 * The MCP-SDK Server uses JSON-RPC 2.0 framed by Content-Length
 * headers when on stdio.  The SDK takes care of framing, so we
 * just send/receive JSON messages line by line.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import process from 'node:process';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

interface JsonRpcRequest {
	jsonrpc: '2.0';
	id: number;
	method: string;
	params?: unknown;
}

interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: number;
	result?: unknown;
	error?: { code: number; message: string };
}

interface ScenarioResult {
	name: string;
	passed: boolean;
	detail?: string;
}

const results: ScenarioResult[] = [];

function pass(name: string) {
	results.push({ name, passed: true });
}
function fail(name: string, detail: string) {
	results.push({ name, passed: false, detail });
}

/** Run an MCP server child process, send the request list, and
 *  collect the responses. */
async function runMcpDialog(
	requests: JsonRpcRequest[],
	instanceUrl: string
): Promise<JsonRpcResponse[]> {
	const child = spawn('node', ['dist/main.js'], {
		cwd: new URL('..', import.meta.url).pathname,
		env: {
			...process.env,
			MORPHIT_MCP_INSTANCE_URL: instanceUrl
		},
		stdio: ['pipe', 'pipe', 'pipe']
	});

	const responses: JsonRpcResponse[] = [];
	let buf = '';

	child.stdout.on('data', (chunk: Buffer) => {
		buf += chunk.toString('utf-8');
		// MCP stdio uses newline-delimited JSON (NDJSON), one
		// message per line.
		while (true) {
			const nl = buf.indexOf('\n');
			if (nl === -1) return;
			const line = buf.slice(0, nl).replace(/\r$/, '');
			buf = buf.slice(nl + 1);
			if (!line.trim()) continue;
			try {
				responses.push(JSON.parse(line));
			} catch {
				// ignore non-JSON lines (debug output, etc.)
			}
		}
	});

	// Initialize handshake (required by the MCP protocol).
	const initReq: JsonRpcRequest = {
		jsonrpc: '2.0',
		id: 0,
		method: 'initialize',
		params: {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: { name: 'smoke-test', version: '0.0.0' }
		}
	};
	for (const req of [initReq, ...requests]) {
		child.stdin.write(JSON.stringify(req) + '\n');
	}

	// Wait up to 5s for all requests + initialize to respond.
	const deadline = Date.now() + 5_000;
	while (responses.length < requests.length + 1 && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 50));
	}

	child.kill('SIGTERM');
	try {
		await once(child, 'exit');
	} catch {
		// ignore
	}

	// Drop the initialize response, return only the test ones.
	return responses.filter((r) => r.id !== 0);
}

async function main() {
	console.log('── morphit-mcp smoke ───────────────────────────────────');

	// Stand up a stub indexer for tests that need a working instance.
	const stub = createServer((req, res) => {
		if (req.url === '/v1/instance') {
			res.setHeader('Content-Type', 'application/json');
			res.end(
				JSON.stringify({
					display_name: 'smoke-test instance',
					contact_url: 'mailto:smoke@example.org',
					declared_region: 'us-east'
				})
			);
		} else if (req.url?.startsWith('/v1/orderbook')) {
			res.setHeader('Content-Type', 'application/json');
			res.end(
				JSON.stringify({
					rows: [
						{
							account: 'alice',
							permlink: 'sell-xmr-cash-001',
							asset: 'XMR',
							side: 'sell',
							fiat_currency: 'USD',
							price: '152.40',
							amount_min: '0.5',
							amount_max: '5.0',
							location_region: 'US-CA',
							payment_methods: 'cash,bank_transfer',
							feedback_count: 12,
							weighted_rating: 4.8,
							is_new_trader: false,
							updated_at: '2026-05-26T00:00:00Z',
							// fields that should be trimmed:
							internal_indexer_seq: 999,
							row_hash: 'deadbeef'
						}
					],
					next_cursor: null
				})
			);
		} else {
			res.statusCode = 404;
			res.end('not found');
		}
	});
	stub.listen(0, '127.0.0.1');
	await once(stub, 'listening');
	const addr = stub.address();
	if (!addr || typeof addr === 'string') throw new Error('stub no addr');
	const stubUrl = `http://127.0.0.1:${addr.port}`;

	// Scenario 1: ListTools advertises exactly 5 tools.
	const listResp = await runMcpDialog(
		[{ jsonrpc: '2.0', id: 1, method: 'tools/list' }],
		stubUrl
	);
	const tools = (listResp[0]?.result as { tools?: Array<{ name: string }> })?.tools || [];
	const expected = new Set([
		'morphit_search_orders',
		'morphit_list_instances',
		'morphit_list_payment_methods',
		'morphit_get_listing',
		'morphit_describe'
	]);
	if (tools.length === 5 && tools.every((t) => expected.has(t.name))) {
		pass('ListTools advertises exactly the 5 expected tools');
	} else {
		fail(
			'ListTools advertises exactly the 5 expected tools',
			`got ${tools.length}: ${tools.map((t) => t.name).join(',')}`
		);
	}

	// Scenario 2: each tool input schema declares "type":"object".
	const allObject = (listResp[0]?.result as { tools?: Array<{ inputSchema?: { type?: string } }> })?.tools?.every(
		(t) => t.inputSchema?.type === 'object'
	);
	if (allObject) {
		pass('every tool inputSchema is type=object');
	} else {
		fail('every tool inputSchema is type=object', 'one or more missing');
	}

	// Scenario 3: bogus tool name → isError=true.
	const bogus = await runMcpDialog(
		[
			{
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/call',
				params: { name: 'morphit_does_not_exist', arguments: {} }
			}
		],
		stubUrl
	);
	const bogusResult = bogus[0]?.result as { isError?: boolean } | undefined;
	if (bogusResult?.isError === true) {
		pass('bogus tool name returns isError=true');
	} else {
		fail('bogus tool name returns isError=true', JSON.stringify(bogus[0]));
	}

	// Scenario 4: unreachable instance → isError=true with message.
	const unreachable = await runMcpDialog(
		[
			{
				jsonrpc: '2.0',
				id: 3,
				method: 'tools/call',
				params: { name: 'morphit_search_orders', arguments: { asset: 'XMR' } }
			}
		],
		'http://127.0.0.1:1' // port 1 is reserved; should fail fast
	);
	const unreachResult = unreachable[0]?.result as
		| { isError?: boolean; content?: Array<{ text?: string }> }
		| undefined;
	if (unreachResult?.isError === true && unreachResult.content?.[0]?.text) {
		pass('unreachable instance returns isError with diagnostic');
	} else {
		fail(
			'unreachable instance returns isError with diagnostic',
			JSON.stringify(unreachable[0])
		);
	}

	// Scenario 5: working stub + describe returns expected shape.
	const describe = await runMcpDialog(
		[
			{
				jsonrpc: '2.0',
				id: 4,
				method: 'tools/call',
				params: { name: 'morphit_describe', arguments: {} }
			}
		],
		stubUrl
	);
	const descResult = describe[0]?.result as
		| { content?: Array<{ text?: string }> }
		| undefined;
	const descText = descResult?.content?.[0]?.text;
	if (
		descText &&
		descText.includes('"non_custodial": true') &&
		descText.includes('"kyc_required": false') &&
		descText.includes('"federated": true') &&
		descText.includes('"on_chain": "Blurt"') &&
		descText.includes('"supported_assets"')
	) {
		pass('describe returns expected fields');
	} else {
		fail('describe returns expected fields', descText?.slice(0, 200) || 'no text');
	}

	// Scenario 6: searchOrders trims internal fields.
	const search = await runMcpDialog(
		[
			{
				jsonrpc: '2.0',
				id: 5,
				method: 'tools/call',
				params: { name: 'morphit_search_orders', arguments: { asset: 'XMR' } }
			}
		],
		stubUrl
	);
	const searchResult = search[0]?.result as
		| { content?: Array<{ text?: string }> }
		| undefined;
	const searchText = searchResult?.content?.[0]?.text;
	if (
		searchText &&
		searchText.includes('"account": "alice"') &&
		searchText.includes('"asset": "XMR"') &&
		!searchText.includes('internal_indexer_seq') &&
		!searchText.includes('row_hash') &&
		searchText.includes('"deeplink":')
	) {
		pass('search trims internal fields and emits deeplink');
	} else {
		fail(
			'search trims internal fields and emits deeplink',
			searchText?.slice(0, 300) || 'no text'
		);
	}

	// Scenario 7: invalid input (bad enum) → isError.
	const badInput = await runMcpDialog(
		[
			{
				jsonrpc: '2.0',
				id: 6,
				method: 'tools/call',
				params: {
					name: 'morphit_search_orders',
					arguments: { asset: 'DOGE_FAKE' }
				}
			}
		],
		stubUrl
	);
	const badResult = badInput[0]?.result as { isError?: boolean } | undefined;
	if (badResult?.isError === true) {
		pass('invalid asset enum rejected with isError');
	} else {
		fail('invalid asset enum rejected with isError', JSON.stringify(badInput[0]));
	}

	// Scenario 8: deeplink is well-formed URL pointing at stub.
	if (
		searchText &&
		/"deeplink":\s*"http:\/\/127\.0\.0\.1:\d+\/en\/orderbook\?asset=XMR"/.test(searchText)
	) {
		pass('deeplink is well-formed URL with filter preserved');
	} else {
		fail(
			'deeplink is well-formed URL with filter preserved',
			searchText?.match(/"deeplink":\s*"[^"]+"/)?.[0] || 'no deeplink'
		);
	}

	stub.close();

	// Report.
	console.log('');
	for (const r of results) {
		const mark = r.passed ? `${ANSI_GREEN}✓${ANSI_RESET}` : `${ANSI_RED}✗${ANSI_RESET}`;
		console.log(`  ${mark} ${r.name}`);
		if (!r.passed && r.detail) {
			console.log(`      ${r.detail}`);
		}
	}
	const failed = results.filter((r) => !r.passed).length;
	console.log('');
	console.log('──────────────────────────────────────────────────────');
	if (failed === 0) {
		console.log(`✓ all ${results.length} scenarios passed`);
	} else {
		console.log(`✗ ${failed}/${results.length} scenarios failed`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('smoke fatal:', err);
	process.exit(1);
});
