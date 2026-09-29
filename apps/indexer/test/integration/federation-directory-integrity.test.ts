/**
 * v1.20.0 fix wave — the federation directory's integrity (E5–E9, E14).
 *
 *   E5  the boot reconcile replayed an OLD rejected registration over the
 *       operator's newer applied one (the register op is an UPSERT);
 *   E6  "alive on chain" (clearnet_blocked) meant "registered in the last day":
 *       only the register op moved `last_action_block_num`, so a censored but
 *       active operator turned unreachable a day later — with a week of failures
 *       already counted — and was deleted from the directory;
 *   E7  a peer's /v1/instance answer was cached unchecked (any type, any size,
 *       any scheme) and its alt addresses outranked the on-chain ones;
 *   E8  ?status=clearnet_blocked / =syncing returned EVERY row;
 *   E9  re-registering without an origin left the old directory row live.
 *
 * Real Postgres, the real register handler, dispatcher, probe scheduler,
 * reconcile and route; only a peer's HTTP answers are stubbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import net from 'node:net';

import operatorRegisterHandler from '../../src/indexer/handlers/operatorRegister';
import { FederationProbeScheduler } from '../../src/indexer/federationProbe';
import { reconcileOperatorRegistrations } from '../../src/indexer/reconcileRegistrations';
import { applyBlock } from '../../src/indexer/dispatcher';
import { instancesRoute } from '../../src/api/instances';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { makeCtx, fakeConfig, unusedBlurt } from '../testutils/context';

const NOW = new Date('2026-09-24T12:00:00Z');
const ORIGIN = 'https://censored-node.example';
const DOWN = async <T>(_url: string): Promise<T> => {
	throw new Error('connect ETIMEDOUT');
};

describe.skipIf(!INTEGRATION_ENABLED)('federation directory integrity', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		if (fx) await fx.teardown();
	});
	beforeEach(async () => {
		await truncateAll(fx);
		await fx.db.query(
			`TRUNCATE known_instances, operators, operator_registration_events, ops, user_settings CASCADE`
		);
	});
	const register = (signer: string, tag: string, payload: Record<string, unknown>, block: number) =>
		fx.db.withTx((c) =>
			operatorRegisterHandler(
				makeCtx({
					signer,
					blockNum: block,
					blockTime: NOW,
					payload: { v: 1, tag, display_name: `${tag} node`, ...payload }
				}),
				c
			)
		);
	const ki = async (origin = ORIGIN) =>
		(
			await fx.db.query<{ last_probe_status: string; consecutive_failures: number }>(
				`SELECT last_probe_status, consecutive_failures FROM known_instances WHERE origin = $1`,
				[origin]
			)
		).rows[0];

	it('E5: an OLD rejected registration never overwrites the operator’s newer applied one', async () => {
		await fx.db.query(
			`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status, reject_reason)
			 VALUES (100, 0, 0, $1, 'aa', 'lat', 'morphit_operator_register_v1', $2::jsonb, 'rejected', 'display_name_forbidden_char')`,
			[
				NOW,
				JSON.stringify({
					v: 1,
					tag: 'lat',
					display_name: 'Old Name',
					origin: 'https://old.example'
				})
			]
		);
		expect(
			await register('lat', 'lat', { display_name: 'New Name', origin: 'https://new.example' }, 200)
		).toEqual({ ok: true });
		await reconcileOperatorRegistrations({
			db: fx.db,
			blurt: unusedBlurt(),
			config: fakeConfig(),
			feeVerifiers: {} as never,
			feeAmounts: {} as never,
			fiatToUsd: () => null
		});
		const op = (
			await fx.db.query(`SELECT display_name, origin FROM operators WHERE account = 'lat'`)
		).rows[0];
		expect(op, 'the reconcile reverted a newer registration').toEqual({
			display_name: 'New Name',
			origin: 'https://new.example'
		});
		const rows = (await fx.db.query(`SELECT origin FROM known_instances`)).rows.map(
			(r) => r.origin
		);
		expect(rows).toEqual(['https://new.example']);
	});

	it('E5: the register op itself is monotonic — an older block never overwrites a newer one', async () => {
		expect(await register('lat', 'lat', { origin: 'https://new.example' }, 200)).toEqual({
			ok: true
		});
		await register('lat', 'lat', { origin: 'https://old.example' }, 150);
		const op = (await fx.db.query(`SELECT origin FROM operators WHERE account = 'lat'`)).rows[0];
		expect(op?.origin).toBe('https://new.example');
	});

	it('E6: an operator active on chain (any Morphit op) stays clearnet_blocked, and is never pruned for it', async () => {
		expect(await register('iran', 'iran', { origin: ORIGIN }, 1_000)).toEqual({ ok: true });
		// Censored for a week already: clearnet_blocked, with every hourly
		// failure of that week counted (as the probe used to count them).
		await fx.db.query(
			`UPDATE known_instances SET last_probe_status = 'clearnet_blocked', consecutive_failures = 170,
			        last_probed_at = NOW() - INTERVAL '2 hours' WHERE origin = $1`,
			[ORIGIN]
		);
		// Two days later the operator does something else Morphit records.
		const client: pg.PoolClient = await fx.pool.connect();
		try {
			await client.query(`SET search_path TO "${fx.schema}"`);
			await client.query('BEGIN');
			await applyBlock(
				client,
				1_000 + 57_600,
				{
					timestamp: NOW.toISOString().slice(0, 19),
					transaction_ids: ['act'],
					transactions: [
						{
							operations: [
								[
									'custom_json',
									{
										required_auths: [],
										required_posting_auths: ['iran'],
										id: 'morphit_settings_v1',
										json: JSON.stringify({ v: 1, enc: Buffer.from('x').toString('base64') })
									}
								]
							]
						}
					]
				} as never,
				{} as never,
				{ feeRecipient: 'morphit' } as never,
				{} as never,
				{} as never,
				(async () => null) as never
			);
			await client.query('COMMIT');
		} finally {
			client.release();
		}
		const probe = new FederationProbeScheduler(fx.db, {
			intervalMs: 0,
			clearnetFetch: DOWN,
			currentBlock: () => 1_000 + 57_700,
			hiddenServiceProxies: { torSocks: '', i2pHttpProxy: '' } as never
		});
		await probe.scanOnce();
		const after = await ki();
		expect(after?.last_probe_status, 'an active operator was called dead').toBe('clearnet_blocked');
		await fx.db.query(
			`UPDATE known_instances SET last_probed_at = NOW() - INTERVAL '2 hours' WHERE origin = $1`,
			[ORIGIN]
		);
		// Then the operator really goes quiet: unreachable, but the failures
		// counted while it was alive-but-censored must not prune it at once.
		const later = new FederationProbeScheduler(fx.db, {
			intervalMs: 0,
			clearnetFetch: DOWN,
			currentBlock: () => 1_000 + 57_600 + 28_801,
			hiddenServiceProxies: { torSocks: '', i2pHttpProxy: '' } as never
		});
		await later.scanOnce();
		await later.scanOnce();
		expect(
			await ki(),
			'the row was pruned the moment it stopped being clearnet_blocked'
		).toBeDefined();
	});

	it('E7: a peer’s /v1/instance answer is validated before it is cached, and on-chain addresses win', async () => {
		const onion = 'a'.repeat(56) + '.onion';
		expect(
			await register(
				'peer',
				'peer',
				{ origin: 'https://peer.example', alt_addresses: { tor: onion } },
				10
			)
		).toEqual({ ok: true });
		const fetchFn = async <T>(url: string): Promise<T> => {
			if (url.endsWith('/v1/instance'))
				return {
					name: 'N'.repeat(250_000),
					tagline: { not: 'a string' },
					contact_url: 'javascript:alert(1)',
					relay_account: 'peer',
					alt_networks: {
						tor: 'phish.example/login',
						lokinet: 'x.loki',
						i2p_b32: 'nope',
						nostr: null
					}
				} as unknown as T;
			if (url.endsWith('/v1/health'))
				return { status: 'ok', lag_blocks: 0, indexed_block: 1 } as unknown as T;
			return { orders: [{ created_at: new Date().toISOString() }] } as unknown as T;
		};
		await new FederationProbeScheduler(fx.db, { intervalMs: 0, clearnetFetch: fetchFn }).scanOnce();
		const body = (await (await instancesRoute(fx.db).request('/')).json()) as {
			instances: Array<{
				name: unknown;
				tagline: unknown;
				contact_url: unknown;
				status: string;
				alt_networks: Record<string, unknown>;
			}>;
		};
		const e = body.instances[0]!;
		expect(e.status).toBe('good');
		expect(e.name, 'an oversized name was cached').toBeNull();
		expect(e.tagline, 'a non-string tagline was cached').toBeNull();
		expect(e.contact_url, 'a javascript: contact URL was cached').toBeNull();
		expect(e.alt_networks.tor, 'the peer’s own answer outranked its signed on-chain address').toBe(
			onion
		);
		expect(e.alt_networks.i2p_b32).toBeNull();
		expect(e.alt_networks.lokinet).toBe('x.loki');
	});

	it('E8: ?status=clearnet_blocked and ?status=syncing filter, rather than returning everything', async () => {
		await fx.db.query(
			`INSERT INTO known_instances (origin, operator_account, registered_at_block, registered_at_time, last_probe_status)
			 VALUES ('https://a.example','a',1,NOW(),'good'), ('https://b.example','b',2,NOW(),'clearnet_blocked'),
			        ('https://c.example','c',3,NOW(),'syncing')`
		);
		for (const st of ['clearnet_blocked', 'syncing']) {
			const b = (await (await instancesRoute(fx.db).request(`/?status=${st}`)).json()) as {
				instances: Array<{ status: string }>;
			};
			expect(
				b.instances.map((i) => i.status),
				`?status=${st}`
			).toEqual([st]);
		}
	});

	it('E14: a hidden-origin peer whose first probe failed is not re-probed on every scan tick', async () => {
		const onion = `http://${'c'.repeat(56)}.onion`;
		expect(await register('hid', 'hid', { origin: onion }, 10)).toEqual({ ok: true });
		// A SOCKS proxy that is up and reports the ONION unreachable: a peer-side
		// failure, which the probe records (a dead proxy would be ours, and list).
		const socks = net.createServer((sock) => {
			let stage = 0;
			sock.on('data', () => {
				if (stage++ === 0) sock.write(Buffer.from([5, 0]));
				else sock.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));
			});
		});
		await new Promise<void>((r) => socks.listen(0, '127.0.0.1', () => r()));
		const port = (socks.address() as net.AddressInfo).port;
		let asked = 0;
		const sched = new FederationProbeScheduler(fx.db, {
			intervalMs: 0,
			hiddenServiceProxies: { torSocks: `127.0.0.1:${port}`, i2pHttpProxy: '' } as never
		});
		// Count probes by watching last_probed_at move.
		for (let i = 0; i < 3; i++) {
			const before = (
				await fx.db.query(`SELECT last_probed_at FROM known_instances WHERE origin = $1`, [onion])
			).rows[0]?.last_probed_at;
			await sched.scanOnce();
			const after = (
				await fx.db.query(`SELECT last_probed_at FROM known_instances WHERE origin = $1`, [onion])
			).rows[0]?.last_probed_at;
			if (String(before) !== String(after)) asked++;
		}
		socks.close();
		const st = (
			await fx.db.query(
				`SELECT last_probe_status, consecutive_failures FROM known_instances WHERE origin = $1`,
				[onion]
			)
		).rows[0];
		expect(
			st?.consecutive_failures,
			'setup: the probe must have recorded a peer-side failure'
		).toBeGreaterThanOrEqual(1);
		expect(asked, 'the same failing peer was probed on consecutive scan ticks').toBe(1);
	});

	it('E14: a peer listed but never probed (hidden-only node) is not shown as Good', async () => {
		await fx.db.query(
			`INSERT INTO known_instances (origin, operator_account, registered_at_block, registered_at_time,
			                              last_probed_at, last_probe_status, last_probe_error)
			 VALUES ('https://clear.example','c',1,NOW(),NOW(),'good','clearnet_peer_not_probed_hidden_only')`
		);
		const b = (await (await instancesRoute(fx.db).request('/')).json()) as {
			instances: Array<{ status: string }>;
		};
		expect(b.instances[0]?.status, 'an unverified peer was labelled good').toBe('never');
	});

	it('E9: re-registering with origin EMPTY withdraws it from the directory; OMITTING it changes nothing', async () => {
		expect(await register('bob', 'bob', { origin: 'https://bob.example' }, 10)).toEqual({
			ok: true
		});
		// The web /run-a-node form re-registers with tag + name + contact only. That
		// must not wipe the operator's origin (it used to set operators.origin NULL
		// while leaving the directory row: two stories about one operator).
		expect(await register('bob', 'bob', { display_name: 'Bob renamed' }, 20)).toEqual({ ok: true });
		const kept = (
			await fx.db.query(`SELECT origin, display_name FROM operators WHERE account = 'bob'`)
		).rows[0];
		expect(kept).toEqual({ origin: 'https://bob.example', display_name: 'Bob renamed' });
		expect(
			(await fx.db.query(`SELECT origin FROM known_instances WHERE operator_account = 'bob'`)).rows
		).toEqual([{ origin: 'https://bob.example' }]);
		// An explicit empty origin is a withdrawal: gone from operators AND the directory.
		expect(await register('bob', 'bob', { origin: '' }, 30)).toEqual({ ok: true });
		expect(
			(await fx.db.query(`SELECT origin FROM operators WHERE account = 'bob'`)).rows[0]?.origin
		).toBeNull();
		const rows = (
			await fx.db.query(`SELECT origin FROM known_instances WHERE operator_account = 'bob'`)
		).rows;
		expect(rows, 'the operator withdrew its origin but the directory still lists it').toEqual([]);
	});
});
