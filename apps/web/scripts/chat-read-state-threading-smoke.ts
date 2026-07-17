#!/usr/bin/env tsx
/**
 * Smoke: read state is per DISCUSSION, not per person (cp446, Ken).
 *
 * "If I read one thread from a user, it should not mark other threads with that
 * user as read. Think of it like email."
 *
 * This crosses a signed on-chain op (`morphit_chat_read_v1`), so the guards here
 * are about COMPATIBILITY as much as behaviour:
 *
 *   '*'  — a legacy peer-wide ack. What every pre-cp446 client sent, and what an
 *          old client still sends today. A client may NOT forge one.
 *   ''   — the thread that cites no order. A real thread of its own.
 *   else — the permlink of the order that thread is about.
 *
 * Two silent regressions this exists to catch:
 *   1. attributing a legacy ack (no order field) to the order-less thread —
 *      every other thread with that peer would look unread forever;
 *   2. dropping legacy localStorage keys instead of migrating them — every
 *      existing user's inbox lights up unread on upgrade day.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');
const REPO = join(WEB, '..', '..');

const strip = (src: string): string =>
	src
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
		.join('\n');

const store = strip(readFileSync(join(WEB, 'src', 'lib', 'chat', 'readState.ts'), 'utf8'));
const op = strip(readFileSync(join(WEB, 'src', 'lib', 'blurt', 'ops', 'chatRead.ts'), 'utf8'));
const view = strip(readFileSync(join(WEB, 'src', 'lib', 'components', 'ConversationView.svelte'), 'utf8'));
const thread = strip(readFileSync(join(WEB, 'src', 'routes', '[lang]', 'chat', '[peer=account]', '+page.svelte'), 'utf8'));
const inbox = strip(readFileSync(join(WEB, 'src', 'routes', '[lang]', 'chat', '+page.svelte'), 'utf8'));
const badge = strip(readFileSync(join(WEB, 'src', 'lib', 'notifications', 'chatUnread.ts'), 'utf8'));
const handler = strip(readFileSync(join(REPO, 'apps', 'indexer', 'src', 'indexer', 'handlers', 'chatRead.ts'), 'utf8'));
const api = strip(readFileSync(join(REPO, 'apps', 'indexer', 'src', 'api', 'chatReadState.ts'), 'utf8'));
const migrations = strip(readFileSync(join(REPO, 'apps', 'indexer', 'src', 'db', 'migrations.ts'), 'utf8'));
const schema = readFileSync(join(REPO, 'apps', 'indexer', 'src', 'db', 'schema.sql'), 'utf8');

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean): void => {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.error(`  \u2717 ${name}`);
	}
};

// ─── the store keys a DISCUSSION ─────────────────────────────────────
check('a read-state key is (peer, order), not a peer', /function threadKey\(peer: string, orderPermlink: string\)/.test(store));
check('…separated by NUL, which no name or permlink can contain', /\$\{peer\}\\u0000\$\{orderPermlink\}/.test(store));
check('the peer-wide sentinel is reserved', /export const PEER_WIDE = '\*';/.test(store));
check('unread honours BOTH this thread\u2019s ack and any peer-wide ack', /const own = state\[threadKey\(peer, orderPermlink\)\]/.test(store) && /const wide = state\[threadKey\(peer, PEER_WIDE\)\]/.test(store));
check('…taking the LATER of the two, so a thread can never be un-read', /new Date\(own\)\.getTime\(\) >= new Date\(wide\)\.getTime\(\) \? own : wide/.test(store));
check('a caller cannot forge a peer-wide ack', /if \(orderPermlink === PEER_WIDE \|\| orderPermlink\.length > 256\) return;/.test(store));

// ─── upgrade day: nothing lights up unread ───────────────────────────
check('a legacy bare-peer localStorage key is MIGRATED, not dropped', /out\[`\$\{k\}\\u0000\$\{PEER_WIDE\}`\] = v;/.test(store));
check('…and a remote ack with no order field is peer-wide, not order-less', /const order = entry\.order_permlink \?\? PEER_WIDE;/.test(store));

// ─── the on-chain op ─────────────────────────────────────────────────
check('the ack names the discussion it acknowledges', /readonly order_permlink: string;/.test(op));
check('broadcastChatRead takes the thread', /orderPermlink: string,/.test(op));
check('…and refuses to broadcast the reserved sentinel', /orderPermlink === '\*' \|\| orderPermlink\.length > 256/.test(op));

// ─── indexer: handler + storage + read endpoint ──────────────────────
check('the handler treats a MISSING order field as a legacy peer-wide ack', /orderPermlink = '\*'; /.test(handler) || /orderPermlink = '\*';/.test(handler));
check('…and rejects a client that tries to send the sentinel itself', /rawOrder === '\*'/.test(handler));
check('the upsert is keyed on (reader, peer, order)', /ON CONFLICT \(reader_account, peer_account, order_permlink\) DO UPDATE/.test(handler));
check('…and still advances monotonically', /WHERE chat_read_state\.last_read_at < EXCLUDED\.last_read_at/.test(handler));
check('the read endpoint returns the discussion', /SELECT peer_account AS peer, order_permlink, last_read_at/.test(api));

// ─── schema + migration ──────────────────────────────────────────────
check('migration 39 adds the column and re-keys the PK', /version: 39/.test(migrations) && /ADD PRIMARY KEY \(reader_account, peer_account, order_permlink\)/.test(migrations));
check('…defaulting existing rows to the peer-wide sentinel', /ADD COLUMN IF NOT EXISTS order_permlink TEXT NOT NULL DEFAULT '\*'/.test(migrations));
// schema.sql keeps the v1 baseline table and APPENDS each v37+ change as its
// own section (the v38 convention). So the v39 DDL lives at the bottom, not
// inside CREATE TABLE — asserting the latter would have quietly passed on a
// schema that never re-keys the PK.
check('schema.sql carries the v39 section', /-- \u2500\u2500\u2500 v39: chat read-state is per DISCUSSION/.test(schema));
check('…which adds the column with the peer-wide default', /ADD COLUMN IF NOT EXISTS order_permlink TEXT NOT NULL DEFAULT '\*'/.test(schema));
check('…and re-keys the primary key', /ADD PRIMARY KEY \(reader_account, peer_account, order_permlink\)/.test(schema));
check('…and warns about the indexer downgrade hazard', /DOWNGRADE HAZARD/.test(schema));

// ─── every caller passes the thread ──────────────────────────────────
check('the conversation view acks the thread it is showing', /markConversationRead\(peer, orderPermlink \?\? '', readAckTimestamp/.test(view));
check('the thread route acks on-chain with the order', /broadcastChatRead\(live, peer, orderPermlink \?\? ''\)/.test(thread));
check('the inbox marks one discussion read, not a person', /function handleOpen\(peer: string, orderPermlink: string\)/.test(inbox));
check('mark-all-read walks discussions', /markConversationRead\(c\.peer, c\.order\?\.permlink \?\? '', now\)/.test(inbox));
check(
	'the unread badge counts unread discussions, excluding archived (t.txt 10)',
	/const order = c\.order\?\.permlink \?\? '';/.test(badge) &&
		/isArchived\(c\.peer, order\)/.test(badge) &&
		// v1.7.5 (t.txt #2) — this used to pin the THREE-arg
		// `isUnread(c.peer, order, c.last_message_at)`, which is the call
		// signature from BEFORE the cross-device fix. `isUnread` could not see
		// who sent the last message, so a message you sent from your PC came
		// back as unread on your phone: the per-device cursor had never seen it.
		// The fix made `lastMessageIsMine` a REQUIRED 4th argument, and this
		// check failed — the guard was pinning the bug's shape.
		//
		// Pin the requirement instead: the badge must pass the thread AND must
		// tell isUnread whose message it was. Both properties, neither literal.
		/isUnread\(\s*c\.peer,\s*order,\s*c\.last_message_at,\s*c\.last_message_is_mine/.test(badge)
);

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} chat-read-state-threading scenarios passed`);
else {
	console.error(`\u2717 ${fail} of ${pass + fail} chat-read-state-threading checks FAILED`);
	process.exit(1);
}
