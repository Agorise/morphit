#!/usr/bin/env tsx
/**
 * apps/web/scripts/order-title-crypto-ticker-smoke.ts  (cp615, Ken)
 *
 * Ken's two screenshots: he LIKES a barter order's title listing accepted
 * cryptos by TICKER ("… for BCH, BTC, ETH, or SOL"), and DISLIKES a crypto
 * order's title listing its payment rails by FULL NAME ("… for Litecoin (LTC),
 * Dogecoin (DOGE), …") — which also ran to three lines and bled right up to the
 * Message button. This pins both halves of the fix so no layer regresses:
 *
 *   PART 1 (runtime — the shared title builder orderTitle.ts):
 *     • a crypto order's payment rails render as TICKERS in the title (matching
 *       the barter path): "…for LTC, DOGE, …", never "…for Litecoin (LTC), …"
 *     • a FIAT rail (Cash in person) keeps its full name in the title, and a
 *       crypto rail beside it is still a ticker
 *     • the BARTER path is untouched (accepted tickers verbatim)
 *     • tickers are never translated (same in a non-English locale)
 *     • the "I accept:" detail line (displayNamesForMethods) is UNTOUCHED — it
 *       still spells rails out in full, proving only the title changed
 *
 *   PART 2 (static — OrderCard.svelte, comments stripped):
 *     • the title <h3> clamps to 2 lines on mobile / 1 line on desktop
 *       (ellipsised), and reserves enough desktop right-pad to clear the
 *       top-right cluster — NOT the old sm:line-clamp-none / line-clamp-3 /
 *       sm:pr-28 that let a long title bleed into the Message button.
 *
 * Source greps strip comments first, so this fix's own comments can't satisfy
 * (or trip) the static checks.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orderTitleParts, type OrderTitleInput } from '../src/lib/utils/orderTitle';
import { displayNamesForMethods } from '../src/lib/payments/display';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  \u2713 ${m}`);
};
const bad = (m: string, d = '') => {
	fail++;
	console.log(`  \u2717 ${m}`);
	if (d) console.log(`      ${d}`);
};

/** Strip // line comments, block comments, and HTML/Svelte comments so a grep
 *  sees only live code — a fix's comment necessarily names the pattern it added. */
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const settlementOf = (o: OrderTitleInput, goodsLabel?: string, locale = 'en'): string =>
	String(
		(orderTitleParts(o, (n) => String(n), goodsLabel, { locale }).values as Record<string, unknown>)
			.settlement
	);

// ── PART 1: crypto rails render as tickers in the title ───────────────
{
	const s = settlementOf({
		side: 'sell',
		asset: 'BLURT',
		fiat_currency: 'USD',
		amount_min: 5,
		amount_max: 25,
		payment_methods: ['pay_ltc', 'pay_doge', 'pay_usdt', 'pay_dai', 'pay_bch', 'pay_dash', 'pay_xrp', 'pay_sol']
	});
	const expected = 'LTC, DOGE, USDT, DAI, BCH, DASH, XRP, or SOL';
	if (s === expected) ok(`crypto order title lists rails as tickers: "${s}"`);
	else bad('crypto order title should list rails as tickers', `got "${s}" want "${expected}"`);
	if (!/Litecoin|Dogecoin|\(LTC\)|\(DOGE\)/.test(s))
		ok('crypto order title carries no full rail names / parenthesised tickers');
	else bad('crypto order title leaked a full rail name', s);
}
{
	const s = settlementOf({
		side: 'sell',
		asset: 'BTC',
		fiat_currency: 'USD',
		amount_min: 100,
		amount_max: null,
		payment_methods: ['pay_ltc', 'pay_xmr']
	});
	if (s === 'LTC or XMR') ok(`crypto-for-crypto title: "${s}"`);
	else bad('crypto-for-crypto title should be "LTC or XMR"', s);
}

// ── Fiat rail keeps its name; crypto rail beside it stays a ticker ────
{
	const s = settlementOf({
		side: 'sell',
		asset: 'BLURT',
		fiat_currency: 'USD',
		amount_min: 10,
		amount_max: null,
		payment_methods: ['cash_in_person', 'pay_btc']
	});
	if (/Cash \(in person\)/.test(s)) ok(`fiat rail keeps its full name in the title: "${s}"`);
	else bad('fiat rail should keep its full name in the title', s);
	if (/\bBTC\b/.test(s) && !/Bitcoin \(BTC\)/.test(s))
		ok('crypto rail beside a fiat rail still renders as a ticker');
	else bad('crypto rail beside a fiat rail should render as a ticker', s);
}

// ── Barter path unchanged (accepted tickers verbatim) ────────────────
{
	const s = settlementOf(
		{
			side: 'sell',
			asset: 'BARTER',
			fiat_currency: 'USD',
			amount_min: null,
			amount_max: null,
			accepted_assets: ['BTC', 'XMR']
		},
		'bananas'
	);
	if (s === 'BTC or XMR') ok(`barter title still lists accepted tickers verbatim: "${s}"`);
	else bad('barter title should list accepted tickers verbatim', s);
}

// ── Tickers are never translated (locale only changes the joiner) ────
{
	const es = settlementOf({
		side: 'sell',
		asset: 'BLURT',
		fiat_currency: 'USD',
		amount_min: 5,
		amount_max: null,
		payment_methods: ['pay_ltc', 'pay_doge', 'pay_sol']
	}, undefined, 'es');
	if (/\bLTC\b/.test(es) && /\bDOGE\b/.test(es) && /\bSOL\b/.test(es))
		ok(`tickers stay identical in a non-English locale: "${es}"`);
	else bad('tickers must never be translated across locales', es);
}

// ── "I accept:" detail line unchanged (still full names) ─────────────
{
	const names = displayNamesForMethods(['pay_ltc', 'pay_doge']);
	if (names.join(', ') === 'Litecoin (LTC), Dogecoin (DOGE)')
		ok('"I accept:" line still spells rails out in full — only the title changed');
	else bad('"I accept:" line should be unchanged (full names)', names.join(', '));
}

// ── PART 2: OrderCard title clamp + right-pad (static) ───────────────
{
	const card = stripComments(readFileSync(resolve(WEB, 'src/lib/components/OrderCard.svelte'), 'utf8'));
	const m = card.match(/<h3\s+class="([^"]*line-clamp[^"]*)"/);
	const cls = m ? m[1] : '';
	if (!cls) {
		bad('could not find the title <h3> class in OrderCard.svelte');
	} else {
		if (/\bline-clamp-2\b/.test(cls)) ok('title clamps to 2 lines on mobile (line-clamp-2)');
		else bad('title should clamp to 2 lines on mobile (line-clamp-2)', cls);

		if (/\bsm:line-clamp-1\b/.test(cls))
			ok('title clamps to 1 line on desktop (sm:line-clamp-1, auto-ellipsised)');
		else bad('title should clamp to 1 line on desktop (sm:line-clamp-1)', cls);

		if (!/sm:line-clamp-none|\bline-clamp-3\b/.test(cls))
			ok('old unclamped-desktop / 3-line-mobile classes are gone');
		else bad('old sm:line-clamp-none / line-clamp-3 still present', cls);

		// Desktop pad clears the top-right EXPIRY CHIP — the single title line
		// sits at the chip row; the Message button is lower, over the identity,
		// so the title need only clear the chip. The chip is COMPACT in LTR
		// ("Expires in 82d") but a whole phrase in RTL ("…روز دیگر منقضی می‌شود"),
		// so the two directions carry different pads, each mirrored to the
		// correct side (cp620). LTR pads the RIGHT; a sane window [8rem,11rem]
		// clears the compact chip without the old dead space (the retired
		// sm:pr-[13rem] was sized for the button, not the chip). RTL pads the
		// LEFT and must be wide enough (≥12rem) for the verbose phrase.
		const ltrStep = cls.match(/sm:ltr:pr-(\d+)\b/);
		const ltrRem = ltrStep ? parseInt(ltrStep[1], 10) / 4 : NaN;
		if (ltrStep && ltrRem >= 8 && ltrRem <= 11)
			ok(`LTR title pads the right just enough to clear the compact chip (sm:ltr:pr-${ltrStep[1]} = ${ltrRem}rem)`);
		else bad('LTR title should pad the RIGHT in [8rem,11rem] — clears the compact chip without dead space', cls);

		const rtlArb = cls.match(/sm:rtl:pl-\[(\d+(?:\.\d+)?)rem\]/);
		const rtlStep = cls.match(/sm:rtl:pl-(\d+)\b/);
		const rtlRem = rtlArb ? parseFloat(rtlArb[1]) : rtlStep ? parseInt(rtlStep[1], 10) / 4 : NaN;
		if (rtlRem >= 12)
			ok(`RTL title mirrors the pad to the LEFT, wide enough for the verbose phrase (${rtlArb ? rtlArb[0] : rtlStep?.[0]} = ${rtlRem}rem)`);
		else bad('RTL title should pad the LEFT ≥12rem for the verbose expiry phrase', cls);

		// The old symmetric physical pad must be gone (it did not mirror for RTL).
		if (!/\bsm:pr-\[13rem\]\b/.test(cls) && !/\bsm:pr-28\b/.test(cls))
			ok('retired symmetric sm:pr-[13rem] / sm:pr-28 physical pad is gone');
		else bad('old physical sm:pr-[13rem] / sm:pr-28 still present (should be ltr:/rtl: mirrored)', cls);
	}
}

console.log('');
console.log('\u2500'.repeat(56));
if (fail === 0) {
	console.log(`\u2713 all ${pass} order-title-crypto-ticker scenarios passed`);
} else {
	console.log(`\u2717 ${fail} FAILED, ${pass} passed`);
	process.exit(1);
}
