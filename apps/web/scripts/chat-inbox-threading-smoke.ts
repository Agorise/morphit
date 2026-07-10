#!/usr/bin/env tsx
/**
 * Smoke: the chat inbox is an inbox of DISCUSSIONS, not of people (cp446, Ken).
 *
 * "I will have multiple discussions with the same person, but regarding
 * different orders." So: one card per (peer, order), an order-less thread gets
 * its own card and no RE: subline, newest first, and opening a card scopes the
 * transcript to that order.
 *
 * The two silent regressions this guards:
 *   1. keying the list on `peer` — two cards collide and Svelte reuses one node;
 *   2. dropping the transcript filter — a reply about order A shows up in the
 *      discussion about order B, which is a privacy-adjacent correctness bug,
 *      not a cosmetic one.
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

const inbox = strip(readFileSync(join(WEB, 'src', 'routes', '[lang]', 'chat', '+page.svelte'), 'utf8'));
const service = strip(readFileSync(join(WEB, 'src', 'lib', 'chat', 'chatService.ts'), 'utf8'));
const conversations = strip(readFileSync(join(REPO, 'apps', 'indexer', 'src', 'api', 'conversations.ts'), 'utf8'));
const chatApi = strip(readFileSync(join(REPO, 'apps', 'indexer', 'src', 'api', 'chat.ts'), 'utf8'));
const stream = strip(readFileSync(join(REPO, 'apps', 'indexer', 'src', 'api', 'chatStream.ts'), 'utf8'));
const tailer = strip(readFileSync(join(REPO, 'apps', 'indexer', 'src', 'indexer', 'chatHeadTailer.ts'), 'utf8'));
const chatHandler = strip(readFileSync(join(REPO, 'apps', 'indexer', 'src', 'indexer', 'handlers', 'chat.ts'), 'utf8'));

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

// ─── server: one row per discussion ──────────────────────────────────
check('conversations GROUP BY (peer, order_permlink) — not by peer', /GROUP BY peer, order_permlink/.test(conversations));
check('…and NOT the old peer-only grouping', !/GROUP BY peer\s*\n/.test(conversations));
check('newest discussion first', /ORDER BY g\.last_message_at DESC/.test(conversations));
check('the order owner is whichever PARTY owns it (not "the recipient")', /ord\.account IN \(\$1, g\.peer\)/.test(conversations));
check('…preferring the peer when both could match, deterministically', /ORDER BY \(ord\.account = g\.peer\) DESC/.test(conversations));
check('a thread with no order still yields a row (LEFT JOIN LATERAL … ON TRUE)', /LEFT JOIN LATERAL[\s\S]{0,240}\) o ON TRUE/.test(conversations));

// ─── server: every message carries its order ─────────────────────────
check('/v1/chat selects order_permlink', /SELECT id::text, sender, recipient, ciphertext, header, created_at, order_permlink/.test(chatApi));
check('/v1/chat returns it on each item', /order_permlink: r\.order_permlink/.test(chatApi));
check('the SSE row select carries it', /ROW_SELECT[\s\S]{0,200}order_permlink/.test(stream));
check('the sub-6s FAST PATH carries it too (else a live message jumps threads)', /order_permlink: ev\.orderPermlink/.test(stream));
check('…and the tailer parses it off the op body', /order_permlink[\s\S]{0,200}orderPermlink/.test(tailer));
check('the tailer shape-validates rather than trusting the signer', /rawPermlink\.length <= 256/.test(tailer));

// ─── the tag and the fee-bypass are DIFFERENT things ─────────────────
// Conflating them meant the ORDER OWNER could not reply in their own thread (a
// person is not the recipient of their own listing), and nobody could speak in a
// thread once the order was cancelled — precisely the "(Cancelled)" threads the
// inbox now shows. Caught only because the inbox began linking with `?order=`.
check('the tag is accepted when EITHER party owns the order', /account IN \(\$2, \$4\)/.test(chatHandler));
check('…and rejected when neither does (a tag is not a free-text field)', /return \{ ok: false, reason: 'order_permlink_not_found' \}/.test(chatHandler));
check('the stranger-fee bypass still requires the RECIPIENT to own a LIVE order', /orderResponseBypass = ord\.account === recipient && ord\.live;/.test(chatHandler));
check('…and liveness still excludes expired orders', /status = 'live' AND \(expires_at IS NULL OR expires_at > \$3\)/.test(chatHandler));
check('a cancelled order no longer rejects the message outright', !/status = 'live'[\s\S]{0,120}\) AS exists/.test(chatHandler));

// ─── client: the transcript is scoped to ONE thread ──────────────────
check('every inbound record is filtered to this thread', /if \(\(rec\.order_permlink \?\? null\) !== \(deps\.orderPermlink \?\? null\)\) continue;/.test(service));
check('…at the single seam every record passes through', /for \(const rec of oldestFirst\) \{[\s\S]{0,400}continue;/.test(service));
check('both outgoing sites (pending + failed) inherit the thread\u2019s order', (service.match(/orderPermlink: deps\.orderPermlink \?\? null/g) ?? []).length === 2);
check('wire messages keep the order they arrived with', (service.match(/orderPermlink: rec\.order_permlink \?\? null/g) ?? []).length === 2);
check('LocalMessage carries the order', /orderPermlink: string \| null;/.test(service));

// ─── client: the inbox renders discussions ───────────────────────────
check('the list is keyed on (peer, order), never on peer alone', /\{#each activeList as convo \(threadKey\(convo\)\)\}/.test(inbox));
check('…and the key separator cannot occur in a name or permlink', /\\u0000/.test(inbox));
check('a card opens its own thread, scoped by ?order=', /\$\{base\}\?order=\$\{encodeURIComponent\(c\.order\.permlink\)\}/.test(inbox));
check('an order-less card opens the plain conversation', /return c\.order \? .* : base;/.test(inbox));
check('no RE: subline when the thread cites no order', /\{#if convo\.order\}/.test(inbox));
check('the avatar spans the full height of the text beside it', /avatarSize=\{40\}/.test(inbox));
check('…and the RE: subline is realigned under it', /pl-\[66px\]/.test(inbox) && !/pl-\[62px\]/.test(inbox));

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} chat-inbox-threading scenarios passed`);
else {
	console.error(`\u2717 ${fail} of ${pass + fail} chat-inbox-threading checks FAILED`);
	process.exit(1);
}
