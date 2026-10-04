#!/usr/bin/env tsx
/**
 * Morphit — IP-disclosure single-source smoke (v1.7.5).
 *
 * The maintainer's rule, verbatim: "if a user leaks their ip one time to one of the rpc
 * nodes because we made the conscious decision to do so, then i only want that
 * bad news mentioned in one faq article, and nowhere else on the site."
 *
 * Morphit makes exactly ONE kind of direct browser→Blurt-node request: the
 * release check (`initRelease()` → `fetchVerifiedRelease()` → one node, a
 * second operator's node only when needed), at most once a day per browser. It
 * is deliberate — it is what makes `staleBuild` meaningful, so an operator
 * cannot pin a user to an old, genuinely-signed, backdoored build. The privacy
 * cost is one node (two at most) learning that an IP loaded a page.
 *
 * This guard pins the three things that make that honest:
 *   1. The disclosure lives in exactly ONE user-facing string, in all 10 locales.
 *   2. No string anywhere makes the absolute claims that this call falsifies.
 *   3. A worried user actually FINDS the article — the words they type rank it
 *      first, not some other entry that happens to mention an IP.
 *
 * (3) is not decoration. Before this, "ip leak" ranked the VIDEO TUTORIAL entry
 * first, because it says "expose your IP" — a user asking the scariest question
 * got the wrong answer. The FAQ scorer weights QUESTION tokens 2x answer tokens
 * and matches answers by set membership, so repeating a word in the body buys
 * nothing: the user's words have to be in the question. That is why the question
 * says "see or leak".
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchEntries, type FaqEntry } from '../src/lib/utils/faqIndex';
import { RELEASE_CACHE_TTL_MS } from '../src/lib/net/releaseCache';
import {
	RELEASE_CHECK_STEADY_STATE_REQUESTS,
	RELEASE_HISTORY_WINDOWS
} from '../src/lib/net/releaseFetch';
import { MAX_NODES_PER_CHECK } from '../src/lib/net/releaseVerifyCore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES = resolve(__dirname, '..', 'src', 'lib', 'i18n', 'locales');
const KEY = 'ip_address_and_rpc_nodes';

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.log(`  \u2717 ${name}${detail ? `: ${detail}` : ''}`);
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

const files = readdirSync(LOCALES).filter((f) => f.endsWith('.json'));
check('1 all 10 locales present', files.length === 10, `found ${files.length}`);

// ── 1. exactly ONE disclosure site ─────────────────────────────────
//
// Checked precisely in ENGLISH and structurally across all ten. A multilingual
// keyword heuristic was tried first and is the wrong tool: matching "node" +
// "IP" + "sees" across ten languages flags `privacy.guides.sol.caveats` ("your
// WALLET talks to a Solana RPC endpoint"), `why_multi_accounts_fail` ("we
// rate-limit signups to 2 per IP per day"), and the video-embed entry ("a
// PeerTube iframe would expose your IP") — three legitimate discussions of IPs
// on three unrelated subjects. A guard that cries wolf on those gets muted, and
// a muted guard protects nothing.
//
// What actually identifies THIS disclosure is its subject: Morphit's own browser
// asking a Blurt node for the release record. That is what is pinned.
// Pins the SUBJECT, not the phrasing: this browser, a network node, the release
// record. That triple is what makes it THIS disclosure and not the signup
// rate-limit note ("2 per IP per day"), the Solana wallet guide ("your wallet
// talks to an RPC endpoint"), or the video-embed entry ("a PeerTube iframe would
// expose your IP") — three legitimate discussions of IPs on unrelated subjects
// that a looser keyword heuristic flagged. A guard that cries wolf gets muted,
// and a muted guard protects nothing.
const DISCLOSURE_EN = /browser[\s\S]{0,140}?network node[\s\S]{0,260}?release record/i;

const enAll = leaves(JSON.parse(readFileSync(join(LOCALES, 'en.json'), 'utf8')));
const enSites = enAll.filter(([, v]) => DISCLOSURE_EN.test(v));
check(
	'2 EN: the browser→Blurt-node disclosure appears in exactly ONE string',
	enSites.length === 1 && enSites[0]![0] === `faq.entries.${KEY}.a`,
	`found in: ${enSites.map(([k]) => k).join(', ') || '(nowhere — did the article lose it?)'}`
);

// Structural, all ten: the article must exist and actually carry the explanation.
// If a future edit stubs it out, the disclosure silently vanishes from the site
// while the direct call keeps happening — the exact failure this guard exists for.
for (const f of files) {
	const loc = f.replace('.json', '');
	const d = JSON.parse(readFileSync(join(LOCALES, f), 'utf8')) as Json;
	const entry = ((d.faq as Json)?.entries as Json)?.[KEY] as { q?: string; a?: string } | undefined;
	check(
		`3.${loc} the disclosure article exists and carries the explanation`,
		!!entry?.q && !!entry?.a && entry.a.length > 400,
		entry ? `answer is ${entry.a?.length ?? 0} chars` : 'missing entirely'
	);
	// Every locale must name the recommendation, because that is the part that
	// actually helps a Monero user: Tor or a VPN closes this and everything else.
	check(
		`3.${loc} …and names the Tor / VPN recommendation`,
		/tor/i.test(entry?.a ?? '') && /vpn/i.test(entry?.a ?? '')
	);
}

// ── 1b. the article says how OFTEN and HOW MANY requests, as the code does ──
// The numbers come from the code itself (imported values, not its text): the
// outcome is remembered for RELEASE_CACHE_TTL_MS; a check costs
// RELEASE_CHECK_STEADY_STATE_REQUESTS requests to one node (each may be preceded
// by the browser's CORS preflight), a second node only when needed
// (MAX_NODES_PER_CHECK; the article does not promise that node is run by another
// operator, since the default hidden nodes are not independent); the history windows are 100 then
// 10,000. src/lib/net/releaseBudget.test.ts proves the code makes exactly that
// many requests; this proves the article says the same. If a number changes,
// update the article in all 10 locales.
{
	const WORDS: Record<number, string> = { 1: 'one', 2: 'two', 3: 'three', 4: 'four' };
	const enA = (
		JSON.parse(readFileSync(join(LOCALES, 'en.json'), 'utf8')) as {
			faq: { entries: Record<string, { a: string }> };
		}
	).faq.entries[KEY]!.a;
	const budget = `${WORDS[RELEASE_CHECK_STEADY_STATE_REQUESTS]} small requests to one node`;
	check(
		`1b EN: the article says "at most once a day", "after each site update" and "${budget}", the preflight and "another node" (no operator-independence claim) — as the code does`,
		RELEASE_CACHE_TTL_MS === 24 * 60 * 60 * 1000 &&
			MAX_NODES_PER_CHECK === 2 &&
			RELEASE_HISTORY_WINDOWS[0] === 100 &&
			RELEASE_HISTORY_WINDOWS[1] === 10_000 &&
			/at most once a day/i.test(enA) &&
			/after each site update/i.test(enA) &&
			enA.includes(budget) &&
			/is another node asked/i.test(enA) &&
			/preflight/i.test(enA) &&
			!/another operator/i.test(enA) &&
			!/four small requests/i.test(enA),
		RELEASE_CACHE_TTL_MS !== 24 * 60 * 60 * 1000
			? 'RELEASE_CACHE_TTL_MS is no longer 24 h — update the article in all 10 locales'
			: 'the budget in the code and the article differ — update the article in all 10 locales'
	);
	for (const f of files) {
		const loc = f.replace('.json', '');
		const d = JSON.parse(readFileSync(join(LOCALES, f), 'utf8')) as Json;
		const a = ((((d.faq as Json)?.entries as Json)?.[KEY] as { a?: string }) ?? {}).a ?? '';
		check(
			`1b.${loc} the article states the budget (24 h, 100 entries, ~115 KB) and the per-origin pools (.onion, .i2p)`,
			/24/.test(a) && /100/.test(a) && /115/.test(a) && /\.onion/.test(a) && /\.b32\.i2p/.test(a)
		);
	}
	const ONCE_PER_SESSION: Record<string, RegExp> = {
		en: /once per session/i,
		es: /una vez por sesi[oó]n/i,
		de: /einmal pro sitzung/i,
		fr: /une fois par session/i,
		it: /una volta per sessione/i,
		pl: /raz na sesj[eę]/i,
		ru: /раз за сессию/i,
		fa: /یک بار در هر نشست/,
		'zh-CN': /每次会话一次/,
		'zh-HK': /每次工作階段一次/
	};
	for (const f of files) {
		const loc = f.replace('.json', '');
		const d = JSON.parse(readFileSync(join(LOCALES, f), 'utf8')) as Json;
		const a = ((((d.faq as Json)?.entries as Json)?.[KEY] as { a?: string }) ?? {}).a ?? '';
		const re = ONCE_PER_SESSION[loc];
		check(
			`1b.${loc} the article no longer says "once per session"`,
			re !== undefined && !re.test(a),
			re ? '' : 'no pattern for this locale'
		);
	}
}

// ── 2. no surviving absolute claim that the direct call falsifies ───
for (const f of files) {
	const loc = f.replace('.json', '');
	const all = leaves(JSON.parse(readFileSync(join(LOCALES, f), 'utf8')));
	// Pin the CLASS, not the phrasings. The first version of this guard listed the
	// two sentences already found — and missed a third, `settings.endpoints
	// .pool_note`, which told users "your browser never talks to these nodes
	// directly" on the very panel that LISTS the node the release check calls.
	// Hardcoding known-bad literals is how a guard ends up certifying the bug it
	// was written to catch.
	//
	// The article itself is exempt: it says "your browser never touches third-party
	// endpoints" and then immediately says "The one exception." — scoped, not false.
	// "nowhere else" is only false UNSCOPED. `security.tracking_body` says "your
	// orders, your chat, and your balances all go to Morphit and nowhere else",
	// which is true and is a brag worth keeping — so the pattern requires the
	// universal quantifier ("every request", "all traffic"), not the phrase alone.
	const ABSOLUTE_CLAIM =
		/(browser|you)\s+never\s+(talks?|touch\w*|reach\w*|contact\w*|connect\w*)[\s\S]{0,40}(node|endpoint|third[- ]party)|(every|all)\s+(request|traffic)[\s\S]{0,40}nowhere else|no third[- ]party services|we don'?t know you'?re here|handles all blurt network traffic/i;
	const bad = all.filter(([k, v]) => ABSOLUTE_CLAIM.test(v) && !k.startsWith(`faq.entries.${KEY}`));
	check(
		`4.${loc} no string outside the article claims the browser never reaches a node`,
		bad.length === 0,
		bad.map(([k]) => k).join(', ')
	);
}

// ── 3. a worried user actually finds it ─────────────────────────────
interface EnShape {
	faq: { entries: Record<string, { q: string; a: string }> };
}
const en = JSON.parse(readFileSync(join(LOCALES, 'en.json'), 'utf8')) as unknown as EnShape;
const entries: FaqEntry[] = Object.entries(en.faq.entries).map(([key, v]) => ({
	key: key as FaqEntry['key'],
	question: v.q,
	answer: v.a,
	related: []
}));
// The words someone types when they are worried, or when they opened the Network
// tab and saw one request that was not to Morphit.
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
	check(`5 "${q}" ranks the disclosure article FIRST`, top === KEY, `got ${top}`);
}

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} ip-disclosure-single-source checks passed`);
else {
	console.error(`\u2717 ${fail} of ${pass + fail} ip-disclosure-single-source checks FAILED`);
	process.exit(1);
}
