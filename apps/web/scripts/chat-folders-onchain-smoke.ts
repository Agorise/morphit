/**
 * chat-folders-onchain-smoke — v1.4.9 (t.txt #5)
 *
 * Pins the end-to-end wiring of on-chain chat folders (morphit_chat_folders_v1)
 * so no layer can silently fall out of sync: the op id (client + indexer), the
 * indexer handler + its registration + the v42 migration (BOTH migrations.ts and
 * the schema.sql baseline) + the mounted endpoint, the client fetch, the
 * posting-key-derived ENCRYPTION (not plaintext, not the memo key), and the
 * flipped default (Archived).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p: string): string => readFileSync(join(repo, p), 'utf8');

let failures = 0;
let total = 0;
function check(name: string, cond: boolean): void {
	total++;
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (!cond) failures++;
}

const OP = 'morphit_chat_folders_v1';

// ── Op id: client + indexer must agree ──
const netConfig = read('apps/web/src/lib/net/config.ts');
check('client OP_IDS has chatFolders → ' + OP, new RegExp(`chatFolders:\\s*'${OP}'`).test(netConfig));

const dispatcher = read('apps/indexer/src/indexer/dispatcher.ts');
check('indexer dispatcher OP_IDS has chatFolders', new RegExp(`chatFolders:\\s*'${OP}'`).test(dispatcher));
check(
	'indexer dispatcher maps the op to a handler',
	/\[OP_IDS\.chatFolders\]:\s*chatFoldersHandler/.test(dispatcher) &&
		/import chatFoldersHandler from/.test(dispatcher)
);

// ── Handler: exists + validates ──
const handler = read('apps/indexer/src/indexer/handlers/chatFolders.ts');
check('handler rejects unsupported version', /version_unsupported/.test(handler));
check('handler bounds the ciphertext size', /enc_too_large/.test(handler) && /96 \* 1024/.test(handler));
check(
	'handler upserts chat_folders latest-by-block',
	/INSERT INTO chat_folders/.test(handler) &&
		/source_block_num < EXCLUDED\.source_block_num/.test(handler)
);

// ── Migration: BOTH migrations.ts and schema.sql baseline ──
const migrations = read('apps/indexer/src/db/migrations.ts');
check(
	'migrations.ts adds v42 creating chat_folders',
	/version:\s*42/.test(migrations) && /CREATE TABLE IF NOT EXISTS chat_folders/.test(migrations)
);
const schema = read('apps/indexer/src/db/schema.sql');
check(
	'schema.sql baseline creates chat_folders',
	/CREATE TABLE IF NOT EXISTS chat_folders/.test(schema)
);
// The baseline (fresh DB) and the migration (existing DB) MUST agree on the
// column shape, or a migrated node and a fresh node silently diverge.
for (const [label, src] of [
	['migrations.ts', migrations],
	['schema.sql', schema]
] as const) {
	const table = src.slice(src.indexOf('CREATE TABLE IF NOT EXISTS chat_folders'));
	check(
		`${label} chat_folders has the agreed columns (account PK, enc, source_block_num, source_trx_id)`,
		/account TEXT PRIMARY KEY/.test(table) &&
			/enc TEXT NOT NULL/.test(table) &&
			/source_block_num BIGINT NOT NULL/.test(table) &&
			/source_trx_id TEXT NOT NULL/.test(table)
	);
}

// ── Endpoint: mounted + client fetch ──
const main = read('apps/indexer/src/main.ts');
check(
	"endpoint mounted at /v1/chat-folders (rate-limited)",
	/\/v1\/chat-folders/.test(main) && /chatFoldersRoute/.test(main)
);
const client = read('apps/web/src/lib/indexer/client.ts');
check('client exposes getChatFolders', /export function getChatFolders/.test(client));

// ── Encryption: posting-key-derived, domain-separated (NOT plaintext, NOT memo) ──
const folderCrypto = read('apps/web/src/lib/chat/folderCrypto.ts');
// Strip comments — the doc comment legitimately explains that the memo key is
// NOT used; we only care that no CODE references it.
const folderCryptoCode = folderCrypto
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/\/\/.*$/gm, '');
check(
	'folder state is encrypted with a posting-key-derived key (BLAKE2b keyed)',
	/crypto_generichash\(32, info, postingPriv\)/.test(folderCrypto) &&
		/morphit-chat-folders-v1\/state\//.test(folderCrypto)
);
check('folderCrypto code never uses the memo key', !/memo/i.test(folderCryptoCode));
const broadcaster = read('apps/web/src/lib/blurt/ops/chatFolders.ts');
check(
	'broadcaster encrypts before broadcasting (no plaintext lists on chain)',
	/encryptFolderState\(live\.posting\.privateKey/.test(broadcaster)
);
check(
	'the on-chain op body is exactly { v: 1, enc } — never the raw state',
	/broadcastCustomJson\(\s*live,\s*OP_IDS\.chatFolders,\s*\{\s*v:\s*1,\s*enc\s*\}/.test(broadcaster) &&
		!/broadcastCustomJson\([^)]*starred/.test(broadcaster) &&
		!/broadcastCustomJson\([^)]*archived/.test(broadcaster)
);

// ── Default is Inbox (safe default — new/unfiled threads stay visible) ──
const chatFolders = read('apps/web/src/lib/chat/chatFolders.ts');
check(
	"folderOf defaults to 'inbox' (absence from the map — new threads never auto-hide)",
	/return entry \? entry\.folder : 'inbox'/.test(chatFolders)
);
check(
	'on-chain state records only the filed folders (starred + archived)',
	/starred:\s*readonly string\[\]/.test(broadcaster) &&
		/archived:\s*readonly string\[\]/.test(broadcaster)
);
check(
	'chatFolders wires the on-chain sync + a migration path',
	/export async function syncChatFoldersFromChain/.test(chatFolders) &&
		/getChatFolders\(account\)/.test(chatFolders)
);
// The inbox page is already read at the top of this file — reuse it.
const inbox = read('apps/web/src/routes/[lang]/chat/+page.svelte');
check(
	'the inbox calls syncChatFoldersFromChain when unlocked',
	/syncChatFoldersFromChain\(\)/.test(inbox) && /\$isUnlocked/.test(inbox)
);

// v1.4.10 — Gmail-style un-archive on new activity.
check(
	'chatFolders resurrects archived threads on newer activity (compares lastMessageAt to archived-at)',
	/export function resurrectArchivedOnNewActivity/.test(chatFolders) &&
		/lastMsgMs > archivedAtMs/.test(chatFolders)
);
check(
	'the inbox runs the resurrect over the conversation list',
	/resurrectArchivedOnNewActivity\(/.test(inbox) && /last_message_at/.test(inbox)
);
check(
	'the GLOBAL unread channel runs the resurrect too (badge fires on any page / hidden tab)',
	/resurrectArchivedOnNewActivity\(/.test(read('apps/web/src/lib/notifications/chatUnread.ts'))
);
check(
	'the badge counts STARRED threads too — its predicate excludes only archived, never starred',
	/return !isArchived\(/.test(read('apps/web/src/lib/notifications/chatUnread.ts')) &&
		!/isStarred|=== 'starred'/.test(
			read('apps/web/src/lib/notifications/chatUnread.ts')
				.split('function badgeEligible')[1]
				?.split('function recount')[0] ?? ''
		)
);

// ── v1.7.7: the archive watermark must not mix TIME BASES ──────────
// Ken's kentest3: archive a thread, refresh a minute later, it is BACK in the
// Inbox; archive again and it sticks. kentest2 never reproduced it on identical
// code — because it was never the code, never the older Brave build, never a
// cache. It was his CLOCK. `resurrectArchivedOnNewActivity` compares a folder
// entry's `at` against a thread's `last_message_at` (a BLOCK time), and `at` was
// stamped `new Date()` — the user's LOCAL WALL CLOCK. A slow clock writes a
// watermark EARLIER than the message already sitting in the thread, and the
// resurrect rule reads that as "new activity since you archived".
//
// Pin the requirement: the watermark is measured in the same units it is
// compared against, and can never sit behind a message already in the thread.
// `chatFolders` is already read at the top of this file — reuse it rather than
// opening the same file twice under a second name.
const folders = chatFolders;
check(
	'archive watermark clamps to the newest KNOWN message time (no wall-clock vs block-time compare)',
	// v1.7.7 — pins the REQUIREMENT (clamp UP to the newest known message time)
	// rather than the variable name. `Math.max(now, seen)` broke when the hostile-
	// timestamp sanitiser renamed the local to `seenDate` — a change that closes a
	// federation vector, not one that weakens this.
	/function watermark\([\s\S]{0,700}?Math\.max\(now, seen(Date\.getTime\(\)|)\)/.test(folders)
);
// An unsanitised far-future last_message_at makes an archived thread
// unresurrectable (nothing is ever "newer" than 2099) and immune to cap()'s
// eviction (it sorts newest forever). This file's check() takes no detail
// argument — the name has to carry the meaning.
check(
	'…and the value it clamps against is SANITISED (a federated indexer is not trusted)',
	/const seenDate = sanitizeBlockTime\(lastMessageAt, now\);/.test(folders)
);
check(
	'setFolder stamps via watermark(), never bare new Date()',
	/next\[key\] = \{ folder, at: watermark\(lastMessageAt\) \}/.test(folders) &&
		!/next\[key\] = \{ folder, at: new Date\(\)\.toISOString\(\) \}/.test(folders)
);
check(
	'archiveThread accepts the block time to clamp against',
	/export function archiveThread\(\s*peer: string,\s*orderPermlink: string,\s*lastMessageAt\?: string\s*\)/.test(
		folders
	) || /export function archiveThread\(peer: string, orderPermlink: string, lastMessageAt\?: string\)/.test(folders)
);
check(
	'the resurrect rule survives the fix (a genuinely newer message still surfaces)',
	/lastMsgMs > archivedAtMs/.test(folders)
);

// ── v1.7.7 (t.txt #5): folder moves must PROPAGATE, not just publish ──
// Ken: archived on his PC, phone kept the thread in the Inbox "even after a few
// minutes" until he manually refreshed. The publish side was fine — the op was
// on chain. The READ side ran exactly once, from a $effect that fired when
// $isUnlocked flipped true. One read per page load.
//
// Ken also named the asymmetry that explains it: un-archive DID cross devices
// without a refresh. That was never syncing — resurrectArchivedOnNewActivity
// RE-DERIVES it locally on every 5s conversation poll from data the device
// already has. Archiving cannot be re-derived; it is a decision, and it only
// exists on chain. Nothing re-read the chain.
check(
	'the inbox RE-syncs folder state on an interval, not once per page load',
	/setInterval\(\(\) => void syncChatFoldersFromChain\(\), FOLDER_SYNC_MS\)/.test(inbox)
);
check(
	'…and clears that interval on teardown',
	/return \(\) => clearInterval\(t\)/.test(inbox)
);
check(
	'…at an interval a human reads as "it just moved" (<= 20s)',
	(() => {
		const m = /const FOLDER_SYNC_MS = ([0-9_]+);/.exec(inbox);
		if (!m) return false;
		const ms = Number(m[1].replace(/_/g, ''));
		return ms > 0 && ms <= 20_000;
	})()
);
check(
	'a repeat sync SKIPS the posting-key decrypt when the chain has not moved',
	/if \(lastAdoptedAt !== null && res\.data\.updated_at === lastAdoptedAt\) return;/.test(
		chatFolders
	)
);
check(
	'…keyed on updated_at, never on the enc ciphertext',
	!/=== lastAdoptedEnc/.test(chatFolders)
);
// v1.7.7 — the memo now goes through setLastAdoptedAt() because it is PERSISTED
// (module state died with the tab, which left the watermark nothing to clamp
// against right after a refresh). Pin the requirement — set only inside the
// successful-adopt branch — not the assignment syntax.
check(
	'…and the memo is set only on a SUCCESSFUL adopt',
	/isFolderState\(decrypted\)\) \{[\s\S]{0,500}?setLastAdoptedAt\(res\.data\.updated_at\);/.test(
		chatFolders
	)
);
check(
	'…and dies with the folder store (per-account state)',
	/syncedThisSession = false;[\s\S]{0,500}?setLastAdoptedAt\(null\);/.test(chatFolders)
);

if (failures === 0) {
	console.log(`✓ all ${total} chat-folders-onchain scenarios passed`);
} else {
	console.log(`\n✗ ${failures} of ${total} chat-folders-onchain checks FAILED`);
	process.exit(1);
}
