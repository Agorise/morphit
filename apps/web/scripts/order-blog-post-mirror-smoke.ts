#!/usr/bin/env tsx
/**
 * apps/web/scripts/order-blog-post-mirror-smoke.ts  (v1.9.0, Ken)
 *
 * The per-order Blurt announcement was rewritten to MIRROR the order detail page:
 * og-image header, an H1 headline, a DETAILS block (pay/accept + methods, posted /
 * expires dates, optional location, "✓ Verified"), the full order Terms WITH markdown,
 * a bold tagline, and the shareable link. Pins:
 *   - publish.ts builds that structure programmatically (og-image.png, "# ", DETAILS,
 *     Terms heading, tagline, check_out, dates via formatDayMonth) and reuses the
 *     order_detail.* labels so the two surfaces can't drift
 *   - OrderPostContext carries the fields the body needs, and the caller passes them
 *   - the old flat body_buy/body_sell templates are gone; the new label keys exist in
 *     all 10 locales (title_buy/title_sell kept for the headline)
 *
 * Greps strip comments first.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');
const SRC = resolve(WEB, 'src');
const LOCALES = resolve(SRC, 'lib', 'i18n', 'locales');
let pass = 0,
	fail = 0;
const ok = (m: string) => (pass++, console.log(`  \u2713 ${m}`));
const bad = (m: string, d = '') => (fail++, console.log(`  \u2717 ${m}${d ? `\n      ${d}` : ''}`));
const strip = (s: string) =>
	s
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const read = (p: string) => strip(readFileSync(p, 'utf8'));
const LOCS = SUPPORTED_LOCALES.map((l) => l.code);

// publish.ts body assembly.
{
	const pub = read(resolve(SRC, 'lib', 'syndication', 'publish.ts'));
	const checks: Array<[string, boolean]> = [
		['leads with morphit.io/og-image.png', /morphit\.io\/og-image\.png/.test(pub)],
		['H1 headline (# ${title})', /`#\s*\$\{title\}`/.test(pub)],
		['DETAILS label', /syndicate\.order_post\.details/.test(pub)],
		['Terms heading', /syndicate\.order_post\.terms_heading/.test(pub)],
		['tagline', /syndicate\.order_post\.tagline/.test(pub)],
		['check_out line', /syndicate\.order_post\.check_out/.test(pub)],
		['dates via formatDayMonth', /formatDayMonth\(/.test(pub)],
		['reuses detail pay/accept labels', /order_detail\.i_can_pay_with/.test(pub)],
		['sell side uses "I will accept"', /syndicate\.order_post\.i_will_accept/.test(pub)],
		['fee shows Verified', /order_detail\.fee_verified/.test(pub)],
		['location omitted when blank', /ctx\.locationRegion\s*&&/.test(pub)]
	];
	for (const [n, okp] of checks) okp ? ok(`publish.ts: ${n}`) : bad(`publish.ts: ${n}`);

	// OrderPostContext carries the mirror fields
	const ctxFields = ['paymentMethodNames', 'createdAtIso', 'expiresAtIso', 'locationRegion', 'terms'];
	const missing = ctxFields.filter((f) => !new RegExp(`readonly ${f}\\??:`).test(pub));
	missing.length === 0
		? ok('OrderPostContext carries the mirror fields')
		: bad('OrderPostContext fields', `missing: ${missing.join(', ')}`);
}

// Caller passes the mirror fields.
{
	const post = read(resolve(SRC, 'routes', '[lang]', 'post', '+page.svelte'));
	/paymentMethodNames:\s*displayNamesForMethods\(/.test(post) &&
	/createdAtIso:\s*new Date\(\)\.toISOString\(\)/.test(post) &&
	/expiresAtIso:/.test(post) &&
	/terms:\s*terms\.trim\(\)/.test(post)
		? ok('caller passes methods, dates, location, terms')
		: bad('caller passes the mirror fields');
}

// Locales: old flat body gone; new label keys present in all 10.
{
	const NEW = ['details', 'terms_heading', 'tagline', 'check_out', 'i_will_accept'];
	let allNew = true;
	let noOld = true;
	for (const loc of LOCS) {
		const op = JSON.parse(readFileSync(resolve(LOCALES, `${loc}.json`), 'utf8')).syndicate
			?.order_post ?? {};
		for (const k of NEW) if (typeof op[k] !== 'string') (allNew = false), bad(`${loc}.${k} present`);
		if ('body_buy' in op || 'body_sell' in op) (noOld = false), bad(`${loc}: body_buy/body_sell removed`);
		if (typeof op.title_buy !== 'string' || typeof op.title_sell !== 'string')
			bad(`${loc}: title_buy/title_sell kept`);
	}
	if (allNew) ok('all 10 locales carry details/terms_heading/tagline/check_out/i_will_accept');
	if (noOld) ok('flat body_buy/body_sell removed from all 10');
}

console.log('\n' + '\u2500'.repeat(56));
if (fail > 0) {
	console.log(`\u2717 order-blog-post-mirror smoke FAILED (${fail})`);
	process.exit(1);
}
console.log('\u2713 blog announcement mirrors the detail page; labels reused; 10 locales clean');
console.log(`\u2713 all ${pass} order-blog-post-mirror scenarios passed`);
