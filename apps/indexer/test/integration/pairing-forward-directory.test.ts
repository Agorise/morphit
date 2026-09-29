/**
 * v1.20.0 — the cross-instance pairing forward's directory lookup, against the
 * REAL schema (known_instances + operators.reg_alt_networks JSONB).
 *
 * test/api/pairingForward.test.ts drives the route end to end with a directory
 * double; this one proves the SQL: which rows it returns for a target, that a
 * `mismatch` row is never a target, that a hidden target is found through the
 * alt addresses an operator published, and that the addresses handed to the
 * dialler are that instance's, hidden first.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
	resolvePairingTarget,
	selfPairingAddresses,
	parsePairingTarget
} from '$api/pairingForward';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';

const A_ONION = `${'a'.repeat(56)}.onion`;
const A_B32 = `${'q'.repeat(52)}.b32.i2p`;
const B_ONION = `${'b'.repeat(56)}.onion`;
const B_ONION_PUBLISHED = `${'e'.repeat(56)}.onion`;
const PROXIES = { torSocks: '127.0.0.1:9050', i2pHttpProxy: '127.0.0.1:4444' };
const SELF = selfPairingAddresses(['https://b.example', B_ONION]);

describe.skipIf(!INTEGRATION_ENABLED)('pairing forward — directory lookup (real Postgres)', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		if (fx) await fx.teardown();
	});
	beforeEach(async () => {
		await fx.db.query(`TRUNCATE known_instances, operators CASCADE`);
		const op = (account: string, tag: string, alt: Record<string, string> | null) =>
			fx.db.query(
				`INSERT INTO operators (account, tag, display_name, registered_in_block, reg_alt_networks)
				 VALUES ($1, $2, $2, 1, $3::jsonb)`,
				[account, tag, alt === null ? null : JSON.stringify(alt)]
			);
		const inst = (origin: string, account: string, status: string) =>
			fx.db.query(
				`INSERT INTO known_instances (origin, operator_account, registered_at_block,
				                              registered_at_time, last_probe_status)
				 VALUES ($1, $2, 1, now(), $3)`,
				[origin, account, status]
			);
		await op('alice', 'alice', { tor: A_ONION, i2p_b32: A_B32, ens: 'alice.eth' });
		await inst('https://a.example', 'alice', 'good');
		await op('mallory', 'mallory', null);
		await inst('https://m.example', 'mallory', 'mismatch');
		await op('bob', 'bob', { tor: B_ONION_PUBLISHED });
		await inst('https://b.example', 'bob', 'good');
	});

	const resolve = (t: string) => resolvePairingTarget(fx.db, parsePairingTarget(t)!, SELF, PROXIES);

	it('a registered clearnet origin resolves to that instance, hidden addresses first', async () => {
		const r = await resolve('https://a.example');
		expect(r).toEqual({
			kind: 'peer',
			key: 'https://a.example',
			addresses: [
				{ origin: `http://${A_ONION}`, hidden: true },
				{ origin: `http://${A_B32}`, hidden: true },
				{ origin: 'https://a.example', hidden: false }
			],
			healthy: true
		});
	});

	it('what the probe last saw decides the budget class (wave 2, V4)', async () => {
		for (const [status, healthy] of [
			['good', true],
			['quiet', true],
			['syncing', true],
			['clearnet_blocked', true],
			['never', false],
			['stale', false],
			['unreachable', false]
		] as const) {
			await fx.db.query(
				`UPDATE known_instances SET last_probe_status = $1 WHERE origin = 'https://a.example'`,
				[status]
			);
			const r = await resolve('https://a.example');
			expect(r.kind === 'peer' && r.healthy, status).toBe(healthy);
		}
	});

	it('the instance’s published onion (a desktop on the .onion page) resolves to it', async () => {
		const r = await resolve(`http://${A_ONION}`);
		expect(r.kind).toBe('peer');
		expect(r.kind === 'peer' && r.key).toBe('https://a.example');
		const i2p = await resolve(`http://${A_B32}`);
		expect(i2p.kind === 'peer' && i2p.key).toBe('https://a.example');
	});

	it('mismatch rows, strangers and look-alikes are unknown', async () => {
		for (const t of [
			'https://m.example',
			'https://evil.example',
			'https://a.example.evil.example',
			'https://example',
			`http://${'c'.repeat(56)}.onion`,
			'https://alice.eth'
		]) {
			expect((await resolve(t)).kind, t).toBe('unknown');
		}
	});

	it('look-alike registrations cannot crowd the real one out of the lookup', async () => {
		// Sixty registrations whose origins CONTAIN the target's host, inserted
		// first and probed more recently. A substring match under the LIMIT
		// returned only these, and the real instance read as unknown.
		for (let i = 0; i < 60; i++) {
			await fx.db.query(
				`INSERT INTO operators (account, tag, display_name, registered_in_block)
				 VALUES ($1, $1, $1, 1)`,
				[`crowd${i}`]
			);
			await fx.db.query(
				`INSERT INTO known_instances (origin, operator_account, registered_at_block,
				                              registered_at_time, last_probe_status, last_probed_at)
				 VALUES ($1, $2, 1, now(), 'good', now())`,
				[`https://z${i}.a.example.crowd.example`, `crowd${i}`]
			);
		}
		await fx.db.query(`DELETE FROM known_instances WHERE origin = 'https://a.example'`);
		await fx.db.query(
			`INSERT INTO known_instances (origin, operator_account, registered_at_block,
			                              registered_at_time, last_probe_status)
			 VALUES ('https://a.example', 'alice', 1, now(), 'quiet')`
		);
		const r = await resolve('https://a.example');
		expect(r.kind === 'peer' && r.key).toBe('https://a.example');
	});

	it('a registration that copies another instance’s hidden address cannot put its own first', async () => {
		const COPY_ONION = `${'c'.repeat(56)}.onion`;
		await fx.db.query(
			`INSERT INTO operators (account, tag, display_name, registered_in_block, reg_alt_networks)
			 VALUES ('copycat', 'copycat', 'copycat', 1, $1::jsonb)`,
			[JSON.stringify({ tor: COPY_ONION, i2p_b32: A_B32 })]
		);
		await fx.db.query(
			`INSERT INTO known_instances (origin, operator_account, registered_at_block,
			                              registered_at_time, last_probe_status, last_probed_at)
			 VALUES ('https://copycat.example', 'copycat', 1, now() - interval '1 year', 'good', now())`
		);
		const r = await resolve(`http://${A_B32}`);
		expect(r.kind).toBe('peer');
		expect(r.kind === 'peer' && r.addresses[0]).toEqual({
			origin: `http://${A_B32}`,
			hidden: true
		});
	});

	it('this instance — by config, or by its own registration’s published onion — is self', async () => {
		expect(await resolve('https://b.example')).toEqual({ kind: 'self' });
		expect(await resolve(`http://${B_ONION}`)).toEqual({ kind: 'self' });
		expect(await resolve(`http://${B_ONION_PUBLISHED}`)).toEqual({ kind: 'self' });
	});
});
