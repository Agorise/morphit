#!/usr/bin/env tsx
/**
 * Queue drainer — never pay twice. REAL Postgres.
 *
 * The drainer used to stamp `broadcast_attempt_at` INSIDE a per-row savepoint,
 * so a failed attempt rolled the stamp back: a transfer that LANDED on chain but
 * whose reply was lost was re-signed and re-sent on the very next cycle, up to
 * queueMaxRetries times, with no backoff. This smoke drives the real
 * RelayQueueDrainer against a real `relay_pending_transfers` table (own schema,
 * dropped afterwards) with a mock chain, and checks what actually lands.
 *
 * Needs TEST_DATABASE_URL (e.g. postgres://morphit:morphit@localhost:5433/morphit_a).
 * Without it the smoke says so and exits 0 (same rule as the indexer's
 * integration tests).
 *
 * Usage: cd apps/relay && TEST_DATABASE_URL=… ../../node_modules/.bin/tsx --tsconfig ../../tsconfig.smoke.json scripts/drainer-no-double-pay-smoke.ts
 */
import pg from 'pg';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
	console.log('drainer no-double-pay smoke: skipped — TEST_DATABASE_URL is not set');
	process.exit(0);
}

const { RelayQueueDrainer } = await import('../src/queue/drainer.ts');
const { BroadcastOutcomeUnknownError } = await import('../src/blurt/client.ts');

let failures = 0;
let scenarios = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
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

const SCHEMA = `drainer_smoke_${process.pid}`;
const admin = new pg.Client({ connectionString: url });
await admin.connect();
await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
const db = {
	connect: () => pool.connect(),
	query: (t: string, p?: readonly unknown[]) => pool.query(t, p as unknown[]),
	withTx: async () => {
		throw new Error('unused');
	},
	close: async () => {}
};

async function freshTable(): Promise<void> {
	await pool.query(`DROP TABLE IF EXISTS relay_pending_transfers`);
	await pool.query(`CREATE TABLE relay_pending_transfers (
		id BIGSERIAL PRIMARY KEY, recipient TEXT NOT NULL, kind TEXT NOT NULL,
		amount_blurt NUMERIC NOT NULL, amount_bp NUMERIC, reason TEXT NOT NULL,
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), broadcast_at TIMESTAMPTZ, broadcast_trx_id TEXT,
		last_error TEXT, last_error_at TIMESTAMPTZ, error_count INTEGER NOT NULL DEFAULT 0,
		broadcast_attempt_at TIMESTAMPTZ)`);
	await pool.query(
		`INSERT INTO relay_pending_transfers (recipient, kind, amount_blurt, reason) VALUES ('alice', 'liquid', 10, 'welcome_bonus_liquid')`
	);
}
async function row(): Promise<{
	broadcast_at: Date | null;
	error_count: number;
	last_error: string | null;
}> {
	return (
		await pool.query(`SELECT broadcast_at, error_count, last_error FROM relay_pending_transfers`)
	).rows[0];
}
/** Time passes: the stamp is now `minutes` old. */
async function age(minutes: number): Promise<void> {
	await pool.query(
		`UPDATE relay_pending_transfers SET broadcast_attempt_at = NOW() - make_interval(mins => $1)`,
		[minutes]
	);
}

/** A mock chain behind the BlurtClient API the drainer uses. `mode` decides
 *  what the NEXT broadcast does; `expOffsetMs` is the signed expiration
 *  relative to "now" at signing (negative = already expired, so settling can
 *  happen at once); `libMs` is the chain's irreversible-block time. */
function mockChain() {
	const history: Array<{ trx_id: string; op: [string, Record<string, unknown>] }> = [];
	let n = 0;
	const state = {
		history,
		sends: 0,
		mode: 'lands_reply_lost' as 'lands_reply_lost' | 'lost_before_node' | 'ok',
		expOffsetMs: -120_000,
		libMs: Date.now()
	};
	const blurt = {
		broadcastTransfer: async (a: {
			from: string;
			to: string;
			amountBlurt: number;
			memo?: string;
			onSigned?: (i: { txid: string; expirationMs: number }) => Promise<void>;
		}) => {
			const txid = (++n).toString(16).padStart(40, '0');
			const expirationMs = Date.now() + state.expOffsetMs;
			await a.onSigned?.({ txid, expirationMs });
			state.sends++;
			const op: [string, Record<string, unknown>] = [
				'transfer',
				{ from: a.from, to: a.to, amount: `${a.amountBlurt.toFixed(3)} BLURT`, memo: a.memo ?? '' }
			];
			if (state.mode === 'ok') {
				history.push({ trx_id: txid, op });
				return { id: txid, block_num: 1, trx_num: 0, expired: false };
			}
			if (state.mode === 'lands_reply_lost') history.push({ trx_id: txid, op });
			throw new BroadcastOutcomeUnknownError(
				txid,
				expirationMs,
				'all RPC endpoints unavailable: fetch failed'
			);
		},
		settleTransfer: async (a: {
			expirationMs: number;
			match: (op: string, body: Record<string, unknown>, trx: string | undefined) => boolean;
		}) => {
			if (history.some((h) => a.match(h.op[0], h.op[1], h.trx_id))) return 'found';
			return state.libMs > a.expirationMs + 3000 ? 'absent' : 'unknown';
		}
	};
	return { state, blurt };
}
const config = {
	relayAccount: 'relay',
	relayActiveKeyWif: 'x',
	queueMaxRetries: 3,
	queueBatchSize: 20,
	queuePollIntervalMs: 60_000
};
const landed = (h: Array<{ op: [string, Record<string, unknown>] }>) =>
	h.filter((x) => x.op[0] === 'transfer').length;

console.log('drainer no-double-pay smoke (real Postgres):\n');

await check(
	'a transfer that landed but lost its reply is not sent again on the next cycles',
	async () => {
		await freshTable();
		const m = mockChain();
		const d = new RelayQueueDrainer(config as never, db as never, m.blurt as never);
		for (let i = 0; i < 4; i++) await d.drainOnce().catch(() => {});
		assert(
			landed(m.state.history) === 1,
			`${landed(m.state.history)} transfers landed for one 10 BLURT row (expected 1)`
		);
	}
);

await check(
	'…and once the stamp is old, it is SETTLED from history (marked done, not re-sent)',
	async () => {
		await freshTable();
		const m = mockChain();
		const d = new RelayQueueDrainer(config as never, db as never, m.blurt as never);
		await d.drainOnce().catch(() => {});
		await age(10);
		m.state.libMs = Date.now();
		await d.drainOnce().catch(() => {});
		const r = await row();
		assert(
			landed(m.state.history) === 1 && r.broadcast_at !== null,
			`landed=${landed(m.state.history)} broadcast_at=${r.broadcast_at} (expected 1 and set)`
		);
	}
);

await check(
	'a transfer that provably never landed is re-sent only after it can no longer land',
	async () => {
		await freshTable();
		const m = mockChain();
		m.state.mode = 'lost_before_node';
		const d = new RelayQueueDrainer(config as never, db as never, m.blurt as never);
		await d.drainOnce().catch(() => {});
		m.state.mode = 'ok';
		// Later, but the chain's irreversible block is not yet past the signed
		// expiration: the transaction could still land — must wait.
		await age(2);
		m.state.libMs = Date.now() - 10 * 60_000;
		await d.drainOnce().catch(() => {});
		const sendsWhileOpen = m.state.sends;
		// Window closed and history proves absence: re-send, exactly once.
		await age(10);
		m.state.libMs = Date.now();
		await d.drainOnce().catch(() => {}); // settle: proven absent → attempt failed
		await d.drainOnce().catch(() => {}); // re-send
		const r = await row();
		assert(
			sendsWhileOpen === 1,
			`re-sent while the first transaction could still land (sends=${sendsWhileOpen})`
		);
		assert(
			landed(m.state.history) === 1 && r.broadcast_at !== null,
			`landed=${landed(m.state.history)} broadcast_at=${r.broadcast_at} (expected 1 and set)`
		);
	}
);

await check(
	'a crash after signing (txid recorded) is settled from history, not re-sent',
	async () => {
		await freshTable();
		const m = mockChain();
		m.state.mode = 'ok';
		m.state.history.push({
			trx_id: 'f'.repeat(40),
			op: [
				'transfer',
				{ from: 'relay', to: 'alice', amount: '10.000 BLURT', memo: 'morphit:welcome_bonus_liquid' }
			]
		});
		await pool.query(
			`UPDATE relay_pending_transfers SET broadcast_attempt_at = NOW() - INTERVAL '10 minutes', last_error = $1`,
			[`in_flight trx_id=${'f'.repeat(40)} exp=${Date.now() - 300_000}`]
		);
		const d = new RelayQueueDrainer(config as never, db as never, m.blurt as never);
		await d.drainOnce().catch(() => {});
		const r = await row();
		assert(
			m.state.sends === 0 && r.broadcast_at !== null,
			`sends=${m.state.sends} broadcast_at=${r.broadcast_at} (expected 0 and set)`
		);
	}
);

await check(
	'a crash BEFORE signing (bare in_flight — nothing was sent) is simply sent, once',
	async () => {
		await freshTable();
		const m = mockChain();
		m.state.mode = 'ok';
		await pool.query(
			`UPDATE relay_pending_transfers SET broadcast_attempt_at = NOW() - INTERVAL '10 minutes', last_error = 'in_flight'`
		);
		const d = new RelayQueueDrainer(config as never, db as never, m.blurt as never);
		await d.drainOnce().catch(() => {});
		const r = await row();
		assert(
			m.state.sends === 1 && r.broadcast_at !== null,
			`sends=${m.state.sends} broadcast_at=${r.broadcast_at} (expected 1 and set)`
		);
	}
);

await check('two drainers on one database send a row once (atomic claim)', async () => {
	await freshTable();
	const m = mockChain();
	m.state.mode = 'ok';
	const slow = {
		...m.blurt,
		broadcastTransfer: async (a: {
			from: string;
			to: string;
			amountBlurt: number;
			memo?: string;
		}) => {
			await new Promise((r) => setTimeout(r, 200));
			return m.blurt.broadcastTransfer(a);
		}
	};
	const d1 = new RelayQueueDrainer(config as never, db as never, slow as never);
	const d2 = new RelayQueueDrainer(config as never, db as never, slow as never);
	await Promise.all([d1.drainOnce().catch(() => {}), d2.drainOnce().catch(() => {})]);
	assert(m.state.sends === 1, `sends=${m.state.sends} (expected 1)`);
});

await pool.end();
await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
await admin.end();

console.log('');
if (failures > 0) {
	console.log(`✗ ${failures} of ${scenarios} drainer no-double-pay scenarios failed`);
	process.exit(1);
}
console.log(`✓ all ${scenarios} drainer no-double-pay scenarios passed`);
process.exit(0);
