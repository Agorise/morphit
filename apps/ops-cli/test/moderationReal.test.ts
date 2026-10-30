/**
 * Moderation against a real Postgres with the indexer's real schema
 * (runs when TEST_DATABASE_URL is set, as CI's integration jobs do).
 *
 *  - H4: the main menu's "⚠ N to review" and the Moderation screen count the
 *    SAME flags — all four signals, all time, pile-on per (subject, attacker)
 *    pair. The menu counted two signals over 30 days while the screen listed
 *    four over 7 days: "⚠ 2 to review" opened onto "0 flags".
 *  - H5: clearing a pile-on (Signal C) flag takes that attacker out of
 *    attacking_reviewers (the row goes when none is left), so the review
 *    counts again at once. It used to run DELETE … WHERE subject = $1 AND
 *    subject = $2, which never matched: "Cleared" and nothing changed.
 *  - M1: a clearance can be undone.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandCtx } from '../src/lib/ctx.ts';

const ADMIN = process.env.TEST_DATABASE_URL;
const SCHEMA = `modtest_${randomBytes(4).toString('hex')}`;
const OPERATOR = 'alice-operator';
const DAY = 86_400_000;

describe.skipIf(!ADMIN)('moderation on the real schema', () => {
	let url = '';
	let admin: pg.Client;
	let db: { query: pg.Client['query']; close: () => Promise<void> };
	let client: pg.Client;

	beforeAll(async () => {
		admin = new pg.Client({ connectionString: ADMIN });
		await admin.connect();
		await admin.query(`CREATE SCHEMA ${SCHEMA}`);
		const u = new URL(ADMIN!);
		u.searchParams.set('options', `-c search_path=${SCHEMA}`);
		url = u.toString();
		client = new pg.Client({ connectionString: url });
		await client.connect();
		await client.query(
			readFileSync(
				join(import.meta.dirname, '..', '..', 'indexer', 'src', 'db', 'schema.sql'),
				'utf8'
			)
		);
		db = { query: client.query.bind(client) as pg.Client['query'], close: async () => {} };
	}, 120_000);
	afterAll(async () => {
		await client?.end();
		await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
		await admin?.end();
	});

	beforeEach(async () => {
		for (const t of [
			'suspicious_reciprocity',
			'related_accounts',
			'one_way_pile_on',
			'review_concentration',
			'operator_blocks',
			'moderation_flag_clearances'
		])
			await client.query(`DELETE FROM ${t}`);
		const ago = (d: number): Date => new Date(Date.now() - d * DAY);
		await client.query(
			`INSERT INTO suspicious_reciprocity (account_a, account_b, detected_at, mutual_review_count, avg_rating)
			 VALUES ('alice', 'bob', $1, 4, 5)`,
			[ago(20)]
		);
		await client.query(
			`INSERT INTO related_accounts (account_a, account_b, detected_at, reason, evidence)
			 VALUES ('carol', 'dave', $1, 'same creator', '{}'::jsonb)`,
			[ago(40)]
		);
		const attackers = JSON.stringify(
			['frank', 'gina', 'hank'].map((r) => ({ reviewer: r, rating_avg: 1, count: 1 }))
		);
		for (const d of [10, 9]) {
			await client.query(
				`INSERT INTO one_way_pile_on (subject, detected_at, detection_date, attacking_reviewers,
				   avg_rating, review_count, review_window_days, activity_cluster_days)
				 VALUES ('erin', $1::timestamptz, ($1::timestamptz)::date, $2::jsonb, 1, 3, 30, 14)`,
				[ago(d), attackers]
			);
		}
		await client.query(
			`INSERT INTO review_concentration (reviewer, dominant_subject, detected_at, concentration_pct, review_count, window_days)
			 VALUES ('ivan', 'judy', $1, 90, 10, 30)`,
			[ago(3)]
		);
		// @hank is blocked here: the (erin, hank) pile-on pair is acted on.
		await client.query(
			`INSERT INTO operator_blocks (operator, blocked, state, origin, reason, since_block_num,
			   since_trx_id, last_action_block_num, created_at, updated_at)
			 VALUES ($1, 'hank', 'blocked', 'local', '', 1, 'local', 1, now(), now())`,
			[OPERATOR]
		);
	});

	it('the menu marker and the screen count the same flags: all four signals, all time', async () => {
		vi.stubEnv('MORPHIT_OPS_DATABASE_URL', url);
		vi.stubEnv('MORPHIT_INDEXER_OPERATOR_ACCOUNT_NAME', OPERATOR);
		const { unresolvedFlagCount } = await import('../src/lib/menuAnnotations.ts');
		const menu = await unresolvedFlagCount(20_000);
		vi.unstubAllEnvs();
		// 1 reciprocity + 1 related + 3 pile-on pairs + 1 concentration = 6; hank's pair is blocked.
		expect(menu).toBe(5);

		const { runModeration } = await import('../src/commands/moderation.ts');
		let out = '';
		const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
			out += a.join(' ') + '\n';
		});
		const w = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
			out += String(c);
			return true;
		});
		const ctx = {
			db,
			config: { operatorAccount: OPERATOR },
			flags: {},
			positional: []
		} as unknown as CommandCtx;
		await runModeration(ctx);
		log.mockRestore();
		w.mockRestore();
		expect(out).toMatch(/Moderation — flags & blocking \(all time\)/);
		expect(out).toMatch(/6 flags/);
		expect(out).toMatch(/5 not acted on yet/);
		expect(out).toMatch(/@carol .* @dave/); // 40 days old: outside any 7- or 30-day window
		expect(out.match(/@gina/g)?.length).toBe(1); // one line per pair, not per detection day
		expect(out).not.toMatch(/--since=all|36500d/);
	});

	it('clearing a pile-on pair takes the attacker out, so the review counts again; the last one removes the row', async () => {
		const { clearFlag, fetchPileOnFlags } = await import('../src/lib/moderationSignals.ts');
		// The pile-on clause of the indexer's read paths
		// (apps/indexer/src/api/reputationJoin.ts feedbackPairCountsSql): a
		// review of the subject is left out while its reviewer is listed.
		const counts = async (reviewer: string): Promise<boolean> =>
			(
				await client.query<{ ok: boolean }>(
					`SELECT NOT EXISTS (
					   SELECT 1 FROM one_way_pile_on owpo,
					          jsonb_array_elements(owpo.attacking_reviewers) attacker
					    WHERE owpo.subject = 'erin' AND attacker->>'reviewer' = $1::text) AS ok`,
					[reviewer]
				)
			).rows[0]!.ok;
		expect(await counts('gina')).toBe(false);
		const r = await clearFlag(db as never, {
			signal: 'pile_on',
			accountA: 'Gina',
			accountB: 'erin',
			note: 'test'
		});
		expect(r.cleared).toBe(2); // in both detection days' rows
		expect(await counts('gina')).toBe(true);
		expect(await counts('frank')).toBe(false);
		const left = await fetchPileOnFlags(db as never, null, 50);
		expect(left.map((x) => x.account_b).sort()).toEqual(['frank', 'hank']);
		for (const who of ['frank', 'hank'])
			await clearFlag(db as never, {
				signal: 'pile_on',
				accountA: who,
				accountB: 'erin',
				note: ''
			});
		expect((await client.query('SELECT count(*)::int AS n FROM one_way_pile_on')).rows[0].n).toBe(
			0
		);
		const c = await client.query(
			`SELECT account_a, account_b, watermark FROM moderation_flag_clearances WHERE signal = 'pile_on' ORDER BY 2`
		);
		expect(c.rows).toContainEqual({ account_a: 'erin', account_b: 'gina', watermark: null });
	});

	it('a clearance can be undone', async () => {
		const { clearFlag, unclearFlag, fetchClearances } = await import(
			'../src/lib/moderationSignals.ts'
		);
		await clearFlag(db as never, {
			signal: 'reciprocity',
			accountA: 'bob',
			accountB: 'alice',
			note: ''
		});
		expect((await fetchClearances(db as never, 10)).length).toBe(1);
		const r = await unclearFlag(db as never, {
			signal: 'reciprocity',
			accountA: 'alice',
			accountB: 'bob'
		});
		expect(r.removed).toBe(1);
		expect((await fetchClearances(db as never, 10)).length).toBe(0);
	});
});
