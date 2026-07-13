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

if (failures === 0) {
	console.log(`✓ all ${total} chat-folders-onchain scenarios passed`);
} else {
	console.log(`\n✗ ${failures} of ${total} chat-folders-onchain checks FAILED`);
	process.exit(1);
}
