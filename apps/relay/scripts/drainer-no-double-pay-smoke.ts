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
		libMs: Date.now(),
		delegationSends: [] as number[],
		refusal: 'all RPC endpoints unavailable: fetch failed'
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
		broadcastDelegation: async (a: {
			delegator: string;
			delegatee: string;
			amountBp: number;
			onSigned?: (i: { txid: string; expirationMs: number }) => Promise<void>;
		}) => {
			const txid = (++n).toString(16).padStart(40, '0');
			const expirationMs = Date.now() + state.expOffsetMs;
			await a.onSigned?.({ txid, expirationMs });
			state.sends++;
			state.delegationSends.push(a.amountBp);
			const op: [string, Record<string, unknown>] = [
				'delegate_vesting_shares',
				{ delegator: a.delegator, delegatee: a.delegatee, vesting_shares: `${a.amountBp} VESTS` }
			];
			if (state.mode === 'ok') {
				history.push({ trx_id: txid, op });
				return { id: txid, block_num: 1, trx_num: 0, expired: false };
			}
			if (state.mode === 'lands_reply_lost') history.push({ trx_id: txid, op });
			throw new BroadcastOutcomeUnknownError(txid, expirationMs, state.refusal);
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

// ─── Delegations (2026-10-08, morphit.io) ─────────────────────────────────
// Two delegation rows for one account were re-signed about once a minute for
// five days: every send ended "outcome unknown", delegations were never
// settled from the chain, and error_count never rose.
async function delegationRows(...bps: number[]): Promise<void> {
	await pool.query(`DELETE FROM relay_pending_transfers`);
	for (const [i, bp] of bps.entries())
		await pool.query(
			`INSERT INTO relay_pending_transfers (recipient, kind, amount_blurt, amount_bp, reason, created_at)
			 VALUES ('khrom', 'delegation', 0, $1, $2, NOW() - make_interval(days => 5))`,
			[bp, i === 0 ? 'first_listing_fee_welcome' : 'loyalty_milestone_100']
		);
}
async function rows(): Promise<
	Array<{ id: string; broadcast_at: Date | null; error_count: number; last_error: string | null }>
> {
	return (
		await pool.query(
			`SELECT id::text, broadcast_at, error_count, last_error FROM relay_pending_transfers ORDER BY id`
		)
	).rows;
}

await check(
	"a delegation the chain keeps refusing stops after the retry limit, with the nodes' reason (not re-signed forever)",
	async () => {
		await freshTable();
		await delegationRows(11);
		const m = mockChain();
		m.state.mode = 'lost_before_node';
		m.state.refusal = 'Account must delegate a minimum of 1000.000 VESTS';
		const d = new RelayQueueDrainer(config as never, db as never, m.blurt as never);
		for (let i = 0; i < 20; i++) {
			await d.drainOnce().catch(() => {});
			await age(300); // past every backoff; the chain is past each expiration
			m.state.libMs = Date.now();
		}
		const [r] = await rows();
		assert(
			m.state.delegationSends.length === config.queueMaxRetries,
			`sent ${m.state.delegationSends.length} times in 20 cycles (expected ${config.queueMaxRetries}, then stop)`
		);
		assert(r!.error_count >= config.queueMaxRetries, `error_count=${r!.error_count}`);
		assert(
			(r!.last_error ?? '').includes('Account must delegate a minimum'),
			`the nodes' reason is not on the row: ${r!.last_error}`
		);
	}
);

await check(
	'a delegation that landed with its reply lost is settled from history, not re-sent',
	async () => {
		await freshTable();
		await delegationRows(11);
		const m = mockChain();
		m.state.mode = 'lands_reply_lost';
		const d = new RelayQueueDrainer(config as never, db as never, m.blurt as never);
		await d.drainOnce().catch(() => {});
		for (let i = 0; i < 3; i++) {
			await age(10);
			m.state.libMs = Date.now();
			await d.drainOnce().catch(() => {});
		}
		const [r] = await rows();
		assert(
			m.state.delegationSends.length === 1 && r!.broadcast_at !== null,
			`sends=${m.state.delegationSends.length} broadcast_at=${r!.broadcast_at} (expected 1 and set)`
		);
	}
);

await check(
	'only the newest delegation target for an account is sent; the older row is retired, never sent',
	async () => {
		await freshTable();
		await delegationRows(1, 11);
		const m = mockChain();
		m.state.mode = 'ok';
		const d = new RelayQueueDrainer(config as never, db as never, m.blurt as never);
		await d.drainOnce().catch(() => {});
		await age(10);
		await d.drainOnce().catch(() => {});
		const [older, newer] = await rows();
		assert(
			JSON.stringify(m.state.delegationSends) === '[11]',
			`delegation sends ${JSON.stringify(m.state.delegationSends)} (expected only the 11 BP target)`
		);
		assert(
			older!.broadcast_at !== null && /superseded/.test(older!.last_error ?? ''),
			`older row: ${older!.last_error}`
		);
		assert(newer!.broadcast_at !== null, 'newer row not done');
	}
);

await check(
	"a newer delegation is not sent while an older one's attempt for the account may still land",
	async () => {
		await freshTable();
		await delegationRows(1, 11);
		await pool.query(
			`UPDATE relay_pending_transfers SET broadcast_attempt_at = NOW() - INTERVAL '10 minutes',
			        last_error = $1 WHERE id = (SELECT min(id) FROM relay_pending_transfers)`,
			[`outcome_unknown trx_id=${'e'.repeat(40)} exp=${Date.now() + 60_000} checks=0`]
		);
		const m = mockChain();
		m.state.mode = 'ok';
		const d = new RelayQueueDrainer(config as never, db as never, m.blurt as never);
		await d.drainOnce().catch(() => {});
		assert(
			m.state.delegationSends.length === 0,
			`sent ${JSON.stringify(m.state.delegationSends)} while the older attempt could still land`
		);
	}
);

// ─── Review 2026-10-08 ───────────────────────────────────────────────────
await check(
	"a node's reply with a NUL byte in it does not get the payment sent again",
	async () => {
		// Postgres refuses NUL in text: writing the reply into last_error threw,
		// the failure path then overwrote the record of the signed transaction,
		// and the next cycle signed and sent a new one.
		await freshTable();
		const m = mockChain();
		const d = new RelayQueueDrainer(
			config as never,
			db as never,
			{
				...m.blurt,
				broadcastTransfer: async (a: Parameters<typeof m.blurt.broadcastTransfer>[0]) =>
					m.blurt.broadcastTransfer(a).catch((e: unknown) => {
						if (e instanceof BroadcastOutcomeUnknownError)
							throw new BroadcastOutcomeUnknownError(
								e.txid,
								e.expirationMs,
								'rejected\u0000\u2028x'
							);
						throw e;
					})
			} as never
		);
		for (let i = 0; i < 4; i++) {
			await d.drainOnce().catch(() => {});
			await age(300);
			m.state.libMs = Date.now();
		}
		assert(
			landed(m.state.history) === 1,
			`${landed(m.state.history)} transfers landed (expected 1)`
		);
		assert((await row()).broadcast_at !== null, 'the landed transfer was not settled');
	}
);

await check('a database error while settling does not get the payment sent again', async () => {
	await freshTable();
	const m = mockChain();
	let blips = 1;
	const flaky = {
		...db,
		query: (t: string, p?: readonly unknown[]) => {
			// The write that marks a found payment as done fails once (a dropped
			// connection), after the payment was found in the history.
			if (blips > 0 && /broadcast_trx_id = \$2/.test(t) && /^[0-9a-f]{40}$/.test(String(p?.[1]))) {
				blips--;
				return Promise.reject(new Error('Connection terminated unexpectedly'));
			}
			return db.query(t, p);
		}
	};
	const d = new RelayQueueDrainer(config as never, flaky as never, m.blurt as never);
	for (let i = 0; i < 4; i++) {
		await d.drainOnce().catch(() => {});
		await age(300);
		m.state.libMs = Date.now();
	}
	assert(blips === 0, 'the database error was never hit');
	assert(landed(m.state.history) === 1, `${landed(m.state.history)} transfers landed (expected 1)`);
	assert((await row()).broadcast_at !== null, 'the landed transfer was not settled');
});

await check(
	'delegations waiting on an older one for the same account never stall the queue',
	async () => {
		// A newer delegation waits while an older attempt for that account may
		// still land. It was never stamped, so it sorted first every cycle; with
		// a batch full of such rows, the older ones were never picked to settle.
		await freshTable();
		await pool.query(`DELETE FROM relay_pending_transfers`);
		const m = mockChain();
		m.state.mode = 'ok';
		// The older 1 BP attempt landed; its reply was lost.
		const oldTx = 'a'.repeat(40);
		m.state.history.push({
			trx_id: oldTx,
			op: [
				'delegate_vesting_shares',
				{ delegator: 'relay', delegatee: 'khrom', vesting_shares: '1 VESTS' }
			]
		});
		await pool.query(
			`INSERT INTO relay_pending_transfers (recipient, kind, amount_blurt, amount_bp, reason, created_at,
			        broadcast_attempt_at, last_error)
			 VALUES ('khrom', 'delegation', 0, 1, 'first_listing_fee_welcome', NOW() - INTERVAL '5 days',
			        NOW() - INTERVAL '300 minutes', $1),
			        ('khrom', 'delegation', 0, 11, 'loyalty_milestone_100', NOW() - INTERVAL '4 days', NULL, NULL),
			        ('carol', 'liquid', 5, NULL, 'welcome_bonus_liquid', NOW(), NULL, NULL)`,
			[`outcome_unknown trx_id=${oldTx} exp=${Date.now() - 600_000} checks=0`]
		);
		const d = new RelayQueueDrainer(
			{ ...config, queueBatchSize: 1 } as never,
			db as never,
			m.blurt as never
		);
		for (let i = 0; i < 6; i++) await d.drainOnce().catch(() => {});
		const all = await rows();
		assert(
			all.every((r) => r.broadcast_at !== null),
			`not done after 6 cycles: ${JSON.stringify(all.filter((r) => r.broadcast_at === null))}`
		);
		assert(
			JSON.stringify(m.state.delegationSends) === '[11]',
			`delegation sends ${JSON.stringify(m.state.delegationSends)} (expected only the 11 BP target)`
		);
	}
);

// ─── The chain's minimum delegation (Blurt, inherited from Steem HF20) ─────
// A NEW delegation must be at least account_creation_fee / 3 (≈ 33.4 BP at a
// 100 BLURT fee); a change, at least fee / 30. On morphit.io the 1 BP welcome
// stake and the 11 BP first milestone to khrom were refused for five days.
function withRules(m: ReturnType<typeof mockChain>, currentBp: number) {
	return {
		...m.blurt,
		delegationRules: async () => ({ minNewBp: 100 / 3, minChangeBp: 100 / 30, currentBp })
	};
}

await check('a delegation below the chain minimum is held, not sent, and says why', async () => {
	await freshTable();
	await delegationRows(1, 11);
	const m = mockChain();
	m.state.mode = 'ok';
	const d = new RelayQueueDrainer(config as never, db as never, withRules(m, 0) as never);
	await d.drainOnce().catch(() => {}); // the older row is retired as superseded
	await age(300);
	await d.drainOnce().catch(() => {}); // the newer one is held
	const [, held] = await rows();
	// A held row is looked at again only after hours, not every cycle.
	const again = await pool.query(
		`SELECT broadcast_attempt_at > NOW() + INTERVAL '1 hour' AS later FROM relay_pending_transfers WHERE id = $1`,
		[held!.id]
	);
	assert(again.rows[0]?.later === true, 'a held row is checked again within the hour');
	for (let i = 0; i < 3; i++) {
		await age(600);
		await d.drainOnce().catch(() => {});
	}
	const [older, newer] = await rows();
	assert(
		m.state.delegationSends.length === 0,
		`sent ${JSON.stringify(m.state.delegationSends)} below the chain minimum`
	);
	assert(/superseded/.test(older!.last_error ?? ''), `older: ${older!.last_error}`);
	assert(
		newer!.broadcast_at === null && /^held: .*minimum/.test(newer!.last_error ?? ''),
		`newer: ${newer!.last_error}`
	);
	assert(newer!.error_count === 0, `a hold counted as an error (${newer!.error_count})`);
});

await check('once the reward adds up to the minimum it is lent', async () => {
	await freshTable();
	await delegationRows(1, 11, 61);
	const m = mockChain();
	m.state.mode = 'ok';
	const d = new RelayQueueDrainer(config as never, db as never, withRules(m, 0) as never);
	for (let i = 0; i < 3; i++) {
		await d.drainOnce().catch(() => {});
		await age(300);
	}
	assert(
		JSON.stringify(m.state.delegationSends) === '[61]',
		`delegation sends ${JSON.stringify(m.state.delegationSends)} (expected only 61)`
	);
});

await check('a target the chain already holds is marked done without a send', async () => {
	await freshTable();
	await delegationRows(61);
	const m = mockChain();
	m.state.mode = 'ok';
	const d = new RelayQueueDrainer(config as never, db as never, withRules(m, 61) as never);
	await d.drainOnce().catch(() => {});
	const [r] = await rows();
	assert(m.state.delegationSends.length === 0, `sent ${JSON.stringify(m.state.delegationSends)}`);
	assert(r!.broadcast_at !== null, `not marked done: ${r!.last_error}`);
});

// ─── Second review 2026-10-08 ─────────────────────────────────────────────
await check(
	'an older delegation that has hit the retry limit does not block newer ones forever',
	async () => {
		await freshTable();
		await delegationRows(1, 61);
		await pool.query(
			`UPDATE relay_pending_transfers SET error_count = $2, broadcast_attempt_at = NOW() - INTERVAL '1 day',
		        last_error = $1 WHERE id = (SELECT min(id) FROM relay_pending_transfers)`,
			[
				`outcome_unknown trx_id=${'f'.repeat(40)} exp=${Date.now() - 86_400_000} checks=0`,
				config.queueMaxRetries
			]
		);
		const m = mockChain();
		m.state.mode = 'ok';
		const d = new RelayQueueDrainer(config as never, db as never, m.blurt as never);
		await d.drainOnce().catch(() => {});
		assert(
			JSON.stringify(m.state.delegationSends) === '[61]',
			`delegation sends ${JSON.stringify(m.state.delegationSends)} (the newer target never went out)`
		);
	}
);

await check(
	'an older delegation is not retired in favour of a newer row that can no longer be sent',
	async () => {
		await freshTable();
		await delegationRows(61, 111);
		await pool.query(
			`UPDATE relay_pending_transfers SET error_count = $1, last_error = 'escalated: x'
		  WHERE id = (SELECT max(id) FROM relay_pending_transfers)`,
			[config.queueMaxRetries]
		);
		const m = mockChain();
		m.state.mode = 'ok';
		const d = new RelayQueueDrainer(config as never, db as never, m.blurt as never);
		await d.drainOnce().catch(() => {});
		assert(
			JSON.stringify(m.state.delegationSends) === '[61]',
			`delegation sends ${JSON.stringify(m.state.delegationSends)} (expected the older 61 BP target)`
		);
	}
);

await check(
	'a row with an open attempt that fails validation is counted, so it stops and reaches the operator',
	async () => {
		await freshTable();
		await pool.query(
			`UPDATE relay_pending_transfers SET recipient = 'Bad Name', last_error = $1,
		        broadcast_attempt_at = NOW() - INTERVAL '1 day'`,
			[`outcome_unknown trx_id=${'e'.repeat(40)} exp=${Date.now() - 86_400_000} checks=0`]
		);
		const m = mockChain();
		const d = new RelayQueueDrainer(config as never, db as never, m.blurt as never);
		for (let i = 0; i < 6; i++) {
			await d.drainOnce().catch(() => {});
			await age(300);
		}
		const r = await row();
		assert(r.error_count >= config.queueMaxRetries, `error_count=${r.error_count} after 6 cycles`);
		assert(
			/^outcome_unknown trx_id=e{40}/.test(r.last_error ?? ''),
			`the attempt record was lost: ${r.last_error}`
		);
		assert(landed(m.state.history) === 0 && m.state.sends === 0, 'sent while the attempt was open');
	}
);

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
