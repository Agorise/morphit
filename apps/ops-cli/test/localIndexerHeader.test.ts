/**
 * ops-cli's reads of this box's own indexer ask for the loopback-only fields:
 * the indexer returns them only
 * when the request carries `x-morphit-local-health: 1`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getLocalIndexerJson } from '../src/init/hiddenUpgradeLocalIndexer.ts';
import * as summary from '../src/init/installSummary.ts';

let server: Server;
let base = '';
beforeAll(async () => {
	server = createServer((req, res) => {
		const local = req.headers['x-morphit-local-health'] === '1';
		res.setHeader('content-type', 'application/json');
		if (req.url === '/v1/instance') {
			res.end(
				JSON.stringify(
					local ? { clearnet_eliminated: true, clearnet_eliminated_missing: [] } : { name: 'x' }
				)
			);
		} else if (req.url === '/v1/health') {
			res.end(
				JSON.stringify(
					local
						? { status: 'ok', rpc_ok: false, rpc_endpoints_healthy: 3, price_feeds: { ok: true } }
						: { status: 'ok', rpc_ok: false }
				)
			);
		} else {
			res.statusCode = 404;
			res.end('{}');
		}
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('loopback indexer reads', () => {
	it('the hidden-upgrade check reads clearnet_eliminated_missing from /v1/instance', async () => {
		const inst = await getLocalIndexerJson<Record<string, unknown>>(base, '/v1/instance');
		expect(inst.clearnet_eliminated_missing, 'the loopback-only field was not asked for').toEqual(
			[]
		);
	});

	it('the install summary reads the RPC and price-feed detail', async () => {
		const read = (
			summary as { readLocalIndexerHealth?: (b: string) => Promise<summary.IndexerHealth> }
		).readLocalIndexerHealth;
		expect(read).toBeTypeOf('function');
		const h = await read!(base);
		expect(h).toEqual({ reachable: true, synced: true, rpcOk: true, fxOk: true });
	});
});
