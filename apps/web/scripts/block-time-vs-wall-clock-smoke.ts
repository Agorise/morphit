#!/usr/bin/env tsx
/**
 * Morphit — block-time vs wall-clock smoke (v1.7.7).
 *
 * THE RULE, one line: **anything compared against a block time must be measured
 * in block time.**
 *
 * Ken asked the question that produced this guard: "i guess we should no longer
 * rely on the user's clock on their local pc, right? ... we do not want to have
 * any sync issues in the future, or especially when money is being transfered."
 *
 * The audit answer was: money was already right, and it is the SMALL things that
 * were wrong. This bug class has now surfaced three times, and each time it was
 * invisible on a synced clock — it only appears on someone's actual machine:
 *
 *   1. `chatFolders.setFolder` stamped `new Date()` and `resurrectArchived-
 *      OnNewActivity` compared it to `last_message_at`. kentest3's archive
 *      bounced back out of Archived; kentest2 never reproduced it on identical
 *      code. It looked like a browser-version bug. It was the clock.
 *   2. `handleOpen` stamped `new Date()` and `isUnread()` compares the cursor to
 *      `last_message_at`. On a slow clock the thread you just opened stays green.
 *   3. (guarded here so there is no #3.)
 *
 * WHY A GUARD AND NOT A FIXED BUG: every instance passes typecheck, passes every
 * test, and works perfectly on the machine of whoever wrote it. The failure needs
 * someone else's clock to be a bit off, which no CI will ever have. The only
 * defence is refusing to let a bare `new Date()` reach a value that meets block
 * time.
 *
 * THE MONEY PATHS ARE THE POINT OF #1–#4: they were already correct before this
 * guard existed, and must stay that way. A transaction expiration derived from a
 * user's wall clock would be rejected outright by the node on a skewed machine —
 * the user simply could not send.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string): string =>
	s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/<!--[\s\S]*?-->/g, ' ');

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) { pass++; console.log(`  \u2713 ${name}`); }
	else { fail++; console.log(`  \u2717 ${name}${detail ? `\n      ${detail}` : ''}`); }
};

// ── MONEY: expiration must come from the CHAIN, never the browser ───
for (const f of ['apps/web/src/lib/blurt/sign.ts', 'apps/web/src/lib/blurt/ops/comment.ts']) {
	const src = strip(read(f));
	check(
		`1 ${f.split('/').pop()} derives expiration from chain head time`,
		/const head = new Date\(props\.time \+ 'Z'\)\.getTime\(\)/.test(src) &&
			/expiration = new Date\(head \+ 60_000\)/.test(src),
		'a wall-clock expiration is REJECTED by the node on a skewed machine — the user cannot send at all'
	);
	check(
		`2 …and never reads the local clock`,
		!/Date\.now\(\)/.test(src),
		'no signing path may consult the browser clock'
	);
}
for (const f of ['apps/web/src/lib/blurt/withdrawVestingSign.ts', 'apps/web/src/lib/blurt/client.ts']) {
	check(
		`3 ${f.split('/').pop()} does not read the local clock`,
		!/Date\.now\(\)/.test(strip(read(f)))
	);
}

// ── READ CURSORS: compared against last_message_at (block time) ─────
const readState = strip(read('apps/web/src/lib/chat/readState.ts'));
// Pins the REQUIREMENT — ack with the newest message actually seen, else now —
// rather than the variable names. The first version spelled out `latestSeenAt`
// and broke when the sanitiser introduced a `seen` local: a correct change
// failing a check it never violated. Third time today; the family is relentless.
check(
	'4 readAckTimestamp clamps to max(latestSeen, now)',
	/export function readAckTimestamp\([\s\S]{0,600}?\.getTime\(\) > now\.getTime\(\) \?[\s\S]{0,40}?: now;/.test(
		readState
	),
	'this is the watermark that keeps a cursor from landing behind the message it acks'
);
const inbox = strip(read('apps/web/src/routes/[lang]/chat/+page.svelte'));
check(
	'5 the inbox acks through the clamp, not a bare new Date()',
	/markConversationRead\(\s*peer,\s*orderPermlink,\s*readAckTimestamp\(/.test(inbox),
	'bare new Date() here = the thread you just opened stays green on a slow clock'
);
check(
	'6 …and hands it the row block time it already has',
	/handleOpen\(convo\.peer, convo\.order\?\.permlink \?\? '', convo\.last_message_at\)/.test(inbox)
);
const convView = strip(read('apps/web/src/lib/components/ConversationView.svelte'));
check(
	'7 ConversationView acks through the clamp against the newest message',
	/markConversationRead\(peer, orderPermlink \?\? '', readAckTimestamp\(latestConfirmedAt\(\)\)\)/.test(convView)
);

// ── FOLDERS: compared against last_message_at (block time) ──────────
const folders = strip(read('apps/web/src/lib/chat/chatFolders.ts'));
check(
	'8 the archive watermark clamps to max(now, lastMessageAt)',
	/function watermark\([\s\S]{0,600}?Math\.max\(now, seenDate\.getTime\(\)\)/.test(folders),
	'Ken s kentest3: archive → refresh → back in the Inbox, on identical code to kentest2'
);
check(
	'9 …and setFolder never stamps a bare new Date()',
	!/next\[key\] = \{ folder, at: new Date\(\)\.toISOString\(\) \}/.test(folders)
);


// ── the no-order thread must be clamped too ────────────────────────
// [KEN, v1.7.7]: "sometimes users use the chatroom to discuss a specific order
// with a permlink … but other times those same users might just want to message
// each other to have a separate chat thread about their girlfriends and that
// thread does not have an order id permlink attached to it at all."
//
// `''` is a REAL thread key, not an absence — distinct from BOTH an
// order-scoped thread with the same peer AND from the legacy `PEER_WIDE` ('*'),
// which markConversationRead rejects outright. The clock fixes must apply to it
// identically: a girlfriends thread on a slow clock stays green just as an order
// thread would. Nothing here may special-case a missing permlink into "no thread".
check(
	'10 the no-order thread ("") goes through the same clamp as an order thread',
	/handleOpen\(convo\.peer, convo\.order\?\.permlink \?\? '', convo\.last_message_at\)/.test(inbox),
	'`?? \'\'` is the girlfriends thread — it carries a block time like any other and must be clamped'
);
check(
	'11 …and the fallback-peer list still opens a no-order thread',
	/handleOpen\(peer, ''\)/.test(inbox),
	'no messages loaded there, so the clamp degrades to now — correct, not special-cased away'
);
check(
	'12 archiving passes the block time for BOTH thread shapes',
	/archiveThread\(row\.peer, order, row\.last_message_at\)/.test(inbox) &&
		/const order = row\.order\?\.permlink \?\? ''/.test(inbox),
	'one call site, both shapes — an order thread and a girlfriends thread archive identically'
);


// ── STARRED takes the same basis as ARCHIVED ───────────────────────
// [KEN, v1.7.7]: "you did not mention the Starred tab/folder though. did you
// forget about that one?"
//
// Not a live bug when he asked — resurrectArchivedOnNewActivity bails on
// `folder !== 'archived'`, so a starred `at` never met a block time. But:
//   1. `cap()` sorts EVERY entry by `at` to evict at MAX_ENTRIES, so once
//      archived clamped to max(now, blockTime) and starred stamped bare `now`,
//      that one sort compared two time bases. On a slow clock archived entries
//      stamp ahead of local now, sort newer, and STARRED is evicted first. The
//      v1.7.7 watermark fix introduced that skew — before it both were
//      `new Date()`: consistently wrong, but comparable.
//   2. Ken has floated resurrecting starred threads on new activity, which would
//      make a bare `now` here the archive bug over again.
check(
	'13 toggleStar accepts the block time to clamp against',
	/export function toggleStar\(peer: string, orderPermlink: string, lastMessageAt\?: string\)/.test(
		folders
	)
);
check(
	'14 …and hands it to setFolder, so starred shares ONE basis with archived',
	/setFolder\(peer, orderPermlink, isStarred\(peer, orderPermlink\) \? 'inbox' : 'starred', lastMessageAt\)/.test(
		folders
	),
	'cap() sorts every entry by `at` — two bases in one sort evicts the wrong entries'
);
check(
	'15 the inbox star passes the row block time',
	/toggleStar\(row\.peer, row\.order\?\.permlink \?\? '', row\.last_message_at\)/.test(inbox)
);
check(
	'16 the conversation star passes the newest confirmed message time',
	/toggleStar\(peer, orderPermlink \?\? '', seen !== null \? seen\.toISOString\(\) : undefined\)/.test(
		strip(read('apps/web/src/lib/components/ConversationView.svelte'))
	)
);


// ── the LAST-WRITE-WINS guard itself (the worst instance) ──────────
// [KEN, v1.7.7]: "if i have 20 messages sitting in my inbox, and i want every
// single one of them to move to Archived and i click on one archive link for
// each message every half second, then nothing will malfunction or break,
// right? ... experienced users will be clicking stuff pretty damn fast."
//
// The answer was no. `markLocalChange` stamped `Date.now()` and the sync
// compared it to `res.data.updated_at` (BLOCK time) to decide "am I ahead of the
// chain?". On a clock slower than the age of the chain's last write, that reads
// backwards, the sync adopts the chain's OLDER state, and every click still
// sitting in the 1.5s debounce is silently reverted. The v1.7.7 15s re-sync made
// it fire every 15 seconds instead of once per page load.
check(
	'17 the local-change stamp clamps to the newest block time this device has seen',
	/const seen = lastAdoptedAt === null \? NaN : new Date\(lastAdoptedAt\)\.getTime\(\);[\s\S]{0,200}?Math\.max\(Date\.now\(\), seen\)/.test(
		folders
	),
	'a bare Date.now() here lets a slow clock hand the user s un-broadcast clicks back to the chain'
);
check(
	'18 …and the guard uses <=, so an unchanged chain does not read as "ahead"',
	/chainAtMs <= localAtMs/.test(folders),
	'the watermark makes the common case EQUAL; `<` treated that as the chain being ahead'
);
check(
	'19 cross-device sync is NOT traded away — a genuinely newer chain still wins',
	/const chainAtMs = res\.data\.updated_at !== null \? new Date\(res\.data\.updated_at\)\.getTime\(\) : 0;/.test(
		folders
	),
	'a plain dirty BOOLEAN would fix the clock and lose the phone s star — the tests say so explicitly'
);
check(
	'20 broadcasts serialize (no older op landing in a later block)',
	/if \(broadcastInFlight\) \{[\s\S]{0,200}?broadcastQueued = true;/.test(folders)
);
// Pins the REQUIREMENT — the payload is read when the broadcast FIRES, not when
// it is scheduled — rather than the exact call expression. The first version
// spelled out `await broadcastChatFolders(id.live, mapToState(get(foldersStore)))`
// and broke the moment that call moved inside a Promise.race for the timeout: a
// correct change failing a check it never violated.
check(
	'21 …and the debounce reads the store at FIRE time, so a click spree is one batched op',
	/broadcastTimer = setTimeout\(\(\) => \{[\s\S]{0,80}?void broadcastNow\(\);/.test(folders) &&
		/broadcastChatFolders\(id\.live, mapToState\(get\(foldersStore\)\)\)/.test(folders)
);
check(
	'22 the local-change stamp clears only after a broadcast SUCCEEDS',
	/broadcastChatFolders\(id\.live, mapToState\(get\(foldersStore\)\)\)[\s\S]{0,500}?clearLocalChange\(\);/.test(
		folders
	) && !/clearLocalChange\(\);[\s\S]{0,200}?await Promise\.race/.test(folders),
	'clearing before confirmation lets the next sync adopt over a change that never left the device'
);
check(
	'23 a hung broadcast cannot deadlock every later change',
	/Promise\.race\(\[[\s\S]{0,300}?BROADCAST_TIMEOUT_MS/.test(folders),
	'the in-flight guard has no way out without this: one request that never settles queues every folder change for the rest of the session'
);
check(
	'24 the newest-seen block time is PERSISTED, so the watermark survives a refresh',
	/const LAST_ADOPTED_KEY = 'morphit\.chat\.folders\.lastAdoptedAt';/.test(folders) &&
		/let lastAdoptedAt: string \| null = safeLocal\.get\(LAST_ADOPTED_KEY\);/.test(folders),
	'module state dies with the tab; archiving right after a refresh then had nothing to clamp against'
);


// ── ADVERSARIAL: a block time from the network is UNTRUSTED ────────
// [KEN, v1.7.7]: "when we do the walkthroughs and deep deep before a release,
// this is exactly the type of thing that a black hat would try to do. he wants
// to break things."
//
// Morphit is FEDERATED — `last_message_at` arrives from whichever operator's
// indexer the user picked, and v1.7.7 made it load-bearing in three places at
// once: the read cursor, the archive watermark, and cap()'s eviction order.
// "My operator is honest" is the one assumption this project refuses to make
// everywhere else, and these consumers were making it.
//
// The dangerous one is the CURSOR. `last_message_at: '2099-01-01'` → the user
// opens the thread → readAckTimestamp clamps the cursor UP to 2099 → every
// genuine message afterwards reads as already-seen. No badge, no border, no
// notification: the user goes silently deaf. In a marketplace that is a
// counterparty's payment message you never see, an order that expires, and a
// dispute you lose.
check(
	'25 block times from the network are sanitised before use',
	/export function sanitizeBlockTime\(/.test(readState) &&
		/if \(t > now \+ MAX_FUTURE_SKEW_MS\) return null;/.test(readState),
	'a chain fact cannot lead our clock — anything materially ahead of now is a lie or a bug'
);
check(
	'26 the READ CURSOR sanitises before clamping (the deafening vector)',
	/const seen = sanitizeBlockTime\(latestSeenAt, now\.getTime\(\)\);/.test(readState),
	'max(seen, now) hands a poisoned future timestamp straight into the cursor'
);
check(
	'27 the archive watermark sanitises before clamping',
	/const seenDate = sanitizeBlockTime\(lastMessageAt, now\);/.test(folders),
	'an unsanitised future watermark can never resurrect and never be evicted by cap()'
);
check(
	'28 …and the tolerance is generous enough for an honest slow clock',
	(() => {
		const m = /const MAX_FUTURE_SKEW_MS = ([0-9 *_]+);/.exec(readState);
		if (!m) return false;
		// eslint-disable-next-line no-eval
		const ms = Number(eval(m[1]!.replace(/_/g, '')));
		return ms >= 5 * 60_000 && ms <= 24 * 60 * 60_000;
	})(),
	'too tight and a user with a slow PC cannot read their chat; too loose and it stops defending anything'
);


// ── the INVERSE vector (found in the Charlie walkthrough) ─────────
// Sanitising the cursor closed the deafening vector and opened a smaller one:
// `isUnread` still compared the RAW `last_message_at`, so a hostile `2099` kept
// `2099 > cursor` true forever — a badge the user could never clear, on a thread
// that would not stop shouting. Severity fell from dangerous to maddening; it did
// not reach zero. Half a fix, and it took walking the code as an attacker rather
// than as a user to see it.
check(
	'29 isUnread sanitises its timestamp too (no unclearable badge)',
	/const at = sanitizeBlockTime\(lastMessageAt\);/.test(readState) &&
		/const atMs = at === null \? Date\.now\(\) : at\.getTime\(\);/.test(readState),
	'an untrustworthy stamp read as `now` counts as unread until opened, then clears — like any other message'
);
check(
	'30 …and a PAST lie still cannot silence a real message',
	/latestSeenAt/.test(readState) && /\.getTime\(\) > now\.getTime\(\) \?/.test(readState),
	'both consumers floor at now, so a past lie can only fail to advance the cursor'
);

// ── the inbox slide must not fire on arrival (Bob walkthrough) ────
const inboxPage = strip(read('apps/web/src/routes/[lang]/chat/+page.svelte'));
check(
	'31 the first paint does not animate',
	/if \(!listReady\) return 0;/.test(inboxPage) &&
		/if \(firstFill\) void tick\(\)\.then\(\(\) => \(listReady = true\)\);/.test(inboxPage),
	'the list arrives from a fetch, so every card is CREATED after mount and intros play: 20 cards sliding in on every load'
);

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} block-time-vs-wall-clock checks passed`);
else { console.error(`\u2717 ${fail} of ${pass + fail} block-time-vs-wall-clock checks FAILED`); process.exit(1); }
