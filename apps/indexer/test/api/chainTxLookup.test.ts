/**
 * GET /v1/chain/tx/:id — "the chain does not have it" is not an outage.
 *
 * v1.18.0 review (W3). The browser's chat sweep asks this before it calls one
 * of the user's sends failed: a message that DID land, on an instance whose
 * indexer is behind, must not be failed and retried into a second on-chain
 * copy. That needs "no such transaction" and "could not ask" kept apart. A node
 * answers an unknown id by THROWING ("Unknown Transaction …"), and every throw
 * used to become a 502 — so "no" read as "could not reach the network".
 */
import { describe, expect, it } from 'vitest';

import { chainExplorerRoute } from '$api/chainExplorer';
import type { BlurtClient } from '$blurt/client';
import type { Database } from '$db/pool';

const ID = 'a'.repeat(40);

function routeThrowing(err: unknown) {
	const blurt = {
		callCondenser: async () => {
			throw err;
		}
	} as unknown as BlurtClient;
	return chainExplorerRoute(blurt, {} as Database);
}

describe('GET /tx/:id', () => {
	it('a node that answers "Unknown Transaction" is a 404, not an outage', async () => {
		const res = await routeThrowing(
			new Error(`Assert Exception:false: Unknown Transaction ${ID}`)
		).request(`/tx/${ID}`);
		expect(res.status).toBe(404);
	});

	it('a transport failure is still a 502', async () => {
		const res = await routeThrowing(
			Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
		).request(`/tx/${ID}`);
		expect(res.status).toBe(502);
	});

	it('any other chain error is still a 502, never a false "not there"', async () => {
		const res = await routeThrowing(new Error('Could not find API account_history_api')).request(
			`/tx/${ID}`
		);
		expect(res.status).toBe(502);
	});
});
