#!/usr/bin/env tsx
/**
 * profile-trades-both-sides — v1.21.17.
 *
 * A seller who filled a buyer's order had no "Trade history" of it: the tab
 * listed only completed orders the profile's account had POSTED. It now reads
 * the instance's trades route (both sides), falls back to the old list on an
 * instance without it, names whose order another person's trade was, and the
 * empty texts name the account ("Nothing yet. @bob has not …").
 *
 * Tamper tests (each must turn this red):
 *   - Drop getAccountTrades from the profile's parallel read.
 *   - Build completedOrders from allOrders alone.
 *   - Read another person's order in the poster's voice ("I'm buying …").
 *   - Drop `values: { account }` from an empty text, or "@{account}" from a locale.
 *   - Put the focus ring back on the tabs (clipped to a partial box on a Mac),
 *     or make keyboard focus look the same as the selected tab.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(WEB, p), 'utf8');
const page = read('src/routes/[lang]/[x+40][account=account]/+page.svelte');
const client = read('src/lib/indexer/client.ts');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
		failed++;
	}
};

check(
	'the client reads /v1/accounts/:account/trades',
	/export function getAccountTrades[\s\S]{0,300}`\/v1\/accounts\/\$\{encodeURIComponent\(account\)\}\/trades`[\s\S]{0,120}limit: '100'/.test(
		client
	)
);
check(
	'the profile reads the trades alongside the orders',
	/Promise\.all\(\[\s*getAccountOrderPages\([^)]*\{[^}]*\}\),\s*getAccountTrades\(forAccount\)\s*\]\)/.test(
		page
	)
);
check(
	'a failed trades read falls back (null)',
	/trades = t\.ok \? \[\.\.\.t\.data\.items\] : null;/.test(page)
);
check(
	'Trade history is the trades, else the completed orders it posted',
	/\(trades \?\? allOrders\.filter\(\(o\) => o\.status === 'completed'\)\)/.test(page)
);
check(
	'another person’s order reads from the outside, naming its owner',
	/if \(o\.account === account\) return cardTitle\(o\);[\s\S]{0,200}voice: 'third'[\s\S]{0,120}chat\.header\.re_peer/.test(
		page
	)
);
check(
	'the partner of another person’s order is its owner',
	/o\.account === account \? \(o\.completed_counterparty \?\? null\) : o\.account/.test(page)
);
for (const key of ['no_feedback_yet', 'no_given_yet', 'no_trade_history']) {
	const uses = [...page.matchAll(new RegExp(`'profile\\.${key}'([^)]*)\\)`, 'g'))];
	check(
		`profile.${key}: every use names the account`,
		uses.length > 0 && uses.every((m) => /values: \{ account \}/.test(m[1])),
		`${uses.length} use(s)`
	);
	for (const { code } of SUPPORTED_LOCALES) {
		const d = JSON.parse(read(`src/lib/i18n/locales/${code}.json`)) as {
			profile: Record<string, string>;
		};
		check(
			`${code} profile.${key} says @{account}`,
			d.profile[key]?.includes('@{account}') === true
		);
	}
}
const tab = page.match(/class="-mb-px whitespace-nowrap[^"]*border-b-2[^"]*"/)?.[0] ?? '';
check('the tabs exist', tab !== '');
check(
	'the tabs mark keyboard focus with a tint and underlined text of their own (no ring or box — the owner saw a cut-off box on a Mac — and not the selected underline)',
	!/ring/.test(tab) &&
		/focus-visible:bg-morphit-emerald\/20/.test(tab) &&
		/focus-visible:underline /.test(tab) &&
		!/focus-visible:border-morphit-emerald/.test(tab)
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed === 0) {
	console.log(`✓ all ${passed} profile-trades-both-sides scenarios passed`);
	process.exit(0);
}
console.log(`✗ ${failed} of ${passed + failed} profile-trades-both-sides scenarios FAILED`);
process.exit(1);
