#!/usr/bin/env tsx
/**
 * apps/web/scripts/barter-specific-title-smoke.ts  (v1.9.0, Ken)
 *
 * The BARTER "goods/services" text in the create-order summary became an inline
 * fill-in-the-blank: the user types WHAT they're offering (e.g. "bananas") and it
 * flows into the order title + the on-chain Blurt announcement. This pins the whole
 * chain so no layer can silently drop it:
 *   - sanitizeBarterTitle: letters-only, ≤24 code points (accented/non-Latin kept)
 *   - buildOrderPayload: includes specific_barter_title only when it survives
 *   - all 10 locales: the 4 barter summary templates carry a {goods} slot (not the
 *     literal goods phrase), and order_title.goods_services still exists (the input
 *     placeholder reuses it)
 *   - indexer order.ts / orderReplace.ts: STRICT validation (reject, don't truncate)
 *   - OrderRecord + the API read paths + the DB migration carry the column
 *   - every order-title caller passes the label so barter reads "…of bananas"
 *   - the create form actually renders the inline input
 *
 * Source greps strip comments first, so a fix's own comment naming a pattern can't
 * satisfy (or trip) the check.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	sanitizeBarterTitle,
	SPECIFIC_BARTER_TITLE_MAX,
	buildOrderPayload,
	type OrderFormInput
} from '../src/lib/orders/payload';
import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');
const ROOT = resolve(WEB, '..', '..');
const LOCALES = resolve(WEB, 'src', 'lib', 'i18n', 'locales');

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

const read = (p: string) => readFileSync(p, 'utf8');
/** Strip // line comments, block comments, and HTML/Svelte comments so a grep
 *  sees only live code — a fix's comment necessarily names the pattern it added. */
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const LOCS = SUPPORTED_LOCALES.map((l) => l.code);

// ── 1. sanitizeBarterTitle ───────────────────────────────────────────
{
	if (SPECIFIC_BARTER_TITLE_MAX === 24) ok('max length is 24');
	else bad('max length is 24', String(SPECIFIC_BARTER_TITLE_MAX));

	if (sanitizeBarterTitle('bananas') === 'bananas') ok('plain letters pass through');
	else bad('plain letters pass through');

	if (sanitizeBarterTitle('ban4n2s!! 99') === 'banns') ok('digits/punctuation/space stripped');
	else bad('digits/punctuation/space stripped', sanitizeBarterTitle('ban4n2s!! 99'));

	if (sanitizeBarterTitle('goods/services') === 'goodsservices') ok('slash stripped (not a letter)');
	else bad('slash stripped', sanitizeBarterTitle('goods/services'));

	if (sanitizeBarterTitle('plátanosбананы香蕉') === 'plátanosбананы香蕉')
		ok('accented + non-Latin letters kept');
	else bad('accented + non-Latin letters kept', sanitizeBarterTitle('plátanosбананы香蕉'));

	const long = 'a'.repeat(40);
	if (sanitizeBarterTitle(long).length === 24) ok('truncates to 24 code points');
	else bad('truncates to 24', String(sanitizeBarterTitle(long).length));

	// astral letters count as ONE code point (Array.from, not UTF-16 units)
	const astral = '𝔞'.repeat(30); // each is a 2-unit surrogate pair
	if (Array.from(sanitizeBarterTitle(astral)).length === 24)
		ok('astral letters counted by code point');
	else bad('astral letters counted by code point', String(Array.from(sanitizeBarterTitle(astral)).length));

	if (sanitizeBarterTitle('') === '' && sanitizeBarterTitle(null) === '' && sanitizeBarterTitle(undefined) === '')
		ok('empty/null/undefined → empty');
	else bad('empty/null/undefined → empty');
}

// ── 2. buildOrderPayload wiring ──────────────────────────────────────
{
	const base: OrderFormInput = {
		side: 'sell',
		asset: 'BARTER' as OrderFormInput['asset'],
		fiatCurrency: 'mxn',
		amountMin: 100,
		amountMax: null,
		priceModel: { kind: 'fixed', price: 1 },
		locationRegion: null,
		paymentMethods: ['pay_xmr'],
		terms: 'come to my farm',
		expiresAt: new Date('2026-10-22T00:00:00Z'),
		acceptedAssets: ['XMR'] as OrderFormInput['acceptedAssets']
	};

	const withTitle = buildOrderPayload('order-x', { ...base, specificBarterTitle: 'bananas99!!' });
	if (withTitle.specific_barter_title === 'bananas') ok('payload carries sanitized title');
	else bad('payload carries sanitized title', String(withTitle.specific_barter_title));

	const blank = buildOrderPayload('order-x', { ...base, specificBarterTitle: '  99 !! ' });
	if (!('specific_barter_title' in blank)) ok('blank-after-sanitize title omitted from payload');
	else bad('blank title omitted', JSON.stringify(blank.specific_barter_title));

	const none = buildOrderPayload('order-x', base);
	if (!('specific_barter_title' in none)) ok('no title → field omitted');
	else bad('no title → omitted');
}

// ── 3. locale templates: {goods} slot in all 10 ─────────────────────
{
	const KEYS = [
		'barter_sentence_sell',
		'barter_sentence_buy',
		'barter_sentence_sell_novalue',
		'barter_sentence_buy_novalue'
	];
	let allGoods = true;
	let placeholderOk = true;
	for (const loc of LOCS) {
		const d = JSON.parse(read(resolve(LOCALES, `${loc}.json`)));
		const s = d.post_order?.summary ?? {};
		const gs = d.order_title?.goods_services;
		if (typeof gs !== 'string' || gs.length === 0) placeholderOk = false;
		for (const k of KEYS) {
			const v = s[k];
			if (typeof v !== 'string' || !v.includes('{goods}')) {
				allGoods = false;
				bad(`${loc}.${k} has {goods} slot`, JSON.stringify(v));
			}
			// the generic phrase must no longer be baked into the template (it's the
			// input's placeholder now); only the slot remains.
			if (typeof v === 'string' && typeof gs === 'string' && v.includes(gs)) {
				allGoods = false;
				bad(`${loc}.${k} no longer bakes the literal goods phrase`, JSON.stringify(v));
			}
		}
	}
	if (allGoods) ok('all 10 locales: 4 barter templates carry the {goods} slot, phrase removed');
	if (placeholderOk) ok('order_title.goods_services present in all 10 (input placeholder)');
	else bad('order_title.goods_services present in all 10');
}

// ── 4. indexer STRICT validation (order.ts + orderReplace.ts) ────────
for (const rel of [
	'apps/indexer/src/indexer/handlers/order.ts',
	'apps/indexer/src/indexer/handlers/orderReplace.ts'
]) {
	const src = stripComments(read(resolve(ROOT, rel)));
	const tag = rel.includes('Replace') ? 'orderReplace.ts' : 'order.ts';
	const checks: Array<[string, boolean]> = [
		['not_permitted_for_asset reason', src.includes('specific_barter_title_not_permitted_for_asset')],
		['too_long reason', src.includes('specific_barter_title_too_long')],
		['forbidden_char reason', src.includes('specific_barter_title_forbidden_char')],
		// STRICT: counts code points, rejects >24 (never truncates)
		['code-point length guard', /Array\.from\(normalized\)\.length > 24/.test(src)],
		// letters-only reject
		['letters-only guard', /\[\^\\p\{L\}\]/.test(src)]
	];
	for (const [n, okp] of checks) okp ? ok(`${tag}: ${n}`) : bad(`${tag}: ${n}`);
}

// ── 5. OrderRecord + API read paths carry the column ────────────────
{
	const rec = stripComments(read(resolve(ROOT, 'packages/indexer-client/src/index.ts')));
	if (/specific_barter_title\??: (readonly )?string/.test(rec)) ok('OrderRecord has specific_barter_title');
	else bad('OrderRecord has specific_barter_title');

	for (const rel of [
		'apps/indexer/src/api/orders.ts',
		'apps/indexer/src/api/orderbook.ts',
		'apps/indexer/src/api/featuredOrderbook.ts'
	]) {
		const src = stripComments(read(resolve(ROOT, rel)));
		const name = rel.split('/').pop();
		const selected = /o\.specific_barter_title/.test(src) || /specific_barter_title,/.test(src);
		const mapped = /specific_barter_title:\s*r\.specific_barter_title/.test(src);
		selected && mapped
			? ok(`${name}: SELECTs + maps specific_barter_title`)
			: bad(`${name}: SELECTs + maps specific_barter_title`, `select=${selected} map=${mapped}`);
	}
	// The SSE stream splits its SELECT (orderbookStream.ts) from its row→record
	// mapping (orderbookStreamHelpers.ts) — check each in its own file.
	{
		const sel = stripComments(read(resolve(ROOT, 'apps/indexer/src/api/orderbookStream.ts')));
		const map = stripComments(read(resolve(ROOT, 'apps/indexer/src/api/orderbookStreamHelpers.ts')));
		const selected = /o\.specific_barter_title/.test(sel);
		const mapped = /specific_barter_title:\s*r\.specific_barter_title/.test(map);
		selected && mapped
			? ok('orderbookStream(+Helpers): SELECTs + maps specific_barter_title')
			: bad('orderbookStream(+Helpers): SELECTs + maps', `select=${selected} map=${mapped}`);
	}
}

// ── 6. DB migration v52 ─────────────────────────────────────────────
{
	const mig = read(resolve(ROOT, 'apps/indexer/src/db/migrations.ts'));
	const has52 = /version:\s*52/.test(mig) && /specific_barter_title/.test(mig);
	has52 ? ok('migration v52 adds orders.specific_barter_title') : bad('migration v52 present');
	const schema = read(resolve(ROOT, 'apps/indexer/src/db/schema.sql'));
	/specific_barter_title TEXT/.test(schema)
		? ok('schema.sql carries the column for fresh installs')
		: bad('schema.sql carries the column');
}

// ── 7. every order-title caller passes the goods label ──────────────
{
	const callers: Array<[string, RegExp]> = [
		['orderbook/+page.svelte', /o\.specific_barter_title \|\|/],
		['my/orders/+page.svelte', /o\.specific_barter_title \|\|/],
		['[permlink]/+page.svelte', /order\.specific_barter_title \|\|/],
		['FeaturedOrders.svelte', /o\.specific_barter_title \|\|/],
		['ConversationView.svelte', /orderRecord\.specific_barter_title \|\|/],
		['syndication/publish.ts', /ctx\.specificBarterTitle \|\|/]
	];
	const paths: Record<string, string> = {
		'orderbook/+page.svelte': 'apps/web/src/routes/[lang]/orderbook/+page.svelte',
		'my/orders/+page.svelte': 'apps/web/src/routes/[lang]/my/orders/+page.svelte',
		'[permlink]/+page.svelte':
			'apps/web/src/routes/[lang]/[x+40][account=account]/[permlink=permlink]/+page.svelte',
		'FeaturedOrders.svelte': 'apps/web/src/lib/components/FeaturedOrders.svelte',
		'ConversationView.svelte': 'apps/web/src/lib/components/ConversationView.svelte',
		'syndication/publish.ts': 'apps/web/src/lib/syndication/publish.ts'
	};
	for (const [name, re] of callers) {
		const src = stripComments(read(resolve(ROOT, paths[name])));
		re.test(src) ? ok(`${name}: passes the goods label`) : bad(`${name}: passes the goods label`);
	}
}

// ── 8. create form renders the inline input ─────────────────────────
{
	const src = stripComments(read(resolve(WEB, 'src', 'routes', '[lang]', 'post', '+page.svelte')));
	const hasField = /barter-goods-field/.test(src);
	const bound = /bind:value=\{specificBarterTitle\}/.test(src);
	const capped = /maxlength=\{SPECIFIC_BARTER_TITLE_MAX\}/.test(src);
	const sanitized = /sanitizeBarterTitle\(/.test(src);
	const parts = /barterSentenceParts/.test(src);
	hasField && bound && capped && sanitized && parts
		? ok('create form: inline input bound, capped, sanitized, slotted')
		: bad('create form inline input', `field=${hasField} bound=${bound} cap=${capped} san=${sanitized} parts=${parts}`);
	// the CSS makes it mobile-safe: max-width so the tail wraps, not overflows
	if (/max-width:\s*100%/.test(read(resolve(WEB, 'src', 'routes', '[lang]', 'post', '+page.svelte'))))
		ok('inline field is width-capped (mobile tail wraps)');
	else bad('inline field width-capped for mobile');
}

console.log('\n' + '\u2500'.repeat(56));
if (fail > 0) {
	console.log(`\u2717 barter-specific-title smoke FAILED (${fail} failing)`);
	process.exit(1);
}
console.log('\u2713 specific_barter_title: sanitizer, payload, 10 locales, indexer, API, migration, titles, form');
console.log(`\u2713 all ${pass} barter-specific-title scenarios passed`);
