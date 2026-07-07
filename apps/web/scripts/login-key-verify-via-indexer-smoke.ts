#!/usr/bin/env tsx
/**
 * login-key-verify-via-indexer smoke — cp298.
 *
 * PRIVACY (priority #1). Login / key-import (onboarding/import) and the
 * settings account-name verifier used to call Blurt `get_accounts`
 * directly from the browser, leaking "IP X is logging into account Y" to
 * third-party RPC operators. cp298 routes the lookup through the
 * operator's own `/v1/account/:name/keys` endpoint. This smoke fails if
 * either surface regresses to direct RPC, or if the endpoint ever grows a
 * secret-key field.
 *
 * Non-custodial invariant: the endpoint returns PUBLIC authorities only.
 * The WIF→pubkey derivation + verifyPostingKey comparison stay client-
 * side (verifyPostingKey takes the public-authorities subset).
 *
 * Tamper tests (each must flip a check red):
 *   - Re-introduce getBlurtClient into the import page → fails.
 *   - Drop the /keys mount from main.ts → fails.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');

const P = {
	endpoint: join(REPO, 'apps/indexer/src/api/accountKeys.ts'),
	main: join(REPO, 'apps/indexer/src/main.ts'),
	client: join(REPO, 'packages/indexer-client/src/index.ts'),
	webHelper: join(REPO, 'apps/web/src/lib/blurt/accountKeys.ts'),
	postingVerify: join(REPO, 'apps/web/src/lib/crypto/postingVerify.ts'),
	importPage: join(REPO, 'apps/web/src/routes/[lang]/onboarding/import/+page.svelte'),
	settingsPage: join(REPO, 'apps/web/src/routes/[lang]/settings/+page.svelte')
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

// 1. Endpoint serves /:account/keys returning the four public authority fields.
{
	const s = read(P.endpoint);
	const okRoute = /\.get\(\s*['"]\/:account\/keys['"]/.test(s);
	const okFields = /name:/.test(s) && /owner:/.test(s) && /active:/.test(s) && /posting:/.test(s) && /memo_key:/.test(s);
	if (okRoute && okFields) ok('indexer endpoint serves /:account/keys with owner/active/posting/memo_key');
	else bad('indexer /keys endpoint missing route or one of the public authority fields');
}

// 2. SECURITY: the endpoint must expose NO secret-key field.
{
	// Strip comments first — the doc comment legitimately says "no secret"
	// / "private→public derivation"; we must scan the CODE, not the prose.
	const code = read(P.endpoint)
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/[^\n]*/g, '')
		.toLowerCase();
	const leaks = /\bwif\b/.test(code) || /private[_ ]?key/.test(code) || /\bsecret\b/.test(code) || /privatekey/.test(code);
	if (!leaks) ok('keys endpoint references no secret/private-key field in code (public keys only)');
	else bad('keys endpoint references a secret/private-key field — must be public keys only');
}

// 3. main.ts mounts the keys route on the account app.
{
	const s = read(P.main);
	if (/import \{ accountKeysRoute \}/.test(s) && /accountApp\.route\('\/', accountKeysRoute\(blurt\)\)/.test(s))
		ok('main.ts mounts accountKeysRoute on /v1/account');
	else bad('main.ts does not mount accountKeysRoute');
}

// 4. indexer-client exports AccountKeysResponse.
{
	if (/export interface AccountKeysResponse/.test(read(P.client))) ok('indexer-client exports AccountKeysResponse');
	else bad('indexer-client missing AccountKeysResponse');
}

// 5. web helper fetchAccountKeys exists and returns AccountAuthorities|null.
{
	const s = read(P.webHelper);
	if (/export async function fetchAccountKeys\(/.test(s) && /AccountAuthorities \| null/.test(s))
		ok('web helper fetchAccountKeys returns AccountAuthorities|null');
	else bad('web helper fetchAccountKeys missing or wrong return type');
}

// 6. verifyPostingKey accepts the public-authorities subset (not a full account requirement).
{
	const s = read(P.postingVerify);
	if (/export type AccountAuthorities = Pick<BlurtAccount/.test(s) && /verifyPostingKey\(account: AccountAuthorities/.test(s))
		ok('verifyPostingKey takes AccountAuthorities (keys-only response satisfies it)');
	else bad('verifyPostingKey not adapted to the public-authorities subset');
}

// 7. Both surfaces use fetchAccountKeys and NO getBlurtClient.
for (const [label, path] of [['onboarding/import', P.importPage], ['settings', P.settingsPage]] as const) {
	const s = read(path);
	if (/fetchAccountKeys\(/.test(s) && !/getBlurtClient/.test(s)) ok(`${label} uses fetchAccountKeys and no getBlurtClient`);
	else bad(`${label} still uses getBlurtClient or doesn't call fetchAccountKeys`);
}

// ── Tamper tests ──
{
	const mutated = `import { getBlurtClient } from '$blurt/client';\n${read(P.importPage)}`;
	const stillOk = /fetchAccountKeys\(/.test(mutated) && !/getBlurtClient/.test(mutated);
	if (stillOk) bad('tamper NOT caught: re-adding getBlurtClient to import page still passes (toothless)');
	else ok('tamper caught: re-adding getBlurtClient to the import page turns its check red');
}
{
	const mutated = read(P.main).replace(/\n\taccountApp\.route\('\/', accountKeysRoute\(blurt\)\);/, '');
	const stillOk = /accountApp\.route\('\/', accountKeysRoute\(blurt\)\)/.test(mutated);
	if (mutated === read(P.main)) bad('tamper wiring error: could not drop the /keys mount');
	else if (stillOk) bad('tamper NOT caught: dropping the /keys mount still passes (toothless)');
	else ok('tamper caught: dropping the /keys mount turns the mount check red');
}

console.log(`\n${pass} ok, ${fail} failing`);
if (fail > 0) process.exit(1);
console.log(`\u2713 all ${pass} scenarios passed`);
