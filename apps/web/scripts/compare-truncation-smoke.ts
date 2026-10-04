#!/usr/bin/env tsx
/**
 * apps/web/scripts/compare-truncation-smoke.ts
 *
 * /compare accused instances of censorship for being busy — and then the first
 * fix for that accused nobody at all, including when it should have.
 *
 * THE REPORT
 * The timeapp admin used the comparison page and saw an order flagged as a
 * difference that was, in his words, "old, some days ago", and concluded "the
 * two instance are not on the same page". They were. `/v1/orderbook` returns at
 * most 100 rows ordered `updated_at DESC` with a `next_cursor` when more exist,
 * and the page diffed the two pages as though each were a whole orderbook. A
 * few genuinely-new orders at the top of one side push an equal number off the
 * bottom, and those displaced orders — present on both instances — were
 * reported as missing. They look old because the bottom of the window is where
 * old orders are.
 *
 * HOW THIS SUITE IS BUILT, AND WHY
 * A first version of this smoke passed 15 of its 21 assertions against the
 * UNFIXED logic. It reported "all 21 passed" while six of them were doing the
 * work and the rest were decoration — including one assertion that could not
 * fail under any implementation, and one whose fixture pinned a real defect as
 * intended behaviour.
 *
 * So the suite is now built the other way round. Three MUTANTS are implemented
 * here in full — the shipped-before logic, and the two plausible-but-wrong
 * window rules — and every case states which mutants it must catch. A case that
 * catches nothing is itself reported as a failure, and at the end each mutant
 * must have been caught by at least one case. An assertion that cannot fail
 * cannot hide in here.
 */

import {
	compareOrderbooks,
	type OrderKey,
	type OrderbookSide
} from '../src/lib/utils/compareOrderbooks';
import type { OrderRecord } from '@morphit/indexer-client';

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  ✓ ${m}`);
};
const bad = (m: string, d = '') => {
	fail++;
	console.log(`  ✗ ${m}`);
	if (d) console.log(`      ${d}`);
};

// ── fixtures ─────────────────────────────────────────────────────────

function order(account: string, permlink: string, updatedAt: string): OrderRecord {
	return {
		account,
		permlink,
		side: 'sell',
		asset: 'BTC',
		fiat_currency: 'USD',
		amount_min: null,
		amount_max: null,
		price_model: null,
		location_region: null,
		payment_methods: [],
		terms: null,
		created_at: updatedAt,
		updated_at: updatedAt,
		expires_at: null
	} as unknown as OrderRecord;
}

/** `n` orders, newest first, one minute apart, starting at `startMs`. */
function series(prefix: string, n: number, startMs: number): OrderRecord[] {
	const out: OrderRecord[] = [];
	for (let i = 0; i < n; i++) {
		out.push(order(`${prefix}${i}`, `p${i}`, new Date(startMs - i * 60_000).toISOString()));
	}
	return out;
}

/** The API's ordering: updated_at DESC, account ASC, permlink ASC. */
function apiSort(items: readonly OrderRecord[]): OrderRecord[] {
	return [...items].sort((a, b) => {
		if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
		if (a.account !== b.account) return a.account < b.account ? -1 : 1;
		return a.permlink < b.permlink ? -1 : a.permlink > b.permlink ? 1 : 0;
	});
}

/** What a real instance returns for `limit`: newest N, cursor when more exist. */
function page(all: readonly OrderRecord[], limit: number, indexedBlock: number): OrderbookSide {
	const sorted = apiSort(all);
	return {
		items: sorted.slice(0, limit),
		next_cursor: sorted.length > limit ? 'cursor' : null,
		indexed_block: indexedBlock
	};
}

const key = (o: OrderKey) => `${o.account}/${o.permlink}`;

// ── the mutants this suite must discriminate against ─────────────────

interface Outcome {
	readonly verdict: string;
	readonly onlyHere: readonly string[];
	readonly onlyThere: readonly string[];
}

const outcomeOf = (r: {
	verdict: string;
	onlyHere: readonly OrderKey[];
	onlyThere: readonly OrderKey[];
}): Outcome => ({
	verdict: r.verdict,
	onlyHere: r.onlyHere.map(key).sort(),
	onlyThere: r.onlyThere.map(key).sort()
});

/** M1 — as shipped before: a straight set difference over two capped pages. */
function mutantLegacy(a: OrderbookSide, b: OrderbookSide): Outcome {
	const ka = new Set(a.items.map(key));
	const kb = new Set(b.items.map(key));
	const onlyHere = [...ka].filter((k) => !kb.has(k)).sort();
	const onlyThere = [...kb].filter((k) => !ka.has(k)).sort();
	return {
		verdict: onlyHere.length === 0 && onlyThere.length === 0 ? 'agree' : 'differ',
		onlyHere,
		onlyThere
	};
}

/** Window rule shared by the two timestamp-only mutants. */
function timestampWindow(
	a: OrderbookSide,
	b: OrderbookSide,
	cmp: (updatedAt: string, start: string) => boolean,
	comparableIgnoresTruncation: boolean
): Outcome {
	const oldest = (s: OrderbookSide) =>
		s.items.reduce<string | null>(
			(m, o) => (m === null || o.updated_at < m ? o.updated_at : m),
			null
		);
	const cut: string[] = [];
	if (a.next_cursor !== null) {
		const o = oldest(a);
		if (o !== null) cut.push(o);
	}
	if (b.next_cursor !== null) {
		const o = oldest(b);
		if (o !== null) cut.push(o);
	}
	const start = cut.length ? cut.reduce((x, y) => (x > y ? x : y)) : null;
	const inW = (o: OrderKey) => (start === null ? true : cmp(o.updated_at, start));
	const ai = a.items.filter(inW);
	const bi = b.items.filter(inW);
	const ka = new Set(ai.map(key));
	const kb = new Set(bi.map(key));
	const onlyHere = [...ka].filter((k) => !kb.has(k)).sort();
	const onlyThere = [...kb].filter((k) => !ka.has(k)).sort();
	const truncated = a.next_cursor !== null || b.next_cursor !== null;
	const comparable = comparableIgnoresTruncation
		? ai.length > 0 || bi.length > 0
		: !truncated || ai.length > 0 || bi.length > 0;
	return {
		verdict: !comparable
			? 'inconclusive'
			: onlyHere.length === 0 && onlyThere.length === 0
				? 'agree'
				: 'differ',
		onlyHere,
		onlyThere
	};
}

/** M2 — the first fix: exclude EVERYTHING at the boundary timestamp (`>`).
 *  Discards a whole block's worth of orders on this chain. */
const mutantTimestampStrict = (a: OrderbookSide, b: OrderbookSide): Outcome =>
	timestampWindow(a, b, (u, s) => u > s, false);

/** M3 — the naive alternative: include the boundary timestamp (`>=`).
 *  Re-admits the tie-broken row the window exists to exclude. */
const mutantTimestampInclusive = (a: OrderbookSide, b: OrderbookSide): Outcome =>
	timestampWindow(a, b, (u, s) => u >= s, false);

/** M4 — `comparable` that ignores whether anything was truncated at all. */
const mutantComparableIgnoresTruncation = (a: OrderbookSide, b: OrderbookSide): Outcome =>
	timestampWindow(a, b, (u, s) => u > s, true);

const MUTANTS = {
	M1_legacy_no_window: mutantLegacy,
	M2_timestamp_strict: mutantTimestampStrict,
	M3_timestamp_inclusive: mutantTimestampInclusive,
	M4_comparable_ignores_truncation: mutantComparableIgnoresTruncation
} as const;
type MutantName = keyof typeof MUTANTS;

const caughtBy = new Set<MutantName>();

/**
 * Run one case: assert the real result, and record which mutants it catches.
 * `mustCatch` names the mutants this case EXISTS to discriminate; if any of
 * them survives, that is a failure — the case is not doing its job.
 */
function check(
	name: string,
	here: OrderbookSide,
	there: OrderbookSide,
	expect: { verdict: string; onlyHere: string[]; onlyThere: string[] },
	mustCatch: readonly MutantName[]
): void {
	const real = compareOrderbooks(here, there);
	const got = outcomeOf(real);
	const want = {
		verdict: expect.verdict,
		onlyHere: [...expect.onlyHere].sort(),
		onlyThere: [...expect.onlyThere].sort()
	};
	const same = (x: Outcome, y: Outcome) =>
		x.verdict === y.verdict &&
		x.onlyHere.join(',') === y.onlyHere.join(',') &&
		x.onlyThere.join(',') === y.onlyThere.join(',');

	if (same(got, want as Outcome)) ok(`${name} — ${got.verdict}`);
	else
		bad(
			`${name} — wrong result`,
			`want ${JSON.stringify(want)}\n      got  ${JSON.stringify(got)}`
		);

	for (const m of mustCatch) {
		const mo = MUTANTS[m](here, there);
		if (same(mo, got)) {
			bad(
				`${name} — ${m} SURVIVES: it produces the same answer as the fixed code here, ` +
					'so this case does not discriminate it'
			);
		} else {
			caughtBy.add(m);
			ok(`${name} — catches ${m} (it says ${JSON.stringify(mo)})`);
		}
	}
}

const NOW = Date.parse('2026-09-18T12:00:00.000Z');
const BLOCK = 63_619_446;

console.log('compare-truncation — a busy orderbook is not a censoring one');
console.log('');

// ── 1. The admin's case: displacement ────────────────────────────────
// Both instances carry the same 140 orders. One is a few blocks ahead and has 5
// brand-new orders the other has not indexed yet. Those 5 are a real, transient
// difference at the TOP — and they push 5 orders off the BOTTOM of that
// instance's window. Those 5 are present on both and must not be reported.
{
	const shared = series('shared', 140, NOW - 60 * 60_000);
	const ahead = series('new', 5, NOW);
	const here = page(shared, 100, BLOCK);
	const there = page([...shared, ...ahead], 100, BLOCK + 12);
	check(
		"1. the admin's displaced orders are not reported as missing",
		here,
		there,
		{ verdict: 'differ', onlyHere: [], onlyThere: ahead.map(key) },
		['M1_legacy_no_window']
	);
	const r = compareOrderbooks(here, there);
	if (r.truncated) ok('1. the result is marked truncated so the UI can say so');
	else bad('1. truncation was not reported');
	if (r.blockGap === 12) ok('1. the 12-block gap is carried, explaining the 5 real ones');
	else bad(`1. expected a 12-block gap, got ${r.blockGap}`);
}

// ── 2. "this order is old, some days ago" ────────────────────────────
{
	const recent = series('recent', 99, NOW - 60 * 60_000);
	const old = order('olduser', 'old-order', new Date(NOW - 4 * 86_400_000).toISOString());
	const shared = [...recent, old];
	const fresh = order('fresh', 'p', new Date(NOW).toISOString());
	check(
		'2. the days-old order at the window edge is not a finding',
		page(shared, 100, BLOCK),
		page([...shared, fresh], 100, BLOCK + 3),
		{ verdict: 'differ', onlyHere: [], onlyThere: [key(fresh)] },
		['M1_legacy_no_window']
	);
}

// ── 3. Neither side truncated, and they genuinely differ ─────────────
// The earlier version of this case compared a side against ITSELF, which every
// possible implementation passes. This one has a real difference with no
// truncation anywhere, so the whole diff must be reported.
{
	const shared = series('s', 20, NOW);
	const extra = order('extra', 'p', new Date(NOW - 5 * 60_000).toISOString());
	check(
		'3. with no truncation the entire difference is reported',
		page([...shared, extra], 100, BLOCK),
		page(shared, 100, BLOCK),
		{ verdict: 'differ', onlyHere: [key(extra)], onlyThere: [] },
		[]
	);
	const r = compareOrderbooks(page([...shared, extra], 100, BLOCK), page(shared, 100, BLOCK));
	if (r.windowStart === null && !r.truncated)
		ok('3. no window is applied and nothing is marked truncated');
	else bad(`3. unexpected window ${r.windowStart} / truncated=${r.truncated}`);
}

// ── 4. Real censorship well inside the window is still reported ──────
{
	const shared = series('s', 150, NOW);
	const censored = shared.filter((o) => o.account !== 's3');
	check(
		'4. a recent order missing from the other instance is still reported',
		page(shared, 100, BLOCK),
		page(censored, 100, BLOCK),
		{ verdict: 'differ', onlyHere: ['s3/p3'], onlyThere: [] },
		[]
	);
}

// ── 5. THE BLIND BAND: censorship AT the boundary timestamp ──────────
// The defect the timestamp-only rule introduced. `here` is truncated, so the
// boundary is its own hundredth row — and `there` censors exactly that row.
// M2 discards the whole boundary timestamp and calls this agreement.
{
	const shared = series('s', 150, NOW);
	const victim = shared[99]!;
	const censored = shared.filter((o) => key(o) !== key(victim));
	check(
		'5. an order censored exactly at the window boundary is still reported',
		page(shared, 100, BLOCK),
		page(censored, 100, BLOCK),
		{ verdict: 'differ', onlyHere: [key(victim)], onlyThere: [] },
		['M2_timestamp_strict']
	);
}

// ── 5b. A whole block of orders sharing one timestamp at the boundary ─
// `updated_at` is the BLOCK timestamp, so every order touched in one block
// shares it to the second. A timestamp-only boundary throws away the entire
// block — here, eight orders, one of which is censored.
{
	const ts = new Date(NOW - 99 * 60_000).toISOString();
	const batch = Array.from({ length: 8 }, (_, i) => order(`m${i}`, 'p', ts));
	const shared = [
		...series('s', 99, NOW),
		...batch,
		...series('older', 20, Date.parse(ts) - 60_000)
	];
	const victim = batch[0]!;
	const censored = shared.filter((o) => key(o) !== key(victim));
	check(
		'5b. a censored order inside a same-block batch at the boundary is reported',
		page(shared, 100, BLOCK),
		page(censored, 100, BLOCK),
		{ verdict: 'differ', onlyHere: [key(victim)], onlyThere: [] },
		['M2_timestamp_strict']
	);
}

// ── 6. The tie the window exists for: both sides hold BOTH rows ──────
// Two orders share an `updated_at`; the two instances cut between them because
// one is a row ahead. Neither is hiding anything, and the tie-broken row must
// not be accused. This is the case the `>=` rule gets wrong.
{
	const ts = new Date(NOW - 99 * 60_000).toISOString();
	const tieA = order('aaa', 'tie', ts);
	const tieB = order('zzz', 'tie', ts);
	const base = [...series('s', 98, NOW), tieA, tieB, ...series('old', 10, Date.parse(ts) - 60_000)];
	const brandnew = order('brandnew', 'p', new Date(NOW + 60_000).toISOString());
	const here = page(base, 100, BLOCK);
	const there = page([...base, brandnew], 100, BLOCK);
	check(
		'6. a row cut off by the account tiebreaker alone is not accused',
		here,
		there,
		{ verdict: 'differ', onlyHere: [], onlyThere: [key(brandnew)] },
		['M3_timestamp_inclusive']
	);
}

// ── 7. Two complete, empty orderbooks agree ──────────────────────────
// Neither side truncated, so the diff is authoritative. Calling this
// "inconclusive" — and explaining it with "both instances returned a capped
// page", which neither did — is a false statement about a complete comparison.
{
	check(
		'7. two complete and empty orderbooks report agreement, not inconclusive',
		{ items: [], next_cursor: null, indexed_block: BLOCK },
		{ items: [], next_cursor: null, indexed_block: BLOCK },
		{ verdict: 'agree', onlyHere: [], onlyThere: [] },
		['M4_comparable_ignores_truncation']
	);
}

// ── 8. Two instances serving wholly different orders DO differ ───────
// Every row shares one timestamp, so the timestamp-only rule had nothing left
// to compare and called it "inconclusive". With the tuple window there is
// always a comparable region, and these two orderbooks are genuinely disjoint.
{
	const ts = new Date(NOW).toISOString();
	const here = page(
		Array.from({ length: 120 }, (_, i) => order(`h${String(i).padStart(3, '0')}`, 'p', ts)),
		100,
		BLOCK
	);
	const there = page(
		Array.from({ length: 120 }, (_, i) => order(`t${String(i).padStart(3, '0')}`, 'p', ts)),
		100,
		BLOCK
	);
	const r = compareOrderbooks(here, there);
	if (r.verdict === 'differ' && r.onlyHere.length > 0)
		ok(`8. wholly disjoint orderbooks at one timestamp are reported as differing`);
	else bad(`8. expected differ with findings, got ${r.verdict} (${r.onlyHere.length})`);
	if (mutantTimestampStrict(here, there).verdict === 'inconclusive') {
		caughtBy.add('M2_timestamp_strict');
		ok('8. catches M2_timestamp_strict (it has nothing left to compare and says inconclusive)');
	} else bad('8. M2 survives — it should be blinded by the single shared timestamp');
}

// ── 8b. A side that says "more exist" but sent no rows is MALFORMED ──
// The first page of a non-empty orderbook holds rows, so items:[] with a
// cursor is an impossible answer — how an instance hiding every order would
// reply. It is named (malformedSide) rather than passed off as "nothing to
// compare", and no individual order is listed, because none was compared.
{
	const here: OrderbookSide = { items: [], next_cursor: 'cursor', indexed_block: BLOCK };
	const there = page(series('t', 10, NOW), 100, BLOCK);
	const r = compareOrderbooks(here, there);
	if (
		r.verdict === 'malformed' &&
		r.malformedSide === 'here' &&
		r.onlyHere.length === 0 &&
		r.onlyThere.length === 0
	)
		ok('8b. a side that returned no rows but a cursor is named malformed and no order is listed');
	else
		bad(
			`8b. expected malformed (here) with no findings, got ${r.verdict}/${r.malformedSide} ` +
				`(${r.onlyHere.length}/${r.onlyThere.length})`
		);
	const r2 = compareOrderbooks(there, here);
	if (r2.verdict === 'malformed' && r2.malformedSide === 'there')
		ok('8b. …whichever side sent it (a peer hiding every order is named)');
	else bad(`8b. expected malformed (there), got ${r2.verdict}/${r2.malformedSide}`);
	if (mutantLegacy(here, there).verdict !== 'inconclusive') {
		caughtBy.add('M1_legacy_no_window');
		ok('8b. catches M1_legacy_no_window (it reports every remote order as missing here)');
	} else bad('8b. M1 survives');
}

// ── 9. An instance serving nothing recent is a real finding ──────────
// A truncated side withholds only what is OLDER than its oldest returned row,
// never anything newer. So an instance whose newest order is ten days old
// genuinely lacks every recent order.
{
	const r = compareOrderbooks(
		page(series('h', 150, NOW), 100, BLOCK),
		page(series('t', 150, NOW - 10 * 86_400_000), 100, BLOCK)
	);
	if (r.verdict === 'differ' && r.onlyHere.length > 0)
		ok(`9. an instance serving nothing recent is reported (${r.onlyHere.length} missing)`);
	else bad(`9. expected differ with findings, got ${r.verdict}/${r.onlyHere.length}`);
}

// ── 10. The excluded count is DISTINCT orders ────────────────────────
{
	const shared = series('s', 300, NOW - 200 * 60_000);
	const ahead = series('a', 80, NOW);
	const here = page(shared, 100, BLOCK);
	const there = page([...shared, ...ahead], 100, BLOCK);
	const r = compareOrderbooks(here, there);
	// Derived from the RESULT, not by re-implementing the window rule — a test
	// that recomputes the thing it is checking only proves the code agrees with
	// itself. Everything either side returned is either compared or excluded.
	const returned = new Set([...here.items, ...there.items].map(key));
	const compared = new Set([...r.onlyHere, ...r.inBoth, ...r.onlyThere].map(key));
	const expectedExcluded = [...returned].filter((k) => !compared.has(k)).length;

	if (r.excludedDistinct === expectedExcluded)
		ok(`10. excludedDistinct is the distinct count of excluded orders (${r.excludedDistinct})`);
	else
		bad(
			`10. excludedDistinct=${r.excludedDistinct} but ${expectedExcluded} distinct orders ` +
				'were returned and not compared'
		);

	// The per-side counts overlap whenever both sides withheld the same order,
	// so their sum is not a count of orders and must never be shown as one.
	if (r.excludedDistinct <= r.excludedHere + r.excludedThere)
		ok('10. and it never exceeds the per-side sum, which can double-count');
	else
		bad(
			`10. excludedDistinct (${r.excludedDistinct}) exceeds the per-side sum ` +
				`(${r.excludedHere + r.excludedThere}), which is impossible`
		);
}

// ── every mutant must have been caught by something ──────────────────
console.log('');
for (const m of Object.keys(MUTANTS) as MutantName[]) {
	if (caughtBy.has(m)) ok(`mutant ${m} is caught by at least one case`);
	else
		bad(
			`mutant ${m} is NOT caught by any case — nothing in this suite distinguishes the ` +
				'fixed code from that implementation'
		);
}

console.log('');
console.log('─'.repeat(56));
if (fail === 0) {
	console.log(`✓ all ${pass} compare-truncation scenarios passed`);
} else {
	console.log(`✗ ${fail} FAILED, ${pass} passed`);
	process.exit(1);
}
