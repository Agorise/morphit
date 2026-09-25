/**
 * v1.18.0 deep-deep (rv2-1, rv2-5, rv2-6, rv2-8) — the snapshot pipeline,
 * executed for real: snapshot-export.ts and snapshot-bootstrap.ts run as child
 * processes (exactly as fast-sync and the publish timer run them) against real
 * Postgres databases, local JSON-RPC stubs and a stub IPFS gateway.
 *
 *   rv2-1  one hostile RPC node could hand fast-sync a forged snapshot op, and
 *          the dump was piped into psql, which runs `\!` shell commands.
 *   rv2-5  the export published push subscriptions, the push queue and the
 *          relay payout queue.
 *   rv2-6  the op-log spot-check was spawned with plain node, crashed, and
 *          was read as QUARANTINE; an empty ops table read as success.
 *   rv2-8  OWNER TO the publisher's role failed the restore on any other role,
 *          after --clean had dropped everything.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import pg from 'pg';
import { TEST_DATABASE_URL, INTEGRATION_ENABLED } from './harness';
import { runMigrations } from '../../src/db/migrations';
import { LOCAL_ONLY_TABLES, CHAIN_DERIVED_TABLES } from '../../src/db/snapshotLocalState';
import { INDEXER_SNAPSHOT_OP_ID } from '../../src/blurt/indexerSnapshotOp';

const { PrivateKey, cryptoUtils } = await import('@beblurt/dblurt');

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '../../../..');
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
const CHAIN_ID = 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f';
const OFFICIAL = PrivateKey.fromSeed('snapshot-trust-official-posting');
const OFFICIAL_PUB = OFFICIAL.createPublic().toString();
const LEAKED = PrivateKey.fromSeed('snapshot-trust-some-other-key');
const CID = 'bafy' + 'a'.repeat(55);
const MARK = 'LEAKMARK' + randomBytes(4).toString('hex');

function dbUrl(name: string): string {
	const u = new URL(TEST_DATABASE_URL!);
	u.pathname = `/${name}`;
	return u.toString();
}
async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
	const c = new pg.Client({ connectionString: TEST_DATABASE_URL! });
	await c.connect();
	try {
		return await fn(c);
	} finally {
		await c.end();
	}
}
function wrap(pool: pg.Pool): never {
	return {
		query: (t: string, p?: unknown[]) => pool.query(t, p as never),
		withTx: async (fn: (c: pg.PoolClient) => Promise<unknown>) => {
			const c = await pool.connect();
			try {
				await c.query('BEGIN');
				const r = await fn(c);
				await c.query('COMMIT');
				return r;
			} catch (e) {
				await c.query('ROLLBACK');
				throw e;
			} finally {
				c.release();
			}
		},
		close: () => pool.end()
	} as never;
}
async function q(db: string, sql: string, params: unknown[] = []): Promise<pg.QueryResult> {
	const c = new pg.Client({ connectionString: dbUrl(db) });
	await c.connect();
	try {
		return await c.query(sql, params);
	} finally {
		await c.end();
	}
}

function run(
	script: string,
	args: string[],
	env: Record<string, string>
): Promise<{ code: number | null; err: string }> {
	return new Promise((res) => {
		const p = spawn(
			TSX,
			[
				'--tsconfig',
				join(REPO, 'tsconfig.smoke.json'),
				join(REPO, 'apps/indexer/scripts', script),
				...args
			],
			{
				cwd: REPO,
				env: { ...process.env, ...env },
				stdio: ['ignore', 'pipe', 'pipe']
			}
		);
		let err = '';
		p.stdout.on('data', (d) => (err += d));
		p.stderr.on('data', (d) => (err += d));
		p.on('close', (code) => {
			if (process.env.SNAPTRUST_DEBUG) console.log(`--- ${script} exit ${code}\n${err}`);
			res({ code, err });
		});
	});
}

interface Srv {
	url: string;
	hits: number;
	close(): Promise<void>;
}
async function serve(
	host: string,
	handler: (req: http.IncomingMessage, body: string) => { status?: number; body: Buffer | string }
): Promise<Srv> {
	const s: Srv = { url: '', hits: 0, close: async () => {} };
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			s.hits++;
			const out = handler(req, body);
			res.writeHead(out.status ?? 200);
			res.end(out.body);
		});
	});
	await new Promise<void>((r) =>
		server.listen(0, host === 'localhost' ? '127.0.0.1' : host.replace(/[[\]]/g, ''), () => r())
	);
	const a = server.address() as { port: number };
	s.url = `http://${host}:${a.port}`;
	s.close = () =>
		new Promise<void>((r) => {
			server.closeAllConnections?.();
			server.close(() => r());
		});
	return s;
}

/** A condenser stub: account history + get_block from the given chain view. */
function chainStub(
	host: string,
	view: { history: unknown[]; blocks: Record<number, unknown> }
): Promise<Srv> {
	return serve(host, (_req, body) => {
		const j = JSON.parse(body) as { id?: number; method?: string; params?: unknown[] };
		let result: unknown = null;
		if (j.method === 'condenser_api.get_account_history') result = view.history;
		else if (j.method === 'condenser_api.get_block')
			result = view.blocks[Number((j.params ?? [])[0])] ?? null;
		else if (j.method === 'condenser_api.get_dynamic_global_properties')
			result = {
				head_block_number: 9_000_000,
				last_irreversible_block_num: 9_000_000,
				time: '2026-09-24T00:00:00'
			};
		return { body: JSON.stringify({ jsonrpc: '2.0', id: j.id ?? 0, result }) };
	});
}

/** A signed custom_json snapshot op, the block holding it, and its history entry. */
function publish(
	key: typeof OFFICIAL,
	payload: Record<string, unknown>,
	blockNum: number
): {
	history: unknown[];
	blocks: Record<number, unknown>;
} {
	const op = [
		'custom_json',
		{
			required_auths: [],
			required_posting_auths: ['morphit'],
			id: INDEXER_SNAPSHOT_OP_ID,
			json: JSON.stringify(payload)
		}
	];
	const tx = cryptoUtils.signTransaction(
		{
			ref_block_num: 1234,
			ref_block_prefix: 5678,
			expiration: '2026-09-24T00:01:00',
			operations: [op],
			extensions: []
		} as never,
		[key],
		Buffer.from(CHAIN_ID, 'hex')
	) as unknown as Record<string, unknown>;
	const trxId = cryptoUtils.generateTrxId(tx as never);
	return {
		history: [
			[
				42,
				{
					trx_id: trxId,
					block: blockNum,
					trx_in_block: 0,
					op_in_trx: 0,
					virtual_op: 0,
					timestamp: '2026-09-24T00:00:30',
					op
				}
			]
		],
		blocks: {
			[blockNum]: {
				block_id: `b${blockNum}`,
				previous: 'p',
				timestamp: '2026-09-24T00:00:30',
				witness: 'w',
				transactions: [tx],
				transaction_ids: [trxId]
			}
		}
	};
}

/** A tarball whose dump is `dumpSql`, with a manifest matching it. */
function tarball(
	dir: string,
	baseTar: string,
	mutate: (sql: string) => string
): { tar: string; sha: string } {
	const w = mkdtempSync(join(dir, 'tb-'));
	spawnSync('tar', ['-xzf', baseTar, '-C', w]);
	const sql = mutate(gunzipSync(readFileSync(join(w, 'indexer.sql.gz'))).toString('utf8'));
	const gz = gzipSync(Buffer.from(sql, 'utf8'));
	writeFileSync(join(w, 'indexer.sql.gz'), gz);
	const sha = createHash('sha256').update(gz).digest('hex');
	const m = JSON.parse(readFileSync(join(w, 'manifest.json'), 'utf8'));
	m.dumpSha256 = sha;
	writeFileSync(join(w, 'manifest.json'), JSON.stringify(m));
	const tar = join(w, 'snap.tar.gz');
	spawnSync('tar', ['-czf', tar, '-C', w, 'manifest.json', 'indexer.sql.gz']);
	return { tar, sha };
}

describe.skipIf(!INTEGRATION_ENABLED)(
	'snapshot export and restore trust (rv2-1, rv2-5, rv2-6, rv2-8)',
	() => {
		const tag = randomBytes(4).toString('hex');
		const SRC = `fixb_src_${tag}`;
		const DST = `fixb_dst_${tag}`;
		let work = '';
		let baseTar = '';
		let manifest: { schemaVersion: number; lastAppliedBlock: number } = {
			schemaVersion: 0,
			lastAppliedBlock: 0
		};
		const servers: Srv[] = [];
		const env = (db: string): Record<string, string> => ({
			MORPHIT_INDEXER_DATABASE_URL: dbUrl(db),
			MORPHIT_INDEXER_CHAIN_ID: CHAIN_ID,
			MORPHIT_INDEXER_PUBLIC_ORIGIN: 'https://publisher.invalid',
			MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY: OFFICIAL_PUB,
			MORPHIT_INDEXER_START_BLOCK: '1',
			MORPHIT_INDEXER_RPC_ENDPOINTS: '',
			MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS: '',
			MORPHIT_RPC_HEALTH_STATE: join(work, 'health.json')
		});

		async function freshDst(): Promise<void> {
			await admin(async (c) => {
				await c.query(`DROP DATABASE IF EXISTS ${DST}`);
				await c.query(`CREATE DATABASE ${DST}`);
			});
			const pool = new pg.Pool({ connectionString: dbUrl(DST) });
			await runMigrations(wrap(pool));
			await pool.query(
				`INSERT INTO indexer_state (id, last_applied_block, chain_id) VALUES (1, 77, $1)`,
				[CHAIN_ID]
			);
			await pool.query(`CREATE TABLE keep_me (v text)`);
			await pool.query(`INSERT INTO keep_me VALUES ('existing')`);
			await pool.end();
		}
		const dstIntact = async (): Promise<boolean> => {
			const r = await q(DST, `SELECT v FROM keep_me`).catch(() => null);
			return r !== null && r.rows[0]?.v === 'existing';
		};

		beforeAll(async () => {
			work = mkdtempSync(join(tmpdir(), 'snaptrust-'));
			await admin(async (c) => {
				await c.query(`CREATE DATABASE ${SRC}`);
			});
			const pool = new pg.Pool({ connectionString: dbUrl(SRC) });
			await runMigrations(wrap(pool));
			await pool.query(
				`INSERT INTO indexer_state (id, last_applied_block, chain_id) VALUES (1, 5000, $1)`,
				[CHAIN_ID]
			);
			await pool.query(
				`INSERT INTO accounts (name, creator, created_block_num, created_block_time, created_trx_id) VALUES ('alice', 'x', 1, now(), 't')`
			);
			// One row in every local-only table, each carrying MARK.
			await pool.query(
				`INSERT INTO push_subscriptions (account, endpoint, p256dh, auth, user_agent, privacy_mode)
			 VALUES ('alice', 'https://fcm.googleapis.com/fcm/send/${MARK}', 'p', 'a', 'UA-${MARK}', 'standard')`
			);
			await pool.query(
				`INSERT INTO push_pending (account, category, title, body, event_at) VALUES ('alice', 'chat', 't', '${MARK}', now())`
			);
			await pool.query(
				`INSERT INTO relay_pending_transfers (recipient, kind, amount_blurt, reason, created_at) VALUES ('alice', 'liquid', 10, '${MARK}', now())`
			);
			await pool.query(`INSERT INTO order_views (permlink, count) VALUES ('${MARK}', 3)`);
			await pool.query(
				`INSERT INTO price_drift_baseline (asset, denomination_fiat, baseline_price, baseline_updated_at) VALUES ('${MARK}', 'USD', 1, now())`
			);
			await pool.query(
				`INSERT INTO price_peer_observations (peer_origin, asset, denomination_fiat, observed_price, observed_at) VALUES ('https://${MARK}', 'BLURT', 'USD', 1, now())`
			);
			await pool.query(
				`INSERT INTO moderation_flag_clearances (signal, account_a, account_b, note) VALUES ('reciprocity', 'a1', 'b1', '${MARK}')`
			);
			await pool.query(
				`INSERT INTO operator_blocks (operator, blocked, state, reason, since_block_num, since_trx_id, last_action_block_num, created_at, updated_at, origin)
			 VALUES ('op1', 'chainblocked', 'blocked', 'on chain', 1, 't1', 1, now(), now(), 'chain'),
			        ('op1', 'localblocked', 'blocked', '${MARK}', 1, 't2', 1, now(), now(), 'local')`
			);
			await pool.end();
			const exp = await run('snapshot-export.ts', ['--out', join(work, 'out')], env(SRC));
			expect(exp.code, exp.err).toBe(0);
			baseTar = join(work, 'out', readdirSync(join(work, 'out'))[0]!);
			const w = mkdtempSync(join(work, 'm-'));
			spawnSync('tar', ['-xzf', baseTar, '-C', w]);
			manifest = JSON.parse(readFileSync(join(w, 'manifest.json'), 'utf8'));
		}, 120_000);

		afterAll(async () => {
			await Promise.all(servers.map((s) => s.close()));
			if (!INTEGRATION_ENABLED) return;
			await admin(async (c) => {
				await c.query(`DROP DATABASE IF EXISTS ${SRC}`);
				await c.query(`DROP DATABASE IF EXISTS ${DST}`);
			});
			if (work) rmSync(work, { recursive: true, force: true });
		});

		it('every table is classified as chain-derived or local-only (rv2-5)', async () => {
			const r = await q(SRC, `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
			const all = r.rows.map((x) => x.tablename as string);
			const unclassified = all.filter(
				(t) => !LOCAL_ONLY_TABLES.includes(t) && !CHAIN_DERIVED_TABLES.includes(t)
			);
			expect(unclassified).toEqual([]);
			expect(LOCAL_ONLY_TABLES.filter((t) => CHAIN_DERIVED_TABLES.includes(t))).toEqual([]);
		});

		it('the real export leaves out every local-only row and ownership (rv2-5, rv2-8)', () => {
			const w = mkdtempSync(join(work, 'x-'));
			spawnSync('tar', ['-xzf', baseTar, '-C', w]);
			const sql = gunzipSync(readFileSync(join(w, 'indexer.sql.gz'))).toString('utf8');
			expect(sql).not.toContain(MARK);
			expect(sql).not.toMatch(/OWNER TO/);
			// The chain row of the mixed table is still there.
			expect(sql).toContain('chainblocked');
			expect(sql).not.toContain('localblocked');
		});

		it('a dump with a psql shell command at the start of a line is refused, nothing runs (rv2-1)', async () => {
			await freshDst();
			const pwned = join(work, `pwned-a-${tag}`);
			const t = tarball(work, baseTar, (s) => `\\! id > ${pwned}\n` + s);
			const r = await run(
				'snapshot-bootstrap.ts',
				[t.tar, '--i-trust-this-source', '--force'],
				env(DST)
			);
			expect(existsSync(pwned)).toBe(false);
			expect(r.code).not.toBe(0);
			expect(await dstIntact()).toBe(true);
		}, 60_000);

		it('a shell command in the MIDDLE of a line is refused by psql itself, and the restore rolls back (rv2-1)', async () => {
			await freshDst();
			const pwned = join(work, `pwned-b-${tag}`);
			// After the dump's DROP statements, so a non-transactional restore would
			// already have destroyed the database by the time it failed.
			const t = tarball(work, baseTar, (s) => s + `\nSELECT 1; \\! id > ${pwned}\n`);
			const r = await run(
				'snapshot-bootstrap.ts',
				[t.tar, '--i-trust-this-source', '--force'],
				env(DST)
			);
			expect(existsSync(pwned)).toBe(false);
			expect(r.code).not.toBe(0);
			expect(await dstIntact()).toBe(true);
		}, 60_000);

		it('an older-style dump (owner, local rows, foreign code) restores under another role and is tidied (rv2-8, rv2-5, rv2-1c)', async () => {
			await freshDst();
			const t = tarball(
				work,
				baseTar,
				(s) =>
					s +
					`\nALTER TABLE public.accounts OWNER TO some_publisher_role_${tag};\n` +
					`GRANT ALL ON TABLE public.accounts TO some_publisher_role_${tag};\n` +
					`INSERT INTO public.push_subscriptions (account, endpoint, p256dh, auth, privacy_mode) VALUES ('bob', 'https://x/${MARK}', 'p', 'a', 'standard');\n` +
					`INSERT INTO public.relay_pending_transfers (recipient, kind, amount_blurt, reason, created_at) VALUES ('bob', 'liquid', 5, 'x', now());\n` +
					`INSERT INTO public.rpc_directory (id, endpoints, node_count, published_ts, block_num) VALUES (1, ARRAY['http://${'x'.repeat(56)}.onion'], 1, now(), 1) ON CONFLICT (id) DO UPDATE SET endpoints = EXCLUDED.endpoints;\n` +
					`CREATE FUNCTION public.evil_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;\n` +
					`CREATE TRIGGER evil_trg BEFORE INSERT ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.evil_fn();\n`
			);
			const r = await run(
				'snapshot-bootstrap.ts',
				[t.tar, '--i-trust-this-source', '--force'],
				env(DST)
			);
			expect(r.code, r.err).toBe(0);
			const acc = await q(DST, `SELECT name FROM accounts`);
			expect(acc.rows.map((x) => x.name)).toEqual(['alice']);
			expect((await q(DST, `SELECT count(*)::int AS n FROM push_subscriptions`)).rows[0].n).toBe(0);
			expect(
				(await q(DST, `SELECT count(*)::int AS n FROM relay_pending_transfers`)).rows[0].n
			).toBe(0);
			// The relay merges rpc_directory into its pool at boot, before the
			// indexer's own verification of the row has run: a restored row is
			// the publisher's word, so a restore must not carry it (deep-deep, rv2-4
			// follow-through).
			expect((await q(DST, `SELECT count(*)::int AS n FROM rpc_directory`)).rows[0].n).toBe(0);
			expect(
				(await q(DST, `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'evil_trg'`))
					.rows[0].n
			).toBe(0);
			expect(
				(await q(DST, `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'evil_fn'`)).rows[0].n
			).toBe(0);
		}, 60_000);

		describe('from chain', () => {
			let gateway: Srv;
			let served: Buffer = Buffer.alloc(0);
			const chainEnv = (rpcs: Srv[]): Record<string, string> => ({
				...env(DST),
				MORPHIT_INDEXER_LOCAL_RPC_ENDPOINTS: rpcs.map((s) => s.url).join(','),
				MORPHIT_IPFS_GATEWAYS: gateway.url,
				MORPHIT_LOCAL_IPFS_GATEWAY: gateway.url
			});
			const payloadFor = (sha: string): Record<string, unknown> => ({
				ipfs_cid: CID,
				sha256: sha,
				chain_id: CHAIN_ID,
				schema_version: manifest.schemaVersion,
				last_applied_block: manifest.lastAppliedBlock,
				size_bytes: 1000,
				indexer_version: '1.18.0'
			});
			beforeAll(async () => {
				gateway = await serve('127.0.0.1', () => ({ body: served }));
				servers.push(gateway);
			});

			/** Run the real snapshot-mirror.ts with a fake kubo that logs what it is asked. */
			async function mirror(
				rpcs: Srv[],
				tar: string
			): Promise<{ code: number | null; log: string; state: string }> {
				const bin = mkdtempSync(join(work, 'bin-'));
				const log = join(bin, 'ipfs.log');
				writeFileSync(
					join(bin, 'ipfs'),
					`#!/bin/sh\necho "$@" >> "${log}"\ncase "$1" in\n id) echo PEER;;\n swarm) echo /ip4/10.0.0.1/tcp/4001/p2p/PEER;;\n` +
						` pin) [ "$2" = ls ] && exit 1; exit 0;;\n cat) cat "${tar}";;\nesac\nexit 0\n`,
					{ mode: 0o755 }
				);
				// No runuser on this PATH, so the script drops privileges with sudo — this one.
				writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o755 });
				const state = join(bin, 'mirror-state.json');
				const r = await run('snapshot-mirror.ts', [], {
					...chainEnv(rpcs),
					PATH: `${bin}:${resolve(process.execPath, '..')}:/usr/bin`,
					MORPHIT_SNAPSHOT_MIRROR_STATE: state
				});
				return {
					code: r.code,
					log: existsSync(log) ? readFileSync(log, 'utf8') : '',
					state: existsSync(state) ? readFileSync(state, 'utf8') : ''
				};
			}

			it('the mirror job will not pin a CID one hostile RPC node made up (rv2-1, snapshot-mirror)', async () => {
				const t = tarball(work, baseTar, (s) => s);
				const forged = publish(LEAKED, payloadFor(t.sha), 8_000_010);
				const hostile = await chainStub('127.0.0.1', forged);
				const honest = await chainStub('localhost', { history: [], blocks: {} });
				servers.push(hostile, honest);
				const m = await mirror([hostile, honest], t.tar);
				expect(m.log).not.toContain(`pin add --progress=false ${CID}`);
				expect(m.state).toBe('');
			}, 90_000);

			it('the mirror job pins a genuinely signed, agreed snapshot (rv2-1 happy path)', async () => {
				const t = tarball(work, baseTar, (s) => s);
				const view = publish(OFFICIAL, payloadFor(t.sha), 8_000_011);
				const a = await chainStub('127.0.0.1', view);
				const b = await chainStub('localhost', view);
				servers.push(a, b);
				const m = await mirror([a, b], t.tar);
				expect(m.log).toContain(`pin add --progress=false ${CID}`);
				expect(JSON.parse(m.state).cid).toBe(CID);
			}, 90_000);

			it('ONE hostile RPC node serving a forged op with a shell-command dump gets nowhere (rv2-1)', async () => {
				await freshDst();
				const pwned = join(work, `pwned-c-${tag}`);
				const t = tarball(work, baseTar, (s) => `\\! id > ${pwned}\n` + s);
				served = readFileSync(t.tar);
				// The forger has no @morphit key: it signs with its own.
				const forged = publish(LEAKED, payloadFor(t.sha), 8_000_000);
				const hostile = await chainStub('127.0.0.1', forged);
				const honest = await chainStub('localhost', { history: [], blocks: {} });
				servers.push(hostile, honest);
				gateway.hits = 0;
				const r = await run(
					'snapshot-bootstrap.ts',
					['--from-chain', '--i-trust-signer', '--force', '--skip-verify'],
					chainEnv([hostile, honest])
				);
				expect(existsSync(pwned)).toBe(false);
				expect(r.code).not.toBe(0);
				expect(gateway.hits).toBe(0);
				expect(await dstIntact()).toBe(true);
			}, 90_000);

			it('two RPC operators agreeing on an op signed by a key that is NOT the pinned one: refused (rv2-1)', async () => {
				await freshDst();
				const t = tarball(work, baseTar, (s) => s);
				served = readFileSync(t.tar);
				const view = publish(LEAKED, payloadFor(t.sha), 8_000_001);
				const a = await chainStub('127.0.0.1', view);
				const b = await chainStub('localhost', view);
				servers.push(a, b);
				gateway.hits = 0;
				const r = await run(
					'snapshot-bootstrap.ts',
					['--from-chain', '--i-trust-signer', '--force', '--skip-verify'],
					chainEnv([a, b])
				);
				expect(r.code).not.toBe(0);
				expect(gateway.hits).toBe(0);
				expect(await dstIntact()).toBe(true);
			}, 90_000);

			it('a genuinely signed op confirmed by two operators restores (rv2-1 happy path)', async () => {
				await freshDst();
				const t = tarball(work, baseTar, (s) => s);
				served = readFileSync(t.tar);
				const view = publish(OFFICIAL, payloadFor(t.sha), 8_000_002);
				const a = await chainStub('127.0.0.1', view);
				const b = await chainStub('localhost', view);
				servers.push(a, b);
				const r = await run(
					'snapshot-bootstrap.ts',
					['--from-chain', '--i-trust-signer', '--force', '--skip-verify'],
					chainEnv([a, b])
				);
				expect(r.code, r.err).toBe(0);
				expect(
					(await q(DST, `SELECT last_applied_block::int AS b FROM indexer_state`)).rows[0].b
				).toBe(manifest.lastAppliedBlock);
			}, 90_000);

			it('the op-log spot-check runs and an empty ops log is INCONCLUSIVE, not a quarantine (rv2-6)', async () => {
				await freshDst();
				const t = tarball(work, baseTar, (s) => s);
				served = readFileSync(t.tar);
				const view = publish(OFFICIAL, payloadFor(t.sha), 8_000_003);
				const a = await chainStub('127.0.0.1', view);
				const b = await chainStub('localhost', view);
				servers.push(a, b);
				const r = await run(
					'snapshot-bootstrap.ts',
					['--from-chain', '--i-trust-signer', '--force'],
					chainEnv([a, b])
				);
				// Exit 0: restored, spot-check inconclusive. The unfixed bootstrap
				// crashed the spot-check and exited 1 (QUARANTINE) here.
				expect(r.code, r.err).toBe(0);
				expect(
					(await q(DST, `SELECT last_applied_block::int AS b FROM indexer_state`)).rows[0].b
				).toBe(manifest.lastAppliedBlock);
			}, 90_000);

			it('the spot-check itself calls an empty ops log inconclusive (exit 2), never verified (rv2-6)', async () => {
				const a = await chainStub('127.0.0.1', { history: [], blocks: {} });
				servers.push(a);
				await q(DST, 'DELETE FROM ops');
				const r = await run('snapshot-verify-oplog.ts', ['--samples', '5'], chainEnv([a]));
				expect(r.code, r.err).toBe(2);
			}, 60_000);
		});
	}
);
