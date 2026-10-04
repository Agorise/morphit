/**
 * code carried by a snapshot never runs on the node.
 *
 * Before: the dump sanitizer let a snapshot define functions and triggers, and
 * fast-sync wrote to the restored database (the posting-key reset) BEFORE
 * dropping them, so a trigger the snapshot brought fired and its effect — a
 * relay payout row to the attacker — survived the cleanup (DB evil.mts).
 *
 * Now: the sanitizer refuses any dump that defines code (Morphit's schema
 * defines none), however it is spelled; fast-sync drops foreign code before
 * its first write; and every indexer start drops any that got in and holds
 * the unsent payouts for the operator (the heal for nodes that already
 * restored).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sanitizeDumpFile, newRestrictKey } from '../../src/db/snapshotDumpSanitize';
import { Poller } from '../../src/indexer/poller';
import { loadConfig } from '../../src/config/index';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { mockBlurt } from '../testutils/context';

const dir = mkdtempSync(join(tmpdir(), 'a1-dump-'));
async function sanitize(sql: string): Promise<'restorable' | 'refused'> {
	const gz = join(dir, `${Math.random()}.sql.gz`);
	writeFileSync(gz, gzipSync(sql));
	try {
		await sanitizeDumpFile(gz, join(dir, 'out.sql'), newRestrictKey());
		return 'restorable';
	} catch (e) {
		if ((e as Error).name === 'DumpRefusedError') return 'refused';
		throw e;
	}
}

const PREAMBLE = `SET statement_timeout = 0;
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
`;
const EVIL_BODY = `RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.relay_pending_transfers (recipient, kind, amount_blurt, reason, created_at)
  VALUES ('attacker', 'liquid', 9999, 'welcome_bonus_liquid', now());
  RETURN NULL;
END $$;`;

describe('the dump sanitizer refuses code', () => {
	it('an ordinary dump — data containing the words, comments naming types — is restorable', async () => {
		expect(
			await sanitize(
				PREAMBLE +
					`--
-- Name: orders; Type: TABLE; Schema: public; Owner: morphit
--
CREATE TABLE public.notes (id integer, body text);
COMMENT ON TABLE public.notes IS 'how to CREATE FUNCTION and CREATE TRIGGER; DO it';
COPY public.notes (id, body) FROM stdin;
1	CREATE FUNCTION x() RETURNS int AS 'select 1';
2	DO $$ BEGIN END $$;
\\.
CREATE INDEX notes_idx ON public.notes (id);
`
			)
		).toBe('restorable');
	});

	for (const [name, sql] of [
		[
			'the DB evil dump (function + trigger)',
			`CREATE FUNCTION public.evil() ${EVIL_BODY}
CREATE TRIGGER evil_t AFTER UPDATE ON public.known_instances FOR EACH STATEMENT EXECUTE FUNCTION public.evil();`
		],
		[
			'CREATE and FUNCTION on two lines with a comment between',
			`CREATE -- harmless\n  FUNCTION public.evil() ${EVIL_BODY}`
		],
		[
			'a block comment between',
			`CREATE /* x /* nested */ y */ OR REPLACE FUNCTION public.evil() ${EVIL_BODY}`
		],
		[
			'after a statement on the same line',
			`SELECT 1; CREATE TRIGGER t AFTER UPDATE ON public.a EXECUTE FUNCTION f();`
		],
		[
			'after a string holding -- and ;',
			`SELECT '--;'; CREATE RULE r AS ON UPDATE TO public.a DO ALSO NOTIFY x;`
		],
		['a DO block', `DO $$ BEGIN PERFORM 1; END $$;`],
		['an event trigger', `CREATE EVENT TRIGGER e ON ddl_command_start EXECUTE FUNCTION f();`],
		[
			'a COPY line hidden inside a string literal',
			`SELECT 'x\nCOPY public.a (b) FROM stdin;\n'; CREATE FUNCTION f() ${EVIL_BODY}\n\\.`
		],
		[
			'a backslash-quote, read differently once standard_conforming_strings is off',
			`SET standard_conforming_strings = off;\nSELECT 'a\\''; CREATE FUNCTION f() ${EVIL_BODY}`
		]
	] as const) {
		it(`refuses: ${name}`, async () => {
			expect(await sanitize(PREAMBLE + sql + '\n')).toBe('refused');
		});
	}
});

describe.skipIf(!INTEGRATION_ENABLED)(
	'an indexer start removes foreign code and holds payouts it may have queued',
	() => {
		let fx: IntegrationFixture;
		beforeAll(async () => {
			fx = await setupWithMigrations();
		});
		afterAll(async () => {
			await fx?.teardown();
		});

		it('the real Poller start drops the snapshot trigger before any write and holds the unsent payout', async () => {
			await fx.db.query(
				`CREATE FUNCTION evil() ${EVIL_BODY.replace('public.relay_pending_transfers', 'relay_pending_transfers')}`
			);
			await fx.db.query(
				`CREATE TRIGGER evil_t AFTER UPDATE ON indexer_state FOR EACH STATEMENT EXECUTE FUNCTION evil()`
			);
			await fx.db.query(
				`INSERT INTO relay_pending_transfers (recipient, kind, amount_blurt, reason, created_at)
			 VALUES ('queued-before', 'liquid', 1, 'welcome_bonus_liquid', NOW())`
			);
			const saved = { ...process.env };
			Object.assign(process.env, {
				MORPHIT_INDEXER_DATABASE_URL: 'postgres://unused@localhost/unused',
				MORPHIT_INDEXER_RELAY_ACCOUNT: 'morphit-relay',
				MORPHIT_INDEXER_FEE_RECIPIENT: 'morphit-fees',
				MORPHIT_INDEXER_CHAIN_ID:
					'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f',
				MORPHIT_INDEXER_PUBLIC_ORIGIN: 'https://indexer.example.org',
				MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY:
					'BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9'
			});
			const config = (() => {
				try {
					return loadConfig();
				} finally {
					process.env = saved;
				}
			})();
			await fx.db.query(
				`INSERT INTO indexer_state (id, last_applied_block, chain_id) VALUES (1, 100, $1)
			 ON CONFLICT (id) DO UPDATE SET last_applied_block = 100`,
				[config.chainId]
			);
			await fx.db.query(`DELETE FROM relay_pending_transfers WHERE recipient = 'attacker'`);
			const chain = mockBlurt({
				reachableOperatorCount: () => 1,
				endpointCount: () => 1,
				getDynamicGlobalProperties: async () =>
					({ head_block_number: 100, last_irreversible_block_num: 100 }) as never,
				crossCheckChainConsistency: async () =>
					({ consistent: true, reason: 'ok', agreeing: 1, contacted: 1, required: 1 }) as never
			});
			const poller = new Poller(config, fx.db, chain, null, null);
			const run = poller.run().catch(() => undefined);
			// The whole start sequence has run once the first poll has read the
			// chain head (Poller.run: the heal, the state row, then the loop).
			await vi.waitFor(() => expect(poller.getStatus().chainHeadSeenAt ?? null).not.toBeNull(), {
				timeout: 10_000,
				interval: 10
			});
			poller.stop();
			await run;
			// What the node writes from here on fires nothing.
			await fx.db.query(`UPDATE indexer_state SET last_applied_block = last_applied_block`);
			const rows = await fx.db.query<{ recipient: string; held: boolean }>(
				`SELECT recipient, error_count >= 1000 AS held FROM relay_pending_transfers ORDER BY recipient`
			);
			expect(rows.rows).toEqual([{ recipient: 'queued-before', held: true }]);
			const left = await fx.db.query(
				`SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
			   JOIN pg_namespace n ON n.oid = c.relnamespace
			  WHERE NOT t.tgisinternal AND n.nspname = current_schema()`
			);
			expect(left.rowCount).toBe(0);
		});
	}
);
