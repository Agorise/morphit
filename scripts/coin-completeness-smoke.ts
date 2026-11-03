#!/usr/bin/env tsx
/**
 * coin-completeness-smoke — every place that names the coins, by name or
 * ticker, has to change when a coin is added. This smoke finds the places the
 * compiler cannot see and holds them to the registry.
 *
 * The compiler already catches the code: the registry's NativeCoinTicker,
 * ChatAssetTicker and the SameTickerSet checks stop the indexer, the client,
 * the web app and morphit-ops compiling until a new coin is handled. The
 * per-asset smokes catch the per-coin texts (FAQ, privacy guide, explainer,
 * cheat sheet, chat labels), icons, payment rails and prices. What neither
 * sees is prose and configuration that LIST the coins: the README, the docs,
 * llms.txt, the media kit, the comparison image, the locale texts, the env
 * example, comments. This smoke checks four things across the repo:
 *
 *   A. Lists. Any run of five or more different coins (tickers or names,
 *      separated only by commas, slashes, "and"/"or" and the like) must be one
 *      of the sets the registry defines (every coin; every coin but BLURT; the
 *      native coins; the trade-only coins; the privacy coins; ...), or "every
 *      coin but" one to four coins that stand right after words that leave
 *      them out ("every coin but", "except", "refuse", a DISABLED_ASSETS=
 *      setting, ...; a verb only as a command, "# refuse ECX", not "older
 *      nodes refused ECX"; not after a negation, "no longer refuse") near the
 *      list, or an entry in ALLOWED_PARTIAL_LISTS below with the reason it is
 *      partial.
 *   B. Coverage. A text that names nearly every coin (one locale string, or
 *      one paragraph of a document) must name every coin: the per-coin lines
 *      of the amount-jitter FAQ, a brag-list item that walks the coins.
 *   C. Per-coin settings. Each native coin's chat-link explorer setting
 *      (MORPHIT_FRONTEND_<T>_CHAT_LINK_URL) in the indexer config, the env
 *      example, OPERATIONS.md and the morphit-ops wizard's env file, the
 *      wizard's default and summary line, the matrix bot's schema of
 *      /v1/instance, and the coin's row in the comparison image.
 *   D. Counts. "16 tradable assets", "16 current tradable tickers", "16
 *      digital assets", "a 16-coin (16-asset) picker": a
 *      number close to the number of coins, next to a word for coins, must be
 *      the number of coins (or of trade-only coins, privacy coins, ... when the
 *      sentence says so; one more only when that same sentence counts barter).
 *
 * Self-test: the same checks run against the registry plus two made-up coins,
 * TSTC (a transparent coin) and PRVC (a privacy coin). Each check must then
 * fail at the places a real addition has to touch; if one stays quiet, the
 * check has gone blind and this smoke fails.
 *
 * Not checked here: release notes and ADRs (each records its own release or
 * decision as it was), docs/audit and private/ (dated reports), tests and
 * smokes (they check themselves), llms-full.txt (built from en.json; see
 * llms-full-freshness-smoke).
 *
 * How to add a coin: docs/ADDING-A-COIN.md.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ASSETS as REGISTRY,
	ASSET_TICKERS,
	COIN_PRIVACY_CLASS,
	MULTI_NETWORK_TICKERS,
	NATIVE_COIN_TICKERS,
	isGoodsAsset,
	type CoinPrivacyClass
} from '../packages/asset-registry/src/index';
import { ASSETS as WEB_ASSETS } from '../apps/web/src/lib/assets/registry';
import { SUPPORTED_LOCALES } from '../apps/web/src/lib/i18n/locales';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ─── What the registry says ────────────────────────────────────────

interface Coin {
	readonly ticker: string;
	readonly name: string;
	readonly native: boolean;
	readonly multiNetwork: boolean;
	readonly coordinationChain: boolean;
	readonly canPayListingFee: boolean;
	readonly decimals: number;
	readonly privacy: CoinPrivacyClass | null;
}

function coinsFromRegistry(): Coin[] {
	const out: Coin[] = [];
	for (const ticker of ASSET_TICKERS) {
		if (isGoodsAsset(ticker)) continue;
		const a = REGISTRY.find((x) => x.ticker === ticker)!;
		const web = WEB_ASSETS.find((x) => x.ticker === ticker.toLowerCase());
		const native = (NATIVE_COIN_TICKERS as readonly string[]).includes(ticker);
		out.push({
			ticker,
			// "Ripple (XRP)" → "Ripple"
			name: (web?.displayName ?? ticker).replace(/\s*\(.*\)$/, ''),
			native,
			multiNetwork: (MULTI_NETWORK_TICKERS as readonly string[]).includes(ticker),
			coordinationChain: a.isCoordinationChain,
			canPayListingFee: a.canPayListingFee,
			decimals: a.decimals,
			privacy: native ? COIN_PRIVACY_CLASS[ticker as keyof typeof COIN_PRIVACY_CLASS] : null
		});
	}
	return out;
}

/** The sets a correct list may be. Each is defined by the registry, so a new
 *  coin joins every set it belongs to and each list of that set must name it. */
function namedSets(coins: readonly Coin[]): Map<string, Set<string>> {
	const pick = (f: (c: Coin) => boolean): Set<string> =>
		new Set(coins.filter(f).map((c) => c.ticker));
	const hidesByDefault = (c: Coin): boolean =>
		c.privacy === 'private-by-default' || c.privacy === 'opt-in-shielded';
	return new Map([
		['every coin', pick(() => true)],
		['every coin but BLURT (paid off the Blurt chain)', pick((c) => !c.coordinationChain)],
		['the native coins (one chain each, not BLURT)', pick((c) => c.native)],
		['the single-network coins', pick((c) => !c.multiNetwork)],
		['the trade-only coins', pick((c) => !c.canPayListingFee)],
		['the trade-only single-network coins', pick((c) => !c.canPayListingFee && !c.multiNetwork)],
		['the privacy coins', pick((c) => c.privacy !== null && c.privacy !== 'transparent')],
		['the coins transparent by default', pick((c) => !hidesByDefault(c))],
		[
			'the single-network coins transparent by default',
			pick((c) => !hidesByDefault(c) && !c.multiNetwork)
		],
		[
			'the native coins with 8 decimals (satoshi-style units)',
			pick((c) => c.native && c.decimals === 8)
		]
	]);
}

// ─── The files ─────────────────────────────────────────────────────

interface Text {
	readonly rel: string;
	readonly text: string;
}

const SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'dist',
	'build',
	'.svelte-kit',
	'coverage',
	'private'
]);
const SKIP_PATHS = [
	'docs/release-notes/',
	'docs/adr/',
	'docs/audit/',
	// the guide talks about coins in the abstract and by example
	'docs/ADDING-A-COIN.md',
	// research notes on third-party price providers and the coins THEY cover
	'docs/PRICE-SOURCES-RESEARCH.md',
	'apps/web/static/llms-full.txt',
	'package-lock.json',
	'scripts/coin-completeness-smoke.ts'
];
const SCANNED = /\.(md|ts|svelte|txt|mjs|js|py|sh|example|html|ya?ml|env|sql|j2)$/;
const LOCALES_DIR = 'apps/web/src/lib/i18n/locales/';

function readRepo(): Text[] {
	const out: Text[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			const abs = join(dir, name);
			const rel = relative(REPO, abs);
			if (SKIP_DIRS.has(name) || SKIP_PATHS.some((p) => rel.startsWith(p))) continue;
			const st = statSync(abs);
			if (st.isDirectory()) {
				walk(abs);
				continue;
			}
			const locale = rel.startsWith(LOCALES_DIR) && name.endsWith('.json');
			if (!locale && !SCANNED.test(name)) continue;
			if (/\.(test|spec)\.ts$|-smoke\.(ts|mjs|sh)$/.test(name)) continue;
			if (st.size > 4_000_000) continue;
			out.push({ rel, text: readFileSync(abs, 'utf8') });
		}
	};
	walk(REPO);
	return out;
}

// ─── Finding the coins in a text ───────────────────────────────────

interface Mention {
	readonly ticker: string;
	readonly start: number;
	readonly end: number;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionFinder(coins: readonly Coin[]): (text: string) => Mention[] {
	const byWord = new Map<string, string>();
	for (const c of coins) {
		byWord.set(c.ticker, c.ticker);
		if (c.name !== c.ticker) byWord.set(c.name, c.ticker);
	}
	const words = [...byWord.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
	const lower = coins.map((c) => escapeRe(c.ticker.toLowerCase()));
	// An upper-case ticker or a name, as a whole word; or a lower-case ticker in
	// quotes ('btc', "xmr", `eth`), the way code spells them.
	const re = new RegExp(
		`(?<![A-Za-z0-9_$])(${words.join('|')})(?![A-Za-z0-9_])|(?<=['"\`])(${lower.join('|')})(?=['"\`])`,
		'g'
	);
	return (text) => {
		const out: Mention[] = [];
		for (const m of text.matchAll(re)) {
			const word = m[1] ?? m[2]!;
			out.push({
				ticker: byWord.get(word) ?? word.toUpperCase(),
				start: m.index!,
				end: m.index! + word.length
			});
		}
		return out;
	};
}

/** Words that may join the items of a list, in the ten site languages. */
const JOINERS = new Set([
	'or',
	'and',
	'plus',
	'und',
	'oder',
	'et',
	'ou',
	'e',
	'o',
	'y',
	'i',
	'oraz',
	'lub',
	'или',
	'и',
	'和',
	'及',
	'或',
	'與',
	'与',
	'یا',
	'و'
]);

/** Only list punctuation, joiners and string-concatenation noise between two
 *  coins: they belong to one list. */
function isListGap(gap: string): boolean {
	if (gap.length > 60) return false;
	const pieces = gap
		.replace(/\\n/g, ' ')
		.split(/[\s,/|`'"*+()&·•\-–—:;→>#、，،]+/u)
		.filter(Boolean);
	return pieces.every((p) => JOINERS.has(p));
}

interface List {
	readonly set: Set<string>;
	readonly start: number;
	readonly end: number;
}

function listsIn(text: string, find: (t: string) => Mention[]): List[] {
	const ms = find(text);
	const out: List[] = [];
	for (let i = 0; i < ms.length; ) {
		let j = i;
		while (j + 1 < ms.length && isListGap(text.slice(ms[j]!.end, ms[j + 1]!.start))) j++;
		out.push({
			set: new Set(ms.slice(i, j + 1).map((m) => m.ticker)),
			start: ms[i]!.start,
			end: ms[j]!.end
		});
		i = j + 1;
	}
	return out;
}

/** `{coins:xmr,zec}` names those coins; `{coins:-blurt}` names every coin but
 *  those (the site renders the list from the registry). */
function coinsTokens(text: string): { set: Set<string> | 'all'; start: number }[] {
	const out: { set: Set<string> | 'all'; start: number }[] = [];
	for (const m of text.matchAll(/\{coins(?::([a-z0-9,-]*))?(?:\|[a-z]+)?\}/g)) {
		const items = (m[1] ?? '').split(',').filter(Boolean);
		out.push({
			set:
				items.length === 0 || items.every((x) => x.startsWith('-'))
					? 'all'
					: new Set(items.map((x) => x.toUpperCase())),
			start: m.index!
		});
	}
	return out;
}

// ─── The checks ────────────────────────────────────────────────────

interface Problem {
	readonly rule: 'A' | 'B' | 'C' | 'D' | 'allowlist';
	readonly where: string;
	readonly what: string;
}

/** Lists that are partial on purpose. Keyed by file and the exact set, so a
 *  list that changes is checked again. Keep the reason honest. */
const ALLOWED_PARTIAL_LISTS: readonly { file: string; set: string; why: string }[] = [
	{
		file: 'apps/relay/src/policy/highValueName.ts',
		set: 'ARRR BTC DCR DOGE ETH SOL USDC USDT XMR XRP ZEC',
		why: 'brand-tier words a username may not take; a vocabulary list, not the coins Morphit trades'
	},
	{
		file: 'scripts/comparison-image/README.md',
		set: 'BCH BTC ETH LTC USDT XMR',
		why: "a competitor's coins, from a third-party review"
	},
	...SUPPORTED_LOCALES.map(({ code: l }) => ({
		file: `${LOCALES_DIR}${l}.json`,
		set: 'DAI ETH USDC USDT XRP',
		why: 'one line of the amount-jitter FAQ (the coins sharing one maximum); check B holds the whole answer to every coin'
	})),
	// (fa, pl and zh-CN name these communities in their own words)
	...SUPPORTED_LOCALES.filter(({ code }) => !['fa', 'pl', 'zh-CN'].includes(code)).map(
		({ code: l }) => ({
			file: `${LOCALES_DIR}${l}.json`,
			set: 'ARRR DCR ETH SOL XRP',
			why: 'the word-of-mouth FAQ names a few coin communities "and more"'
		})
	)
];

function sortedKey(s: Iterable<string>): string {
	return [...s].sort().join(' ');
}

function lineOf(text: string, at: number): number {
	let n = 1;
	for (let i = 0; i < at; i++) if (text.charCodeAt(i) === 10) n++;
	return n;
}

/** Words that leave out the coins RIGHT AFTER them: "every coin but", "except",
 *  "refuse", "disable", a DISABLED_ASSETS= setting… in the site's languages. A
 *  plain negation ("no", "not") excludes nothing ("ECX has no URI scheme"), and
 *  neither does a bare "but" ("…, but ECX needs a split first"): only "all /
 *  every / each / any … but". "without" is not one either ("shipped without
 *  ECX" says a list is stale, not that it leaves ECX out on purpose). The verbs
 *  ("refuse", "disable", "exclude") count only as a command (EXCLUDER_VERB):
 *  "older indexers refused ECX" tells what a node did, not what a list leaves
 *  out. The Persian and Russian words must stand alone (no letter around
 *  them). */
const EXCLUDER_RE =
	/\b(?:(?:all|every\w*|each|any(?:thing)?|everything)\s+(?:[\p{L}-]+\s+){0,2}?but|except|excluding|exclude|minus|other than|apart from|disable|refuse|sauf|außer|ausgenommen|excepto|salvo|menos|tranne|eccetto|oprócz|poza)\b|(?<!\p{L})(?:кроме|за исключением|به‌جز|جز)(?!\p{L})|除了|除外|DISABLED_ASSETS/giu;

/** A negation right before an excluding word turns it around: "no longer
 *  refuse ECX", "Do not disable ECX", "never exclude ECX", "No node will
 *  refuse ECX" leave nothing out. Up to three words, and commas, may stand
 *  between ("do not, however, refuse"). */
const NEGATED_BEFORE =
	/(?:\b(?:not|never|no|nicht|nie(?:mals)?|kein\w*|jamais|nunca|non|mai)|n['’]t|(?<!\p{L})не)(?:[\s,;]+[\p{L}-]+){0,3}[\s,;]+$/iu;

/** "refuse", "disable", "exclude" leave coins out only as a command, at the
 *  start of a line (after a comment or list mark): "# refuse BCH, LTC". After
 *  "to" / "can" / "may" they as often tell what a node did or might do
 *  ("older nodes used to refuse ECX", "may refuse ECX"). */
const EXCLUDER_VERB = /^(?:refuse|disable|exclude)$/i;
const COMMAND_BEFORE = /^[\s#/*>`'"-]*$/;

/** What may stand between an excluding word and the first coin it leaves out:
 *  punctuation, quotes, "=" and a few filler words ("but the", "refuse all"). */
const EXCLUDER_LEAD = /^[\s:="'`(]*(?:(?:the|all|of|for|these|those|coins?|assets?)\s+)*$/i;

/** What may come right after the left-out coins: the end of the line, or a
 *  mark that closes the phrase (":", ")", a quote, ";", "." …). A word there
 *  ("but ECX needs…", "without ECX? No") means the coins were the subject of
 *  another sentence, not left out of a list. */
const EXCLUDER_END = /^\s*(?:$|[:)\]"'`;.,。：，、）」』—–(→]|-\s|之外)/u;

/**
 * Is every coin of `rest` LEFT OUT in words beside the list? A coin counts as
 * left out only when it stands in the run of coins right after an excluding
 * word ("every coin but BLURT", "refuse BCH, LTC", DISABLED_ASSETS="USDT,DAI").
 * Naming the coin nearby in any other way is not enough: a stale list lacking
 * a new coin passed because the coin was named, as enabled, two lines above,
 * and any "no"/"not" on a nearby line excused every coin on that line.
 */
function excludedIn(
	around: string,
	rest: readonly string[],
	find: (t: string) => Mention[]
): boolean {
	const excluded = new Set<string>();
	for (const line of around.split('\n')) {
		for (const m of line.matchAll(EXCLUDER_RE)) {
			const before = line.slice(0, m.index!);
			if (NEGATED_BEFORE.test(before)) continue;
			if (EXCLUDER_VERB.test(m[0]) && !COMMAND_BEFORE.test(before)) continue;
			const after = line.slice(m.index! + m[0].length);
			let prevEnd = 0;
			const run: string[] = [];
			for (const x of find(after)) {
				const gap = after.slice(prevEnd, x.start);
				if (prevEnd === 0 ? !EXCLUDER_LEAD.test(gap) : !isListGap(gap)) break;
				run.push(x.ticker);
				prevEnd = x.end;
			}
			if (run.length > 0 && EXCLUDER_END.test(after.slice(prevEnd)))
				for (const t of run) excluded.add(t);
		}
	}
	return rest.every((t) => excluded.has(t));
}

/** The sentence holding text[start, end): up to the nearest line break or
 *  sentence end (". ", "! ", "? ") on each side; "incl.", "e.g.", "i.e." and
 *  "vs." do not end one. */
function sentenceAround(text: string, start: number, end: number): string {
	// Same length, so the offsets hold: the abbreviations' dots masked.
	const masked = text.replace(/\b(?:incl|e\.g|i\.e|vs)\./gi, (a) => a.replace(/\./g, '_'));
	const ENDS = /[.!?](?=\s|$)|\n/g;
	let from = 0;
	for (const m of masked.slice(0, start).matchAll(ENDS)) from = m.index! + m[0].length;
	ENDS.lastIndex = 0;
	const next = ENDS.exec(masked.slice(end));
	return text.slice(from, next ? end + next.index : undefined);
}

/** The part of that sentence between the commas, semicolons or dashes on each
 *  side of text[start, end): "17 coins, four of them privacy coins" counts
 *  coins, not privacy coins. */
function clauseAround(text: string, start: number, end: number): string {
	const sentence = sentenceAround(text, start, end);
	const from = text.lastIndexOf(sentence, start);
	const at = start - from;
	const len = end - start;
	const SEP = /[,;—–]/g;
	let a = 0;
	for (const m of sentence.slice(0, at).matchAll(SEP)) a = m.index! + 1;
	const rest = sentence.slice(at + len);
	const b = rest.search(/[,;—–]/);
	return sentence.slice(a, b === -1 ? undefined : at + len + b);
}

function analyze(coins: readonly Coin[], files: readonly Text[]): Problem[] {
	const problems: Problem[] = [];
	const sets = namedSets(coins);
	const all = sets.get('every coin')!;
	const tickers = coins.map((c) => c.ticker);
	const find = mentionFinder(coins);
	const usedAllowances = new Set<string>();
	const eq = (a: Set<string>, b: Set<string>): boolean =>
		a.size === b.size && [...a].every((x) => b.has(x));
	const nameOf = (s: Set<string>): string | null => {
		for (const [name, set] of sets) if (eq(s, set)) return name;
		return null;
	};
	const missingFrom = (s: Set<string>): string[] => tickers.filter((t) => !s.has(t));

	// A — lists
	for (const f of files) {
		for (const list of listsIn(f.text, find)) {
			if (list.set.size < 5) continue;
			if (nameOf(list.set)) continue;
			const where = `${f.rel}:${lineOf(f.text, list.start)}`;
			// "every coin but C", with C named right beside the list
			const rest = missingFrom(list.set);
			if (rest.length >= 1 && rest.length <= 4) {
				const lineStart = f.text.lastIndexOf('\n', list.start - 1) + 1;
				let from = lineStart;
				for (let k = 0; k < 2 && from > 0; k++) from = f.text.lastIndexOf('\n', from - 2) + 1;
				let to = list.end;
				for (let k = 0; k < 3 && to !== -1; k++) to = f.text.indexOf('\n', to + 1);
				const around =
					f.text.slice(from, list.start) + ' ' + f.text.slice(list.end, to === -1 ? undefined : to);
				if (excludedIn(around, rest, find)) continue;
			}
			const key = `${f.rel}|${sortedKey(list.set)}`;
			if (ALLOWED_PARTIAL_LISTS.some((a) => `${a.file}|${a.set}` === key)) {
				usedAllowances.add(key);
				continue;
			}
			const closest = [...sets].sort(
				(a, b) =>
					[...a[1]].filter((x) => !list.set.has(x)).length +
					[...list.set].filter((x) => !a[1].has(x)).length -
					([...b[1]].filter((x) => !list.set.has(x)).length +
						[...list.set].filter((x) => !b[1].has(x)).length)
			)[0]!;
			const lacks = [...closest[1]].filter((x) => !list.set.has(x));
			const extra = [...list.set].filter((x) => !closest[1].has(x));
			problems.push({
				rule: 'A',
				where,
				what:
					`lists ${list.set.size} coins (${sortedKey(list.set)}), which is none of the registry's sets; ` +
					`closest is ${closest[0]}` +
					(lacks.length ? `, missing ${lacks.join(', ')}` : '') +
					(extra.length ? `, plus ${extra.join(', ')}` : '')
			});
		}
		// {coins:…} is rendered by the site from locale strings only
		for (const tok of f.rel.startsWith(LOCALES_DIR) ? coinsTokens(f.text) : []) {
			if (tok.set === 'all') continue;
			if (nameOf(tok.set)) continue;
			problems.push({
				rule: 'A',
				where: `${f.rel}:${lineOf(f.text, tok.start)}`,
				what: `{coins:…} names ${sortedKey(tok.set)}, none of the registry's sets`
			});
		}
	}

	// B — coverage: a text naming nearly every coin names them all (or names
	// exactly one of the registry's sets). A translation must name, by ticker,
	// every coin its English text names by ticker; names are translated, so a
	// coin the English names only by name is not asked of the translation.
	const units: { where: string; path: string | null; locale: string | null; text: string }[] = [];
	for (const f of files) {
		if (f.rel.startsWith(LOCALES_DIR)) {
			const locale = f.rel.slice(LOCALES_DIR.length).replace(/\.json$/, '');
			const walkJson = (v: unknown, path: string): void => {
				if (typeof v === 'string') units.push({ where: `${f.rel} ${path}`, path, locale, text: v });
				else if (v && typeof v === 'object')
					for (const [k, x] of Object.entries(v)) walkJson(x, path ? `${path}.${k}` : k);
			};
			walkJson(JSON.parse(f.text), '');
		} else if (/\.(md|txt)$/.test(f.rel)) {
			let at = 0;
			for (const para of f.text.split(/\n\s*\n/)) {
				const pos = f.text.indexOf(para, at);
				units.push({
					where: `${f.rel}:${lineOf(f.text, pos)}`,
					path: null,
					locale: null,
					text: para
				});
				at = pos + para.length;
			}
		}
	}
	const coverage = (
		text: string,
		locale: string | null
	): { named: Set<string>; byTicker: Set<string>; everything: boolean } => {
		const ms = find(text);
		const named = new Set(ms.map((m) => m.ticker));
		const byTicker = new Set(
			ms.filter((m) => text.slice(m.start, m.end).toUpperCase() === m.ticker).map((m) => m.ticker)
		);
		let everything = false;
		for (const tok of locale ? coinsTokens(text) : []) {
			if (tok.set === 'all') everything = true;
			else for (const t of tok.set) (named.add(t), byTicker.add(t));
		}
		return { named, byTicker, everything };
	};
	const enByPath = new Map<string, ReturnType<typeof coverage>>();
	for (const u of units) if (u.locale === 'en') enByPath.set(u.path!, coverage(u.text, 'en'));
	const nearlyAll = (n: Set<string>): boolean => {
		const present = tickers.filter((t) => n.has(t)).length;
		return (
			present >= all.size - 3 &&
			present < all.size &&
			!nameOf(new Set(tickers.filter((t) => n.has(t))))
		);
	};
	for (const u of units) {
		const cov = u.locale === 'en' || !u.locale ? coverage(u.text, u.locale) : null;
		if (cov) {
			if (cov.everything || !nearlyAll(cov.named)) continue;
			problems.push({
				rule: 'B',
				where: u.where,
				what: `names ${tickers.filter((t) => cov.named.has(t)).length} of the ${all.size} coins; missing ${missingFrom(cov.named).join(', ')}`
			});
			continue;
		}
		const en = enByPath.get(u.path!);
		if (!en || en.everything) continue;
		const present = tickers.filter((t) => en.named.has(t)).length;
		if (present < all.size - 3) continue;
		const mine = coverage(u.text, u.locale);
		if (mine.everything) continue;
		const lacks = tickers.filter((t) => en.byTicker.has(t) && !mine.byTicker.has(t));
		if (lacks.length)
			problems.push({
				rule: 'B',
				where: u.where,
				what: `the English text names ${lacks.join(', ')} by ticker; this translation does not`
			});
	}

	// C — per-coin settings
	const fileText = (rel: string): string => {
		const f = files.find((x) => x.rel === rel);
		if (f) return f.text;
		try {
			return readFileSync(join(REPO, rel), 'utf8'); // a smoke, skipped by the scan
		} catch {
			return '';
		}
	};
	const must = (rel: string, needle: string, why: string): void => {
		if (!fileText(rel).includes(needle))
			problems.push({ rule: 'C', where: rel, what: `has no ${needle} (${why})` });
	};
	for (const c of coins.filter((x) => x.native)) {
		const T = c.ticker;
		const t = T.toLowerCase();
		const env = `MORPHIT_FRONTEND_${T}_CHAT_LINK_URL`;
		must(
			'apps/indexer/src/config/index.ts',
			`${env}:`,
			"the indexer reads the coin's explorer setting"
		);
		must('ops/env/indexer.env.example', env, 'operators find the setting');
		must('docs/OPERATIONS.md', env, 'operators find the setting');
		must('apps/ops-cli/src/init/render.ts', `${env}=`, 'morphit-ops init writes the setting');
		must(
			'apps/ops-cli/src/init/render.ts',
			`#   ${T}:`,
			"the env file names the coin's default explorer"
		);
		must('apps/ops-cli/src/init/steps.ts', `DEFAULT_${T}_CHAT_LINK_URL`, "the wizard's default");
		must(
			'apps/ops-cli/src/commands/init.ts',
			`chatLinkExplorers.${t}}`,
			"the wizard's summary line"
		);
		must(
			'apps/matrix-bot/scripts/api-response-shape-smoke.ts',
			`\t${t}: z.`,
			"the matrix bot's schema of /v1/instance.chat_link_urls"
		);
		must('scripts/comparison-image/build_comparison.py', `(${T})'`, "the comparison image's row");
	}
	// Every coin is also a way to pay (a payment rail), and the indexer keeps
	// operators from defining their own method under that coin's key.
	for (const c of coins) {
		const key = `'pay_${c.ticker.toLowerCase()}'`;
		must('apps/web/src/lib/payments/registry.ts', `key: ${key}`, 'the coin as a payment rail');
		must(
			'apps/indexer/src/indexer/handlers/operatorPaymentMethod.ts',
			`\t${key},`,
			"the indexer's reserved payment-method keys"
		);
	}
	// The privacy FAQ says which privacy coins cannot pay a listing fee ("never
	// in ZEC, ARRR, DASH or DCR, so their transaction IDs never appear on the
	// Blurt chain"): a list of four, below check A's size, so named here.
	for (const f of files.filter((x) => x.rel.startsWith(LOCALES_DIR))) {
		const a = (JSON.parse(f.text) as { faq?: { entries?: Record<string, { a?: string }> } }).faq
			?.entries?.privacy_coins_onchain?.a;
		if (typeof a !== 'string') {
			problems.push({
				rule: 'C',
				where: f.rel,
				what: 'has no faq.entries.privacy_coins_onchain.a'
			});
			continue;
		}
		for (const c of coins.filter(
			(x) => x.privacy && x.privacy !== 'transparent' && !x.canPayListingFee
		))
			if (!new RegExp(`(?<![A-Za-z0-9])${c.ticker}(?![A-Za-z0-9])`).test(a))
				problems.push({
					rule: 'C',
					where: `${f.rel} faq.entries.privacy_coins_onchain.a`,
					what: `does not name ${c.ticker} among the privacy coins that never pay a listing fee`
				});
	}

	// D — counts
	const WORDS: Record<string, number> = {
		ten: 10,
		eleven: 11,
		twelve: 12,
		thirteen: 13,
		fourteen: 14,
		fifteen: 15,
		sixteen: 16,
		seventeen: 17,
		eighteen: 18,
		nineteen: 19,
		twenty: 20,
		'twenty-one': 21,
		'twenty-two': 22
	};
	const countRe = new RegExp(
		`\\b(\\d{1,2}|${Object.keys(WORDS).join('|')})\\+?(?:-(?:coin|asset|ticker)\\b|\\s+(?:(?:current|supported|tradable|tradeable|different|crypto|digital|native|listed|available)[\\s-]+){0,2}(?:coin\\s+)?(?:assets|coins|cryptocurrencies|cryptos|tickers)\\b)`,
		'gi'
	);
	const tradeOnly = sets.get('the trade-only coins')!.size;
	const privacy = sets.get('the privacy coins')!.size;
	const native = sets.get('the native coins (one chain each, not BLURT)')!.size;
	for (const f of files) {
		// The pattern is English: of the locale files, en.json.
		if (f.rel.startsWith(LOCALES_DIR) && f.rel !== `${LOCALES_DIR}en.json`) continue;
		for (const m of f.text.matchAll(countRe)) {
			const n = WORDS[m[1]!.toLowerCase()] ?? Number(m[1]);
			if (n < all.size - 4 || n > all.size + 4) continue;
			const ctx = clauseAround(f.text, m.index!, m.index! + m[0].length);
			let ok: number[];
			if (/trade[- ]only|category[- ]?b/i.test(ctx)) ok = [tradeOnly];
			else if (/privacy coins?/i.test(ctx)) ok = [privacy];
			else if (/single-network (coins|assets)|native coins/i.test(ctx))
				ok = [native, all.size - MULTI_NETWORK_TICKERS.length];
			// + barter, only where the sentence says it counts it ("18 assets,
			// counting barter"): then it must be one more. Anywhere else a count one
			// too high is a stale count that once included barter, or a coin since
			// removed.
			else if (
				/(?<!\bnot\s+)(?:counting|including|incl\.?)\s+(?:the\s+)?barter|barter\s+included/i.test(
					sentenceAround(f.text, m.index!, m.index! + m[0].length)
				)
			)
				ok = [all.size + 1];
			else ok = [all.size];
			if (!ok.includes(n))
				problems.push({
					rule: 'D',
					where: `${f.rel}:${lineOf(f.text, m.index!)}`,
					what: `"${m[0]}" — the registry has ${ok.join(' (or ')}${ok.length > 1 ? ')' : ''}`
				});
		}
	}

	for (const a of ALLOWED_PARTIAL_LISTS) {
		if (!usedAllowances.has(`${a.file}|${a.set}`) && files.length > 50)
			problems.push({
				rule: 'allowlist',
				where: a.file,
				what: `ALLOWED_PARTIAL_LISTS entry ${a.set} matches no list any more: remove it`
			});
	}
	return problems;
}

// ─── Run ───────────────────────────────────────────────────────────

console.log('\n── coin completeness ────────────────────────────────────\n');

const coins = coinsFromRegistry();
const files = readRepo();
let failed = 0;
let passed = 0;

const problems = analyze(coins, files);
if (problems.length === 0) {
	passed++;
	console.log(
		`  ✓ ${files.length} files: every list, count and per-coin setting matches the ${coins.length} coins`
	);
} else {
	failed++;
	console.log(`  ✗ ${problems.length} place(s) do not match the registry's ${coins.length} coins:`);
	for (const p of problems) console.log(`      [${p.rule}] ${p.where} — ${p.what}`);
	console.log('\n      How to add a coin, and what each check wants: docs/ADDING-A-COIN.md');
}

// Self-test: two made-up coins. Each check must notice them where a real
// addition has to.
{
	const tstc: Coin = {
		ticker: 'TSTC',
		name: 'Testcoin',
		native: true,
		multiNetwork: false,
		coordinationChain: false,
		canPayListingFee: false,
		decimals: 8,
		privacy: 'transparent'
	};
	const prvc: Coin = {
		...tstc,
		ticker: 'PRVC',
		name: 'Privcoin',
		decimals: 12,
		privacy: 'private-by-default'
	};
	const withBoth = analyze([...coins, tstc, prvc], files);
	const expect: [string, (p: Problem) => boolean][] = [
		['A: the README list of every coin', (p) => p.rule === 'A' && p.where.startsWith('README.md:')],
		[
			'A: the media kit list',
			(p) => p.rule === 'A' && p.where.startsWith('scripts/build-mediakit.sh:')
		],
		[
			'A: the llms.txt list',
			(p) => p.rule === 'A' && p.where.startsWith('apps/web/static/llms.txt:')
		],
		[
			'A: the privacy FAQ {coins:…} list (PRVC)',
			(p) =>
				p.rule === 'A' && p.where.startsWith(`${LOCALES_DIR}en.json`) && p.what.includes('{coins:')
		],
		[
			'A: the comparison image privacy line (PRVC)',
			(p) => p.rule === 'A' && p.where.startsWith('scripts/comparison-image/build_comparison.py:')
		],
		[
			'A: the metadata-leak catalog privacy coins',
			(p) => p.rule === 'A' && p.where.startsWith('docs/METADATA-LEAK-CATALOG.md:')
		],
		['B: the amount-jitter FAQ', (p) => p.rule === 'B' && p.where.includes('amount_jitter')],
		[
			'C: the TSTC chat-link setting in the indexer',
			(p) => p.rule === 'C' && p.what.includes('MORPHIT_FRONTEND_TSTC_CHAT_LINK_URL:')
		],
		['C: the PRVC comparison-image row', (p) => p.rule === 'C' && p.what.includes("(PRVC)'")],
		[
			'C: the privacy FAQ fee sentence (PRVC)',
			(p) => p.rule === 'C' && p.where.includes('privacy_coins_onchain') && p.what.includes('PRVC')
		],
		[
			'D: a count of the coins in the brag list',
			(p) => p.rule === 'D' && p.where.startsWith('docs/MORPHIT-BRAG-LIST.md:')
		]
	];
	// COIN_COMPLETENESS_SHOW=1 prints every place the made-up coins would have
	// to reach: the to-do list of a real addition, before it starts.
	if (process.env.COIN_COMPLETENESS_SHOW === '1')
		for (const p of withBoth) console.log(`      (self-test) [${p.rule}] ${p.where} — ${p.what}`);
	const blind = expect.filter(([, f]) => !withBoth.some(f)).map(([n]) => n);
	if (blind.length === 0) {
		passed++;
		console.log(
			`  ✓ self-test: with two made-up coins added, all ${expect.length} expected places fail (${withBoth.length} in all)`
		);
	} else {
		failed++;
		console.log('  ✗ self-test: with two made-up coins added, these checks stayed quiet:');
		for (const b of blind) console.log(`      - ${b}`);
	}
}

// Self-test of the "every coin but" exemption and of the count rule: neither may
// let a stale text through. A list that lacks the newest coin is stale beside a
// line that only NAMES that coin; it is deliberate beside a line that leaves the
// coin out in words. A count one above the number of coins is stale unless the
// sentence says it counts barter (and then the plain number is stale).
{
	const last = coins[coins.length - 1]!.ticker;
	const n = coins.length;
	const others = coins
		.filter((c) => c.ticker !== last)
		.map((c) => c.ticker)
		.join('/');
	const listFlagged = (rel: string, before: string): boolean =>
		analyze(coins, [{ rel, text: `${before}\n# keeps ${others} only\n` }]).some(
			(p) => p.rule === 'A' && p.where.startsWith(rel)
		);
	const countFlagged = (rel: string, text: string): boolean =>
		analyze(coins, [{ rel, text }]).some((p) => p.rule === 'D' && p.where.startsWith(rel));
	const cases: { text: string; stale: boolean; flagged: (rel: string, t: string) => boolean }[] = [
		...[
			`# ${last} stays enabled`,
			`# ${last} has no payment URI scheme.`,
			`# Note: ${last} addresses are not the same as XEC ones.`,
			`# Operators who disabled XMR still list ${last}.`,
			`# Every coin works the same, but ${last} needs a split first.`,
			`# Works without ${last}? No.`,
			`# This build shipped without ${last}.`,
			`# We no longer refuse ${last}.`,
			`# Do not disable ${last}.`,
			`# Don't refuse ${last}.`,
			`# Never exclude ${last}.`,
			`# Indexers older than v1.22.0 refused ${last}.`,
			`# Older nodes disable ${last} (they do not know it).`,
			`# We do not, however, refuse ${last}.`,
			`# No node will refuse ${last}.`,
			`# No list here except ${last}.`,
			`# Nodes before v1.22 used to refuse ${last}.`,
			`# Older indexers may refuse ${last}.`,
			`# Old nodes are set to refuse ${last}.`,
			`# Not, this time, except ${last}.`,
			`# except for old nodes, which skip ${last}.`,
			`# except ${last} users, who must split first.`
		].map((text) => ({ text, stale: true, flagged: listFlagged })),
		...[
			`# refuse ${last}`,
			`# every coin but ${last}:`,
			`# all coins except ${last}`,
			`MORPHIT_INDEXER_DISABLED_ASSETS="${last}"`,
			`# each coin but ${last}:`,
			`- disable ${last}`,
			`# every coin except for ${last}:`,
			`# all coins except ${last}, for now:`,
			`# 除了 ${last} 之外，`
		].map((text) => ({ text, stale: false, flagged: listFlagged })),
		...[
			`Morphit trades ${n + 1} tradable assets.`,
			`${n} tradable assets, counting barter.`,
			`${n + 1} coins. Goods are not coins.`,
			`${n - 1}+ cryptos plus goods.`,
			`${n + 1} tradable assets. Counting barter, the page lists more.`,
			`Including barter matters. ${n + 1} coins trade here.`,
			`${n - 1} current tradable tickers × 10 locales.`,
			`a ${n - 1}-asset picker`,
			`${n - 1} tradable crypto assets`,
			`${n - 1} digital assets`,
			`${n - 1} crypto-assets`,
			`${n + 1} coins trade here, not including barter.`
		].map((text) => ({ text, stale: true, flagged: countFlagged })),
		...[
			`${n + 1} tradable assets, counting barter.`,
			`${n}+ cryptos plus goods.`,
			`${n + 1} tradable assets (incl. barter).`,
			`${n} tradable assets. Counting barter, the page lists more.`,
			`${n + 1} assets (e.g. BTC), counting barter.`,
			`${n} coins, four of them privacy coins.`
		].map((text) => ({
			text,
			stale: false,
			flagged: countFlagged
		}))
	];
	const wrong = cases.filter((c, i) => c.flagged(`selftest/case${i}.md`, c.text) !== c.stale);
	if (wrong.length === 0) {
		passed++;
		console.log(
			`  ✓ self-test: ${cases.filter((c) => c.stale).length} stale lists and counts fail, ${cases.filter((c) => !c.stale).length} deliberate ones pass`
		);
	} else {
		failed++;
		console.log('  ✗ self-test: the "every coin but" exemption and the count rule');
		for (const c of wrong)
			console.log(
				`      ${c.stale ? 'a stale text passed' : 'a deliberate text failed'}: ${c.text}`
			);
	}
}

console.log('\n──────────────────────────────────────────────────────');
if (failed > 0) {
	console.log(`✗ ${failed}/${failed + passed} scenarios failed`);
	process.exit(1);
}
console.log(`✓ all ${passed} scenarios passed`);
