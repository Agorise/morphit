#!/usr/bin/env tsx
/**
 * apps/web/scripts/import-eager-self-avatar-smoke.ts  (v1.9.0, Ken kentest3)
 *
 * After a keyfile/seed sign-in the "You're signed in — one more choice" screen showed
 * the heart identicon, not the user's custom avatar, until they clicked "Remember me
 * and continue". AvatarMenu only fetches selfProfile once blurtAccountName is set, and
 * the reverse key→account lookup was deferred to the commit step. The fix resolves it
 * in the BACKGROUND right after the remember_me transition. Pins:
 *   - a resolveSelfAccountEagerly() helper exists and is fired (void) after the
 *     import stage flips to 'remember_me_choice'
 *   - on a UNIQUE match it calls setUserBlurtAccount (so AvatarMenu reacts) and clears
 *     pendingNeedsAccountName, guarded so it doesn't clobber the commit handler
 *   - AvatarMenu still derives its custom avatar from blurtAccountName → selfProfile
 *
 * Greps strip comments first.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');
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

// Onboarding import page: eager background resolution.
{
	const imp = read(
		resolve(SRC, 'routes', '[lang]', 'onboarding', 'import', '+page.svelte')
	);
	/async function resolveSelfAccountEagerly\(/.test(imp)
		? ok('resolveSelfAccountEagerly helper defined')
		: bad('resolveSelfAccountEagerly helper defined');
	// fired (fire-and-forget) right after the choice screen is shown
	/importStage\s*=\s*'remember_me_choice';[\s\S]{0,600}?void resolveSelfAccountEagerly\(\)/.test(imp)
		? ok('fired after remember_me_choice transition')
		: bad('fired after remember_me_choice transition');
	// a UNIQUE match sets the account (AvatarMenu then fetches the avatar)
	/accounts\.length\s*===\s*1[\s\S]{0,200}?setUserBlurtAccount\(/.test(imp)
		? ok('unique match → setUserBlurtAccount')
		: bad('unique match → setUserBlurtAccount');
	// guarded so it doesn't race/clobber the commit handler
	/if\s*\(\s*!pendingNeedsAccountName/.test(imp) &&
	/resolved\s*&&\s*pendingNeedsAccountName/.test(imp)
		? ok('guarded on pendingNeedsAccountName (no clobber)')
		: bad('guarded on pendingNeedsAccountName');
}

// AvatarMenu still keys its custom avatar off blurtAccountName → selfProfile.
{
	const menu = read(resolve(SRC, 'lib', 'components', 'AvatarMenu.svelte'));
	/activeAccount\s*=\s*\$derived\(\$blurtAccountName\s*\?\?/.test(menu)
		? ok('AvatarMenu activeAccount derives from blurtAccountName')
		: bad('AvatarMenu activeAccount derives from blurtAccountName');
	/refreshSelfProfile\(activeAccount\)/.test(menu)
		? ok('AvatarMenu refreshes selfProfile on account change')
		: bad('AvatarMenu refreshes selfProfile on account change');
}

console.log('\n' + '\u2500'.repeat(56));
if (fail > 0) {
	console.log(`\u2717 import-eager-self-avatar smoke FAILED (${fail})`);
	process.exit(1);
}
console.log('\u2713 custom avatar resolves on the remember-me screen (eager account lookup → selfProfile)');
console.log(`\u2713 all ${pass} import-eager-self-avatar scenarios passed`);
