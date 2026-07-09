#!/usr/bin/env tsx
/**
 * Smoke: display name + avatar no longer fall back to "@account" + identicon
 * and STAY that way across refreshes (Ken #2). Anchor 2026-07-08.
 *
 * Two independent causes, both guarded here:
 *
 *  1. SERVER — the batch profiles endpoint sent `max-age=90,
 *     stale-while-revalidate=60` on EVERY response, including ones that
 *     omitted a requested account. An omitted account is usually just indexer
 *     lag (1–2 blocks after a profile broadcast / signup), and the browser's
 *     HTTP cache replayed that negative result for up to 150s — surviving page
 *     refreshes, because a reload clears the in-memory cache but not the disk
 *     cache. Partial batches are now `no-store`.
 *
 *  2. CLIENT — `getProfileCached` collapses "fetch failed" and "no profile"
 *     into the same bare null, so the selfProfile store CLEARED a good avatar
 *     to the identicon on any transient blip, and it stuck for the whole
 *     session (the store only refreshes on account change / broadcast). The
 *     store now uses `getProfileCachedDetailed`, keeps the prior value on
 *     failure, retries, and force-reloads the HTTP cache after a broadcast.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');
const REPO = join(WEB, '..', '..');

const serverProfiles = readFileSync(join(REPO, 'apps', 'indexer', 'src', 'api', 'profiles.ts'), 'utf8');
const cacheMod = readFileSync(join(WEB, 'src', 'lib', 'indexer', 'profileCache.ts'), 'utf8');
const store = readFileSync(join(WEB, 'src', 'lib', 'stores', 'selfProfile.ts'), 'utf8');

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

// ─── 1. Server: negative batch results are never cached ──────────────
check('server defines a separate no-store header for partial batches', /BATCH_CACHE_CONTROL_PARTIAL = 'no-store'/.test(serverProfiles));
check('server keeps the 90s header for complete batches', /BATCH_CACHE_CONTROL = 'public, max-age=90, stale-while-revalidate=60'/.test(serverProfiles));
check('server picks the header by batch completeness', /const complete = result\.rows\.length === accounts\.length;/.test(serverProfiles) && /complete \? BATCH_CACHE_CONTROL : BATCH_CACHE_CONTROL_PARTIAL/.test(serverProfiles));
check('the single-profile 404 is no-store too (404s are heuristically cacheable)', /c\.header\('Cache-Control', BATCH_CACHE_CONTROL_PARTIAL\);[\s\S]{0,160}errorBody\('not_found'/.test(serverProfiles));

// ─── 2. Client cache: failure is distinguishable + reload path ───────
check('cache exposes getProfileCachedDetailed with a `failed` flag', /export async function getProfileCachedDetailed/.test(cacheMod) && /readonly failed: boolean/.test(cacheMod));
check('`failed` is derived from the cp428 soft-null marker', /cache\.get\(account\)\?\.soft === true/.test(cacheMod));
check('fetchBatch can bypass the browser HTTP cache (cache: reload)', /reload = false/.test(cacheMod) && /cache: 'reload' as RequestCache/.test(cacheMod));
check('a reload request skips the in-memory cache + in-flight sharing', /if \(opts\?\.reload\) \{[\s\S]{0,120}needsFetch\.push\(account\);/.test(cacheMod));
check('reload is threaded batch → fetchBatch', /fetchBatch\(chunkOfAccounts, signal, opts\?\.reload === true\)/.test(cacheMod));

// ─── 3. selfProfile store: never clobber a good avatar on a blip ─────
check('store uses the detailed fetch (not the null-collapsing one)', /getProfileCachedDetailed/.test(store) && !/\bgetProfileCached\b(?!Detailed)/.test(store));
check('on failure the store keeps the current account\u2019s value', /if \(failed\) \{[\s\S]{0,260}cur\.account === account \? cur :/.test(store));
check('on failure during an account SWITCH the store blanks (no leaking the old avatar)', /cur\.account === account \? cur : \{ account, avatarSvg: null, avatarDataUri: null \}/.test(store));
check('a failed fetch is retried (a blip must not blank the session)', /SELF_PROFILE_RETRIES = 2/.test(store) && /SELF_PROFILE_RETRY_DELAY_MS = 6_000/.test(store));
check('the retry delay outlives the 5s soft-null TTL', /6_000/.test(store));
check('bustCache also force-reloads the browser HTTP cache', /reload: opts\?\.bustCache === true/.test(store));
check('an authoritative "no profile" is still applied (avatar really removed)', /const props = extractLabelPropsFromProfile\(profile\);/.test(store));

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} profile-freshness scenarios passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} profile-freshness checks FAILED`);
	process.exit(1);
}
