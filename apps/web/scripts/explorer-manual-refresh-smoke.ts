#!/usr/bin/env tsx
/**
 * explorer-manual-refresh smoke — cp298.
 *
 * The explorer account page auto-polls (5s, backing off to 60s when the
 * account is idle), so a brand-new transaction can take up to a minute to
 * appear on its own. cp298 adds a manual "refresh now" button that
 * re-fetches balance + the latest history in place, CACHE-BYPASSED, plus
 * a delay notice on both the account page and the search landing. This
 * smoke fails if any of that wiring regresses.
 *
 * Tamper tests:
 *   - Unwire the refresh button (drop onclick={manualRefresh}) → fails.
 *   - Drop the noCache param from fetchAccountHistory → fails.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');

const P = {
	accountPage: join(
		REPO,
		'apps/web/src/routes/[lang]/explorer/account/[name=account]/+page.svelte'
	),
	searchPage: join(REPO, 'apps/web/src/routes/[lang]/explorer/+page.svelte'),
	historyHelper: join(REPO, 'apps/web/src/lib/blurt/accountHistory.ts'),
	balanceHelper: join(REPO, 'apps/web/src/lib/blurt/accountBalance.ts'),
	enLocale: join(REPO, 'apps/web/src/lib/i18n/locales/en.json')
} as const;

const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');

let pass = 0;
let fail = 0;
const ok = (m: string): void => {
	console.log(`  \u2713 ${m}`);
	pass++;
};
const bad = (m: string): void => {
	console.error(`  \u2717 ${m}`);
	fail++;
};

// 1. Account page defines manualRefresh and wires it to a button.
{
	const s = read(P.accountPage);
	if (/async function manualRefresh\(/.test(s) && /onclick=\{manualRefresh\}/.test(s))
		ok('account page defines manualRefresh and wires it to a button');
	else bad('account page missing manualRefresh function or its button wiring');
}

// 2. Refresh button has an accessible label from the locale key.
{
	const s = read(P.accountPage);
	if (/aria-label=\{\$_\('explorer\.account\.refresh_label'\)\}/.test(s))
		ok('refresh button has aria-label from explorer.account.refresh_label');
	else bad('refresh button missing aria-label / locale key');
}

// 3. Manual refresh is CACHE-BYPASSED (history + balance fetched with noCache=true).
{
	const s = read(P.accountPage);
	const historyBust = /fetchHistory\(-1,\s*true\)/.test(s);
	const balanceBust = /fetchAccountBalance\([^;]*fetch,\s*true\s*\)/.test(s);
	if (historyBust && balanceBust) ok('manual refresh bypasses cache for both history and balance');
	else bad(`manual refresh not cache-bypassed (history=${historyBust} balance=${balanceBust})`);
}

// 4. Delay notices render on both the account page and the search landing.
{
	const acct = /\$_\('explorer\.account\.delay_notice'\)/.test(read(P.accountPage));
	const search = /\$_\('explorer\.search\.delay_notice'\)/.test(read(P.searchPage));
	if (acct && search) ok('delay notices render on account page and search landing');
	else bad(`delay notice missing (account=${acct} search=${search})`);
}

// 5. Both fetch helpers support the noCache cache-bust.
for (const [label, path] of [
	['fetchAccountHistory', P.historyHelper],
	['fetchAccountBalance', P.balanceHelper]
] as const) {
	const s = read(path);
	const hasParam = /noCache = false/.test(s);
	const busts =
		/_cb=\$\{Date\.now\(\)\}/.test(s) && /cache: noCache \? 'no-store' : 'default'/.test(s);
	if (hasParam && busts) ok(`${label} supports noCache (cache-buster + no-store)`);
	else bad(`${label} missing noCache support (param=${hasParam} busts=${busts})`);
}

// 6. The three new locale keys exist (en). Parity across all 10 is enforced
//    by i18n-locale-parity-smoke.
{
	const en = JSON.parse(read(P.enLocale)) as {
		explorer?: { account?: Record<string, unknown>; search?: Record<string, unknown> };
	};
	const acc = en.explorer?.account ?? {};
	const sea = en.explorer?.search ?? {};
	if (
		typeof acc.refresh_label === 'string' &&
		typeof acc.delay_notice === 'string' &&
		typeof sea.delay_notice === 'string'
	)
		ok('en locale has refresh_label + account/search delay_notice');
	else bad('en locale missing one of the new explorer keys');
}

// ── Tamper tests ──
{
	const mutated = read(P.accountPage).replace('onclick={manualRefresh}', 'onclick={() => {}}');
	const stillWired =
		/async function manualRefresh\(/.test(mutated) && /onclick=\{manualRefresh\}/.test(mutated);
	if (mutated === read(P.accountPage))
		bad('tamper wiring error: could not unwire the refresh button');
	else if (stillWired)
		bad('tamper NOT caught: unwiring the refresh button still passes (toothless)');
	else ok('tamper caught: unwiring the refresh button turns the wiring check red');
}
{
	const mutated = read(P.historyHelper).replace('noCache = false', 'fetchImpl2 = fetch');
	const stillHas = /noCache = false/.test(mutated);
	if (mutated === read(P.historyHelper)) bad('tamper wiring error: could not drop noCache');
	else if (stillHas) bad('tamper NOT caught: dropping noCache still passes (toothless)');
	else ok('tamper caught: dropping noCache from fetchAccountHistory turns its check red');
}

console.log(`\n${pass} ok, ${fail} failing`);
if (fail > 0) process.exit(1);
console.log(`\u2713 all ${pass} scenarios passed`);
