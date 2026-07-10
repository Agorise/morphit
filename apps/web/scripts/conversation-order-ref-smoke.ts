/**
 * conversation-order-ref — cp423.
 *
 * Pins the cross-stack wiring for the chat-inbox "RE: <order title>" subline
 * (the small linked order title shown under a peer's handle when the
 * conversation is about a specific order). The pieces span three workspaces
 * and are easy to break in isolation:
 *
 *   1. INDEXER (src/api/conversations.ts) — the query must surface, per
 *      conversation, the latest order_permlink + the OWNER (= that message's
 *      recipient, per chat.ts's validator) via the orders LEFT JOIN, and map
 *      it into an `order` field on the response.
 *   2. CLIENT (@morphit/indexer-client) — ConversationSummary must carry the
 *      nullable `order` field, and ConversationOrderRef must expose the fiat
 *      band fields orderTitleParts needs.
 *   3. FRONTEND (chat/+page.svelte) — must render the RE: subline (gated on
 *      convo.order), link it to the order detail page, and use the
 *      chat.inbox.re_prefix key.
 *   4. LOCALES — chat.inbox.re_prefix present in all 10.
 *
 * The DB behaviour itself (which order, recipient=owner, both directions,
 * cancelled-still-shown, join-miss→null) is covered by the integration test
 * apps/indexer/test/integration/conversations.test.ts. This smoke guards the
 * wiring around it against a future refactor that removes/renames a piece.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');

function read(rel: string): string {
	return readFileSync(join(repo, rel), 'utf8');
}

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
	if (cond) {
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
		failures++;
	}
}

// ─── 1. Indexer conversations query + mapping ──────────────────────────
const conv = read('apps/indexer/src/api/conversations.ts');

// cp446 — the owner is whichever PARTY owns an order with that permlink. The old
// query took `m.recipient` from the newest citing message: correct for the FIRST
// message of a thread, wrong for every reply, because once the owner answers the
// recipient is the other person. Integration-tested against a reply.
check('the order owner is resolved from either party, not from the recipient', /ord\.account IN \(\$1, g\.peer\)/.test(conv));
check('…and NOT via the old recipient-as-owner assumption', !/m\.recipient AS order_owner/.test(conv));
check('one row per discussion: GROUP BY (peer, order_permlink)', /GROUP BY peer, order_permlink/.test(conv));
check(
	'indexer query selects the latest order permlink (AS order_permlink)',
	/AS\s+order_permlink/.test(conv)
);
// cp446 — REPINNED. These pinned `o.account = lm.order_owner` and
// `m.recipient AS order_owner`, i.e. "the recipient of the newest citing message
// owns the order". True for the FIRST message of a thread, false for every
// reply. The query now resolves the owner as whichever PARTY owns an order with
// that permlink.
check(
	'indexer joins the order via LATERAL, gated on a non-null permlink',
	/LEFT JOIN LATERAL/.test(conv) && /g\.order_permlink\s+IS\s+NOT\s+NULL/.test(conv)
);
check(
	'indexer resolves the order owner from either party, not from the recipient',
	/ord\.account IN \(\$1, g\.peer\)/.test(conv) && !/m\.recipient\s+AS\s+order_owner/.test(conv)
);
check(
	'indexer maps an `order` field, gated on a non-null permlink',
	/order:\s*\n?\s*r\.order_permlink\s*!==\s*null/.test(conv) || /order:\s*r\.order_permlink\s*!==\s*null/.test(conv)
);
check(
	'indexer casts the fiat amounts to text (for the client Number() parse)',
	/order_amount_min/.test(conv) && /::text/.test(conv)
);

// ─── 2. Client type ────────────────────────────────────────────────────
const client = read('packages/indexer-client/src/index.ts');
check('client exports interface ConversationOrderRef', /interface\s+ConversationOrderRef/.test(client));
check(
	'ConversationOrderRef carries permlink + account (link target)',
	/interface\s+ConversationOrderRef[\s\S]*?permlink\s*:/.test(client) &&
		/interface\s+ConversationOrderRef[\s\S]*?account\s*:/.test(client)
);
check(
	'ConversationOrderRef carries the fiat band fields orderTitleParts needs',
	/interface\s+ConversationOrderRef[\s\S]*?side\s*:[\s\S]*?asset\s*:[\s\S]*?fiat_currency\s*:[\s\S]*?amount_min\s*:[\s\S]*?amount_max\s*:/.test(
		client
	)
);
check(
	'ConversationSummary carries a nullable `order: ConversationOrderRef | null`',
	/interface\s+ConversationSummary[\s\S]*?order\s*:\s*ConversationOrderRef\s*\|\s*null/.test(client)
);

// ─── 3. Frontend render ────────────────────────────────────────────────
const page = read('apps/web/src/routes/[lang]/chat/+page.svelte');
check("chat page imports orderTitleParts", /import\s*\{\s*orderTitleParts\s*\}/.test(page));
check('chat page renders the RE: subline gated on convo.order', /\{#if\s+convo\.order\}/.test(page));
check(
	'RE: subline links to the order detail route (/@account/permlink)',
	/\/@\$\{convo\.order\.account\}\/\$\{convo\.order\.permlink\}/.test(page)
);
check('RE: subline uses the chat.inbox.re_prefix key', /chat\.inbox\.re_prefix/.test(page));
check(
	'RE: subline builds its title from orderTitleParts(convo.order, …)',
	// cp425 — orderTitleParts now takes an optional goodsLabel 3rd arg
	// (localized "goods/services" for barter), so allow trailing args.
	/orderTitleParts\(convo\.order[,)]/.test(page)
);

// ─── 4. Locale coverage ────────────────────────────────────────────────
const locales = SUPPORTED_LOCALES.map((l) => l.code);
let localeMisses = 0;
for (const loc of locales) {
	const j = JSON.parse(read(`apps/web/src/lib/i18n/locales/${loc}.json`));
	const v = j?.chat?.inbox?.re_prefix;
	if (typeof v !== 'string' || v.length === 0) localeMisses++;
}
check(
	`chat.inbox.re_prefix present + non-empty in all ${locales.length} locales`,
	localeMisses === 0,
	`${localeMisses} locale(s) missing the key`
);

const scenarios = 15;
console.log(`\n${'─'.repeat(56)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} conversation-order-ref scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} conversation-order-ref scenarios failed`);
	process.exit(1);
}
