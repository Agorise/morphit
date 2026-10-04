/**
 * /v1/rpc-endpoints lists only public nodes.
 *
 * Its header said operator-custom endpoints were filtered out, but the
 * allow-list was built from the operator's whole configured hidden pool plus
 * their local and auto-detected loopback nodes — so an operator's private onion
 * or I2P RPC node was published to every visitor (and probe-triggerable).
 */
import { describe, expect, it } from 'vitest';

import type { EndpointState } from '@morphit/rpc-pool';
import { rpcEndpointsRoute, publishedRpcEndpoints } from '$api/rpcHealth';
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

/** What a node with that configuration has in its pool. */
const POOL = [CANON_CLEARNET, CANON_HIDDEN, PRIVATE_ONION, PRIVATE_I2P, LOCAL, DIRECTORY_ONION];
const state = (url: string): EndpointState =>
	({
		url,
		ewmaLatencyMs: 50,
		consecutiveFailures: 0,
		cooldownUntil: 0,
		lastSuccessAt: Date.now()
	}) as EndpointState;

describe('/v1/rpc-endpoints', () => {
	it('publishes the canon and the signed directory, never the operator’s own nodes', async () => {
		const app = rpcEndpointsRoute(
			() => POOL.map(state),
			() =>
				publishedRpcEndpoints({
					usesClearnet: true,
					clearnetCanon: DEFAULT_BLURT_RPC_ENDPOINTS,
					hiddenCanon: DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS,
					configuredHidden: [CANON_HIDDEN, PRIVATE_ONION, PRIVATE_I2P],
					directoryHidden: [DIRECTORY_ONION]
				})
		);
		const body = await (await app.request('/')).text();
		for (const hidden of [PRIVATE_ONION, PRIVATE_I2P, LOCAL]) {
			expect(body.includes(hidden), `${hidden} was published`).toBe(false);
		}
		for (const shown of [CANON_CLEARNET, CANON_HIDDEN, DIRECTORY_ONION]) {
			expect(body.includes(shown), `${shown} missing`).toBe(true);
		}
	});
});
