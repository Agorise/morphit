#!/usr/bin/env tsx
/**
 * Morphit — IP-disclosure single-source smoke (v1.7.5, t.txt #10).
 *
 * Ken's rule, verbatim: "if a user leaks their ip one time to one of the rpc
 * nodes because we made the conscious decision to do so, then i only want that
 * bad news mentioned in one faq article, and nowhere else on the site."
 *
 * Morphit makes exactly ONE direct browser→Blurt-node request: the boot-time
 * release-integrity check (`initRelease()` → `fetchVerifiedRelease()` →
 * `getDirectChainClient()`). It is deliberate — it is what makes `staleBuild`
 * meaningful, so an operator cannot pin a user to an old, genuinely-signed,
 * backdoored build. The privacy cost is one node learning that an IP loaded a
 * page.
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

// ── 2. no surviving absolute claim that the direct call falsifies ───
for (const f of files) {
	const loc = f.replace('.json', '');
	const all = leaves(JSON.parse(readFileSync(join(LOCALES, f), 'utf8')));
	// Pin the CLASS, not the phrasings. The first version of this guard listed the
	// two sentences I had already found — and missed a third, `settings.endpoints
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
	const bad = all.filter(
		([k, v]) => ABSOLUTE_CLAIM.test(v) && !k.startsWith(`faq.entries.${KEY}`)
	);
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
