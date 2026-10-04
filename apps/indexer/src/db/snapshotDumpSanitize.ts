/**
 * apps/indexer/src/db/snapshotDumpSanitize.ts — (rv2-1b, rv2-8)
 *
 * Make a plain-SQL snapshot dump safe to hand to psql.
 *
 * WHAT WAS WRONG. The restore piped the dump straight into `psql`, and psql
 * executes its own backslash meta-commands from its input — `\! cmd` runs a
 * shell command, as whoever runs the restore (root, under fast-sync). psql
 * recognises a meta-command at ANY unquoted backslash, not just at the start of
 * a line: `SELECT 1; \! id` runs `id`. And the dump's `ALTER … OWNER TO
 * <publisher role>` lines failed on any box whose role is named differently,
 * after `--clean` had already dropped everything.
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
 *   3. Code is refused. Morphit's schema defines no function, procedure,
 *      aggregate, trigger, rule or event trigger, and pg_dump never writes a
 *      DO block, so a dump statement creating any of them (or a DO block) is
 *      foreign code: it would run on this node — a trigger fires on the first
 *      write after the restore — and the dump is refused before anything is
 *      restored. Statements are found with a small SQL lexer (quotes, E''
 *      strings, quoted identifiers, dollar quotes, line and nested block
 *      comments), so line breaks, comments or a `;` hidden in a literal do
 *      not get a statement past it.
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
/** Statement heads (first words, upper-cased) that define code — see 3. */
function isCodeStatement(head: readonly string[]): boolean {
	if (head[0] === 'DO') return true;
	if (head[0] !== 'CREATE') return false;
	let i = 1;
	if (head[i] === 'OR' && head[i + 1] === 'REPLACE') i += 2;
	if (head[i] === 'CONSTRAINT') i++;
	const w = head[i];
	if (w === 'EVENT') return head[i + 1] === 'TRIGGER' || head[i + 1] === undefined;
	return (
		w === 'FUNCTION' || w === 'PROCEDURE' || w === 'AGGREGATE' || w === 'TRIGGER' || w === 'RULE'
	);
}
/** Words of a statement head needed to classify it. */
const HEAD_WORDS = 5;

/**
 * A streaming SQL lexer that yields, per statement, its first words. Only
 * what decides where a statement starts is modelled: '…' (with '' and, in
 * E'…', backslash escapes), "…", $tag$…$tag$, -- comments and nested
 * block comments.
 */
function createStatementLexer(onHead: (head: readonly string[]) => void): {
	feed(line: string): void;
	/** True between statements (where a COPY may start). */
	atStatementStart(): boolean;
} {
	type Mode = 'sql' | 'sq' | 'esq' | 'dq' | 'dollar' | 'block';
	let mode: Mode = 'sql';
	let dollarTag = '';
	let depth = 0;
	let head: string[] = [];
	let word = '';
	let classified = false;
	const flushWord = (): void => {
		if (word.length > 0 && !classified) {
			head.push(word.toUpperCase());
			if (isCodeStatement(head) || head.length >= HEAD_WORDS) {
				onHead(head);
				classified = true;
			}
		}
		word = '';
	};
	const endStatement = (): void => {
		flushWord();
		if (!classified && head.length > 0) onHead(head);
		head = [];
		classified = false;
	};
	const feed = (line: string): void => {
		const text = `${line}\n`;
		for (let i = 0; i < text.length; i++) {
			const c = text[i]!;
			const next = text[i + 1];
			switch (mode) {
				case 'sq':
					// A backslash before a quote means "end of string" with
					// standard_conforming_strings on and "escaped quote" with it
					// off, and a dump can switch it: refuse rather than guess.
					if (c === '\\' && next === "'") {
						throw new AmbiguousEscape();
					}
					if (c === "'") {
						if (next === "'") i++;
						else mode = 'sql';
					}
					continue;
				case 'esq':
					if (c === '\\') i++;
					else if (c === "'") {
						if (next === "'") i++;
						else mode = 'sql';
					}
					continue;
				case 'dq':
					if (c === '"') {
						if (next === '"') i++;
						else mode = 'sql';
					}
					continue;
				case 'dollar':
					if (c === '$' && text.startsWith(dollarTag, i)) {
						i += dollarTag.length - 1;
						mode = 'sql';
					}
					continue;
				case 'block':
					if (c === '/' && next === '*') {
						depth++;
						i++;
					} else if (c === '*' && next === '/') {
						i++;
						if (--depth === 0) mode = 'sql';
					}
					continue;
				case 'sql':
					break;
			}
			if (c === '-' && next === '-') {
				flushWord();
				return; // the rest of the line is a comment
			}
			if (c === '/' && next === '*') {
				flushWord();
				mode = 'block';
				depth = 1;
				i++;
				continue;
			}
			if (c === "'") {
				const escaped = word.toUpperCase() === 'E';
				if (escaped) word = '';
				flushWord();
				mode = escaped ? 'esq' : 'sq';
				continue;
			}
			if (c === '"') {
				flushWord();
				mode = 'dq';
				continue;
			}
			if (c === '$') {
				const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
				if (m && !/[A-Za-z0-9_]$/.test(word)) {
					flushWord();
					dollarTag = m[0];
					mode = 'dollar';
					i += dollarTag.length - 1;
					continue;
				}
			}
			if (c === ';') {
				endStatement();
				continue;
			}
			if (/[A-Za-z0-9_]/.test(c)) word += c;
			else flushWord();
		}
	};
	return {
		feed,
		atStatementStart: () => mode === 'sql' && head.length === 0 && word === ''
	};
}

class AmbiguousEscape extends Error {}

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
	const lex = createStatementLexer((head) => {
		if (isCodeStatement(head)) {
			throw new DumpRefusedError(
				`line ${n} creates code (${JSON.stringify(head.join(' '))}) — Morphit defines none, a snapshot is data`,
				n
			);
		}
	});
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
			// A COPY starts only where a statement can start; a COPY line
			// inside a string literal is not one (psql would read on as SQL).
			const copyStarts = COPY_START.test(line) && lex.atStatementStart();
			try {
				lex.feed(line);
			} catch (e) {
				if (!(e instanceof AmbiguousEscape)) throw e;
				throw new DumpRefusedError(
					`line ${n} has a backslash before a quote in a string literal — ambiguous, refused`,
					n
				);
			}
			if (copyStarts) {
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
