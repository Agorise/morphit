/**
 * The file walk shared by the public-tree content smokes
 * (internal-notes-deny-smoke, personal-name-deny-smoke,
 * box-identity-statement-smoke), and the loader for the private term list.
 *
 * "Public tree" = every text file of the repository, without node_modules,
 * build output, release scratch directories and `private/` (the maintainer's
 * private handoff: gitignored and excluded from every release packer).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', '.svelte-kit', 'build', 'dist', 'coverage']);
const SKIP_ROOT_DIRS = new Set([
	'vendor',
	'release',
	'.canonical-release',
	'.npm-cache',
	'private'
]);
const BINARY = /\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|otf|zip|gz|tgz|zst|pdf|wasm|node|db)$/i;
const MAX_BYTES = 8_000_000;

/** Repo-relative paths of every public text file under `root`, minus `skip`
 *  (with `binaries`, images, archives and fonts too). */
export function publicTextFiles(
	root: string,
	skip: ReadonlySet<string> = new Set(),
	binaries = false
): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				if (SKIP_DIRS.has(e.name) || (dir === root && SKIP_ROOT_DIRS.has(e.name))) continue;
				walk(p);
			} else if (e.isFile() && (binaries || !BINARY.test(e.name))) {
				const rel = relative(root, p);
				if (skip.has(rel)) continue;
				if (statSync(p).size > MAX_BYTES) continue;
				out.push(rel);
			}
		}
	};
	walk(root);
	return out;
}

/** True when the first 4 KiB hold a NUL byte (not text). */
export const looksBinary = (buf: Buffer): boolean => buf.subarray(0, 4096).includes(0);

/** Lower-case, accents stripped, trailing digits dropped (account3 → account). */
export const normWord = (w: string): string =>
	w
		.normalize('NFKD')
		.replace(/\p{M}+/gu, '')
		.toLowerCase()
		.replace(/\d+$/, '');

const WORD = /[\p{L}\p{N}]+/gu;
/** Words of a line, also split at camelCase humps ("isFooBar" → is, foo, bar). */
export function* words(line: string): Generator<string> {
	for (const m of line.matchAll(WORD)) {
		yield m[0];
		const parts = m[0].split(/(?<=\p{Ll})(?=\p{Lu})/u);
		if (parts.length > 1) yield* parts;
	}
}

/**
 * The maintainer's private term list. It lives in the gitignored private/
 * folder and never in the public tree, not even hashed; what each list holds
 * is described there (private/README.md). A public clone has no such file and
 * the guards that need it say so and run only their generic rules.
 */
export interface DenyTerms {
	/** Whole words, compared after normWord(). */
	readonly words: readonly string[];
	/** Whole words, compared exactly. */
	readonly wordsCased: readonly string[];
	/** Whole host names, lower case. */
	readonly hosts: readonly string[];
	/** Whole IPv4 literals. */
	readonly addresses: readonly string[];
	/** Words (compared after normWord()) allowed only in the files listed with them. */
	readonly allowedIn: ReadonlyArray<{ readonly word: string; readonly files: ReadonlySet<string> }>;
	/** Words (compared after normWord()) that must not share a line with a named instance box. */
	readonly boxLineWords: readonly string[];
}

const termListPath = (scriptRepoRoot: string): string =>
	process.env.MORPHIT_DENY_TERMS ?? join(scriptRepoRoot, 'private', 'deny-terms.json');

/** private/deny-terms.json of the repository this script belongs to (or
 *  $MORPHIT_DENY_TERMS), or null when it is absent. */
export function loadDenyTerms(scriptRepoRoot: string): DenyTerms | null {
	const p = termListPath(scriptRepoRoot);
	if (!existsSync(p)) return null;
	const j = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
	const list = (k: string): string[] =>
		Array.isArray(j[k])
			? (j[k] as unknown[]).filter((x): x is string => typeof x === 'string')
			: [];
	const allowed = Array.isArray(j.allowedIn)
		? (j.allowedIn as Array<{ word?: unknown; files?: unknown }>)
		: [];
	return {
		words: list('words').map(normWord),
		wordsCased: list('wordsCased'),
		hosts: list('hosts').map((h) => h.toLowerCase()),
		addresses: list('addresses'),
		allowedIn: allowed
			.filter((a) => typeof a.word === 'string')
			.map((a) => ({
				word: normWord(a.word as string),
				files: new Set(Array.isArray(a.files) ? (a.files as string[]) : [])
			})),
		boxLineWords: list('boxLineWords').map(normWord)
	};
}

/** Every term of the private list as written, with a neutral label
 *  ("<list> #<n>"), for the guards that look for disguised forms. */
export function allDenyTerms(scriptRepoRoot: string): Array<[label: string, term: string]> | null {
	const p = termListPath(scriptRepoRoot);
	if (!existsSync(p)) return null;
	const j = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
	const out: Array<[string, string]> = [];
	for (const [k, v] of Object.entries(j)) {
		if (!Array.isArray(v)) continue;
		v.forEach((x: unknown, i) => {
			const t = typeof x === 'string' ? x : (x as { word?: unknown })?.word;
			if (typeof t === 'string' && t) out.push([`${k} #${i + 1}`, t]);
		});
	}
	return out;
}

/** The line printed when the private term list is absent. */
export const NO_DENY_TERMS =
	'  • private/deny-terms.json is absent (a public clone): the private-term checks were skipped; the generic checks ran.';
