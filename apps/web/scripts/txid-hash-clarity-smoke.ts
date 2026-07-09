#!/usr/bin/env tsx
/**
 * Smoke: transaction-ID / Hash clarity (Ken #7). Anchor 2026-07-08.
 *
 *   - a generic `what_is_a_txid` FAQ exists (explains it's also called Hash,
 *     ~64 chars, Mycelium's "Hash", how to find it), in every locale;
 *   - the post step-4 txid card's tooltip points at THAT FAQ, not the
 *     XMR-specific `xmr_txid`;
 *   - the "required" validation now reads "Transaction ID or Hash is
 *     required." in every locale.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');
const faqIndex = readFileSync(join(WEB, 'src', 'lib', 'utils', 'faqIndex.ts'), 'utf8');
const post = readFileSync(join(WEB, 'src', 'routes', '[lang]', 'post', '+page.svelte'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean): void {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.error(`  \u2717 ${name}`);
	}
}

check('what_is_a_txid is a registered FAQ key', /'what_is_a_txid'/.test(faqIndex));
check('what_is_a_txid has related links', /what_is_a_txid: \[/.test(faqIndex));
check('txid card tooltip points at the generic FAQ (not xmr_txid)', /faqKey="what_is_a_txid"/.test(post) && !/faqKey="xmr_txid"/.test(post));

// Derived from the single source of truth so adding an 11th locale can never
// silently skip this smoke (locale-source-of-truth-smoke enforces this).
const LOCALES = SUPPORTED_LOCALES.map((l) => l.code);
let faqOk = true;
let reqOk = true;
for (const loc of LOCALES) {
	const j = JSON.parse(readFileSync(join(WEB, 'src', 'lib', 'i18n', 'locales', `${loc}.json`), 'utf8'));
	const e = j?.faq?.entries?.what_is_a_txid;
	if (!e || typeof e.q !== 'string' || typeof e.a !== 'string' || !e.q || !e.a) faqOk = false;
	const req = j?.post_order?.fee_method?.txid_required;
	if (typeof req !== 'string' || !req) reqOk = false;
}
check('all 10 locales have the what_is_a_txid FAQ (q + a)', faqOk);
check('all 10 locales have a txid_required string', reqOk);

const en = JSON.parse(readFileSync(join(WEB, 'src', 'lib', 'i18n', 'locales', 'en.json'), 'utf8'));
check('EN required reworded to "Transaction ID or Hash is required."', en.post_order.fee_method.txid_required === 'Transaction ID or Hash is required.');
const enA = en.faq.entries.what_is_a_txid.a;
check('EN FAQ answer covers Hash + Mycelium + 64 chars', /Hash/.test(enA) && /Mycelium/.test(enA) && /64/.test(enA));

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} txid-hash-clarity scenarios passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} txid-hash-clarity checks FAILED`);
	process.exit(1);
}
