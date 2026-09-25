/**
 * apps/indexer/src/db/snapshotDumpSanitize.ts — v1.18.0 deep-deep (rv2-1b, rv2-8)
 *
 * Make a plain-SQL snapshot dump safe to hand to psql.
 *
 * WHAT WAS WRONG. The restore piped the dump straight into `psql`, and psql
 * executes its own backslash meta-commands from its input — `\! cmd` runs a
 * shell command, as whoever runs the restore (root, under fast-sync). psql
 * recognises a meta-command at ANY unquoted backslash, not just at the start of
 * a line: `SELECT 1; \! id` runs `id`. And the dump's `ALTER … OWNER TO
 * <publisher role>` lines failed on any box whose role is named differently,
 * after `--clean` had already dropped everything (rv2-8).
 *
 * WHAT THIS DOES. Kept as plain SQL, so every snapshot already published stays
 * restorable, and made safe in two layers:
 *   1. This filter refuses any line that starts with a backslash outside COPY
 *      data, except the `\restrict` / `\unrestrict` pair pg_dump itself writes
 *      (which it drops). It also drops ownership and privilege statements, so
 *      the restore works under any role.
 *   2. The output begins with `\restrict <fresh random key>`. From there psql
 *      ITSELF refuses every meta-command, wherever it appears in a line —
 *      psql's own lexer decides, so there is no second parser here to get out
 *      of step with it. The key is generated per restore and never leaves this
 *      box, so a dump cannot contain the matching `\unrestrict`. A psql too old
 *      to know `\restrict` fails on that first line, before anything runs.
 * The caller runs psql with ON_ERROR_STOP and --single-transaction, so a
 * refused command or any other error rolls the whole restore back.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';

export class DumpRefusedError extends Error {
	constructor(
		message: string,
		readonly lineNumber: number
	) {
		super(message);
		this.name = 'DumpRefusedError';
	}
}

const COPY_START = /^COPY [^\n]+ FROM stdin;$/;
const PG_DUMP_RESTRICT = /^\\(?:un)?restrict [A-Za-z0-9]+$/;
const OWNERSHIP = /^ALTER [A-Z ]+ .+ OWNER TO .+;$/;
const PRIVILEGE = /^(?:GRANT|REVOKE) .+;$|^ALTER DEFAULT PRIVILEGES .+;$/;

export interface SanitizeStats {
	readonly lines: number;
	readonly droppedOwnership: number;
	readonly droppedPrivileges: number;
}

/** A fresh `\restrict` key: alphanumeric, as psql requires. */
export function newRestrictKey(): string {
	return randomBytes(24).toString('hex');
}

/**
 * The line filter. Feed it every line of the dump in order; it returns the
 * line to emit, or null to drop it, and throws DumpRefusedError on a
 * meta-command.
 */
export function createDumpLineFilter(): {
	next(line: string): string | null;
	stats(): SanitizeStats;
	inCopy(): boolean;
} {
	let inCopy = false;
	let n = 0;
	let owner = 0;
	let priv = 0;
	return {
		next(line: string): string | null {
			n++;
			if (inCopy) {
				// COPY text data escapes backslashes itself; only `\.` ends it.
				if (line === '\\.') inCopy = false;
				return line;
			}
			if (line.startsWith('\\')) {
				if (PG_DUMP_RESTRICT.test(line)) return null;
				throw new DumpRefusedError(
					`line ${n} is a psql meta-command (${JSON.stringify(line.slice(0, 40))}) — a snapshot is data, never commands`,
					n
				);
			}
			if (COPY_START.test(line)) {
				inCopy = true;
				return line;
			}
			if (OWNERSHIP.test(line)) {
				owner++;
				return null;
			}
			if (PRIVILEGE.test(line)) {
				priv++;
				return null;
			}
			return line;
		},
		stats: () => ({ lines: n, droppedOwnership: owner, droppedPrivileges: priv }),
		inCopy: () => inCopy
	};
}

/**
 * Gunzip `gzPath`, filter it, and write `outPath` beginning with
 * `\restrict <restrictKey>`. Throws DumpRefusedError on a meta-command or an
 * unterminated COPY block.
 */
export async function sanitizeDumpFile(
	gzPath: string,
	outPath: string,
	restrictKey: string
): Promise<SanitizeStats> {
	if (!/^[A-Za-z0-9]+$/.test(restrictKey)) throw new Error('restrict key must be alphanumeric');
	const filter = createDumpLineFilter();
	const out = createWriteStream(outPath, { mode: 0o600 });
	const write = (s: string): Promise<void> =>
		new Promise((resolve, reject) => {
			if (out.write(s)) resolve();
			else {
				out.once('drain', resolve);
				out.once('error', reject);
			}
		});
	try {
		await write(`\\restrict ${restrictKey}\n`);
		const rl = createInterface({
			input: createReadStream(gzPath).pipe(createGunzip()),
			crlfDelay: Infinity
		});
		for await (const line of rl) {
			const keep = filter.next(line);
			if (keep !== null) await write(keep + '\n');
		}
		if (filter.inCopy())
			throw new DumpRefusedError('the dump ends inside COPY data', filter.stats().lines);
	} finally {
		await new Promise<void>((resolve) => out.end(() => resolve()));
	}
	return filter.stats();
}
