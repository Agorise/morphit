#!/usr/bin/env tsx
/**
 * head-tailer-validation-parity-smoke (cp403 [1], ADR-0048).
 *
 * The head-block fast-path tailer (headTailer.ts) deliberately
 * duplicates the durable chat handler's intake validation (account-name
 * shape, ciphertext cap, base64 shape) and the block-list check, rather
 * than importing them — the tailer stays on the latency-critical path,
 * decoupled from the handler's DB-stateful machinery (same rationale as
 * the dispatcher↔frontend OP_IDS duplication). Duplication is only safe
 * if it can't silently drift, so this smoke pins the two together AND
 * pins the tailer's most important safety invariant: it never writes the
 * database.
 *
 * Scenarios:
 *   1. CHAT_OP_ID matches dispatcher OP_IDS.chatMessage
 *   2. ACCOUNT_NAME_RE matches handlers/chat.ts
 *   3. MAX_CIPHERTEXT_CHARS matches handlers/chat.ts
 *   4. base64 ciphertext regex matches handlers/chat.ts
 *   5. block-list check uses the same `state = 'blocked'` predicate
 *   6. SAFETY: the tailer performs NO database writes (no INSERT/UPDATE/
 *      DELETE, no withTx/BEGIN/COMMIT) — read-only, per invariant 1
 *   7. SAFETY: the tailer emits on the FAST channel (emitFast), never the
 *      durable emit(), and is CHAT-ONLY (references only morphit_chat_v1)
 *   8. the tailer enforces the client-tag gate (invariant 5)
 *   9. the fast path is ON by default in config (guards the product
 *      requirement that every instance gets it without opting in)
 *
 * Usage:
 *   cd apps/indexer && npx tsx scripts/head-tailer-validation-parity-smoke.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');
const SRC = join(REPO, 'apps/indexer/src');

const tailer = readFileSync(join(SRC, 'indexer/headTailer.ts'), 'utf8');
const handler = readFileSync(join(SRC, 'indexer/handlers/chat.ts'), 'utf8');
const dispatcher = readFileSync(join(SRC, 'indexer/dispatcher.ts'), 'utf8');
const config = readFileSync(join(SRC, 'config/index.ts'), 'utf8');

let failures = 0;
let count = 0;

function ok(name: string): void {
	count++;
	console.log(`  ✓ ${name}`);
}
function bad(name: string, detail: string): void {
	count++;
	failures++;
	console.log(`  ✗ ${name}`);
	console.log(`      ${detail}`);
}

/** Extract `NAME = <regex literal>;` capturing the /.../ source. */
function regexConst(src: string, name: string): string | null {
	const m = src.match(new RegExp(name + '\\s*=\\s*(/[^\\n]*?/)\\s*;'));
	return m ? m[1]! : null;
}
/** Extract `NAME = <number>`. */
function numConst(src: string, name: string): string | null {
	const m = src.match(new RegExp(name + '\\s*=\\s*(\\d+)'));
	return m ? m[1]! : null;
}
/** Extract a single-quoted string value: `KEY...'value'`. */
function firstQuoted(src: string, anchor: string): string | null {
	const idx = src.indexOf(anchor);
	if (idx < 0) return null;
	const m = src.slice(idx).match(/'([^']+)'/);
	return m ? m[1]! : null;
}

// ── 1. CHAT_OP_ID matches dispatcher OP_IDS.chatMessage ──
{
	const tailerOpId = firstQuoted(tailer, "CHAT_OP_ID =");
	const dispatchOpId = firstQuoted(dispatcher, 'chatMessage:');
	if (tailerOpId === null || dispatchOpId === null) {
		bad('1 — CHAT_OP_ID parity', `could not extract (tailer=${tailerOpId}, dispatcher=${dispatchOpId})`);
	} else if (tailerOpId !== dispatchOpId) {
		bad('1 — CHAT_OP_ID parity', `tailer '${tailerOpId}' !== dispatcher '${dispatchOpId}'`);
	} else if (tailerOpId !== 'morphit_chat_v1') {
		bad('1 — CHAT_OP_ID parity', `unexpected op id '${tailerOpId}' (expected morphit_chat_v1)`);
	} else {
		ok(`1 — CHAT_OP_ID matches dispatcher OP_IDS.chatMessage ('${tailerOpId}')`);
	}
}

// ── 2. ACCOUNT_NAME_RE parity ──
{
	const t = regexConst(tailer, 'ACCOUNT_NAME_RE');
	const h = regexConst(handler, 'ACCOUNT_NAME_RE');
	if (t === null || h === null) {
		bad('2 — ACCOUNT_NAME_RE parity', `could not extract (tailer=${t}, handler=${h})`);
	} else if (t !== h) {
		bad('2 — ACCOUNT_NAME_RE parity', `tailer ${t} !== handler ${h}`);
	} else {
		ok(`2 — ACCOUNT_NAME_RE matches handler (${t})`);
	}
}

// ── 3. MAX_CIPHERTEXT_CHARS parity ──
{
	const t = numConst(tailer, 'MAX_CIPHERTEXT_CHARS');
	const h = numConst(handler, 'MAX_CIPHERTEXT_CHARS');
	if (t === null || h === null) {
		bad('3 — MAX_CIPHERTEXT_CHARS parity', `could not extract (tailer=${t}, handler=${h})`);
	} else if (t !== h) {
		bad('3 — MAX_CIPHERTEXT_CHARS parity', `tailer ${t} !== handler ${h}`);
	} else {
		ok(`3 — MAX_CIPHERTEXT_CHARS matches handler (${t})`);
	}
}

// ── 4. base64 ciphertext regex parity ──
// The pattern is inline (not a named const) in the handler, so match on
// the distinctive body both files share verbatim.
{
	const BASE64_BODY = '(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?';
	const inTailer = tailer.includes(BASE64_BODY);
	const inHandler = handler.includes(BASE64_BODY);
	if (inTailer && inHandler) {
		ok('4 — base64 ciphertext regex matches handler');
	} else {
		bad('4 — base64 regex parity', `present in tailer=${inTailer}, handler=${inHandler}`);
	}
}

// ── 5. block-list predicate parity ──
{
	const PRED = "state = 'blocked'";
	const inTailer = tailer.includes(PRED);
	const inHandler = handler.includes(PRED);
	if (inTailer && inHandler) {
		ok("5 — block-list check uses the same \"state = 'blocked'\" predicate");
	} else {
		bad('5 — block predicate parity', `present in tailer=${inTailer}, handler=${inHandler}`);
	}
}

// ── 6. SAFETY: tailer performs NO DB writes ──
{
	// Word-boundary matches so we don't trip on the word "insert" inside
	// prose. The tailer's only DB call is a SELECT (recipientBlockedSender).
	const writePatterns: readonly [string, RegExp][] = [
		['INSERT', /\bINSERT\s+INTO\b/i],
		['UPDATE', /\bUPDATE\s+\w/i],
		['DELETE', /\bDELETE\s+FROM\b/i],
		['withTx', /\bwithTx\b/],
		['BEGIN', /\bBEGIN\b/],
		['COMMIT', /\bCOMMIT\b/]
	];
	const found = writePatterns.filter(([, re]) => re.test(tailer)).map(([n]) => n);
	if (found.length === 0) {
		ok('6 — SAFETY: tailer is DB-read-only (no INSERT/UPDATE/DELETE/withTx/BEGIN/COMMIT)');
	} else {
		bad('6 — DB-read-only invariant', `tailer contains write construct(s): ${found.join(', ')}`);
	}
}

// ── 7. SAFETY: fast channel only + chat-only ──
{
	const usesEmitFast = /emitFast\s*\(/.test(tailer);
	// The durable emit() must NOT be called from the tailer (that path is
	// the poller's, and it requires a real DB messageId).
	const usesDurableEmit = /chatEventBus\.emit\s*\(/.test(tailer);
	// This was "CHAT ONLY: exactly one op id" (cp403), then +feedback (v1.5.5),
	// now +order status (v1.7.0). Each widening must be argued, not assumed —
	// that is the entire job of this allowlist.
	//
	// THE INVARIANT IS UNCHANGED AND NON-NEGOTIABLE: the fast path is PROVISIONAL
	// (a reorg can orphan anything it saw) and must never carry financially
	// material state. ADR-0051 sharpened HOW that invariant is applied — a
	// head-block op may drive provisional DISPLAY, but never money or reputation —
	// which is why this list is longer than "chat" without being weaker.
	//
	// Each entry earns its place differently:
	//   morphit_chat_v1      — provisional display. Orphaned = a message flashed
	//                          and vanished. An annoyance, not a lie.
	//   morphit_feedback_v1  — NOTIFICATION ONLY. The tailer enqueues a push
	//                          (dedup-keyed on trx id so the durable enqueue
	//                          collapses into it) and writes no feedback row. The
	//                          durable handler stays the sole author of reputation:
	//                          a review SCORE that moved on a head block would be a
	//                          lie we told about a person.
	//   morphit_order_cancel_v1 / morphit_order_complete_v1
	//                        — status transitions on an order that ALREADY exists
	//                          durably and is ALREADY fee-verified. They carry no
	//                          free text (a permlink; complete adds a counterparty
	//                          name), are owner-signed (both durable handlers gate
	//                          on `account = signer`), and BOTH remove the order
	//                          from live views — so this path can only ever remove,
	//                          never add. Nothing financially material moves: the
	//                          trade COUNT still waits for the durable pass.
	//
	// The two order ops deliberately NOT here are the whole reason this list is
	// checked at all — see `fastpath-order-scope-smoke`, which owns that argument:
	//   morphit_order_v1          — no verified fee at head. Publishing it would
	//                               put UNPAID orders in every orderbook for ~60s.
	//   morphit_order_replace_v1  — carries the order's free text; a rejected edit
	//                               would flash arbitrary content to everyone.
	const FAST_ALLOWED_OP_IDS = new Set([
		'morphit_chat_v1',
		'morphit_feedback_v1',
		'morphit_order_cancel_v1',
		'morphit_order_complete_v1'
	]);
	// Match op ids in CODE, not in prose. The tailer documents at length WHY
	// morphit_order_v1 and morphit_order_replace_v1 are excluded, and a guard that
	// fails because someone explained a safety decision is a guard that gets
	// deleted — so strip comments first, then look at what the code actually
	// references. This still catches an inline hardcoded id, which a
	// declarations-only match would miss.
	const tailerCode = tailer
		.replace(/\/\*[\s\S]*?\*\//g, '') // block comments (incl. JSDoc)
		.replace(/\/\/.*$/gm, ''); // line comments
	const otherOpIds = (tailerCode.match(/morphit_[a-z_]+_v\d+/g) ?? []).filter(
		(id) => !FAST_ALLOWED_OP_IDS.has(id)
	);
	// Notification-only: the tailer may enqueue pushes, never write the durable
	// tables the durable handlers own.
	const durableWrites = /INSERT INTO (feedback|orders|profiles|chat_messages)\b/i.test(tailer);
	if (!usesEmitFast) {
		bad('7 — fast-channel/allowed-ops', 'tailer does not call emitFast()');
	} else if (usesDurableEmit) {
		bad('7 — fast-channel/allowed-ops', 'tailer calls the durable chatEventBus.emit() — must use emitFast only');
	} else if (otherOpIds.length > 0) {
		bad(
			'7 — fast-channel/allowed-ops',
			`tailer references op id(s) outside the fast allowlist: ${[...new Set(otherOpIds)].join(', ')}. The fast path is provisional (a reorg can orphan it) and must never carry financially material state. Widening this list is a SAFETY decision — see ADR-0051's per-entity matrix and fastpath-order-scope-smoke before adding one.`
		);
	} else if (durableWrites) {
		bad(
			'7 — fast-channel/allowed-ops',
			'tailer writes a durable table directly — the fast path may only emit + enqueue notifications; the durable handlers own reputation and orderbook state'
		);
	} else {
		ok('7 — SAFETY: tailer emits on the fast channel only, carries only chat + feedback (notification-only), and writes no durable table');
	}
}

// ── 8. client-tag gate present ──
{
	// The tailer must gate emission on a non-empty client_tag (invariant 5).
	if (/clientTagFromHeader/.test(tailer) && /clientTag === null/.test(tailer)) {
		ok('8 — tailer enforces the client-tag gate (dedup safety)');
	} else {
		bad('8 — client-tag gate', 'tailer does not gate emission on a non-null client_tag');
	}
}

// ── 9. RETIRED (v1.7.0, ADR-0051) ──
//
// This slot used to assert MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED defaulted to
// 'true'. That variable no longer exists — the fast path is unconditional now,
// so there is no default left to get wrong.
//
// It was also in the wrong file. This smoke exists to pin that the tailer's
// DUPLICATED VALIDATION CONSTANTS still match handlers/chat.ts; a config
// default is not validation parity, it was just squatting here. The successor
// concern — "the opt-out must never come back" — is owned properly by
// `apps/ops-cli:fastpath-always-on-smoke`, which pins it across the env schema,
// the Config type, run(), the status shape, the env example, and the health
// renderer, and tamper-proves the load-bearing premise (the tailer never writes
// the DB). Renumbering the scenarios below would churn every label for nothing,
// so the slot stays vacant and explains itself.

// ── 10. cp406 self-copy bound parity ──
{
	// The optional sender self-copy (self_ciphertext/self_nonce) must be
	// bounded identically in BOTH files, else the fast path could emit a
	// message the durable handler rejects. Pin that both reference the fields
	// AND cap self_ciphertext with MAX_CIPHERTEXT_CHARS.
	const handlerHasSelf =
		handler.includes('self_ciphertext') &&
		/self_ciphertext[\s\S]{0,400}MAX_CIPHERTEXT_CHARS/.test(handler);
	const tailerHasSelf =
		tailer.includes('self_ciphertext') &&
		/self_ciphertext[\s\S]{0,400}MAX_CIPHERTEXT_CHARS/.test(tailer);
	if (!handlerHasSelf) {
		bad('10 — self-copy bound parity', 'handler is missing the self_ciphertext MAX_CIPHERTEXT_CHARS bound');
	} else if (!tailerHasSelf) {
		bad('10 — self-copy bound parity', 'tailer is missing the self_ciphertext MAX_CIPHERTEXT_CHARS bound — fast path could emit what the handler rejects');
	} else {
		ok('10 — self_ciphertext bound mirrored in tailer + handler');
	}
}

console.log(`\n${count} scenarios, ${failures} failed`);
if (failures > 0) {
	console.error('head-tailer-validation-parity-smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${count} head-tailer-validation-parity scenarios passed`);
