/**
 * Why a peer probe failed reaches the indexer's log (`peer_probe_failed`), once
 * per change of reason, cut short (v1.21.7).
 *
 * 2026-10-12: a new instance showed "Clearnet blocked" on every other node and
 * nothing in any log said why — the reason was only in the database. Logged on
 * every 10-minute re-probe it would flood the journal; logged whole, a peer
 * choosing its own error text (its relay account) could write a 200 KB line per
 * probe (review, 2026-10-12). The real scheduler against real Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FederationProbeScheduler } from '../../src/indexer/federationProbe';
import { setLogSink, type LogRecord } from '../../src/log/index';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';

const ORIGIN = 'https://peer.example';
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe.skipIf(!INTEGRATION_ENABLED)('peer_probe_failed in the indexer log', () => {
	let fx: IntegrationFixture;
	const recs: LogRecord[] = [];
	let restore: () => void;
	beforeAll(async () => {
		fx = await setupWithMigrations();
		restore = setLogSink((r) => void recs.push(r));
	});
	afterAll(async () => {
		restore?.();
		if (fx) await fx.teardown();
	});
	beforeEach(async () => {
		recs.length = 0;
		await truncateAll(fx);
		await fx.db.query(`TRUNCATE known_instances, operators CASCADE`);
		await fx.db.query(
			`INSERT INTO known_instances (origin, operator_account, registered_at_block, registered_at_time, last_probe_status)
			 VALUES ($1, 'alice', 1, NOW(), 'never')`,
			[ORIGIN]
		);
	});
	/** Make the peer due for its next probe. */
	const due = (): Promise<unknown> =>
		fx.db.query(`UPDATE known_instances SET last_probed_at = NOW() - INTERVAL '3 hours'`);
	const probeWith = (
		f: (url: string) => Promise<unknown>,
		more: Record<string, unknown> = {}
	): Promise<unknown> =>
		new FederationProbeScheduler(fx.db, {
			intervalMs: 0,
			clearnetFetch: f as <T>(u: string) => Promise<T>,
			...more
		}).scanOnce();
	const failures = (): LogRecord[] => recs.filter((r) => r.event === 'peer_probe_failed');

	it('the same reason on three probes: one line, naming the peer and the reason', async () => {
		const down = async (): Promise<unknown> => {
			throw new Error('HTTP 503');
		};
		for (let i = 0; i < 3; i++) {
			await probeWith(down);
			await due();
		}
		expect(failures()).toHaveLength(1);
		expect(failures()[0]!.context).toMatchObject({ origin: ORIGIN });
		expect(String(failures()[0]!.context.reason)).toContain('503');
	});

	it('a new reason is logged again', async () => {
		let msg = 'HTTP 503';
		const down = async (): Promise<unknown> => {
			throw new Error(msg);
		};
		await probeWith(down);
		await due();
		msg = 'HTTP 502';
		await probeWith(down);
		expect(failures()).toHaveLength(2);
	});

	it('text the peer chose is cut short in the log', async () => {
		let n = 0;
		const hostile = async (u: string): Promise<unknown> =>
			u.endsWith('/v1/instance')
				? {
						name: 'x',
						tagline: null,
						contact_url: null,
						relay_account: `evil${n++}${'A'.repeat(200_000)}`,
						alt_networks: {}
					}
				: { status: 'ok', lag_blocks: 0, indexed_block: 100 };
		for (let i = 0; i < 3; i++) {
			await probeWith(hostile);
			await due();
		}
		expect(failures().length).toBeGreaterThan(0);
		for (const r of failures()) expect(JSON.stringify(r).length).toBeLessThan(1_000);
		// Stored short too, the relay account in its 32 characters.
		const row = (await fx.db.query(`SELECT last_probe_error FROM known_instances`)).rows[0] as {
			last_probe_error: string;
		};
		expect(row.last_probe_error.length).toBeLessThanOrEqual(1_000);
		expect(row.last_probe_error).toMatch(/instance="evil\d+A+"$/);
		expect(row.last_probe_error.match(/instance="([^"]*)"/)![1]!.length).toBeLessThanOrEqual(32);
	});

	it('a treasury address the peer chose is cut short in the log too', async () => {
		const hostile = async (u: string): Promise<unknown> =>
			u.endsWith('/v1/instance')
				? {
						name: 'x',
						tagline: null,
						contact_url: null,
						relay_account: 'alice',
						alt_networks: {},
						treasury: { btc: `bc1${'q'.repeat(200_000)}`, xmr: null }
					}
				: { status: 'ok', lag_blocks: 0, indexed_block: 100 };
		await probeWith(hostile, {
			localLagBlocks: () => 0,
			canonicalTreasury: () => ({ btc: 'bc1qcanonical', xmr: null })
		});
		expect(failures()).toHaveLength(1);
		expect(String(failures()[0]!.context.reason)).toContain('treasury');
		expect(JSON.stringify(failures()[0]).length).toBeLessThan(1_000);
		// And stored at most 1000 characters (a 200 KB row on every probe before).
		const row = (await fx.db.query(`SELECT last_probe_error FROM known_instances`)).rows[0] as {
			last_probe_error: string;
		};
		expect(row.last_probe_error.length).toBeLessThanOrEqual(1_000);
	});

	it('a NUL or control character in what the peer sent: stored, and logged once (v1.21.7)', async () => {
		// What fetchJson does with such a body: JSON.parse names the bad text.
		const hostile = async (): Promise<unknown> => JSON.parse('x\u0000y\u001b[31m');
		for (let i = 0; i < 4; i++) {
			await probeWith(hostile);
			await due();
		}
		// Before: Postgres refused the NUL, the reason was never stored, and the
		// failure was logged again on every probe, with a stack trace.
		expect(recs.filter((r) => r.event !== 'peer_probe_failed').map((r) => r.event)).not.toContain(
			'probe_threw'
		);
		expect(failures()).toHaveLength(1);
		const row = (await fx.db.query(`SELECT last_probe_error FROM known_instances`)).rows[0] as {
			last_probe_error: string;
		};
		expect(row.last_probe_error).not.toMatch(/[\u0000-\u001f\u007f]/);
		expect(row.last_probe_error).not.toMatch(/invalid byte sequence/);
	});

	for (const [label, btc] of [
		['a lone surrogate', 'bc1q\ud800zz'],
		['a lone low surrogate', 'bc1q\udc00zz'],
		['a lone low surrogate first', '\udfffbc1q'],
		[
			'an emoji cut in half by the 1000-character cut',
			`bc1${'q'.repeat(1000 - 'treasury_btc_address mismatch: canonical=bc1qcanonical instance=bc1'.length - 1)}\u{1f600}tail`
		]
	] as const) {
		it(`${label} in what the peer sent: stored as it is compared, logged once (v1.21.7)`, async () => {
			const hostile = async (u: string): Promise<unknown> =>
				u.endsWith('/v1/instance')
					? {
							name: 'x',
							tagline: null,
							contact_url: null,
							relay_account: 'alice',
							alt_networks: {},
							treasury: { btc, xmr: null }
						}
					: { status: 'ok', lag_blocks: 0, indexed_block: 100 };
			for (let i = 0; i < 4; i++) {
				await probeWith(hostile, {
					localLagBlocks: () => 0,
					canonicalTreasury: () => ({ btc: 'bc1qcanonical', xmr: null })
				});
				await due();
			}
			// Before: the database stored U+FFFD for the half character, so the
			// stored reason never equalled the new one: logged on every probe.
			expect(failures()).toHaveLength(1);
			expect(String(failures()[0]!.context.reason)).not.toMatch(LONE_SURROGATE);
		});
	}

	it('an emoji cut in half by the 200-character log cut: the log line is whole text', async () => {
		const pre = 'treasury_btc_address mismatch: canonical=bc1qcanonical instance=bc1';
		const btc = `bc1${'q'.repeat(200 - pre.length - 1)}\u{1f600}tail`;
		const hostile = async (u: string): Promise<unknown> =>
			u.endsWith('/v1/instance')
				? {
						name: 'x',
						tagline: null,
						contact_url: null,
						relay_account: 'alice',
						alt_networks: {},
						treasury: { btc, xmr: null }
					}
				: { status: 'ok', lag_blocks: 0, indexed_block: 100 };
		await probeWith(hostile, {
			localLagBlocks: () => 0,
			canonicalTreasury: () => ({ btc: 'bc1qcanonical', xmr: null })
		});
		expect(failures()).toHaveLength(1);
		expect(String(failures()[0]!.context.reason)).not.toMatch(LONE_SURROGATE);
	});
});
