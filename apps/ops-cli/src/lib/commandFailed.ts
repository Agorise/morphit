/**
 * A command's error as its exit code: Ctrl+C (an AbortError from a question or
 * a step that was stopped) is 130, with one plain line — never "Error: …" and a
 * failure code a caller would treat as a fault (the install wizard queues a
 * `register` that failed for an unattended retry). Anything else is printed
 * (sanitised) and is 3.
 *
 * A database error is said in plain words with the exact command to look at
 * the database on this server: the raw driver text ("connect ECONNREFUSED
 * 127.0.0.1:5432", "role … does not exist") told an operator nothing about what
 * to do (review, 2026-10-29).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAbortError, stoppedLine } from '../init/prompt.ts';
import { error as printError, sanitizeForTerm } from '../render/term.ts';
import { parseBackupDbContainer } from './dbContainer.ts';

export function commandFailed(err: unknown, print: (s: string) => void = console.log): number {
	if (isAbortError(err)) {
		// Ctrl+C, the input ending, or no answer in time on an open input.
		print(`\n  ${stoppedLine(err)}`);
		return 130;
	}
	const db = describeDbError(err);
	if (db !== null) {
		printError(db);
		return 3;
	}
	printError(err instanceof Error ? err.message : String(err));
	return 3;
}

/** The Postgres container this install backs up through (DB_CONTAINER in
 *  /etc/morphit/backup.env), or null: a host Postgres, or the file is not
 *  readable here. That is how the install records a containerised database. */
export function installDbContainer(
	etcDir = process.env.MORPHIT_ETC_DIR ?? `${process.env.MORPHIT_ENV_ROOT ?? ''}/etc/morphit`
): string | null {
	try {
		const c = parseBackupDbContainer(readFileSync(join(etcDir, 'backup.env'), 'utf8'));
		return c !== '' ? c : null;
	} catch {
		return null;
	}
}

/** Where the database lives, as the command's connection string names it:
 *  its host and port (5432 when the URL names none), or null. */
function dbEndpointOf(): { host: string; port: number } | null {
	const url =
		process.env.MORPHIT_OPS_DATABASE_URL ||
		process.env.MORPHIT_INDEXER_DATABASE_URL ||
		process.env.DATABASE_URL ||
		'';
	try {
		if (url === '') return null;
		const u = new URL(url);
		return {
			host: u.hostname.replace(/^\[|\]$/g, ''),
			port: u.port === '' ? 5432 : Number(u.port)
		};
	} catch {
		return null;
	}
}

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|::1|)$/;

/** A Postgres SQLSTATE: five digits/capitals. No SQLSTATE class starts with
 *  "E", so an errno of five letters ("EPIPE", "EPERM") is never taken for one. */
const SQLSTATE = /^[0-9A-DF-Z][0-9A-Z]{4}$/;

/** What node-postgres / pg-pool themselves say when a connection drops or
 *  cannot be made in time (exactly these; a wrapped message is not theirs). */
const PG_CONNECTION_MESSAGE =
	/^(Connection terminated( unexpectedly| due to connection timeout)?|timeout exceeded when trying to connect)$/;

/** The same host: equal, or both this machine (localhost / 127.x / ::1). */
function sameHost(a: string, b: string): boolean {
	if (a.toLowerCase() === b.toLowerCase()) return true;
	return a !== '' && b !== '' && LOCAL.test(a) && LOCAL.test(b);
}

/** The host and port a Node network error names: its fields, else its own
 *  message format ("connect ECONNREFUSED 127.0.0.1:5432", "getaddrinfo
 *  ENOTFOUND db.example.org"). */
function endpointsOf(e: unknown): Array<{ host: string; port: number | null }> {
	if (!(e instanceof Error)) return [];
	const f = e as { address?: unknown; hostname?: unknown; port?: unknown };
	const port = typeof f.port === 'number' ? f.port : null;
	if (typeof f.address === 'string') return [{ host: f.address, port }];
	if (typeof f.hostname === 'string') return [{ host: f.hostname, port }];
	const c = /^connect E[A-Z]+ (\S+):(\d+)$/.exec(e.message ?? '');
	if (c) return [{ host: c[1]!, port: Number(c[2]) }];
	const g = /^getaddrinfo E[A-Z_]+ (\S+)$/.exec(e.message ?? '');
	if (g) return [{ host: g[1]!, port: null }];
	return [];
}

/**
 * Whether `err` came from the database: a Postgres error (SQLSTATE code, or
 * the server's severity/routine fields), node-postgres's own connection
 * messages, or a network error naming the database's host and port (Node's
 * AggregateError for "localhost" carries them on each of its `errors`).
 */
export function isDatabaseError(err: unknown, host: string | null, port: number): boolean {
	if (!(err instanceof Error)) return false;
	const f = err as { code?: unknown; severity?: unknown; routine?: unknown; errors?: unknown };
	if (typeof f.code === 'string' && SQLSTATE.test(f.code)) return true;
	if (typeof f.severity === 'string' && typeof f.routine === 'string') return true;
	if (PG_CONNECTION_MESSAGE.test(err.message ?? '')) return true;
	if (host === null) return false;
	const inner = Array.isArray(f.errors) ? (f.errors as unknown[]) : [];
	return [err, ...inner].some((e) =>
		endpointsOf(e).some((p) => sameHost(p.host, host) && (p.port === null || p.port === port))
	);
}

/** `a` as one shell word: as it is when plain, else in single quotes. */
function shellWord(a: string): string {
	return /^[A-Za-z0-9@%+=:,./_-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

/** This same command line again, exactly, with sudo (each argument quoted
 *  for the shell where it needs it; no terminal control characters). */
export function sudoCommandLine(argv: readonly string[] = process.argv.slice(2)): string {
	return sanitizeForTerm(['sudo morphit-ops', ...argv.map(shellWord)].join(' '));
}

/** This same command again, with sudo. */
function sudoAgain(argv: readonly string[] = process.argv.slice(2)): string {
	return sudoCommandLine(argv);
}

/**
 * A database (Postgres / node-postgres) error in plain words, with what to run
 * on this server, or null when `err` is not one. PURE given its inputs.
 */
export function describeDbError(
	err: unknown,
	where: {
		readonly dbContainer?: string | null;
		readonly dbHost?: string | null;
		/** The database's port (default: the connection string's, else 5432). */
		readonly dbPort?: number;
		readonly isRoot?: boolean;
		readonly argv?: readonly string[];
	} = {}
): string | null {
	if (!(err instanceof Error)) return null;
	const code = String((err as { code?: unknown }).code ?? '');
	const msg = err.message ?? '';
	const endpoint = where.dbHost !== undefined ? null : dbEndpointOf();
	const host = where.dbHost !== undefined ? where.dbHost : (endpoint?.host ?? null);
	const port = where.dbPort ?? endpoint?.port ?? 5432;
	// Only an error FROM THE DATABASE (review v1.21.18): network-looking text
	// from any other command — an upgrade timing out against the release
	// server, a Blurt node refusing — read "The database is not answering …
	// sudo systemctl status postgresql".
	if (!isDatabaseError(err, host, port)) return null;
	const container = where.dbContainer !== undefined ? where.dbContainer : installDbContainer();
	const remote = host !== null && !LOCAL.test(host);
	const lookAt = remote
		? `the database server ${host} (this node's database is not on this server)`
		: container !== null
			? `on this server: sudo docker ps -a --filter name=${container}   (start it: sudo docker start ${container})`
			: 'on this server: sudo systemctl status postgresql   (start it: sudo systemctl start postgresql)';

	const unreachable =
		code === 'ECONNREFUSED' ||
		code === 'ECONNRESET' ||
		code === 'ETIMEDOUT' ||
		code === 'EHOSTUNREACH' ||
		code === '57P03' ||
		/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH/.test(msg) ||
		/Connection terminated|connection timeout|timeout expired|the database system is (starting up|shutting down)/i.test(
			msg
		);
	if (unreachable) {
		return (
			'The database is not answering, so nothing could be read. ' +
			`Check that it is running — ${lookAt}`
		);
	}
	if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo/.test(msg)) {
		return (
			`The database's address${host !== null ? ` (${host})` : ''} could not be found. ` +
			'It comes from MORPHIT_INDEXER_DATABASE_URL in /etc/morphit/indexer.env; it should be the same one the indexer uses. ' +
			'Check the indexer can reach it, on this server: sudo systemctl status morphit-indexer'
		);
	}
	// 28P01 wrong password; 28000 role missing / not allowed; 3D000 no such database.
	if (
		code === '28P01' ||
		code === '28000' ||
		code === '3D000' ||
		/password authentication failed|role "[^"]*" does not exist|database "[^"]*" does not exist|no pg_hba\.conf entry/.test(
			msg
		)
	) {
		const what =
			(/(role|database) "[^"]*" does not exist|password authentication failed for user "[^"]*"/.exec(
				msg
			) ?? [''])[0];
		const root = where.isRoot ?? (typeof process.getuid === 'function' && process.getuid() === 0);
		return (
			`The database turned this command's login down${what !== '' ? ` (${what})` : ''}. ` +
			(root
				? 'It used the login in /etc/morphit/indexer.env (MORPHIT_INDEXER_DATABASE_URL), the one the indexer uses. '
				: `Run it with sudo, so it uses the same login as the indexer (in /etc/morphit/indexer.env): ${sudoAgain(where.argv)}. `) +
			'If the indexer cannot log in either, look at it on this server: sudo systemctl status morphit-indexer'
		);
	}
	if (code === '42P01' || /relation "[^"]*" does not exist/.test(msg)) {
		return (
			'The database has no Morphit tables yet: the indexer creates them when it starts. ' +
			'Look at the indexer on this server: sudo systemctl status morphit-indexer'
		);
	}
	return null;
}
