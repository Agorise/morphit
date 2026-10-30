/**
 * A command that could not read the database said only what the driver said:
 * "connect ECONNREFUSED 127.0.0.1:5432", "role "x" does not exist" — no plain
 * words and nothing to run (review 2026-10-29). Now: what happened, and the
 * exact command to look at the database on this server (the Docker one when
 * the install backs it up from a container).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandFailed } from '../src/lib/commandFailed.ts';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

/** What commandFailed writes for `err`, with its exit code. */
function failed(err: unknown): { code: number; text: string } {
	let text = '';
	vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => ((text += String(c)), true));
	vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => ((text += String(c)), true));
	const code = commandFailed(err, (s) => void (text += s));
	vi.restoreAllMocks();
	return { code, text };
}

const pgErr = (message: string, code: string) => Object.assign(new Error(message), { code });

function etcWithBackup(env: string): string {
	const root = mkdtempSync(join(tmpdir(), 'morphit-cf-'));
	mkdirSync(join(root, 'etc', 'morphit'), { recursive: true });
	writeFileSync(join(root, 'etc', 'morphit', 'backup.env'), env);
	return root;
}

describe('database errors in plain words', () => {
	it('refused connection, host Postgres: says it is not answering and gives systemctl', () => {
		vi.stubEnv('MORPHIT_ENV_ROOT', etcWithBackup('BACKUP_DIR=/x\n'));
		vi.stubEnv('MORPHIT_INDEXER_DATABASE_URL', 'postgresql://u:p@127.0.0.1:5432/db');
		const r = failed(pgErr('connect ECONNREFUSED 127.0.0.1:5432', 'ECONNREFUSED'));
		expect(r.code).toBe(3);
		expect(r.text).toMatch(/database is not answering/);
		expect(r.text).toContain('on this server: sudo systemctl status postgresql');
		expect(r.text).not.toContain('ECONNREFUSED');
	});

	it('refused connection, Postgres in a container: gives the docker command', () => {
		vi.stubEnv('MORPHIT_ENV_ROOT', etcWithBackup('BACKUP_DIR=/x\nDB_CONTAINER=stack-db-1\n'));
		vi.stubEnv('MORPHIT_INDEXER_DATABASE_URL', 'postgresql://u:p@localhost:5432/db');
		// Node's AggregateError for localhost (::1 and 127.0.0.1) has no message;
		// each of its errors names the address and port it tried.
		const each = (address: string) =>
			Object.assign(new Error(`connect ECONNREFUSED ${address}:5432`), {
				code: 'ECONNREFUSED',
				address,
				port: 5432
			});
		const agg = Object.assign(new AggregateError([each('::1'), each('127.0.0.1')], ''), {
			code: 'ECONNREFUSED'
		});
		const r = failed(agg);
		expect(r.text).toContain('sudo docker ps -a --filter name=stack-db-1');
		expect(r.text).not.toContain('systemctl status postgresql');
	});

	it('a missing role: plain words, and the sudo command to run it again', () => {
		vi.stubEnv('MORPHIT_ENV_ROOT', etcWithBackup(''));
		const err = pgErr('role "alice" does not exist', '28000');
		const r = failed(err);
		expect(r.text).toMatch(/turned this command's login down \(role "alice" does not exist\)/);
		expect(r.text).toMatch(/sudo systemctl status morphit-indexer/);
	});

	it('anything else is printed as it was', () => {
		const r = failed(new Error('something odd'));
		expect(r.code).toBe(3);
		expect(r.text).toContain('something odd');
	});
});

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
	const srv = createServer();
	await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
	const port = (srv.address() as AddressInfo).port;
	await new Promise<void>((r) => srv.close(() => r()));
	return port;
}

/** What node-postgres really throws for a database at `url` (one query). */
async function realPgError(url: string): Promise<unknown> {
	const pg = (await import('pg')).default;
	const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 3000 });
	try {
		await pool.query('SELECT 1');
		return null;
	} catch (e) {
		return e;
	} finally {
		await pool.end();
	}
}

// Review v1.21.18: ANY error text that looked like a network failure was read
// as the database's — an upgrade timing out against the release server said
// "The database is not answering … sudo systemctl status postgresql".
describe('only errors from the database are described as the database', () => {
	it('the real driver, refused at the database address: described', async () => {
		const port = await closedPort();
		const url = `postgresql://u:p@127.0.0.1:${port}/db`;
		vi.stubEnv('MORPHIT_ENV_ROOT', etcWithBackup(''));
		vi.stubEnv('MORPHIT_INDEXER_DATABASE_URL', url);
		const r = failed(await realPgError(url));
		expect(r.text).toMatch(/database is not answering/);
	});

	it('the same refusal from something else on this machine (another port): not described', async () => {
		const port = await closedPort();
		vi.stubEnv('MORPHIT_ENV_ROOT', etcWithBackup(''));
		vi.stubEnv('MORPHIT_INDEXER_DATABASE_URL', 'postgresql://u:p@127.0.0.1:5432/db');
		const err = await realPgError(`postgresql://u:p@127.0.0.1:${port}/db`);
		const r = failed(err);
		expect(r.text).not.toMatch(/database/);
		expect(r.text).toContain(`ECONNREFUSED 127.0.0.1:${port}`);
	});

	it.each([
		[
			'an upgrade timing out against the release server',
			Object.assign(
				new Error(
					'request to https://git.example.org/api failed, reason: connect ETIMEDOUT 192.0.2.1:443'
				),
				{ code: 'ETIMEDOUT' }
			)
		],
		[
			'a release server name that does not resolve',
			Object.assign(new Error('getaddrinfo ENOTFOUND git.example.org'), {
				code: 'ENOTFOUND',
				hostname: 'git.example.org'
			})
		],
		[
			'a Blurt node refusing (wrapped)',
			new Error(
				'Could not reach the Blurt network (local indexer or any configured RPC node). Last error: connect ECONNREFUSED 127.0.0.1:8081'
			)
		],
		['a socket closed by some server', new Error('socket hang up: Connection terminated')],
		[
			'a broken pipe (a five-letter errno)',
			Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
		]
	])('%s: printed as it is, never as the database', (_what, err) => {
		vi.stubEnv('MORPHIT_ENV_ROOT', etcWithBackup(''));
		vi.stubEnv('MORPHIT_INDEXER_DATABASE_URL', 'postgresql://u:p@localhost:5432/db');
		const r = failed(err);
		expect(r.code).toBe(3);
		expect(r.text).not.toMatch(/database|postgresql/i);
		expect(r.text).toContain((err as Error).message);
	});

	it('Postgres errors are still described: a server error (SQLSTATE) and the driver dropping the line', async () => {
		vi.stubEnv('MORPHIT_ENV_ROOT', etcWithBackup(''));
		vi.stubEnv('MORPHIT_INDEXER_DATABASE_URL', 'postgresql://u:p@db.example.org:5432/db');
		const pg = (await import('pg')).default;
		const server = Object.assign(
			new pg.DatabaseError('relation "orders" does not exist', 0, 'error'),
			{
				code: '42P01',
				severity: 'ERROR',
				routine: 'parserOpenTable'
			}
		);
		expect(failed(server).text).toMatch(/no Morphit tables yet/);
		expect(failed(new Error('Connection terminated unexpectedly')).text).toMatch(
			/database is not answering.*db\.example\.org/
		);
		// The database's own name not resolving: described, with its name.
		const dns = Object.assign(new Error('getaddrinfo ENOTFOUND db.example.org'), {
			code: 'ENOTFOUND',
			hostname: 'db.example.org'
		});
		expect(failed(dns).text).toMatch(/database's address \(db\.example\.org\) could not be found/);
	});
});
