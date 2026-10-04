/**
 * Installed-box heal: the indexer's database role gets two session defaults.
 *
 *  - jit = off: Postgres compiled the featured-strip query with JIT on its
 *    inflated row estimate, ~2 s of CPU per request for a query that runs in
 *    under a millisecond;
 *  - idle_in_transaction_session_timeout = 300s: a connection left inside an
 *    open transaction (a crashed request, a stuck script) is closed instead of
 *    holding its locks and one of the pool's few connections for ever.
 * The indexer's own connections ask for these (and tighter API limits) when
 * they connect; the role defaults cover everything else that logs in as the
 * same role — the relay, which shares the database, and any script.
 *
 * PRIMARY: as the role itself, through the indexer's own
 * MORPHIT_INDEXER_DATABASE_URL (`ALTER ROLE CURRENT_USER SET …` — a role may
 * set its own defaults), which works for a host Postgres and a Docker one
 * alike. FALLBACK: as the postgres superuser on this host (`runuser -u
 * postgres -- psql`). VERIFY: a NEW session as the role shows both values
 * (`SHOW`). Otherwise one calm line with the SQL to run on this server.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { HealCtx, HealResult } from './healTypes.ts';

export const ROLE_DEFAULTS: ReadonlyArray<readonly [string, string, (shown: string) => boolean]> = [
	['jit', 'off', (v) => v === 'off'],
	['idle_in_transaction_session_timeout', '300s', (v) => v === '5min' || v === '300s']
];

/** The indexer env files, in the unit's order. */
export const INDEXER_ENV_FILES = (root = ''): string[] => [
	`${root}/opt/morphit/morphit.env`,
	`${root}/opt/morphit/morphit.config.env`,
	`${root}/etc/morphit/indexer.env`
];

/** MORPHIT_INDEXER_DATABASE_URL as the indexer sees it (last file wins). PURE. */
export function databaseUrlIn(texts: readonly string[]): string | null {
	let v: string | null = null;
	for (const t of texts)
		for (const m of t.matchAll(
			/^[ \t]*(?:export[ \t]+)?MORPHIT_INDEXER_DATABASE_URL[ \t]*=[ \t]*(.*?)[ \t]*$/gm
		))
			v = (m[1] ?? '').replace(/^(["'])(.*)\1$/, '$2');
	return v === '' ? null : v;
}

/** The statements, for the role named `role` (or CURRENT_USER). PURE. */
export function alterStatements(role: string | null): string[] {
	const who = role === null ? 'CURRENT_USER' : `"${role.replace(/"/g, '""')}"`;
	return ROLE_DEFAULTS.map(([k, v]) => `ALTER ROLE ${who} SET ${k} = '${v}'`);
}

export interface PgRoleRuntime {
	readFile(path: string): string | null;
	/** Run `sql` in one session as the URL's role; the rows of the last
	 *  statement as string arrays, or an error. */
	asRole(
		url: string,
		sql: readonly string[]
	): Promise<{ ok: true; rows: string[][] } | { ok: false; error: string }>;
	/** Run statements as the postgres superuser on this host. */
	asSuperuser(sql: readonly string[]): { ok: boolean; error: string };
}

export async function healPgRole(
	ctx: HealCtx,
	opts: { runtime?: PgRoleRuntime; root?: string } = {}
): Promise<HealResult> {
	const rt = opts.runtime ?? realRuntime;
	const url = databaseUrlIn(INDEXER_ENV_FILES(opts.root ?? '').map((f) => rt.readFile(f) ?? ''));
	if (url === null)
		return {
			strategy: 'skipped',
			verified: true,
			detail: 'Indexer database role: no indexer database is configured on this server.'
		};
	let role: string | null = null;
	try {
		role = decodeURIComponent(new URL(url).username) || null;
	} catch {
		/* the role is then read from the session */
	}
	const show = async (): Promise<Map<string, string> | null> => {
		const r = await rt.asRole(url, [
			`SELECT current_user, ${ROLE_DEFAULTS.map(([k]) => `current_setting('${k}')`).join(', ')}`
		]);
		if (!r.ok || r.rows.length === 0) return null;
		const row = r.rows[0]!;
		role = row[0] ?? role;
		return new Map(ROLE_DEFAULTS.map(([k], i) => [k, row[i + 1] ?? '']));
	};
	const good = (m: Map<string, string> | null): boolean =>
		m !== null && ROLE_DEFAULTS.every(([k, , ok]) => ok(m.get(k) ?? ''));
	const stop = ctx.spinner('Checking the indexer database role (JIT off, idle-transaction cap)…');
	try {
		const before = await show();
		if (before === null)
			return {
				strategy: 'deferred',
				verified: false,
				detail: `Indexer database role: could not connect with MORPHIT_INDEXER_DATABASE_URL just now; nothing changed. It is tried again at the next upgrade, or on this server run as the postgres superuser: ${alterStatements(role).join('; ')};`
			};
		if (good(before))
			return {
				strategy: 'already',
				verified: true,
				detail: `Indexer database role: ${role} already has JIT off and an idle-transaction cap (seen in a new session).`
			};
		let strategy = 'as-role';
		const own = await rt.asRole(url, alterStatements(null));
		let err = own.ok ? '' : own.error;
		let after = await show();
		if (!good(after)) {
			strategy = 'as-superuser';
			const su = rt.asSuperuser(alterStatements(role));
			if (!su.ok) err = `${err}${err ? '; ' : ''}${su.error}`;
			after = await show();
		}
		if (good(after))
			return {
				strategy,
				verified: true,
				detail: `Indexer database role: ${role} now has ${ROLE_DEFAULTS.map(([k, v]) => `${k} = ${v}`).join(' and ')} (seen in a new session).`
			};
		return {
			strategy: 'left-alone',
			verified: false,
			detail: `Indexer database role: could not set its defaults${err ? ` (${err.slice(0, 160)})` : ''}. The indexer still sets them on its own connections. To cover the relay and scripts too, on the database server run as the postgres superuser: ${alterStatements(role).join('; ')};`
		};
	} finally {
		stop();
	}
}

/** The real entry `morphit-ops upgrade` calls (lib/healTypes.ts). */
export function heal(ctx: HealCtx): Promise<HealResult> {
	return healPgRole(ctx);
}

const realRuntime: PgRoleRuntime = {
	readFile: (p) => {
		try {
			return readFileSync(p, 'utf8');
		} catch {
			return null;
		}
	},
	asRole: async (url, sql) => {
		let client: import('pg').Client | null = null;
		try {
			const mod = (await import('pg')) as { default: typeof import('pg') } | typeof import('pg');
			const pg = 'default' in mod ? mod.default : mod;
			client = new pg.Client({
				connectionString: url,
				connectionTimeoutMillis: 8_000,
				statement_timeout: 10_000
			});
			await client.connect();
			let rows: string[][] = [];
			for (const s of sql) {
				const r = await client.query({ text: s, rowMode: 'array' });
				rows = (r.rows as unknown[][]).map((row) => row.map((c) => String(c)));
			}
			return { ok: true, rows };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		} finally {
			await client?.end().catch(() => {});
		}
	},
	asSuperuser: (sql) => {
		try {
			const r = spawnSync(
				'runuser',
				[
					'-u',
					'postgres',
					'--',
					'psql',
					'-X',
					'-v',
					'ON_ERROR_STOP=1',
					'-d',
					'postgres',
					...sql.flatMap((s) => ['-c', s])
				],
				{ encoding: 'utf8', timeout: 20_000 }
			);
			return { ok: r.status === 0, error: (r.stderr ?? '').trim().split('\n').pop() ?? '' };
		} catch (e) {
			return { ok: false, error: String(e) };
		}
	}
};
