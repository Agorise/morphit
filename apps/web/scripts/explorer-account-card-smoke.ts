#!/usr/bin/env tsx
/**
 * explorer-account-card smoke — cp321.
 *
 * The block-explorer account page (/explorer/account/[name]) got a batch of
 * fixes this checkpoint. This smoke locks them in so they can't silently
 * regress. Two of them were REAL bugs (not cosmetics):
 *
 *   • tx / block links 404'd. `morphitExplorerTxUrl` / `morphitExplorerBlockUrl`
 *     return LOCALE-LESS paths (`/explorer/tx/<hash>`), but every route lives
 *     under `[lang]`, so an un-prefixed path 404s. The fix wraps them in
 *     `lp(...)` at the call site. (The no-bare-root-href smoke can't catch this
 *     class — the href is a function-returned expression, not a literal `/`.)
 *
 *   • "Load older operations" silently failed near the start of an account's
 *     history. Blurt's get_account_history rejects `from < limit - 1`, so once
 *     `oldestSeqLoaded` drops below a full page the call errored and nothing
 *     loaded. The fix clamps the page to `Math.min(PAGE_SIZE, oldestSeqLoaded)`.
 *
 * The rest are UX correctness guards: the refresh button must not flip to the
 * red `cursor-not-allowed` while spinning; op timestamps must run through the
 * canonical `formatDayMonthTime` formatter; the third balance stat is the
 * correctly-labelled "Voting" power (Blurt has a single voting_manabar — there
 * is no separate RC mana, so the old "MANA" label was voting power mislabelled);
 * and the keys card shows all four public keys (owner/active/posting/memo)
 * fetched via the indexer's /keys proxy.
 *
 * Tamper tests (each must turn this smoke red):
 *   - Revert the tx link to the bare `morphitExplorerTxUrl(op.trxId) ?? '#'`.
 *   - Drop the Math.min clamp from loadMore.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');

const P = {
	accountPage: join(REPO, 'apps/web/src/routes/[lang]/explorer/account/[name=account]/+page.svelte'),
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

const page = read(P.accountPage);

// 1. tx link is locale-prefixed (the 404 fix), NOT the old bare form.
{
	const fixed = /href=\{txUrl \? lp\(txUrl\) : '#'\}/.test(page);
	const oldBuggy = /href=\{morphitExplorerTxUrl\(op\.trxId\)\s*\?\?\s*'#'\}/.test(page);
	if (fixed && !oldBuggy) ok('tx link is locale-prefixed via lp(txUrl)');
	else if (oldBuggy) bad('tx link still uses the locale-less morphitExplorerTxUrl(...) ?? "#" form → 404s under [lang]');
	else bad('tx link not wired through lp(txUrl)');
}

// 2. block link is locale-prefixed.
{
	const fixed = /href=\{blockUrl \? lp\(blockUrl\) : '#'\}/.test(page);
	const oldBuggy = /href=\{morphitExplorerBlockUrl\(op\.block\)\s*\?\?\s*'#'\}/.test(page);
	if (fixed && !oldBuggy) ok('block link is locale-prefixed via lp(blockUrl)');
	else if (oldBuggy) bad('block link still uses the locale-less morphitExplorerBlockUrl(...) ?? "#" form → 404s under [lang]');
	else bad('block link not wired through lp(blockUrl)');
}

// 3. loadMore clamps the page so Blurt's `from >= limit-1` rule holds near the start.
{
	if (/Math\.min\(PAGE_SIZE, oldestSeqLoaded\)/.test(page)) ok('loadMore clamps the page size to Math.min(PAGE_SIZE, oldestSeqLoaded)');
	else bad('loadMore missing the Math.min(PAGE_SIZE, oldestSeqLoaded) clamp → load-older fails near history start');
}

// 4. fetchHistory accepts an optional limit (so the clamp can take effect).
{
	if (/async function fetchHistory\(from: number, noCache = false, limit = PAGE_SIZE\)/.test(page))
		ok('fetchHistory takes an optional limit param');
	else bad('fetchHistory does not accept a limit param (clamp would have no effect)');
}

// 5. op timestamps run through the canonical formatter (not the raw ISO string).
{
	const importsIt = /import \{ formatDayMonthTime \} from '\$i18n\/formatters'/.test(page);
	const usesIt = /formatDayMonthTime\(iso\)/.test(page);
	if (importsIt && usesIt) ok('op timestamps formatted via formatDayMonthTime(iso)');
	else bad('op timestamps not run through formatDayMonthTime');
}

// 6. refresh button: clear hover + cursor-pointer, and the busy state is a
//    wait cursor — NEVER the red cursor-not-allowed (Ken's "red warning
//    cursor" report).
{
	const hasPointer = /cursor-pointer/.test(page);
	const hasWait = /disabled:cursor-wait/.test(page);
	const hasRed = /disabled:cursor-not-allowed/.test(page);
	if (hasPointer && hasWait && !hasRed) ok('refresh button uses cursor-pointer + disabled:cursor-wait (no red cursor-not-allowed)');
	else if (hasRed) bad('refresh button still uses disabled:cursor-not-allowed (the red "warning" cursor)');
	else bad('refresh button missing cursor-pointer / disabled:cursor-wait');
}

// 7. third balance stat is "Voting" power (not the mislabelled "MANA").
{
	const votingLabel = /\$_\('explorer\.account\.voting_label'\)/.test(page);
	const votingValue = /formatPercentage\(voting\)/.test(page);
	const oldMana = /profile\.my_balance\.mana_label/.test(page);
	if (votingLabel && votingValue && !oldMana) ok('third stat is Voting power (explorer.account.voting_label + formatPercentage(voting))');
	else if (oldMana) bad('account page still shows the mislabelled profile.my_balance.mana_label stat');
	else bad('Voting power stat not wired (voting_label / formatPercentage(voting))');
}

// 7b. BP stat reads "BP (staked BLURT)" and shows the live APR underneath
//     (consistency with the private balance card; encourages staking).
{
	const stakedLabel = /\$_\('profile\.my_balance\.bp_staked_label'\)/.test(page);
	const oldBp = /\$_\('profile\.my_balance\.bp_label'\)/.test(page);
	const aprComputed = /vestingApr\s*=\s*computeBlurtVestingApr\(/.test(page);
	const aprShown =
		/Number\.isFinite\(vestingApr\)/.test(page) &&
		/\$_\('profile\.my_balance\.apr_label'/.test(page) &&
		/formatApr\(vestingApr\)/.test(page);
	if (stakedLabel && !oldBp) ok('BP stat uses bp_staked_label ("BP (staked BLURT)"), not the old bp_label');
	else if (oldBp) bad('BP stat still uses the old bp_label — should be bp_staked_label');
	else bad('BP stat label not wired to bp_staked_label');
	if (aprComputed && aprShown) ok('BP APR computed from DGP (computeBlurtVestingApr) and shown via apr_label/formatApr');
	else bad('BP APR not wired (computeBlurtVestingApr + apr_label + formatApr under the BP figure)');
}

// 8. Public Keys card shows all four keys, fetched via the /keys proxy.
{
	const fetches = /fetchAccountKeys\(/.test(page) && /import \{ fetchAccountKeys \} from '\$blurt\/accountKeys'/.test(page);
	const heading = /\$_\('explorer\.account\.public_keys_heading'\)/.test(page);
	const allFour =
		/keys\.owner/.test(page) &&
		/keys\.active/.test(page) &&
		/keys\.posting/.test(page) &&
		/keys\.memo/.test(page);
	const labels =
		/explorer\.account\.key_owner/.test(page) &&
		/explorer\.account\.key_active/.test(page) &&
		/explorer\.account\.key_posting/.test(page) &&
		/explorer\.account\.key_memo/.test(page);
	if (fetches && heading && allFour && labels) ok('Public Keys card renders owner/active/posting/memo from fetchAccountKeys');
	else bad('Public Keys card not fully wired (fetchAccountKeys / heading / four keys / four labels)');
}

// 9. en locale carries the new keys.
{
	let en: Record<string, unknown> = {};
	try {
		en = JSON.parse(read(P.enLocale));
	} catch {
		/* handled below */
	}
	const acc = ((en.explorer as Record<string, unknown>)?.account ?? {}) as Record<string, unknown>;
	const present =
		typeof acc.voting_label === 'string' &&
		typeof acc.public_keys_heading === 'string' &&
		typeof acc.key_owner === 'string' &&
		typeof acc.key_active === 'string' &&
		typeof acc.key_posting === 'string' &&
		typeof acc.key_memo === 'string';
	if (present) ok('en locale has voting_label + public_keys_heading + key_{owner,active,posting,memo}');
	else bad('en locale missing one of the new explorer.account keys');
}

// ── Tamper tests ──
{
	const mutated = page.replace("href={txUrl ? lp(txUrl) : '#'}", "href={morphitExplorerTxUrl(op.trxId) ?? '#'}");
	const fixedStill = /href=\{txUrl \? lp\(txUrl\) : '#'\}/.test(mutated);
	const oldBuggy = /href=\{morphitExplorerTxUrl\(op\.trxId\)\s*\?\?\s*'#'\}/.test(mutated);
	if (mutated === page) bad('tamper wiring error: could not revert the tx link');
	else if (fixedStill || !oldBuggy) bad('tamper NOT caught: reverting the tx link to the bare form still passes (toothless)');
	else ok('tamper caught: reverting the tx link to the locale-less form turns the link check red');
}
{
	const mutated = page.replace('Math.min(PAGE_SIZE, oldestSeqLoaded)', 'PAGE_SIZE');
	const stillClamped = /Math\.min\(PAGE_SIZE, oldestSeqLoaded\)/.test(mutated);
	if (mutated === page) bad('tamper wiring error: could not drop the loadMore clamp');
	else if (stillClamped) bad('tamper NOT caught: dropping the clamp still passes (toothless)');
	else ok('tamper caught: dropping the loadMore clamp turns its check red');
}

console.log(`\n${pass} ok, ${fail} failing`);
if (fail > 0) process.exit(1);
console.log(`\u2713 all ${pass} scenarios passed`);
