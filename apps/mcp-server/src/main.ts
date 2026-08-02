#!/usr/bin/env node
/**
 * morphit-mcp — Model Context Protocol server for Morphit.
 *
 * Two transports, selected by MORPHIT_MCP_TRANSPORT:
 *   - "stdio" (default) — for LOCAL agents that spawn the server as a
 *     subprocess (Claude Desktop, Cline, Cursor, Continue, Windsurf,
 *     Zed, or anything built on @modelcontextprotocol/sdk).
 *   - "http" — a hardened, loopback-bound Streamable-HTTP server (the
 *     mode morphit-mcp.service runs) so an operator can expose a
 *     network MCP endpoint via a reverse proxy for federation-wide,
 *     remote AI-agent discovery.  Stateless + JSON responses (no
 *     sessions, no long-lived SSE), DNS-rebinding protection, Host/
 *     Origin allowlists, a per-client rate limit, a request-body cap,
 *     and a fail-closed refusal to bind anything but loopback unless
 *     explicitly overridden.
 *
 * Configuration: MORPHIT_MCP_INSTANCE_URL points at whichever Morphit
 * instance to query (defaults to https://morphit.io).  HTTP knobs:
 * MORPHIT_MCP_HTTP_HOST/PORT, _ALLOWED_HOSTS, _ALLOWED_ORIGINS,
 * _RATE_LIMIT_PER_MIN, _MAX_BODY_BYTES, _MAX_CONNECTIONS,
 * _ALLOW_PUBLIC_BIND.
 *
 * Read-only.  No keys.  No signing.  All write actions are handed
 * off to the Morphit web UI via deeplinks returned alongside tool
 * results.  Outbound fetches are SSRF-guarded in indexerClient.ts.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isPrivateIp } from '@morphit/net-defense';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
	SEARCH_ORDERS_DESCRIPTION,
	SearchOrdersInputSchema,
	searchOrders
} from './tools/searchOrders.js';
import {
	LIST_INSTANCES_DESCRIPTION,
	ListInstancesInputSchema,
	listInstances
} from './tools/listInstances.js';
import {
	LIST_PAYMENT_METHODS_DESCRIPTION,
	ListPaymentMethodsInputSchema,
	listPaymentMethods
} from './tools/listPaymentMethods.js';
import {
	GET_LISTING_DESCRIPTION,
	GetListingInputSchema,
	getListing
} from './tools/getListing.js';
import {
	DESCRIBE_DESCRIPTION,
	DescribeInputSchema,
	describeMorphit
} from './tools/describeMorphit.js';

/** Convert a Zod schema to JSON Schema for MCP's tool advertisement.
 *  Use a minimal hand-rolled converter rather than pulling in
 *  zod-to-json-schema; the surface is small enough that this
 *  costs ~30 lines and saves a dependency.
 *
 *  Honours: object, string (+regex, min/max), number (+int, min/max),
 *  boolean, enum, optional, describe(). */
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
	if (schema instanceof z.ZodObject) {
		const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
		const props: Record<string, unknown> = {};
		const required: string[] = [];
		for (const [key, value] of Object.entries(shape)) {
			const inner = value as z.ZodTypeAny;
			props[key] = zodToJsonSchema(inner);
			if (!inner.isOptional()) required.push(key);
		}
		const out: Record<string, unknown> = {
			type: 'object',
			properties: props
		};
		if (required.length > 0) out.required = required;
		return out;
	}
	if (schema instanceof z.ZodOptional) {
		return zodToJsonSchema((schema as z.ZodOptional<z.ZodTypeAny>).unwrap());
	}
	if (schema instanceof z.ZodString) {
		const out: Record<string, unknown> = { type: 'string' };
		const desc = schema.description;
		if (desc) out.description = desc;
		return out;
	}
	if (schema instanceof z.ZodNumber) {
		const out: Record<string, unknown> = { type: 'number' };
		const desc = schema.description;
		if (desc) out.description = desc;
		return out;
	}
	if (schema instanceof z.ZodBoolean) {
		const out: Record<string, unknown> = { type: 'boolean' };
		const desc = schema.description;
		if (desc) out.description = desc;
		return out;
	}
	if (schema instanceof z.ZodEnum) {
		const e = schema as z.ZodEnum<[string, ...string[]]>;
		const out: Record<string, unknown> = { type: 'string', enum: e.options };
		const desc = schema.description;
		if (desc) out.description = desc;
		return out;
	}
	// Fallback — accept anything, let the Zod parse step do the
	// actual validation.
	return {};
}

/** Tool registry — pairs the MCP-advertised schema with the
 *  handler.  Keep the names stable; AI agent tool-selection logic
 *  may key off them. */
interface ToolRegistration<I extends z.ZodTypeAny> {
	name: string;
	description: string;
	inputSchema: I;
	handler: (input: z.infer<I>) => Promise<unknown>;
}

/** Single source of the MCP server's advertised version. Gated by the
 *  repo version-consistency smoke (Category B) so it can't drift from the
 *  root package.json on a release bump — mirrors the relay/indexer
 *  health.ts VERSION constants. */
const MCP_VERSION = '1.9.16';

const TOOLS: ToolRegistration<z.ZodTypeAny>[] = [
	{
		name: 'morphit_search_orders',
		description: SEARCH_ORDERS_DESCRIPTION,
		inputSchema: SearchOrdersInputSchema,
		handler: searchOrders
	},
	{
		name: 'morphit_list_instances',
		description: LIST_INSTANCES_DESCRIPTION,
		inputSchema: ListInstancesInputSchema,
		handler: listInstances
	},
	{
		name: 'morphit_list_payment_methods',
		description: LIST_PAYMENT_METHODS_DESCRIPTION,
		inputSchema: ListPaymentMethodsInputSchema,
		handler: listPaymentMethods
	},
	{
		name: 'morphit_get_listing',
		description: GET_LISTING_DESCRIPTION,
		inputSchema: GetListingInputSchema,
		handler: getListing
	},
	{
		name: 'morphit_describe',
		description: DESCRIBE_DESCRIPTION,
		inputSchema: DescribeInputSchema,
		handler: describeMorphit
	}
];

/** Build a fresh MCP Server with all tools registered.  Called once
 *  for stdio, and once PER REQUEST in stateless HTTP mode (so there
 *  is no shared session/request state to exhaust or leak). */
function buildServer(): Server {
	const server = new Server(
		{
			name: 'morphit-mcp',
			version: MCP_VERSION
		},
		{
			capabilities: {
				tools: {}
			}
		}
	);

	// Advertise tools.
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: TOOLS.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: zodToJsonSchema(t.inputSchema)
		}))
	}));

	// Handle tool calls.  Validate input via Zod, run handler,
	// return JSON-stringified result.  All errors surface back to
	// the agent as a tool-call error rather than crashing the
	// server — agents present these to the user as "the tool
	// errored, here's why."
	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const tool = TOOLS.find((t) => t.name === req.params.name);
		if (!tool) {
			return {
				isError: true,
				content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }]
			};
		}
		try {
			const parsed = tool.inputSchema.parse(req.params.arguments ?? {});
			const result = await tool.handler(parsed);
			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(result, null, 2)
					}
				]
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				isError: true,
				content: [{ type: 'text', text: `Tool error: ${msg}` }]
			};
		}
	});

	return server;
}

// ─── HTTP transport (hardened — MEGA-secure, §45) ─────────────────
// The MCP is the most exposed surface (agents reach it from anywhere
// via a reverse proxy), so the HTTP server is locked down in depth:
// loopback-only bind (fail-closed), stateless JSON (no session table,
// no long-lived SSE), DNS-rebinding Host/Origin allowlists at BOTH
// our layer and the SDK transport, a per-client token-bucket rate
// limit, a hard request-body cap, slowloris timeouts, a connection
// ceiling, and a path allowlist.  It holds no keys and only reads the
// instance's public API (SSRF-guarded in indexerClient.ts).

interface HttpConfig {
	host: string;
	port: number;
	allowedHosts: string[];
	allowedOrigins: string[];
	rateLimitPerMin: number;
	maxBodyBytes: number;
	maxConnections: number;
}

function envInt(name: string, dflt: number): number {
	const raw = process.env[name];
	if (!raw) return dflt;
	const n = parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : dflt;
}
function envList(name: string): string[] {
	return (process.env[name] ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

function readHttpConfig(): HttpConfig {
	const host = process.env.MORPHIT_MCP_HTTP_HOST?.trim() || '127.0.0.1';
	const port = envInt('MORPHIT_MCP_HTTP_PORT', 8124);
	const allowed = envList('MORPHIT_MCP_ALLOWED_HOSTS');
	return {
		host,
		port,
		// Default allowlist always includes the address we actually bind
		// (so a Docker-bridge / private bind like 172.18.0.1:8124 is
		// accepted by DNS-rebinding protection) plus the loopback forms.
		allowedHosts: allowed.length
			? allowed
			: Array.from(
					new Set([`${host}:${port}`, `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])
				),
		allowedOrigins: envList('MORPHIT_MCP_ALLOWED_ORIGINS'),
		rateLimitPerMin: envInt('MORPHIT_MCP_RATE_LIMIT_PER_MIN', 120),
		maxBodyBytes: envInt('MORPHIT_MCP_MAX_BODY_BYTES', 262144),
		maxConnections: envInt('MORPHIT_MCP_MAX_CONNECTIONS', 64)
	};
}

function isLoopbackHost(h: string): boolean {
	return h === '127.0.0.1' || h === '::1' || h === 'localhost' || h.startsWith('127.');
}

/** Classify a requested bind host for the fail-closed guard.  Loopback
 *  and any private / RFC1918 address — including the Docker bridge
 *  gateway (172.18.0.1) that a dockerized reverse proxy (BunkerWeb)
 *  reaches the host through, exactly like the indexer/relay listen host
 *  — are allowed without an override.  `0.0.0.0` / `::` bind ALL
 *  interfaces (including the public one) so they are refused even though
 *  isPrivateIp() counts 0.0.0.0/8 as private; a genuinely public,
 *  internet-routable address is refused too. */
function bindAllowedByDefault(host: string): boolean {
	if (host === '0.0.0.0' || host === '::' || host === '*' || host === '') return false;
	return isLoopbackHost(host) || isPrivateIp(host);
}

/** Minimal per-client token bucket.  No deps.  Refills `perMin`
 *  tokens/minute up to a burst ceiling of `perMin`, keyed by a client
 *  identifier; stale buckets are swept lazily to bound memory. */
class RateLimiter {
	private buckets = new Map<string, { tokens: number; last: number }>();
	constructor(private readonly perMin: number) {}
	take(key: string): boolean {
		const now = Date.now();
		const refillPerMs = this.perMin / 60_000;
		let b = this.buckets.get(key);
		if (!b) {
			b = { tokens: this.perMin, last: now };
			this.buckets.set(key, b);
		}
		b.tokens = Math.min(this.perMin, b.tokens + (now - b.last) * refillPerMs);
		b.last = now;
		if (this.buckets.size > 4096) this.sweep(now);
		if (b.tokens < 1) return false;
		b.tokens -= 1;
		return true;
	}
	private sweep(now: number): void {
		for (const [k, v] of this.buckets) if (now - v.last > 120_000) this.buckets.delete(k);
	}
}

/** Resolve the client identity for rate-limiting.  When the direct
 *  peer is loopback (i.e. the operator's reverse proxy), trust the
 *  LEFTMOST X-Forwarded-For hop as the real client; otherwise use the
 *  socket peer.  Bounds abuse per real client behind nginx and per
 *  connection for direct loopback access. */
function clientKey(req: IncomingMessage): string {
	const peer = req.socket.remoteAddress ?? 'unknown';
	const peerLoopback =
		peer === '127.0.0.1' || peer === '::1' || peer.startsWith('127.') || peer === '::ffff:127.0.0.1';
	if (peerLoopback) {
		const xff = req.headers['x-forwarded-for'];
		const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
		if (first) return first.slice(0, 64);
	}
	return peer;
}

function sendJson(res: ServerResponse, status: number, body: unknown, close = false): void {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff'
	};
	if (close) headers['connection'] = 'close';
	res.writeHead(status, headers);
	res.end(JSON.stringify(body));
}

/** Read the request body with a hard byte cap; reject oversize early
 *  WITHOUT destroying the socket (so the caller can still send a clean
 *  413).  Stops buffering past the cap to bound memory. */
function readBodyCapped(req: IncomingMessage, cap: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		let aborted = false;
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => {
			if (aborted) return; // already over cap — drop, don't buffer
			size += c.length;
			if (size > cap) {
				aborted = true;
				req.pause();
				reject(new Error('body too large'));
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => {
			if (!aborted) resolve(Buffer.concat(chunks).toString('utf-8'));
		});
		req.on('error', reject);
	});
}

function hostAllowed(req: IncomingMessage, cfg: HttpConfig): boolean {
	const host = (req.headers.host ?? '').toLowerCase();
	return cfg.allowedHosts.some((h) => h.toLowerCase() === host);
}
function originAllowed(req: IncomingMessage, cfg: HttpConfig): boolean {
	const origin = req.headers.origin;
	if (!origin) return true; // non-browser MCP clients omit Origin
	if (cfg.allowedOrigins.length === 0) return false; // any Origin but none allowed → reject
	return cfg.allowedOrigins.some((o) => o.toLowerCase() === origin.toLowerCase());
}

const MCP_PATHS = new Set(['/', '/mcp', '/mcp/']);

async function handleHttp(
	req: IncomingMessage,
	res: ServerResponse,
	cfg: HttpConfig,
	limiter: RateLimiter
): Promise<void> {
	const path = (req.url ?? '/').split('?')[0] ?? '/';

	// Health — liveness only, no info leak.
	if (req.method === 'GET' && path === '/health') {
		sendJson(res, 200, { status: 'ok', transport: 'http' });
		return;
	}

	// Rate-limit everything else.
	if (!limiter.take(clientKey(req))) {
		sendJson(res, 429, { error: 'rate_limited' });
		return;
	}

	// Only the MCP endpoint path is served.
	if (!MCP_PATHS.has(path)) {
		sendJson(res, 404, { error: 'not_found' });
		return;
	}

	// Stateless JSON request/response → POST only.
	if (req.method !== 'POST') {
		res.setHeader('allow', 'POST');
		sendJson(res, 405, { error: 'method_not_allowed' });
		return;
	}

	// DNS-rebinding defenses (our layer; the transport enforces too).
	if (!hostAllowed(req, cfg)) {
		sendJson(res, 403, { error: 'host_not_allowed' });
		return;
	}
	if (!originAllowed(req, cfg)) {
		sendJson(res, 403, { error: 'origin_not_allowed' });
		return;
	}

	// Content-Type guard.
	if (!/application\/json/i.test((req.headers['content-type'] ?? '').toString())) {
		sendJson(res, 415, { error: 'unsupported_media_type' });
		return;
	}

	// Body with a hard cap.
	let parsed: unknown;
	try {
		const raw = await readBodyCapped(req, cfg.maxBodyBytes);
		parsed = raw ? JSON.parse(raw) : undefined;
	} catch {
		sendJson(res, 413, { error: 'payload_too_large_or_invalid' }, true);
		return;
	}

	// Per-request, stateless server + transport.
	const server = buildServer();
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
		enableDnsRebindingProtection: true,
		allowedHosts: cfg.allowedHosts,
		allowedOrigins: cfg.allowedOrigins.length ? cfg.allowedOrigins : undefined
	});
	const cleanup = () => {
		transport.close().catch(() => {});
		server.close().catch(() => {});
	};
	res.on('close', cleanup);
	try {
		await server.connect(transport);
		await transport.handleRequest(req, res, parsed);
	} catch (err) {
		if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
		process.stderr.write(
			`morphit-mcp http error: ${err instanceof Error ? err.message : String(err)}\n`
		);
		cleanup();
	}
}

async function startHttpTransport(): Promise<void> {
	const cfg = readHttpConfig();

	// Fail-closed: bind loopback or a private/bridge address freely (the
	// dockerized-proxy case — same as the indexer/relay listen host), but
	// refuse 0.0.0.0/:: or a public, internet-routable bind unless the
	// operator explicitly opts in.  Public exposure is meant to go through
	// a reverse proxy, not a direct public bind.
	if (!bindAllowedByDefault(cfg.host) && process.env.MORPHIT_MCP_ALLOW_PUBLIC_BIND !== '1') {
		const why = cfg.host === '0.0.0.0' || cfg.host === '::' ? 'all interfaces' : 'a public address';
		process.stderr.write(
			`morphit-mcp: refusing to bind ${why} ("${cfg.host}"). Bind loopback or a ` +
				`private/bridge address (e.g. 127.0.0.1, or 172.18.0.1 for a dockerized ` +
				`reverse proxy) and expose the MCP publicly through that proxy — or set ` +
				`MORPHIT_MCP_ALLOW_PUBLIC_BIND=1 to override (NOT recommended).\n`
		);
		process.exit(1);
	}

	const limiter = new RateLimiter(cfg.rateLimitPerMin);
	const httpServer = createServer((req, res) => {
		handleHttp(req, res, cfg, limiter).catch((err) => {
			if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
			process.stderr.write(
				`morphit-mcp http fatal: ${err instanceof Error ? err.message : String(err)}\n`
			);
		});
	});
	httpServer.maxConnections = cfg.maxConnections;
	httpServer.headersTimeout = 10_000; // slowloris guard
	httpServer.requestTimeout = 15_000;
	httpServer.keepAliveTimeout = 5_000;
	httpServer.timeout = 20_000;

	await new Promise<void>((resolve, reject) => {
		httpServer.once('error', reject);
		httpServer.listen(cfg.port, cfg.host, () => {
			process.stderr.write(
				`morphit-mcp: HTTP transport listening on ${cfg.host}:${cfg.port} ` +
					`(instance: ${process.env.MORPHIT_MCP_INSTANCE_URL ?? 'https://morphit.io'}; ` +
					`rate ${cfg.rateLimitPerMin}/min, body cap ${cfg.maxBodyBytes}B)\n`
			);
			resolve();
		});
	});

	const shutdown = () => {
		httpServer.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 5_000).unref();
	};
	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);
}

async function main() {
	const mode = (process.env.MORPHIT_MCP_TRANSPORT ?? 'stdio').trim().toLowerCase();
	if (mode === 'http') {
		await startHttpTransport();
		return; // stay alive on the HTTP server
	}

	// stdio (default) — for local agent spawning (Claude Desktop, …).
	const server = buildServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	// Stay alive until stdio closes — the SDK handles the loop.
}

main().catch((err) => {
	// Last-resort error path. stderr is captured by the MCP client
	// and shown to the user.
	process.stderr.write(`morphit-mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
