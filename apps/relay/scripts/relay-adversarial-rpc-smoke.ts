#!/usr/bin/env tsx
/**
 * Relay spend paths under adversarial / broken RPC nodes.
 * Real RelayQueueDrainer + BlurtClient + CreateEndpoint against in-process fake
 * JSON-RPC nodes sharing one fake chain (scripts/lib/fakeBlurtChain.ts), and a
 * REAL Postgres table. The scenarios are the independent verifier's (V2):
 *
 *   A1  once the signed bytes MAY have reached a node (a timeout), a later
 *       node's rejection is not a definite failure — the drainer must not sign
 *       a second transfer; a hostile node that relays then "rejects" must not
 *       let signups past the ceiling / per-IP limits.
 *   A2  "absent" must come from a node whose history and irreversible block are
 *       read TOGETHER (and from more than one operator): a lagging history node
 *       must not trigger a second payment.
 *   A3  a node without the history API is failed over; a row whose outcome can
 *       never be settled ESCALATES (out of the queue, counted on /v1/health)
 *       instead of retrying forever; unsettled rows cannot starve new ones.
 *   A4  after `broadcast_outcome_unknown` the same-name retry reaches the
 *       "already created with your key" answer (not a 60-min spacing 429).
 *   S1  settling compares the chain to the SIGNED expiration, not to the claim
 *       stamp + a guess.
 *
 * Needs TEST_DATABASE_URL; without it the smoke says so and exits 0.
 * Usage: cd apps/relay && TEST_DATABASE_URL=… ../../node_modules/.bin/tsx --tsconfig ../../tsconfig.smoke.json scripts/relay-adversarial-rpc-smoke.ts
 */
import pg from 'pg';
import { Hono } from 'hono';
import { PrivateKey, cryptoUtils } from '@beblurt/dblurt';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newChain, startNode, type FakeNode } from './lib/fakeBlurtChain.ts';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
	console.log('relay adversarial-RPC smoke: skipped — TEST_DATABASE_URL is not set');
	process.exit(0);
}
const work = mkdtempSync(join(tmpdir(), 'relay-adv-'));
let healthFile = 0;
const freshHealth = (): void => {
	process.env.MORPHIT_RPC_HEALTH_STATE = join(work, `h${healthFile++}.json`);
};
freshHealth();

const { RelayQueueDrainer } = await import('../src/queue/drainer.ts');
const { BlurtClient, BroadcastOutcomeUnknownError } = await import('../src/blurt/client.ts');
const { CreateEndpoint } = await import('../src/api/create.ts');
const { Limiter } = await import('../src/middleware/ratelimit.ts');
const { GlobalDailyCeiling } = await import('../src/policy/globalDailyCeiling.ts');
const { InviteTokenService } = await import('../src/policy/inviteToken.ts');

let failures = 0;
let scenarios = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
	// ONLY=<substring> runs just the matching scenarios (debugging aid).
	if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
	scenarios++;
	try {
		await fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}
function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(msg);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SCHEMA = `relay_adv_${process.pid}`;
const admin = new pg.Client({ connectionString: url });
await admin.connect();
await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
const db = { query: (t: string, p?: readonly unknown[]) => pool.query(t, p as unknown[]) };
async function freshTable(): Promise<void> {
	await pool.query(`DROP TABLE IF EXISTS relay_pending_transfers`);
	await pool.query(`CREATE TABLE relay_pending_transfers (
		id BIGSERIAL PRIMARY KEY, recipient TEXT NOT NULL, kind TEXT NOT NULL,
		amount_blurt NUMERIC NOT NULL, amount_bp NUMERIC, reason TEXT NOT NULL,
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), broadcast_at TIMESTAMPTZ, broadcast_trx_id TEXT,
		last_error TEXT, last_error_at TIMESTAMPTZ, error_count INTEGER NOT NULL DEFAULT 0,
		broadcast_attempt_at TIMESTAMPTZ)`);
}
const WIF = PrivateKey.fromSeed('relay-adversarial-smoke').toString();
const cfg = (over: Record<string, unknown> = {}) =>
	({
		relayAccount: 'relay',
		relayActiveKeyWif: WIF,
		queuePollIntervalMs: 1000,
		queueBatchSize: 20,
		queueMaxRetries: 3,
		queueMaxSettleChecks: 3,
		...over
	}) as never;
const fastOpts = { broadcastAttemptTimeoutMs: 1500, expireSeconds: 9, verifyPollMs: 300 } as never;
const nodes: FakeNode[] = [];
const node = async (c: ReturnType<typeof newChain>, b: Parameters<typeof startNode>[1]) => {
	const n = await startNode(c, b);
	nodes.push(n);
	return n;
};
const ageStamp = (min: number) =>
	pool.query(
		`UPDATE relay_pending_transfers SET broadcast_attempt_at = broadcast_attempt_at - make_interval(mins => $1)`,
		[min]
	);

console.log('relay adversarial-RPC smoke (real Postgres, fake chain):\n');

await check(
	'A1: a node takes the transfer and loses the reply, the next node rejects it → still ONE transfer',
	async () => {
		await freshTable();
		await pool.query(
			`INSERT INTO relay_pending_transfers (recipient, kind, amount_blurt, reason) VALUES ('alice','liquid',10,'welcome_bonus_liquid')`
		);
		freshHealth();
		const chain = newChain();
		chain.libGapBlocks = 0;
		const B = await node(chain, {
			bcast: { reject: 'Assert Exception: transaction tapos exception' },
			noDupCheck: true
		});
		const A = await node(chain, { bcast: 'accept-hang' });
		const drainer = new RelayQueueDrainer(
			cfg(),
			db as never,
			new BlurtClient([B.url, A.url], 100, fastOpts)
		);
		await drainer.drainOnce();
		chain.includePending(); // A's copy was valid all along
		A.b.bcast = 'ok';
		B.b.bcast = 'ok';
		await sleep(19_000); // the signed expiration passes behind the irreversible block
		for (let i = 0; i < 3; i++) {
			await ageStamp(10);
			await drainer.drainOnce();
		}
		const n = chain.transfersTo('alice').length;
		assert(n === 1, `${n} transfers to alice on chain (expected 1)`);
	}
);

await check(
	'A1: a hostile node that relays every account_create and answers "rejected" cannot beat the ceiling',
	async () => {
		freshHealth();
		const chain = newChain();
		const H = await node(chain, {
			bcast: { relayThenReject: 'Assert Exception: transaction tapos exception' }
		});
		const blurt = new BlurtClient([H.url], 100, fastOpts);
		const invites = new InviteTokenService({ ttlMs: 600_000 });
		const ep = new CreateEndpoint(
			{ relayAccount: 'relay', relayActiveKeyWif: WIF } as never,
			blurt,
			new Limiter(1000, 3_600_000),
			new Limiter(1000, 86_400_000),
			0,
			{ canAcceptCreation: () => true, liveFeeSpiked: () => false } as never,
			true,
			new GlobalDailyCeiling(2, () => {}),
			invites,
			null,
			'off',
			4,
			null
		);
		const app = new Hono();
		ep.register(app);
		const key = (s: string) => PrivateKey.fromSeed(s).createPublic('BLT').toString();
		const codes: string[] = [];
		for (let i = 1; i <= 5; i++) {
			const body = {
				invite_token: invites.issue('unknown').token,
				op: {
					new_account_name: `victimpay${i}`,
					owner: { weight_threshold: 1, account_auths: [], key_auths: [[key('o' + i), 1]] },
					active: { weight_threshold: 1, account_auths: [], key_auths: [[key('a' + i), 1]] },
					posting: { weight_threshold: 1, account_auths: [], key_auths: [[key('p' + i), 1]] },
					memo_key: key('m' + i),
					json_metadata: ''
				}
			};
			const r = await app.request('/v1/account/create', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			codes.push(
				`${r.status}:${((await r.json()) as { code?: string; status?: string }).code ?? 'ok'}`
			);
		}
		const created = chain.accountsCreated().length;
		assert(
			created <= 2,
			`${created} accounts created (${created * 100} BLURT) past a 2/day ceiling — responses ${codes.join(' ')}`
		);
	}
);

await check(
	'A2: a lagging history node cannot turn a landed payment into a second one',
	async () => {
		await freshTable();
		freshHealth();
		const chain = newChain();
		const H = await node(chain, { bcast: 'ok' });
		const L = await node(chain, { bcast: 'ok', lagSec: 600 });
		const tx1 = {
			ref_block_num: 1,
			ref_block_prefix: 1,
			expiration: new Date(Date.now() - 280_000).toISOString().slice(0, 19),
			extensions: [],
			signatures: [],
			operations: [
				[
					'transfer',
					{
						from: 'relay',
						to: 'alice',
						amount: '10.000 BLURT',
						memo: 'morphit:welcome_bonus_liquid'
					}
				]
			] as [string, Record<string, unknown>][]
		};
		const tx1id = cryptoUtils.generateTrxId(tx1 as never);
		chain.includeTx(tx1id, tx1, -100); // landed ~5 min ago
		const exp = new Date(tx1.expiration + 'Z').getTime();
		await pool.query(
			`INSERT INTO relay_pending_transfers (recipient, kind, amount_blurt, reason, broadcast_attempt_at, last_error)
		 VALUES ('alice','liquid',10,'welcome_bonus_liquid', NOW() - interval '5 minutes', $1)`,
			[`outcome_unknown trx_id=${tx1id} exp=${exp} checks=0`]
		);
		// Fresh pool: never-tried endpoints are asked first, in order — H then L.
		const drainer = new RelayQueueDrainer(
			cfg(),
			db as never,
			new BlurtClient([H.url, L.url], 100, fastOpts)
		);
		await drainer.drainOnce();
		const n = chain.transfersTo('alice').length;
		assert(n === 1, `${n} transfers to alice (expected 1)`);
	}
);

await check(
	'A3: a node without the history API is failed over — the row is settled, not stuck',
	async () => {
		await freshTable();
		freshHealth();
		const chain = newChain();
		const N1 = await node(chain, { bcast: 'ok', noHistoryApi: true });
		const N2 = await node(chain, { bcast: 'ok', delayMs: 50 });
		const N3 = await node(chain, { bcast: 'ok', delayMs: 80 });
		const exp = Date.now() - 600_000;
		await pool.query(
			`INSERT INTO relay_pending_transfers (recipient, kind, amount_blurt, reason, broadcast_attempt_at, last_error)
		 VALUES ('alice','liquid',10,'welcome_bonus_liquid', NOW() - interval '10 minutes', $1)`,
			[`outcome_unknown trx_id=${'c'.repeat(40)} exp=${exp} checks=0`]
		);
		const blurt = new BlurtClient([N1.url, N2.url, N3.url], 100, fastOpts);
		for (let i = 0; i < 4; i++) await blurt.getDynamicGlobalProperties();
		const drainer = new RelayQueueDrainer(cfg(), db as never, blurt);
		for (let i = 0; i < 2; i++) {
			await drainer.drainOnce();
			await ageStamp(10);
		}
		const row = (await pool.query(`SELECT broadcast_at, last_error FROM relay_pending_transfers`))
			.rows[0];
		assert(
			row.broadcast_at !== null && chain.transfersTo('alice').length === 1,
			`broadcast_at=${row.broadcast_at} last_error=${row.last_error} transfers=${chain.transfersTo('alice').length}`
		);
	}
);

await check(
	'A3: a row that can never be settled ESCALATES (leaves the queue, counted for /v1/health)',
	async () => {
		await freshTable();
		freshHealth();
		const chain = newChain();
		const N1 = await node(chain, { bcast: 'ok', noHistoryApi: true });
		const N2 = await node(chain, { bcast: 'ok', delayMs: 50 });
		await pool.query(
			`INSERT INTO relay_pending_transfers (recipient, kind, amount_blurt, reason, broadcast_attempt_at, last_error)
		 VALUES ('alice','liquid',10,'welcome_bonus_liquid', NOW() - interval '10 minutes', $1)`,
			[`outcome_unknown trx_id=${'c'.repeat(40)} exp=${Date.now() - 600_000} checks=0`]
		);
		const drainer = new RelayQueueDrainer(
			cfg(),
			db as never,
			new BlurtClient([N1.url, N2.url], 100, fastOpts)
		);
		for (let i = 0; i < 6; i++) {
			await drainer.drainOnce();
			await ageStamp(60 * 24);
		}
		const row = (await pool.query(`SELECT error_count, last_error FROM relay_pending_transfers`))
			.rows[0];
		const stats = (
			drainer as unknown as { queueStats?: () => { escalated: number } }
		).queueStats?.();
		assert(
			row.error_count >= 3 &&
				/^escalated/.test(row.last_error ?? '') &&
				stats?.escalated === 1 &&
				chain.transfersTo('alice').length === 0,
			`error_count=${row.error_count} last_error=${row.last_error} stats=${JSON.stringify(stats)} transfers=${chain.transfersTo('alice').length}`
		);
	}
);

await check('A3: twenty unsettled rows cannot starve a new payment', async () => {
	await freshTable();
	freshHealth();
	const chain = newChain();
	const N1 = await node(chain, { bcast: 'ok', noHistoryApi: true });
	const N2 = await node(chain, { bcast: 'ok', delayMs: 20 });
	for (let i = 0; i < 20; i++)
		await pool.query(
			`INSERT INTO relay_pending_transfers (recipient, kind, amount_blurt, reason, created_at, broadcast_attempt_at, last_error)
			 VALUES ($1,'liquid',10,'welcome_bonus_liquid', NOW() - interval '1 hour', NOW() - interval '10 minutes', $2)`,
			[
				`user${String.fromCharCode(97 + i)}x`,
				`outcome_unknown trx_id=${'c'.repeat(40)} exp=${Date.now() - 600_000} checks=0`
			]
		);
	await pool.query(
		`INSERT INTO relay_pending_transfers (recipient, kind, amount_blurt, reason) VALUES ('newcomer','liquid',10,'welcome_bonus_liquid')`
	);
	const drainer = new RelayQueueDrainer(
		cfg(),
		db as never,
		new BlurtClient([N1.url, N2.url], 100, fastOpts)
	);
	await drainer.drainOnce();
	assert(
		chain.transfersTo('newcomer').length === 1,
		`newcomer paid: ${chain.transfersTo('newcomer').length}`
	);
});

await check(
	'S1: settling waits for the SIGNED expiration, however late the transaction was signed',
	async () => {
		await freshTable();
		freshHealth();
		await pool.query(
			`INSERT INTO relay_pending_transfers (recipient, kind, amount_blurt, reason) VALUES ('alice','liquid',10,'welcome_bonus_liquid')`
		);
		const chain = newChain();
		chain.libGapBlocks = 0;
		const G = await node(chain, { bcast: 'accept-hang' });
		const G2 = await node(chain, { bcast: 'ok', delayMs: 30 });
		const blurt = new BlurtClient([G.url], 100, {
			broadcastAttemptTimeoutMs: 1500,
			expireSeconds: 60,
			verifyPollMs: 300
		} as never);
		const drainer = new RelayQueueDrainer(cfg(), db as never, blurt);
		await drainer.drainOnce(); // taken by G, reply lost; tx1 valid for 60 s
		blurt.mergeRpcEndpoints([G2.url]);
		G.b.bcast = 'ok';
		await ageStamp(10); // the claim stamp looks old; the signed expiration is not
		await sleep(3_100); // a new head block: a re-signed transfer would get a NEW id
		await drainer.drainOnce();
		chain.includePending(); // tx1 lands now, still valid
		const n = chain.transfersTo('alice').length;
		if (process.env.ONLY)
			console.log(
				'      debug:',
				(await pool.query('select last_error, broadcast_at from relay_pending_transfers')).rows[0],
				G.hits,
				G2.hits
			);
		assert(n === 1, `${n} transfers to alice (expected 1)`);
	}
);

await check(
	'A4: after broadcast_outcome_unknown, the same-name retry is answered from the chain, not refused for spacing',
	async () => {
		const key = (s: string) => PrivateKey.fromSeed(s).createPublic('BLT').toString();
		const owner = key('o');
		let exists = false;
		const blurt = {
			getAccount: async () =>
				exists
					? {
							name: 'sallyretry',
							owner_pubkey: owner,
							posting_pubkey: key('p'),
							created: '',
							balance: '0.000 BLURT',
							pending_claimed_accounts: 0
						}
					: null,
			broadcastAccountCreate: async () => {
				exists = true;
				throw new BroadcastOutcomeUnknownError(
					'd'.repeat(40),
					Date.now() + 60_000,
					'no endpoint confirmed'
				);
			},
			broadcastTransfer: async () => ({ id: 'x', block_num: 0, trx_num: 0, expired: false })
		};
		const invites = new InviteTokenService({ ttlMs: 600_000 });
		const ep = new CreateEndpoint(
			{ relayAccount: 'r', relayActiveKeyWif: 'x' } as never,
			blurt as never,
			new Limiter(5, 3_600_000),
			new Limiter(2, 86_400_000),
			60,
			{ canAcceptCreation: () => true, liveFeeSpiked: () => false } as never,
			true,
			new GlobalDailyCeiling(50, () => {}),
			invites,
			null,
			'off',
			4,
			null
		);
		const app = new Hono();
		ep.register(app);
		const body = () => ({
			invite_token: invites.issue('unknown').token,
			op: {
				new_account_name: 'sallyretry',
				owner: { weight_threshold: 1, account_auths: [], key_auths: [[owner, 1]] },
				active: { weight_threshold: 1, account_auths: [], key_auths: [[key('a'), 1]] },
				posting: { weight_threshold: 1, account_auths: [], key_auths: [[key('p'), 1]] },
				memo_key: key('m'),
				json_metadata: ''
			}
		});
		const post = async () => {
			const r = await app.request('/v1/account/create', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body())
			});
			return {
				status: r.status,
				body: (await r.json()) as { status?: string; code?: string; note?: string }
			};
		};
		const first = await post();
		const retry = await post();
		assert(
			first.status === 503 && first.body.code === 'broadcast_outcome_unknown',
			`first: ${first.status} ${first.body.code}`
		);
		assert(
			retry.status === 200 && retry.body.note === 'already_created',
			`retry: ${retry.status} ${JSON.stringify(retry.body)}`
		);
	}
);

for (const n of nodes) n.close();
await pool.end();
await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
await admin.end();
console.log('');
if (failures > 0) {
	console.log(`✗ ${failures} of ${scenarios} relay adversarial-RPC scenarios failed`);
	process.exit(1);
}
console.log(`✓ all ${scenarios} relay adversarial-RPC scenarios passed`);
process.exit(0);
