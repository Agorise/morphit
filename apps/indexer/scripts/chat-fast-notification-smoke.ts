/**
 * chat-fast-notification-smoke (cp471) — the fast head-block notification path
 * must be a SAFE SUBSET of the durable path's admission, or it becomes a
 * notification-spam vector. This guard pins every safety property structurally
 * (comment-stripped, so a comment can't satisfy an assertion), so a future
 * refactor that removes a gate, drops the dedup, or unshares the order check
 * fails loudly.
 *
 * Properties pinned:
 *   • dedup: enqueueChatPush INSERTs source_trx_id with ON CONFLICT DO NOTHING;
 *     BOTH paths pass the on-chain trx id — one notification, fast when the
 *     tailer wins.
 *   • block gate: the tailer drops a blocked sender BEFORE it emits or
 *     fast-notifies (block-check < emit < maybeFastNotify).
 *   • stranger gate: maybeFastNotify returns without enqueuing unless there is
 *     a prior exchange OR an order-response bypass (a first-contact stranger is
 *     never fast-notified).
 *   • order validity: maybeFastNotify returns on a tag that names no real owned
 *     order (which the durable path rejects).
 *   • no divergence: order validity lives ONCE in chatGates.checkChatOrder;
 *     both chat.ts and the tailer call it.
 *   • self-chat guard in the shared enqueue.
 *   • badge: the SW pokes every tab (CHAT_PUSH) + sets the OS app-badge; the
 *     page treats CHAT_PUSH as a chat-activity ping (fire()).
 *   • migration v43 present in migrations.ts AND schema.sql.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // apps/indexer
const WEB = join(ROOT, '..', 'web');

let failures = 0;
let scenarios = 0;
function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${String((err as Error)?.message ?? err)}`);
	}
}
function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}
function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
function read(abs: string): string {
	return stripComments(readFileSync(abs, 'utf8'));
}

const chat = read(join(ROOT, 'src/indexer/handlers/chat.ts'));
const tailer = read(join(ROOT, 'src/indexer/chatHeadTailer.ts'));
const gates = read(join(ROOT, 'src/indexer/chatGates.ts'));
const enqueue = read(join(ROOT, 'src/indexer/chatPushEnqueue.ts'));
const migrations = read(join(ROOT, 'src/db/migrations.ts'));
const schema = readFileSync(join(ROOT, 'src/db/schema.sql'), 'utf8'); // SQL comments kept
const sw = read(join(WEB, 'src/service-worker.ts'));
const globalStream = read(join(WEB, 'src/lib/chat/globalChatActivityStream.ts'));

// ── Dedup ────────────────────────────────────────────────────────────
scenario('enqueueChatPush INSERTs source_trx_id with ON CONFLICT DO NOTHING', () => {
	assert(/INSERT INTO push_pending/.test(enqueue), 'enqueue does not INSERT push_pending');
	assert(enqueue.includes('source_trx_id'), 'enqueue INSERT omits source_trx_id (the dedup key)');
	assert(
		/ON CONFLICT \(account, source_trx_id\)[\s\S]*DO NOTHING/.test(enqueue),
		'enqueue INSERT lacks ON CONFLICT (account, source_trx_id) … DO NOTHING'
	);
});
scenario('durable chat.ts passes ctx.trxId as the dedup key', () => {
	assert(chat.includes('enqueueChatPush(client'), 'chat.ts does not call the shared enqueue');
	assert(chat.includes('sourceTrxId: ctx.trxId'), 'chat.ts does not pass ctx.trxId to enqueue');
});
scenario('fast tailer passes the block trx id as the dedup key', () => {
	assert(tailer.includes('enqueueChatPush(this.db'), 'tailer does not call the shared enqueue');
	assert(tailer.includes('block.transaction_ids[ti]'), 'tailer does not read the on-chain trx id');
	assert(tailer.includes('sourceTrxId: trxId'), 'tailer does not pass the trx id to enqueue');
});

// ── Block gate: blocked sender never emitted or fast-notified ─────────
scenario('tailer block-check precedes emit precedes maybeFastNotify', () => {
	const block = tailer.indexOf('this.recipientBlockedSender(located.recipient');
	const emit = tailer.indexOf('chatEventBus.emitFast(');
	const notify = tailer.indexOf('this.maybeFastNotify(located');
	assert(block !== -1, 'no recipientBlockedSender call in scanBlock');
	assert(emit !== -1, 'no emitFast call');
	assert(notify !== -1, 'no maybeFastNotify call');
	assert(block < emit, 'block-check does not precede emit');
	assert(emit < notify, 'emit does not precede maybeFastNotify (a blocked/continue’d op could fast-notify)');
});
scenario('tailer drops a blocked sender with continue', () => {
	assert(/if \(blocked\) \{[\s\S]*?continue;/.test(tailer), 'tailer does not continue on blocked');
});

// ── Stranger gate: no fast push for a first-contact stranger ─────────
scenario('maybeFastNotify fast-notifies only on recipient-reply OR order-response bypass', () => {
	assert(
		tailer.includes('if (!recipientReplied && !orderResponseBypass) return'),
		'maybeFastNotify lacks the (recipientReplied || orderResponseBypass) safe gate'
	);
	assert(tailer.includes('recipientHasReplied(this.db'), 'maybeFastNotify does not check recipient-reply');
});
scenario('maybeFastNotify returns on a bogus order tag (durable would reject)', () => {
	assert(tailer.includes('if (!oc.found) return'), 'maybeFastNotify does not skip an invalid order tag');
});

// ── No divergence: order validity has ONE implementation ─────────────
scenario('checkChatOrder is the single order-validity impl (query lives in chatGates)', () => {
	assert(/FROM orders/.test(gates) && gates.includes('account IN ($2, $4)'), 'chatGates lacks the order query');
	assert(chat.includes('checkChatOrder(client'), 'chat.ts does not delegate to checkChatOrder');
	assert(tailer.includes('checkChatOrder(this.db'), 'tailer does not use the shared checkChatOrder');
	assert(!chat.includes('account IN ($2, $4)'), 'chat.ts still has an inline order query (divergence risk)');
});
scenario('recipientHasReplied is DIRECTIONAL (recipient→sender) + uses the pair index', () => {
	assert(
		/LEAST\(sender, recipient\)[\s\S]*GREATEST\(sender, recipient\)[\s\S]*AND sender = \$1/.test(gates),
		'recipientHasReplied is not directional / does not use the pair index'
	);
	// guard against regressing to a bidirectional (one-way-spammable) check
	assert(!/hasPriorExchange/.test(gates), 'bidirectional hasPriorExchange resurfaced');
	assert(!/hasPriorExchange/.test(tailer), 'tailer still references bidirectional hasPriorExchange');
});

// ── Self-chat guard ──────────────────────────────────────────────────
scenario('enqueueChatPush refuses self-chat', () => {
	assert(
		enqueue.includes('if (params.recipient === params.sender) return'),
		'enqueue lacks the self-chat guard'
	);
});

// ── Badge: SW pokes tabs + sets OS badge; page treats it as a ping ───
scenario('service worker pokes every tab with CHAT_PUSH on push', () => {
	assert(sw.includes("addEventListener('push'"), 'no SW push handler');
	assert(sw.includes('matchAll('), 'SW does not enumerate tabs');
	assert(/postMessage\(\{ type: 'CHAT_PUSH'/.test(sw), 'SW does not postMessage CHAT_PUSH');
});
scenario('service worker sets the OS app-badge on push', () => {
	assert(sw.includes('setAppBadge'), 'SW does not set the OS app-badge');
});
scenario('page treats a CHAT_PUSH message as a chat-activity ping (fire)', () => {
	assert(globalStream.includes("data.type === 'CHAT_PUSH'"), 'page does not listen for CHAT_PUSH');
	assert(
		/CHAT_PUSH'\) fire\(\)/.test(globalStream) || /CHAT_PUSH[\s\S]{0,40}fire\(\)/.test(globalStream),
		'page does not fire() on CHAT_PUSH'
	);
	assert(globalStream.includes("serviceWorker") && globalStream.includes("'message'"), 'page does not bind the SW message channel');
});

// ── Migration v43 present in BOTH migrations.ts and schema.sql ────────
scenario('migration v43 adds source_trx_id + partial unique index (migrations.ts)', () => {
	assert(/version:\s*43/.test(migrations), 'migrations.ts has no version 43');
	assert(migrations.includes('push_pending') && migrations.includes('source_trx_id'), 'v43 does not touch push_pending.source_trx_id');
	assert(
		migrations.includes('push_pending_account_source_trx_uidx'),
		'v43 lacks the partial unique index'
	);
});
scenario('schema.sql has the idempotent source_trx_id block', () => {
	assert(schema.includes('push_pending_account_source_trx_uidx'), 'schema.sql lacks the source_trx_id unique index');
	assert(/ADD COLUMN IF NOT EXISTS source_trx_id/.test(schema), 'schema.sql lacks the idempotent column add');
});

if (failures === 0) {
	console.log(`✓ all ${scenarios} chat-fast-notification scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures} of ${scenarios} chat-fast-notification checks FAILED`);
	process.exit(1);
}
