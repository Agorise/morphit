/**
 * Failed broadcasts, against a real Postgres with the indexer's real schema
 * and real relay_pending_transfers rows (runs when TEST_DATABASE_URL is set).
 * Review of v1.21.18:
 *  - `status` counted every unsent row with an error as "still not sent",
 *    including rows the relay is still sending or settling from the chain
 *    (`in_flight …`, `outcome_unknown …`);
 *  - `failed-broadcasts` called a row the relay ESCALATED ("outcome … still
 *    unknown") a red ✗ "not sent". The relay could not tell whether it landed
 *    and will not send it again; "not sent" invites paying twice. It is now
 *    "may have been sent", with the exact way to look its transaction up — on
 *    this server, and never with a clearnet link on a hidden-only node.
 * v1.24.7: a delegation the relay HOLDS because the chain would refuse it
 * (below its minimum) was a red ✗ "not sent", a failed broadcast on `status`,
 * and a 47-day ✗ "oldest pending" on morphit.io. It is "held", never a failure.
 * The last_error texts are the relay's own (apps/relay/src/queue/drainer.ts).
 */
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/init/chainCheck.ts', async (orig) => ({
	...((await orig()) as object),
	lookupBlurtAccount: async () => null
}));
vi.mock('../src/lib/operatorFeeRecipient.ts', async (orig) => ({
	...((await orig()) as object),
	localFeeView: async () => null
}));

const { runStatus } = await import('../src/commands/status.ts');
const { runFailedBroadcasts } = await import('../src/commands/failedBroadcasts.ts');
const { runLoyalty } = await import('../src/commands/loyalty.ts');
const { runDrainQueue } = await import('../src/commands/drainQueue.ts');

const ADMIN = process.env.TEST_DATABASE_URL;
const SCHEMA = `fbtest_${randomBytes(4).toString('hex')}`;
const HOUR = 3_600_000;
const TX_ESCALATED = 'a'.repeat(40);
const TX_AT_LIMIT = 'b'.repeat(40);
const TX_SETTLING = 'c'.repeat(40);
const HELD_TEXT =
	"held: 11 BP is below the chain's minimum delegation of 33.333 BP; it is lent once this account's rewards add up to it";

const config = {
	relayAccount: 'alice-relay',
	signupDailyCeiling: 50,
	thresholds: {
		relayBalance: { warn: 100, error: 30, direction: 'lower_worse' },
		drainQueueAgeSec: { warn: 300, error: 3600, direction: 'higher_worse' },
		indexerLagBlocks: { warn: 5, error: 30, direction: 'higher_worse' },
		signupsPercentOfCeiling: { warn: 80, error: 100, direction: 'higher_worse' },
		abuseAlerts24h: { warn: 10, error: 50, direction: 'higher_worse' }
	}
};

describe.skipIf(!ADMIN)('failed broadcasts on the real schema', () => {
	let admin: pg.Client;
	let client: pg.Client;
	let pool: pg.Pool;
	let db: { query: pg.Pool['query'] };

	beforeAll(async () => {
		admin = new pg.Client({ connectionString: ADMIN });
		await admin.connect();
		await admin.query(`CREATE SCHEMA ${SCHEMA}`);
		const u = new URL(ADMIN!);
		u.searchParams.set('options', `-c search_path=${SCHEMA}`);
		client = new pg.Client({ connectionString: u.toString() });
		await client.connect();
		await client.query(
			readFileSync(
				join(import.meta.dirname, '..', '..', 'indexer', 'src', 'db', 'schema.sql'),
				'utf8'
			)
		);
		// The commands ask several queries at once, as on a server (a pool).
		pool = new pg.Pool({ connectionString: u.toString(), max: 4 });
		db = { query: pool.query.bind(pool) as pg.Pool['query'] };
	}, 120_000);
	afterAll(async () => {
		await pool?.end();
		await client?.end();
		await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
		await admin?.end();
	});

	let out = '';
	beforeEach(async () => {
		out = '';
		vi.spyOn(process.stdout, 'write').mockImplementation(
			(c: unknown) => ((out += String(c)), true)
		);
		vi.spyOn(console, 'log').mockImplementation(
			(...a: unknown[]) => void (out += a.join(' ') + '\n')
		);
		// An empty server root: the relay's default retry limit (3), no relay
		// answering, no backups.
		const root = mkdtempSync(join(tmpdir(), 'morphit-fb-'));
		vi.stubEnv('MORPHIT_ENV_ROOT', root);
		vi.stubEnv('MORPHIT_BACKUP_DIR', join(root, 'backups'));
		vi.stubEnv('MORPHIT_RELAY_LISTEN_HOST', '127.0.0.1');
		vi.stubEnv('MORPHIT_RELAY_LISTEN_PORT', '1');

		await client.query('DELETE FROM relay_pending_transfers');
		const recent = new Date(Date.now() - HOUR);
		const old = new Date(Date.now() - 72 * HOUR);
		const rows: Array<[string, number, string, Date, boolean]> = [
			// recipient, error_count, last_error, last_error_at, sent after all
			['sent-after', 1, 'boom', recent, true],
			[
				'settling',
				1,
				`outcome_unknown trx_id=${TX_SETTLING} exp=1 checks=2 cause=timeout`,
				recent,
				false
			],
			['signed', 1, `in_flight trx_id=${'d'.repeat(40)} exp=1`, recent, false],
			['claimed', 2, 'in_flight', recent, false],
			[
				'escalated',
				3,
				`escalated: outcome of trx_id=${TX_ESCALATED} still unknown after 30 checks — check the relay account's history for it before re-queueing`,
				recent,
				false
			],
			['at-limit', 3, `outcome_unknown trx_id=${TX_AT_LIMIT} exp=1 checks=4`, recent, false],
			[
				'not-landed',
				1,
				`not_landed trx_id=${'e'.repeat(40)} (absent past its expiration per 2+ operators)`,
				recent,
				false
			],
			['bad-name', 3, 'row 9: recipient does not match account-name regex', recent, false],
			['long-ago', 3, 'boom', old, false]
		];
		for (const [recipient, errors, lastError, at, sent] of rows)
			await client.query(
				`INSERT INTO relay_pending_transfers
				   (recipient, kind, amount_blurt, reason, created_at, error_count, last_error,
				    last_error_at, broadcast_at, broadcast_trx_id)
				 VALUES ($1, 'liquid', 10, 'welcome_bonus_liquid', $4, $2, $3, $4, $5, $6)`,
				[recipient, errors, lastError, at, sent ? at : null, sent ? 'f'.repeat(40) : null]
			);
		// Held delegations, as on morphit.io: queued 47 days ago, looked at
		// again an hour ago; one had a counted error before the hold existed.
		for (const [recipient, errors] of [
			['held-fresh', 0],
			['held-errored', 1]
		] as const)
			await client.query(
				`INSERT INTO relay_pending_transfers
				   (recipient, kind, amount_blurt, amount_bp, reason, created_at, error_count,
				    last_error, last_error_at)
				 VALUES ($1, 'delegation', 0, 11, 'loyalty_milestone_1000', $3, $2, $4, $5)`,
				[recipient, errors, new Date(Date.now() - 47 * 24 * HOUR), HELD_TEXT, recent]
			);
		// A row not tried yet (no last_error at all), queued 100 hours ago.
		await client.query(
			`INSERT INTO relay_pending_transfers (recipient, kind, amount_blurt, reason, created_at)
			 VALUES ('untried', 'liquid', 10, 'welcome_bonus_liquid', $1)`,
			[new Date(Date.now() - 100 * HOUR)]
		);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	const ctx = (flags: Record<string, string> = {}) =>
		({ db, config, flags, positional: [] }) as never;
	const hidden = { indexerBase: 'http://127.0.0.1:8081', explorerOrigin: null };
	const clearnet = { indexerBase: 'http://127.0.0.1:8081', explorerOrigin: 'https://example.org' };

	it('status counts only rows that need a look: not sent, or may have been sent', async () => {
		await runStatus(ctx({ json: 'true' }));
		const j = JSON.parse(out.slice(out.indexOf('{'))) as {
			failed_broadcasts_24h: { count: number; may_have_been_sent: number; not_sent: number };
		};
		expect(j.failed_broadcasts_24h).toEqual({ count: 4, may_have_been_sent: 2, not_sent: 2 });
	});

	it('status: held delegations are counted apart, are not the oldest pending, and are not failures', async () => {
		await runStatus(ctx({ json: 'true' }));
		const j = JSON.parse(out.slice(out.indexOf('{'))) as {
			drain_queue: { pending: number; held: number; oldest_age_sec: number };
		};
		expect(j.drain_queue.pending).toBe(11);
		expect(j.drain_queue.held).toBe(2);
		// The oldest row waiting to be SENT is the untried one (100 hours, no
		// last_error at all), not the held ones (47 days).
		expect(Math.round(j.drain_queue.oldest_age_sec / 3600)).toBe(100);
	});

	it('status, a queue holding only held delegations (morphit.io): no ✗, no warning, said calmly', async () => {
		await client.query(`DELETE FROM relay_pending_transfers WHERE recipient NOT LIKE 'held-%'`);
		await runStatus(ctx());
		if (process.env.SHOW_OUT) process.stderr.write(out);
		const queue = out.slice(out.indexOf('Relay drain queue'), out.indexOf('Signups today'));
		expect(queue).toMatch(/Pending transfers:\s+2\s+2 delegations/);
		expect(queue).toMatch(
			/Held delegations:\s+2\s+\[i\] below the chain's minimum delegation, so the relay keeps them and lends them by itself once the rewards add up — not an error, nothing to do/
		);
		expect(queue).toMatch(/Oldest pending age:\s+\(none to send\)\s+\[OK\]/);
		expect(queue).toMatch(/Failed broadcasts 24h:\s+0\s+\[OK\]/);
		expect(queue).not.toMatch(/✗|\[WARN\]|\[ERROR\]/);
	});

	it('status says which are "may have been sent", not "still not sent"', async () => {
		await runStatus(ctx());
		if (process.env.SHOW_OUT) process.stderr.write(out);
		expect(out).toMatch(
			/Failed broadcasts 24h:\s+4\s+\[WARN\] 2 not sent, 2 may have been sent \(look them up before sending again\) — see them, on this server: sudo morphit-ops failed-broadcasts/
		);
	});

	it('failed-broadcasts --json: each row in its real state, the totals of the window', async () => {
		await runFailedBroadcasts(ctx({ json: 'true' }), { ways: hidden });
		const j = JSON.parse(out.slice(out.indexOf('{'))) as {
			total: number;
			sent: number;
			waiting_for_confirmation: number;
			may_have_been_sent: number;
			held_until_the_chain_allows: number;
			not_sent: number;
			entries: Array<{ recipient: string; state: string; trx_id: string | null }>;
		};
		expect([
			j.total,
			j.sent,
			j.waiting_for_confirmation,
			j.may_have_been_sent,
			j.held_until_the_chain_allows,
			j.not_sent
		]).toEqual([10, 1, 3, 2, 2, 2]);
		const state = Object.fromEntries(j.entries.map((e) => [e.recipient, e.state]));
		expect(state).toEqual({
			'sent-after': 'sent',
			settling: 'waiting',
			signed: 'waiting',
			claimed: 'waiting',
			escalated: 'maybe-sent',
			'at-limit': 'maybe-sent',
			'not-landed': 'stuck',
			'bad-name': 'stuck',
			'held-fresh': 'held',
			'held-errored': 'held'
		});
		expect(j.entries.find((e) => e.recipient === 'escalated')?.trx_id).toBe(TX_ESCALATED);
	});

	it('an escalated row is "may have been sent", with the exact lookup on this server (hidden-only: no link)', async () => {
		await runFailedBroadcasts(ctx(), { ways: hidden });
		if (process.env.SHOW_OUT) process.stderr.write(out);
		const line = out.split('\n').find((l) => l.includes('@escalated')) ?? '';
		expect(line).toMatch(/may have been sent/);
		expect(line).not.toMatch(/✗/);
		expect(out).toContain(
			`Look up transaction ${TX_ESCALATED} before sending it again, on this server: curl -s http://127.0.0.1:8081/v1/chain/tx/${TX_ESCALATED}`
		);
		expect(out).toContain(`curl -s http://127.0.0.1:8081/v1/chain/tx/${TX_AT_LIMIT}`);
		expect(out).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
		expect(out).toMatch(/2 may have been sent, 2 not sent/);
		expect(out).toMatch(/if the lookup shows the transaction, it was paid — do not send it again/);
	});

	it('failed-broadcasts: a held delegation is "held, not an error", its reason whole, never ✗', async () => {
		await runFailedBroadcasts(ctx(), { ways: hidden });
		if (process.env.SHOW_OUT) process.stderr.write(out);
		for (const who of ['held-fresh', 'held-errored']) {
			const line = out.split('\n').find((l) => l.includes(`@${who}`)) ?? '';
			expect(line, who).toMatch(/delegation\s+11 BP\s+\(held, not an error\)/);
			expect(line, who).not.toMatch(/✗|errors/);
		}
		expect(out.split(HELD_TEXT)).toHaveLength(3);
		expect(out).toMatch(
			/8 payments had errors\s+\(1 sent after all, 3 being sent or confirmed by the relay, 2 may have been sent, 2 not sent\); 2 held until the chain allows them \(not an error\)/
		);
		expect(out).toContain(
			"Held: the chain does not accept a delegation this small, so the relay keeps it and looks again every few hours; it is lent by itself once the account's rewards add up to the chain's minimum. Nothing to do."
		);
	});

	it('failed-broadcasts with only held delegations (morphit.io): no failures, and no journal hint', async () => {
		await client.query(`DELETE FROM relay_pending_transfers WHERE recipient NOT LIKE 'held-%'`);
		await runFailedBroadcasts(ctx(), { ways: hidden });
		if (process.env.SHOW_OUT) process.stderr.write(out);
		expect(out).toMatch(
			/No broadcast failures in this window\.\s+\(2 held until the chain allows them \(not an error\)\)/
		);
		expect(out).not.toMatch(/✗|had errors|journalctl/);
	});

	it('a held row at the retry limit is not "held": nothing looks at it again, so it is not sent', async () => {
		await client.query(
			`UPDATE relay_pending_transfers SET error_count = 3 WHERE recipient = 'held-errored'`
		);
		await runFailedBroadcasts(ctx({ json: 'true' }), { ways: hidden });
		const j = JSON.parse(out.slice(out.indexOf('{'))) as {
			held_until_the_chain_allows: number;
			not_sent: number;
			entries: Array<{ recipient: string; state: string }>;
		};
		expect(j.held_until_the_chain_allows).toBe(1);
		expect(j.not_sent).toBe(3);
		expect(j.entries.find((e) => e.recipient === 'held-errored')?.state).toBe('stuck');
		out = '';
		await runStatus(ctx({ json: 'true' }));
		const st = JSON.parse(out.slice(out.indexOf('{'))) as {
			drain_queue: { held: number; oldest_age_sec: number };
			failed_broadcasts_24h: { count: number };
		};
		expect(st.drain_queue.held).toBe(1);
		expect(Math.round(st.drain_queue.oldest_age_sec / 3600)).toBe(47 * 24);
		expect(st.failed_broadcasts_24h.count).toBe(5);
	});

	it('loyalty: a held milestone is "·" and said calmly; one replaced by a newer target is ✓ with no red; a failed one stays ✗', async () => {
		await client.query('DELETE FROM relay_pending_transfers');
		await client.query('DELETE FROM account_loyalty_milestones');
		const rows: Array<[string, string | null, number, boolean]> = [
			['held-one', HELD_TEXT, 1, false],
			[
				'replaced',
				'superseded: row 9 carries a newer delegation target for replaced; this one was never sent again',
				0,
				true
			],
			['failed-one', 'row 9: recipient does not match account-name regex', 3, false],
			['sending', `in_flight trx_id=${'d'.repeat(40)} exp=1`, 0, false],
			[
				'escalated-one',
				`escalated: outcome of trx_id=${TX_ESCALATED} still unknown after 30 checks`,
				3,
				false
			]
		];
		for (const [account, lastError, errors, closed] of rows) {
			await client.query(
				`INSERT INTO account_loyalty_milestones (account, milestone_blurt, bp_rewarded, triggered_in_block)
				 VALUES ($1, 1000, 11, 1)`,
				[account]
			);
			await client.query(
				`INSERT INTO relay_pending_transfers
				   (recipient, kind, amount_blurt, amount_bp, reason, error_count, last_error,
				    last_error_at, broadcast_at, created_at)
				 VALUES ($1, 'delegation', 0, 11, 'loyalty_milestone_1000', $2, $3, NOW(), $4, NOW())`,
				[account, errors, lastError, closed ? new Date() : null]
			);
		}
		await runLoyalty(ctx());
		if (process.env.SHOW_OUT) process.stderr.write(out);
		const line = (who: string) => out.split('\n').find((l) => l.includes(`@${who}`)) ?? '';
		expect(line('held-one')).toMatch(/^\s+· .*held until the chain allows it \(not an error\)$/);
		expect(line('replaced')).toMatch(/^\s+✓ .*superseded: row 9/);
		expect(line('failed-one')).toMatch(/^\s+✗ .*recipient does not match/);
		expect(line('sending')).toMatch(/^\s+⏳ .*in_flight trx_id=/);
		expect(line('escalated-one')).toMatch(/^\s+\? .*escalated: outcome/);
		expect(out).toContain('Held: the chain does not accept a delegation this small');

		out = '';
		await runDrainQueue(ctx());
		if (process.env.SHOW_OUT) process.stderr.write(out);
		expect(out.split('\n').find((l) => l.includes('held-one'))).toMatch(/\(held: 11 BP/);
		expect(out.split('\n').find((l) => l.includes('failed-one'))).toMatch(/errored 3×/);
		expect(out).toContain('Held: the chain does not accept a delegation this small');
		expect(out).toContain('A payment marked "errored" is retried by the relay a few times');
	});

	it("a clearnet node also gets its own explorer's page", async () => {
		await runFailedBroadcasts(ctx(), { ways: clearnet });
		expect(out).toContain(`(or open https://example.org/en/explorer/tx/${TX_ESCALATED})`);
	});

	it('a row the relay is still settling is not "not sent" and needs no lookup', async () => {
		await runFailedBroadcasts(ctx(), { ways: hidden });
		const line = out.split('\n').find((l) => l.includes('@settling')) ?? '';
		expect(line).toMatch(/being sent or confirmed/);
		expect(out).not.toContain(`/v1/chain/tx/${TX_SETTLING}`);
	});

	it('a long list is read page by page: the exact command for the next page, which shows the rest', async () => {
		for (let i = 0; i < 60; i++)
			await client.query(
				`INSERT INTO relay_pending_transfers
				   (recipient, kind, amount_blurt, reason, created_at, error_count, last_error, last_error_at)
				 VALUES ($1, 'liquid', 10, 'welcome_bonus_liquid', NOW(), 1, 'boom', NOW() - interval '2 hours')`,
				[`page${i}`]
			);
		await runFailedBroadcasts(ctx(), { ways: hidden });
		expect(out).toMatch(/Showing 1–50 of 70 payments, newest first\./);
		const next = /on this server: (sudo morphit-ops failed-broadcasts [^\n]*--offset=(\d+))/.exec(
			out
		);
		expect(next?.[2]).toBe('50');
		expect(next?.[1]).toContain('--since=24h');
		out = '';
		await runFailedBroadcasts(ctx({ since: '24h', offset: next?.[2] ?? '' }), { ways: hidden });
		expect(out).toMatch(
			/Showing 51–70 of 70 payments, newest first\. These are the last of them\./
		);
		const listed = (out.match(/^\s+\S+\s+\d+\S*\s+@/gm) ?? []).length;
		expect(listed).toBe(20);
	});
});
