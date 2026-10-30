/**
 * `morphit-ops mcp` (menu 17) says what it SAW, not what systemctl returned.
 * morphit-mcp.service is Type=simple: `enable --now` exits 0 as soon as the
 * process starts, whether or not it stays up — so "✓ enabled and started" was
 * printed for a server that crashed a moment later (M10). And a unit that is
 * crash-looping was offered "enable" (which changes nothing) instead of its
 * log (M10). Disabling it left the site advertising /mcp to AI agents (LOW).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceState } from '../src/commands/health.ts';

const { runMcp } = await import('../src/commands/mcp.ts');
const CTX = { flags: {}, positional: [], colorEnabled: false };

let out = '';
beforeEach(() => {
	out = '';
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		out += a.join(' ') + '\n';
	});
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

function states(...seq: ServiceState[]): (u: string) => ServiceState {
	let i = 0;
	return () => seq[Math.min(i++, seq.length - 1)]!;
}
const calls: string[] = [];
const exec = (cmd: string, args: readonly string[]) => {
	calls.push([cmd, ...args].join(' '));
	return { status: 0 };
};

describe('morphit-ops mcp', () => {
	it('enabled but it dies at once: ✗ with its log, exit 1 — never "✓ enabled and started"', async () => {
		const rc = await runMcp(CTX, {
			exec,
			readState: states('inactive', 'failed'),
			probeHealth: async () => false,
			journalTail: () => 'Error: Cannot find module tsx',
			confirm: async () => true,
			settleMs: 50
		});
		expect(rc).toBe(1);
		expect(out).toMatch(/did not stay up/);
		expect(out).toContain('Error: Cannot find module tsx');
		expect(out).not.toMatch(/✓ MCP server enabled/);
	});

	it('enabled and answering on its port: ✓, and the check to run later is `sudo morphit-ops health`', async () => {
		const rc = await runMcp(CTX, {
			exec,
			readState: states('inactive', 'active'),
			probeHealth: async () => true,
			confirm: async () => true,
			settleMs: 50
		});
		expect(rc).toBe(0);
		expect(out).toMatch(/✓ MCP server enabled, running and answering on 127\.0\.0\.1:\d+/);
		expect(out).toContain('sudo morphit-ops health');
		expect(out).not.toMatch(/reverse-proxy/);
	});

	it('crash-looping: shows its log and offers to stop it — never "enable"', async () => {
		calls.length = 0;
		const questions: string[] = [];
		const rc = await runMcp(CTX, {
			exec,
			readState: states('failed'),
			journalTail: () => 'listen EADDRINUSE 127.0.0.1:8124',
			confirm: async (q) => {
				questions.push(q);
				return false;
			}
		});
		expect(rc).toBe(1);
		expect(out).toContain('listen EADDRINUSE 127.0.0.1:8124');
		expect(questions.some((q) => /Enable/i.test(q))).toBe(false);
		expect(calls.some((c) => /enable --now/.test(c))).toBe(false);
	});

	it('disabled while the site still advertises /mcp: says so, with the exact commands', async () => {
		const rc = await runMcp(CTX, {
			exec,
			readState: states('active', 'inactive'),
			advertisedUrl: async () => 'https://alice.example.org/mcp',
			confirm: async () => true
		});
		expect(rc).toBe(0);
		expect(out).toMatch(/still tells AI agents to use https:\/\/alice\.example\.org\/mcp/);
		expect(out).toContain('sudo systemctl restart morphit-indexer');
		expect(out).toContain('sudo morphit-ops mcp');
	});
});

describe('morphit-ops mcp: it checks the address the server really listens on', () => {
	// A real MCP stand-in answering GET /health like apps/mcp-server, and the
	// real probe (no probeHealth injected), reading a real mcp.env.
	const servers: Server[] = [];
	afterEach(async () => {
		vi.unstubAllEnvs();
		await Promise.all(servers.splice(0).map((x) => new Promise((r) => x.close(r))));
	});
	async function mcpAt(host: string): Promise<number> {
		const srv = createServer((q, r) => {
			r.setHeader('content-type', 'application/json');
			r.end(q.url === '/health' ? '{"status":"ok","transport":"http"}' : '{}');
		});
		servers.push(srv);
		await new Promise<void>((r) => srv.listen(0, host, r));
		return (srv.address() as AddressInfo).port;
	}
	function mcpEnv(text: string): string {
		const root = mkdtempSync(join(tmpdir(), 'morphit-mcpenv-'));
		mkdirSync(join(root, 'etc', 'morphit'), { recursive: true });
		writeFileSync(join(root, 'etc', 'morphit', 'mcp.env'), text);
		vi.stubEnv('MORPHIT_ENV_ROOT', root);
		vi.stubEnv('MORPHIT_ETC_DIR', join(root, 'etc', 'morphit'));
		return join(root, 'etc', 'morphit', 'mcp.env');
	}
	const enable = (): Promise<number> =>
		runMcp(CTX, {
			exec,
			readState: states('inactive', 'active'),
			confirm: async () => true,
			settleMs: 3_000
		});

	it('bound to another address (a bridge, here 127.0.0.2): asked there, ✓, exit 0', async () => {
		const port = await mcpAt('127.0.0.2');
		mcpEnv(`MORPHIT_MCP_HTTP_HOST=127.0.0.2\nMORPHIT_MCP_HTTP_PORT=${port}\n`);
		const rc = await enable();
		expect(rc).toBe(0);
		expect(out).toContain(`✓ MCP server enabled, running and answering on 127.0.0.2:${port}.`);
	});

	it('bound to all addresses (the installer default): reached on loopback, and not called "this server only"', async () => {
		const port = await mcpAt('0.0.0.0');
		const env = mcpEnv(`MORPHIT_MCP_HTTP_HOST=0.0.0.0\nMORPHIT_MCP_HTTP_PORT=${port}\n`);
		const rc = await enable();
		expect(rc).toBe(0);
		expect(out).toContain(
			`It listens on all of this server's network addresses (0.0.0.0:${port}, set in ${env})`
		);
		expect(out).not.toMatch(/this server only/);
		expect(out).toContain(`answering on 127.0.0.1:${port}.`);
	});

	it('something else on the port is not the MCP server: ✗', async () => {
		const srv = createServer((_q, r) => r.end('<html>proxy</html>'));
		servers.push(srv);
		await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
		const port = (srv.address() as AddressInfo).port;
		mcpEnv(`MORPHIT_MCP_HTTP_PORT=${port}\n`);
		const rc = await runMcp(CTX, {
			exec,
			readState: states('inactive', 'active'),
			confirm: async () => true,
			journalTail: () => null,
			settleMs: 1_200
		});
		expect(rc).toBe(1);
		expect(out).toContain(`does not answer on 127.0.0.1:${port} (it listens on this server only`);
	});
});
