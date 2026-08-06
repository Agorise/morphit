/**
 * Unit test — POST /v1/chain/condenser (cp410).
 *
 * The generic read-only condenser relay: the ONLY path by which the browser
 * reads the Blurt chain (every other browser→node read was removed for
 * privacy). Because it's a public, unauthenticated proxy onto the operator's
 * RPC pool, its guardrails are security-critical and pinned here:
 *
 *   - ONLY whitelisted READ methods are relayed (no broadcast / no arbitrary
 *     method) — a regression here would turn the relay into a write path or an
 *     amplifier against the operator's pool.
 *   - params must be a small, bounded array.
 *   - the chain result is relayed verbatim (null included) and never cached.
 *
 * The live RPC round-trip is stubbed (same as the other route tests); we assert
 * the HTTP-layer policy, not the upstream call.
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { chainExplorerRoute } from '$api/chainExplorer';
import type { BlurtClient } from '$blurt/client';
import type { Database } from '$db/pool';

/**
 * A concrete (non-generic) stub shape for the relay's upstream reader. The real
 * `BlurtClient['callCondenser']` is generic (`<T>(…) => Promise<T>`), which a
 * fixed-return mock like `async () => [...]` can't satisfy — a generic function
 * type demands the impl work for ANY T. The relay only ever needs a value it can
 * serialize, so the test stubs a plain `Promise<unknown>` and casts once at the
 * mount boundary.
 */
type CondenserStub = (
	method: string,
	params?: readonly unknown[],
	options?: { userFacing?: boolean }
) => Promise<unknown>;

/**
 * Minimal Database stub for the key-references DB-union path. `resolve` maps the
 * queried keys → account names found in accounts.posting_pubkey (or throws to
 * simulate a DB outage). Defaults to "no rows" so the condenser tests, which
 * never touch the DB, are unaffected.
 */
function mockDb(resolve: (keys: string[]) => string[] = () => []): Database {
	return {
		query: (async (_text: string, params?: readonly unknown[]) => {
			const keys = (params?.[0] as string[]) ?? [];
			const names = resolve(keys);
			return { rows: names.map((name) => ({ name })), rowCount: names.length };
		}) as Database['query'],
		withTx: (async () => {
			throw new Error('withTx not used in these tests');
		}) as Database['withTx'],
		close: async () => {}
	};
}

/** Mount /v1/chain with a stub whose callCondenser records the last call. */
function mount(
	callCondenser: CondenserStub,
	db: Database = mockDb()
): {
	app: Hono;
	calls: Array<{ method: string; params: unknown[] }>;
} {
	const calls: Array<{ method: string; params: unknown[] }> = [];
	const wrapped = ((method: string, params: unknown[], opts?: unknown) => {
		calls.push({ method, params });
		return callCondenser(method, params, opts as { userFacing?: boolean });
	}) as BlurtClient['callCondenser'];
	const app = new Hono();
	app.route('/v1/chain', chainExplorerRoute({ callCondenser: wrapped } as unknown as BlurtClient, db));
	return { app, calls };
}

function post(app: Hono, body: unknown): Promise<Response> {
	// Hono's `request` is typed `Response | Promise<Response>`; normalize to a
	// Promise so every call site can `await` it uniformly.
	return Promise.resolve(
		app.request('/v1/chain/condenser', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	);
}

describe('POST /v1/chain/condenser', () => {
	it('relays a whitelisted read method and returns the result verbatim, no-store', async () => {
		const { app, calls } = mount(async () => [{ name: 'alice' }]);
		const res = await post(app, { method: 'get_accounts', params: [['alice']] });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: unknown };
		expect(body.result).toEqual([{ name: 'alice' }]);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(calls).toEqual([{ method: 'get_accounts', params: [['alice']] }]);
	});

	it('relays each whitelisted method', async () => {
		for (const method of [
			'get_accounts',
			'get_account_history',
			'get_dynamic_global_properties',
			'get_block',
			'get_transaction',
			'get_key_references'
		]) {
			const { app } = mount(async () => ({ ok: true }));
			const res = await post(app, { method, params: [] });
			expect(res.status, `${method} should be relayed`).toBe(200);
		}
	});

	it('relays a null chain result as { result: null } (not 404)', async () => {
		const { app } = mount(async () => null);
		const res = await post(app, { method: 'get_transaction', params: ['a'.repeat(40)] });
		expect(res.status).toBe(200);
		expect((await res.json()) as { result: unknown }).toEqual({ result: null });
	});

	it('defaults missing params to an empty array', async () => {
		const { app, calls } = mount(async () => ({}));
		const res = await post(app, { method: 'get_dynamic_global_properties' });
		expect(res.status).toBe(200);
		expect(calls[0]).toEqual({ method: 'get_dynamic_global_properties', params: [] });
	});

	it('REFUSES broadcast (400) — the relay can never push to the chain', async () => {
		let reached = false;
		const { app } = mount(async () => {
			reached = true;
			return {};
		});
		for (const method of [
			'broadcast_transaction',
			'broadcast_transaction_synchronous'
		]) {
			const res = await post(app, { method, params: [{ some: 'trx' }] });
			expect(res.status, `${method} must be refused`).toBe(400);
			expect(((await res.json()) as { code: string }).code).toBe('bad_request');
		}
		expect(reached, 'upstream must never be called for a refused method').toBe(false);
	});

	it('REFUSES a non-whitelisted read method (400)', async () => {
		const { app, calls } = mount(async () => ({}));
		const res = await post(app, { method: 'get_witness_by_account', params: ['alice'] });
		expect(res.status).toBe(400);
		expect(calls.length).toBe(0);
	});

	it('400s on a non-string / missing method', async () => {
		const { app } = mount(async () => ({}));
		expect((await post(app, { method: 123, params: [] })).status).toBe(400);
		expect((await post(app, { params: [] })).status).toBe(400);
	});

	it('400s when params is not an array', async () => {
		const { app } = mount(async () => ({}));
		const res = await post(app, { method: 'get_accounts', params: { not: 'array' } });
		expect(res.status).toBe(400);
	});

	it('400s when params has too many elements (> 4)', async () => {
		const { app } = mount(async () => ({}));
		const res = await post(app, { method: 'get_accounts', params: [1, 2, 3, 4, 5] });
		expect(res.status).toBe(400);
	});

	it('400s when the serialized params exceed the size cap', async () => {
		const { app } = mount(async () => ({}));
		const huge = 'x'.repeat(3000);
		const res = await post(app, { method: 'get_accounts', params: [huge] });
		expect(res.status).toBe(400);
	});

	it('400s on a non-object / non-JSON body', async () => {
		const { app } = mount(async () => ({}));
		expect((await post(app, [1, 2, 3])).status).toBe(400);
		const raw = await app.request('/v1/chain/condenser', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: 'not json'
		});
		expect(raw.status).toBe(400);
	});

	it('502s when the RPC pool throws', async () => {
		const { app } = mount(async () => {
			throw new Error('all endpoints failed');
		});
		const res = await post(app, { method: 'get_accounts', params: [['alice']] });
		expect(res.status).toBe(502);
		expect(((await res.json()) as { code: string }).code).toBe('internal');
	});
});

describe('POST /v1/chain/key-references (chain + indexer-DB union)', () => {
	const KEY = 'BLT8eGZMnyrBvNgcz3KKbFga5xwfEXpDEDHXrEuTLG7JMEi5BoAVo';

	function keyRefPost(app: Hono, body: unknown): Promise<Response> {
		return Promise.resolve(
			app.request('/v1/chain/key-references', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			})
		);
	}

	it('returns the chain result when the plugin indexes the key', async () => {
		const { app } = mount(async () => [['alice']]);
		const res = await keyRefPost(app, { keys: [KEY] });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { accounts: string[] }).accounts).toEqual(['alice']);
	});

	it('falls back to the indexer DB when the chain plugin misses a pre-fork key', async () => {
		// Chain returns [] (account_by_key never indexed the genesis key), but
		// the account has touched Morphit so accounts.posting_pubkey has it.
		const { app } = mount(
			async () => [[]],
			mockDb((keys) => (keys.includes(KEY) ? ['kencode'] : []))
		);
		const res = await keyRefPost(app, { keys: [KEY] });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { accounts: string[] }).accounts).toEqual(['kencode']);
	});

	it('unions + dedupes both sources', async () => {
		const { app } = mount(
			async () => [['alice']],
			mockDb(() => ['alice', 'kencode'])
		);
		const res = await keyRefPost(app, { keys: [KEY] });
		const { accounts } = (await res.json()) as { accounts: string[] };
		expect([...accounts].sort()).toEqual(['alice', 'kencode']);
	});

	it('still answers from the DB when the chain RPC is down (no 502)', async () => {
		const { app } = mount(
			async () => {
				throw new Error('all endpoints failed');
			},
			mockDb(() => ['kencode'])
		);
		const res = await keyRefPost(app, { keys: [KEY] });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { accounts: string[] }).accounts).toEqual(['kencode']);
	});

	it('502s only when BOTH the chain AND the DB fail', async () => {
		const { app } = mount(
			async () => {
				throw new Error('all endpoints failed');
			},
			mockDb(() => {
				throw new Error('db down');
			})
		);
		const res = await keyRefPost(app, { keys: [KEY] });
		expect(res.status).toBe(502);
	});

	it('returns empty (200) when neither source knows the key', async () => {
		const { app } = mount(async () => [[]]);
		const res = await keyRefPost(app, { keys: [KEY] });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { accounts: string[] }).accounts).toEqual([]);
	});
});
