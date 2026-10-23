#!/usr/bin/env tsx
/**
 * Morphit — IP-disclosure single-source smoke.
 *
 * Who sees a visitor's IP address is answered in ONE place: the FAQ article
 * `ip_address_and_rpc_nodes`, in all 10 locales. Since the v1.21.14 final
 * review the browser contacts nothing but its own instance — the release check
 * reads through the instance's agreed-read relay (`POST /v1/chain/agreed`) and
 * every page's Content-Security-Policy allows `connect-src 'self'` only
 * (scripts/csp-header-consistency-smoke.ts). This guard pins that the words
 * match the code:
 *   1. The article exists in every locale, carries the explanation, names
 *      the Tor / VPN recommendation, and points to the push-notifications
 *      entry (with push on, the browser also uses its vendor's push service).
 *   2. It states the release check's budget as the code has it (imported
 *      values, not text): two small requests to this site, at most once a day,
 *      100 history entries first, ~115 KB at most, that two RPC operators
 *      must agree, and that a check with no answer is retried after 12 hours.
 *   3. No string anywhere still says the browser asks a public Blurt node
 *      (the old disclosure), and the article no longer lists per-origin node
 *      pools.
 *   4. A worried user FINDS the article — the words they type rank it first.
 *      (Before, "ip leak" ranked the video tutorial entry first, because it
 *      says "expose your IP". The FAQ scorer weights QUESTION tokens 2x answer
 *      tokens, so the user's words have to be in the question.)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchEntries, type FaqEntry } from '../src/lib/utils/faqIndex';
import { RELEASE_CACHE_TTL_MS, RELEASE_FAILED_TTL_MS } from '../src/lib/net/releaseCache';
import {
	RELEASE_CHECK_STEADY_STATE_REQUESTS,
	RELEASE_HISTORY_WINDOWS
} from '../src/lib/net/releaseFetch';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES = resolve(__dirname, '..', 'src', 'lib', 'i18n', 'locales');
const KEY = 'ip_address_and_rpc_nodes';

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
	}
};

type Json = Record<string, unknown>;
const leaves = (o: unknown, p: string[] = []): Array<[string, string]> => {
	const out: Array<[string, string]> = [];
	if (typeof o === 'string') out.push([p.join('.'), o]);
	else if (o && typeof o === 'object')
		for (const [k, v] of Object.entries(o as Json)) out.push(...leaves(v, [...p, k]));
	return out;
};
const read = (f: string): Json => JSON.parse(readFileSync(join(LOCALES, f), 'utf8')) as Json;
const articleOf = (d: Json): { q?: string; a?: string } | undefined =>
	((d.faq as Json)?.entries as Json)?.[KEY] as { q?: string; a?: string } | undefined;

const files = readdirSync(LOCALES).filter((f) => f.endsWith('.json'));
check('0 all 10 locales present', files.length === 10, `found ${files.length}`);

// ── 1. the article exists everywhere and says what to do ───────────
for (const f of files) {
	const loc = f.replace('.json', '');
	const entry = articleOf(read(f));
	check(
		`1.${loc} the article exists and carries the explanation`,
		!!entry?.q && !!entry?.a && entry.a.length > 400,
		entry ? `answer is ${entry.a?.length ?? 0} chars` : 'missing entirely'
	);
	check(
		`1.${loc} …and names the Tor / VPN recommendation`,
		/tor/i.test(entry?.a ?? '') && /vpn/i.test(entry?.a ?? '')
	);
	// With push on (clearnet and mixed instances), the browser also uses its
	// vendor's push service (notifications/push.ts; METADATA-LEAK-CATALOG). The
	// article must say so by pointing at the push entry: it quotes that entry's
	// question, the way FAQ answers cross-reference each other.
	const push = ((read(f).faq as Json)?.entries as Json)?.push_notifications_privacy as
		| { q?: string }
		| undefined;
	const pushQ = push?.q;
	check(
		`1.${loc} …and points to the push-notifications entry (the browser's push service)`,
		!!pushQ && (entry?.a ?? '').includes(pushQ),
		pushQ ? 'the push caveat is missing' : 'push_notifications_privacy.q missing'
	);
}

// ── 2. the budget in the article is the budget in the code ─────────
{
	const WORDS: Record<number, string> = { 1: 'one', 2: 'two', 3: 'three', 4: 'four' };
	const enA = articleOf(read('en.json'))?.a ?? '';
	const budget = `${WORDS[RELEASE_CHECK_STEADY_STATE_REQUESTS]} small requests`;
	check(
		`2 EN: "at most once a day", "after each site update", "${budget}", this site only, two RPC operators agree — as the code does`,
		RELEASE_CACHE_TTL_MS === 24 * 60 * 60 * 1000 &&
			RELEASE_HISTORY_WINDOWS[0] === 100 &&
			RELEASE_HISTORY_WINDOWS[1] === 10_000 &&
			/at most once a day/i.test(enA) &&
			/after each site update/i.test(enA) &&
			enA.includes(budget) &&
			/connect to this site only/i.test(enA) &&
			/two Blurt RPC operators agree/i.test(enA),
		'the code and the article differ — update the article in all 10 locales'
	);
	// A check that got no answer is asked again after 12 hours, not a day (at
	// most twice a day, a standing decision).
	check(
		'2 EN: "if this site could not get an answer, after 12 hours" — as the code does',
		RELEASE_FAILED_TTL_MS === 12 * 60 * 60 * 1000 &&
			/could not get an answer, after 12 hours/i.test(enA),
		'the code and the article differ — update the article in all 10 locales'
	);
	for (const f of files) {
		const loc = f.replace('.json', '');
		const a = articleOf(read(f))?.a ?? '';
		check(
			`2.${loc} the article states the budget (24 h, 100 entries, ~115 KB) and no node pools`,
			/24/.test(a) && /100/.test(a) && /115/.test(a) && !/\.b32\.i2p/.test(a) && /RPC/.test(a)
		);
	}
}

// ── 3. nothing still says the browser asks a node ──────────────────
{
	// English: any string in which the browser reads, asks or contacts a public
	// or network node is the old disclosure, wherever it survives.
	const OLD = /browser[\s\S]{0,160}?(public|network) (Blurt )?(RPC )?node/i;
	const bad = leaves(read('en.json')).filter(([, v]) => OLD.test(v));
	check(
		'3 EN: no string says the browser asks a public Blurt node',
		bad.length === 0,
		bad.map(([k]) => k).join(', ')
	);
	// Every locale: the three strings that told it now say "through this site,
	// two RPC operators".
	for (const f of files) {
		const loc = f.replace('.json', '');
		const d = read(f);
		const glossary = ((d.glossary as Json)?.release_op as Json)?.body;
		const security = (d.security as Json)?.reproducible_body;
		check(
			`3.${loc} the glossary and the security page name the RPC operators, not a public node`,
			typeof glossary === 'string' &&
				typeof security === 'string' &&
				/RPC/.test(glossary) &&
				/RPC/.test(security)
		);
	}
}

// ── 4. a worried user actually finds it ─────────────────────────────
interface EnShape {
	faq: { entries: Record<string, { q: string; a: string }> };
}
const en = read('en.json') as unknown as EnShape;
const entries: FaqEntry[] = Object.entries(en.faq.entries).map(([key, v]) => ({
	key: key as FaqEntry['key'],
	question: v.q,
	answer: v.a,
	related: []
}));
// The words someone types when they are worried, or when they opened the Network
// tab to see where the page connects.
const MUST_RANK_FIRST = [
	'ip leak',
	'ip address',
	'is my ip exposed',
	'who sees my ip',
	'do you log my ip',
	'hide my ip',
	'rpc node ip',
	'network tab request'
];
for (const q of MUST_RANK_FIRST) {
	const hits = searchEntries(entries, q, 3);
	const top = hits[0]?.entry.key ?? '(nothing)';
	check(`4 "${q}" ranks the article FIRST`, top === KEY, `got ${top}`);
}

console.log('');
if (fail === 0) console.log(`✓ all ${pass} ip-disclosure-single-source checks passed`);
else {
	console.error(`✗ ${fail} of ${pass + fail} ip-disclosure-single-source checks FAILED`);
	process.exit(1);
}
