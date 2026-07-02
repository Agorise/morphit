#!/usr/bin/env tsx
/**
 * chat-head-tailer-validation-parity-smoke (cp403 [1], ADR-0048).
 *
 * The head-block fast-path tailer (chatHeadTailer.ts) deliberately
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
 *   cd apps/indexer && npx tsx scripts/chat-head-tailer-validation-parity-smoke.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');
const SRC = join(REPO, 'apps/indexer/src');

const tailer = readFileSync(join(SRC, 'indexer/chatHeadTailer.ts'), 'utf8');
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
	// Chat-only: the tailer must not reference any other morphit op id.
	const otherOpIds = (tailer.match(/morphit_[a-z_]+_v\d+/g) ?? []).filter(
		(id) => id !== 'morphit_chat_v1'
	);
	if (!usesEmitFast) {
		bad('7 — fast-channel/chat-only', 'tailer does not call emitFast()');
	} else if (usesDurableEmit) {
		bad('7 — fast-channel/chat-only', 'tailer calls the durable chatEventBus.emit() — must use emitFast only');
	} else if (otherOpIds.length > 0) {
		bad('7 — fast-channel/chat-only', `tailer references non-chat op id(s): ${[...new Set(otherOpIds)].join(', ')}`);
	} else {
		ok('7 — SAFETY: tailer emits on the fast channel only + is chat-only');
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

// ── 9. fast path ON by default in config ──
{
	// Extract the .default(...) for the ENABLED enum. Product requirement:
	// every instance (incl. existing operators on upgrade) gets the fast
	// path without setting anything, so the default must be 'true'.
	const m = config.match(
		/MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED[\s\S]{0,120}?\.default\('([^']+)'\)/
	);
	if (m === null) {
		bad('9 — default-on', 'could not find MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED .default(...)');
	} else if (m[1] !== 'true') {
		bad('9 — default-on', `fast path defaults to '${m[1]}' — must be 'true' so every instance gets it`);
	} else {
		ok("9 — fast path is ON by default (MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED .default('true'))");
	}
}

console.log(`\n${count} scenarios, ${failures} failed`);
if (failures > 0) {
	console.error('chat-head-tailer-validation-parity-smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${count} chat-head-tailer-validation-parity scenarios passed`);
