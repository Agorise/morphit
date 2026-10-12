/**
 * /v1/rpc-endpoints lists only public nodes.
 *
 * Its header said operator-custom endpoints were filtered out, but the
 * allow-list was built from the operator's whole configured hidden pool plus
 * their local and auto-detected loopback nodes — so an operator's private onion
 * or I2P RPC node was published to every visitor (and probe-triggerable).
 */
import { describe, expect, it } from 'vitest';

import { rpcEndpointsRoute, publishedRpcEndpoints, RpcHealthProber } from '$api/rpcHealth';
import {
	DEFAULT_BLURT_RPC_ENDPOINTS,
	DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS
} from '@morphit/operator-config';

const PRIVATE_ONION = `http://${'p'.repeat(56)}.onion:8091`;
const PRIVATE_I2P = `http://${'q'.repeat(52)}.b32.i2p:8091`;
const LOCAL = 'http://127.0.0.1:8091';
const DIRECTORY_ONION = `http://${'d'.repeat(56)}.onion:8091`;
const CANON_HIDDEN = DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS[0]!;
const CANON_CLEARNET = DEFAULT_BLURT_RPC_ENDPOINTS[0]!;

describe('/v1/rpc-endpoints', () => {
	it('publishes and probes the canon and the signed directory, never the operator’s own nodes', async () => {
		const published = (): string[] =>
			publishedRpcEndpoints({
				usesClearnet: true,
				clearnetCanon: DEFAULT_BLURT_RPC_ENDPOINTS,
				hiddenCanon: DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS,
				configuredHidden: [CANON_HIDDEN, PRIVATE_ONION, PRIVATE_I2P],
				directoryHidden: [DIRECTORY_ONION]
			});
		const probed: string[] = [];
		const prober = new RpcHealthProber(published, {
			probe: async (url) => {
				probed.push(url);
				return { ok: true, latencyMs: 50, reason: null, httpStatus: null };
			}
		});
		await prober.tick();
		const app = rpcEndpointsRoute(prober, published);
		const body = await (await app.request('/')).text();
		for (const hidden of [PRIVATE_ONION, PRIVATE_I2P, LOCAL]) {
			expect(probed.includes(hidden), `${hidden} was probed`).toBe(false);
		}
		for (const hidden of [PRIVATE_ONION, PRIVATE_I2P, LOCAL]) {
			expect(body.includes(hidden), `${hidden} was published`).toBe(false);
		}
		for (const shown of [CANON_CLEARNET, CANON_HIDDEN, DIRECTORY_ONION]) {
			expect(body.includes(shown), `${shown} missing`).toBe(true);
		}
	});
});
