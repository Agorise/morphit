#!/usr/bin/env tsx
/**
 * profile-display-retry-smoke — a display name, avatar or reply the user
 * should see is never replaced by a stale fallback.
 *
 *  - Chat inbox: a peer's display name and avatar fell back to @username for
 *    good. The inbox's own profileMap treated a null as an answer and never
 *    re-asked, so profileCache's soft-null retry never got a chance.
 *  - Profile page: a just-posted feedback reply is staged from the text that
 *    went on chain, so "Reply posted" is not shown above an empty reply slot
 *    for the ~45-63 s the indexer needs (a reply is display only; ratings are
 *    computed from `feedback` rows, never from responses).
 *  - Profile cache: the prime-hold that keeps a just-saved profile from
 *    reverting lasts as long as irreversibility (`profiles` is written only by
 *    the LIB-bounded poller), not a hand-tuned 12 s.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');

const merge = readFileSync(join(WEB, 'src', 'lib', 'indexer', 'profileMerge.ts'), 'utf8');
const inbox = readFileSync(join(WEB, 'src', 'routes', '[lang]', 'chat', '+page.svelte'), 'utf8');
const profilePage = readFileSync(
	join(WEB, 'src', 'routes', '[lang]', '[x+40][account=account]', '+page.svelte'),
	'utf8'
);
const profileCache = readFileSync(join(WEB, 'src', 'lib', 'indexer', 'profileCache.ts'), 'utf8');

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

/** Source with comments removed: a fix's own docblock may quote the old code. */
const stripComments = (src: string): string =>
	src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
		.join('\n');

// ─── chat inbox profile fallback ─────────────────────────────────────
check(
	'peersNeedingProfile treats a NULL as "still unknown", not an answer',
	/map\[p\] == null/.test(merge)
);
check(
	'mergeProfileMap never downgrades a known-good profile to null',
	/profile \?\? next\[account\] \?\? null/.test(merge)
);
check(
	'the inbox uses the shared helpers',
	/peersNeedingProfile\(peers, profileMap\)/.test(inbox) &&
		/mergeProfileMap\(profileMap, fetched\)/.test(inbox)
);
check(
	'the inbox no longer keys retries off mere presence',
	!/!\(p in profileMap\)/.test(stripComments(inbox))
);

// ─── staged feedback replies ─────────────────────────────────────────
check(
	'a just-posted reply is staged from the text that went on chain',
	/addPendingReply\(fb\.source_trx_id, account, res\.comment\)/.test(profilePage)
);
check(
	'the feedback list merges staged replies',
	/mergePendingReplies\(r\.data\.items, get\(pendingFeedbackReplies\)/.test(profilePage)
);
check(
	'profile hydration sees the staged responder (avatar, not identicon)',
	/hydrateReviewerProfiles\(merged, 'received'\)/.test(profilePage)
);

// ─── profile prime-hold ──────────────────────────────────────────────
check(
	'the profile prime-hold outlasts irreversibility, not block time',
	/const PRIME_HOLD_MS = PENDING_TTL_MS;/.test(profileCache)
);
check(
	'the prime-hold shares the chain constant rather than hand-tuning a copy',
	/from '\$lib\/stores\/pendingEcho'/.test(profileCache)
);

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} profile-display-retry checks passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} profile-display-retry checks FAILED`);
	process.exit(1);
}
