/**
 * `morphit-ops health` right after the indexer (re)starts. The
 * indexer's background prober has not measured every node yet: those rows say
 * so (`checked_at: null`, the web card shows "probing…"). Health must not count
 * them as unreachable ("0/3 reachable" in red), and must ask for the instant
 * answer (no `?probe=1`, which waits up to ~43 s, past health's own 22 s).
 */
import { afterEach, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runHealth } from '../src/commands/health.ts';

let server: http.Server | null = null;
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
});

it('nodes not measured yet are not reported unreachable, and no probe round is asked for', async () => {
	const asked: string[] = [];
	const rows = [
		'https://a.example',
		'https://b.example',
		`http://${'f'.repeat(56)}.onion:8091`
	].map((url) => ({
		url,
		transport: url.includes('.onion') ? 'tor' : 'clearnet',
		healthy: false,
		latency_ms: null,
		consecutive_failures: 0,
		cooldown_ms: 0,
		failure_reason: null,
		http_status: null,
		checked_at: null
	}));
	server = http.createServer((q, r) => {
		asked.push(q.url ?? '');
		r.setHeader('content-type', 'application/json');
		if ((q.url ?? '').startsWith('/v1/rpc-endpoints')) {
			r.end(
				JSON.stringify({
					network: 'morphit',
					generated_at: new Date().toISOString(),
					endpoints: rows
				})
			);
			return;
		}
		r.end(
			JSON.stringify({
				status: 'ok',
				network: 'morphit',
				version: '1.21.6',
				indexed_block: 100,
				chain_head_block: 100,
				lag_blocks: 0,
				uptime_sec: 3,
				rpc_endpoints_healthy: 3,
				rpc_endpoints_total: 3
			})
		);
	});
	await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/health`;
	// The relay probe stays on loopback (no bridge-gateway auto-probe).
	vi.stubEnv('MORPHIT_RELAY_LISTEN_HOST', '127.0.0.1');
	vi.stubEnv('MORPHIT_RELAY_LISTEN_PORT', '9');
	const lines: string[] = [];
	vi.spyOn(console, 'log').mockImplementation(
		(...a: unknown[]) => void lines.push(a.map(String).join(' '))
	);
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
	await runHealth({ flags: { url }, colorEnabled: false } as never);
	const rpcLine = lines.find((l) => l.includes('Blurt RPC:')) ?? '';
	expect(rpcLine).not.toBe('');
	expect(rpcLine).not.toMatch(/\b0\/3 reachable/);
	expect(asked.filter((u) => u.startsWith('/v1/rpc-endpoints'))).toEqual(['/v1/rpc-endpoints']);
}, 60_000);
