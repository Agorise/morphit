#!/usr/bin/env tsx
/**
 * apps/web/scripts/rtl-bidi-smoke.ts  (Ken — RTL)
 *
 * Farsi (fa) is Morphit's one right-to-left locale. Two failure modes were
 * showing up as "an absolute mess" on the Farsi UI:
 *   (1) USER-TYPED content (order terms, an operator's instance title/tagline,
 *       display names, locations, chat messages) rendered without per-content
 *       direction detection, so a Farsi order read on an English UI — or an
 *       English order read on the Farsi UI — mangled its bidi ordering.
 *   (2) The templated ORDER TITLE embeds LTR tokens (the fiat amount range, the
 *       asset/currency ticker, the settlement rails) inside a Farsi sentence;
 *       without isolation the bidi algorithm reshuffled them ("10 تا 100"
 *       flipping, "(XMR)" jumping).
 * And the prerendered pages shipped a static `lang="en" dir="ltr"`, so a no-JS
 * Farsi visitor (and crawlers/screen readers) got LTR + the wrong language.
 *
 * This pins all three layers:
 *   A. DIRECTION SOURCE OF TRUTH — `isRtlLocale` in locales.ts (fa/ar rtl).
 *   B. ORDER-TITLE ISOLATION (runtime) — fa values carry bidi isolates, en
 *      values stay byte-clean (so the exact-match title smokes keep passing),
 *      and the settlement's localized connector stays in the RTL flow.
 *   C. `<html lang>/<dir>` at prerender (hooks.server.ts) + client (hooks.client)
 *      + the `?lang=` inline script (app.html).
 *   D. `dir="auto"` / `<bdi>` on every user-typed surface.
 *
 * Source greps strip comments first, so a fix's own comment can't satisfy them.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orderTitleParts } from '../src/lib/utils/orderTitle';
import { isRtlLocale, SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

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

function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const read = (p: string) => readFileSync(resolve(WEB, p), 'utf8');
const live = (p: string) => stripComments(read(p));

const FSI = '\u2068';
const PDI = '\u2069';
const hasIsolate = (s: unknown) => typeof s === 'string' && (s.includes(FSI) || s.includes(PDI));

// ── A. Direction source of truth ─────────────────────────────────────
{
	if (isRtlLocale('fa') === true) ok('isRtlLocale("fa") is true');
	else bad('isRtlLocale("fa") should be true');
	if (isRtlLocale('en') === false && isRtlLocale('es') === false)
		ok('isRtlLocale is false for LTR locales (en, es)');
	else bad('isRtlLocale should be false for en/es');
	if (isRtlLocale('fa-IR') === true) ok('isRtlLocale tolerates a region subtag (fa-IR)');
	else bad('isRtlLocale should tolerate fa-IR');
	if (isRtlLocale('ar') === true) ok('isRtlLocale("ar") is true (planned RTL locale)');
	else bad('isRtlLocale("ar") should be true');
	if (isRtlLocale(null) === false && isRtlLocale(undefined) === false)
		ok('isRtlLocale is false for null/undefined');
	else bad('isRtlLocale should be false for null/undefined');
	const fa = SUPPORTED_LOCALES.find((l) => l.code === 'fa');
	if (fa && fa.rtl === true) ok('SUPPORTED_LOCALES fa entry carries rtl:true');
	else bad('SUPPORTED_LOCALES fa entry should have rtl:true');
}

// ── B. Order-title token isolation (runtime) ─────────────────────────
{
	const order = {
		side: 'sell',
		asset: 'BLURT',
		fiat_currency: 'USD',
		amount_min: 10,
		amount_max: 100,
		payment_methods: ['pay_ltc', 'pay_doge', 'pay_sol']
	} as const;

	const en = orderTitleParts(order, (n) => String(n), undefined, { locale: 'en' });
	const enLeak = Object.values(en.values).some(hasIsolate);
	if (!enLeak) ok('LTR (en) title values are byte-clean — no bidi isolates');
	else bad('en title values must NOT carry isolates (would break exact-match smokes)', JSON.stringify(en.values));

	const fa = orderTitleParts(order, (n) => String(n), undefined, { locale: 'fa' });
	const v = fa.values as Record<string, string>;
	if (hasIsolate(v.min) && hasIsolate(v.max) && hasIsolate(v.fiat) && hasIsolate(v.asset))
		ok('RTL (fa) isolates the amount range, fiat and asset tokens');
	else bad('fa should isolate min/max/fiat/asset', JSON.stringify(v));

	// Each settlement rail isolated, but the localized connector ("یا") stays
	// OUTSIDE the isolates (in the sentence's RTL flow).
	if (v.settlement.includes(`${FSI}LTC${PDI}`) && v.settlement.includes(`${FSI}SOL${PDI}`))
		ok('fa isolates each settlement rail (LTC…, SOL…)');
	else bad('fa should isolate each settlement rail', v.settlement);
	if (v.settlement.includes('یا') && !v.settlement.includes(`${FSI}یا`))
		ok('fa settlement connector ("یا") stays in the RTL flow, not isolated');
	else bad('fa settlement connector should stay outside the isolates', v.settlement);

	// A Farsi user's barter goods label is isolated as a unit.
	const faBarter = orderTitleParts(
		{ side: 'sell', asset: 'BARTER', fiat_currency: 'USD', amount_min: null, amount_max: null, accepted_assets: ['BTC', 'XMR'] },
		(n) => String(n),
		'درختان موز',
		{ locale: 'fa' }
	);
	if (hasIsolate((faBarter.values as Record<string, string>).asset))
		ok('fa isolates a user-typed barter goods label');
	else bad('fa should isolate the barter goods label', JSON.stringify(faBarter.values));
}

// ── C. html lang/dir: prerender hook + client hook + inline script ───
{
	const server = live('src/hooks.server.ts');
	if (/lang="en" dir="ltr"/.test(server) && /transformPageChunk/.test(server))
		ok('hooks.server.ts rewrites the <html> lang/dir at prerender via transformPageChunk');
	else bad('hooks.server.ts should transform the <html> lang/dir');
	if (/isRtlLocale/.test(server)) ok('hooks.server.ts derives dir from isRtlLocale (source of truth)');
	else bad('hooks.server.ts should use isRtlLocale');
	if (/SUPPORTED_LOCALES\.some/.test(server) || /SUPPORTED_LOCALES\.find/.test(server))
		ok('hooks.server.ts only treats an EXACT supported prefix as a locale');
	else bad('hooks.server.ts should exact-match the locale prefix');

	const appHtml = read('src/app.html');
	if (/<html lang="en" dir="ltr"/.test(appHtml))
		ok('app.html carries the lang="en" dir="ltr" default the hook targets');
	else bad('app.html should carry <html lang="en" dir="ltr"> (the hook replace target)');
	const appLive = stripComments(appHtml);
	if (/documentElement\.dir\s*=/.test(appLive) && /'rtl'/.test(appLive))
		ok('app.html ?lang= inline script sets dir=rtl for the fallback SPA case');
	else bad('app.html inline script should set dir for the ?lang= case');

	const client = live('src/hooks.client.ts');
	if (/documentElement\.dir\s*=/.test(client) && /rtl/.test(client))
		ok('hooks.client.ts sets <html dir> on in-app locale change');
	else bad('hooks.client.ts should set <html dir> client-side');
}

// ── D. dir="auto" / <bdi> on user-typed surfaces ─────────────────────
{
	const card = live('src/lib/components/OrderCard.svelte');
	if (/<bdi>\{order\.location_region\}<\/bdi>/.test(card)) ok('OrderCard isolates the location value (<bdi>)');
	else bad('OrderCard location should be wrapped in <bdi>');
	if (/dir="auto"[^>]*truncate|truncate[^>]*dir="auto"/.test(card) || (card.match(/dir="auto"/g)?.length ?? 0) >= 2)
		ok('OrderCard terms preview carries dir="auto"');
	else bad('OrderCard terms preview should carry dir="auto"');

	const label = live('src/lib/components/IdentityLabel.svelte');
	if (/<span dir="auto" class=\{weightCls\}>\{name\}<\/span>/.test(label))
		ok('IdentityLabel display-name span carries dir="auto"');
	else bad('IdentityLabel name span should carry dir="auto"');

	const inst = live('src/routes/[lang]/instances/+page.svelte');
	if ((inst.match(/dir="auto"/g)?.length ?? 0) >= 2)
		ok('instances card gives dir="auto" to the instance name + tagline');
	else bad('instances card should carry dir="auto" on name + tagline', `found ${inst.match(/dir="auto"/g)?.length ?? 0}`);

	const chat = live('src/lib/components/ChatMessage.svelte');
	if (/dir="auto" class="whitespace-pre-wrap"/.test(chat))
		ok('ChatMessage plaintext bubble carries dir="auto"');
	else bad('ChatMessage plaintext should carry dir="auto"');

	const terms = live('src/lib/components/TermsText.svelte');
	if (/<div dir="auto">/.test(terms)) ok('TermsText wraps the full user terms in dir="auto"');
	else bad('TermsText should wrap its blocks in a dir="auto" container');
}

// ── E. RTL layout mirroring on OrderCard (cp620) ─────────────────────
// Farsi goes <html dir="rtl">, which mirrors the flow content — the poster
// identity flips (avatar to the right). The card's own absolutely-positioned
// clusters and the title pad use PHYSICAL sides, which do NOT auto-flip, so
// they must carry ltr:/rtl: variants. Without them the top-right Message-
// button cluster stays physically-right and collides with the now-right-
// aligned identity — the original "Farsi is a mess" bug. Guards follow the
// app's documented ltr:/rtl: convention (app.css §"Logical direction helpers").
{
	const card = live('src/lib/components/OrderCard.svelte');

	// Top-right cluster (expiry chip / price model / Message button) must sit on
	// the inline-END side: right in LTR, LEFT in RTL.
	const clusterCls = card.match(/class="(absolute[^"]*top-3[^"]*)"/)?.[1] ?? '';
	if (/ltr:right-\d/.test(clusterCls) && /rtl:left-\d/.test(clusterCls))
		ok('OrderCard top-right cluster mirrors to the left in RTL (ltr:right-*/rtl:left-*)');
	else
		bad(
			'OrderCard top-right cluster must mirror (ltr:right-*/rtl:left-*), else it collides with the RTL-mirrored identity',
			clusterCls
		);

	// Title pad reserved on the END side: RIGHT in LTR, LEFT in RTL.
	if (/sm:ltr:pr-/.test(card) && /sm:rtl:pl-/.test(card))
		ok('OrderCard title pad mirrors to the left in RTL (sm:ltr:pr-*/sm:rtl:pl-*)');
	else bad('OrderCard title pad must mirror for RTL (sm:ltr:pr-*/sm:rtl:pl-*)', card.match(/<h3[\s\S]*?"/)?.[0] ?? '');

	// The bottom hide/blocked cluster is also absolute + physical — mirror it too.
	const hideCls = card.match(/class="(absolute[^"]*bottom-3[^"]*)"/)?.[1] ?? '';
	if (/ltr:right-\d/.test(hideCls) && /rtl:left-\d/.test(hideCls))
		ok('OrderCard bottom hide/blocked cluster mirrors for RTL (ltr:right-*/rtl:left-*)');
	else bad('OrderCard bottom hide/blocked cluster must mirror (ltr:right-*/rtl:left-*)', hideCls);
}

console.log('');
console.log('\u2500'.repeat(56));
if (fail === 0) {
	console.log(`\u2713 all ${pass} rtl-bidi scenarios passed`);
} else {
	console.log(`\u2717 ${fail} FAILED, ${pass} passed`);
	process.exit(1);
}
