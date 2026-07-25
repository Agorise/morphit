#!/usr/bin/env tsx
/**
 * scripts/witness-chat-identity-claimed-op-smoke.ts
 *
 * v1.8.15 (cp555) — witness chat-identity verification structural guard.
 *
 * THE BUG THIS LOCKS IN THE FIX FOR. Ken and @mariuszkarowski could not open a
 * chat with the Blurt witness @khrom: every send died with a red "tamper
 * detected — the blockchain reports none" banner (pub_pin_chain_reports_none),
 * while the two of them chatted with each other fine. Root cause: the chain
 * check found a peer's `morphit_chat_identity_v1` op by WALKING account history
 * (get_account_history, 10000-entry per-call cap). For a block producer that op
 * is buried under ~1,430 `producer_reward` virtual ops PER DAY — beyond any
 * single window (10000 ≈ a week of a witness's activity). The walk found
 * nothing → null → false tamper.
 *
 * THE FIX. Verify the indexer's CLAIMED op directly by trx_id
 * (verifyClaimedChatIdentityOnChain → chainRelay('get_transaction', …)): O(1),
 * immune to account activity. The chat send path (chatService) and the OOB
 * fingerprint path (peerPubFetch) both call verifyPeerChatIdentityOnChain,
 * which tries the claimed op first and keeps the history walk only as a
 * fallback.
 *
 * WHAT THIS SMOKE ASSERTS (structural — fails at lint time if the wiring
 * regresses back to a bare history walk at the call sites):
 *   1. chainVerify exports verifyClaimedChatIdentityOnChain + verifyPeerChatIdentityOnChain.
 *   2. the claimed-op verifier fetches the op via get_transaction (the O(1) path).
 *   3. the orchestrator tries the claimed op first (calls verifyClaimedChatIdentityOnChain).
 *   4. the two call sites (chatService, peerPubFetch) wire verifyPeerChatIdentityOnChain
 *      and no longer reference the raw history-walk (fetchLatestChatIdentityFromChainQuorum).
 *   5. pubPin threads the indexer's claimed ref into verifyOnChain (so the primary
 *      path can chase the exact op instead of re-deriving "the latest").
 *
 * COMMENTS ARE STRIPPED BEFORE GREPPING. This guard's evidence is the CODE, not
 * the prose — and the fix's own comments necessarily NAME the retired history
 * walk (`fetchLatestChatIdentityFromChainQuorum`) and the buried-op problem. A
 * raw grep would trip on those comments. The blunt stripper can only ever
 * REMOVE evidence, so its failure mode is a false ALARM (noisy, fixed), never a
 * false pass.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

/** Blunt comment strip (block + line, with a `:` guard so `https://` survives). */
const stripComments = (src: string): string =>
	src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

function readStripped(rel: string): string {
	return stripComments(readFileSync(resolve(REPO, rel), 'utf8'));
}

interface Scenario {
	name: string;
	ok: boolean;
	detail?: string;
}

const results: Scenario[] = [];
function check(name: string, ok: boolean, detail?: string): void {
	results.push({ name, ok, detail });
}

console.log('\n── witness chat-identity claimed-op structural smoke ───\n');

const CHAIN_VERIFY = 'apps/web/src/lib/chat/chainVerify.ts';
const PUB_PIN = 'apps/web/src/lib/chat/pubPin.ts';
const CHAT_SERVICE = 'apps/web/src/lib/chat/chatService.ts';
const PEER_PUB_FETCH = 'apps/web/src/lib/chat/peerPubFetch.ts';

const chainVerify = readStripped(CHAIN_VERIFY);
const pubPin = readStripped(PUB_PIN);
const chatService = readStripped(CHAT_SERVICE);
const peerPubFetch = readStripped(PEER_PUB_FETCH);

// 1. chainVerify exports both new functions.
check(
	'chainVerify exports verifyClaimedChatIdentityOnChain',
	/export\s+async\s+function\s+verifyClaimedChatIdentityOnChain\b/.test(chainVerify),
	CHAIN_VERIFY
);
check(
	'chainVerify exports verifyPeerChatIdentityOnChain',
	/export\s+async\s+function\s+verifyPeerChatIdentityOnChain\b/.test(chainVerify),
	CHAIN_VERIFY
);

// 2. The claimed-op verifier fetches the op via get_transaction (O(1) path).
//    Scoped to the function body so we credit the real call, not a stray token.
const claimedFnMatch = chainVerify.match(
	/verifyClaimedChatIdentityOnChain[\s\S]*?\n\}/
);
const claimedFnBody = claimedFnMatch ? claimedFnMatch[0] : '';
check(
	'verifyClaimedChatIdentityOnChain fetches the claimed op via get_transaction',
	/chainRelay\s*(<[^>]*>)?\s*\(\s*['"]get_transaction['"]/.test(claimedFnBody),
	CHAIN_VERIFY
);
check(
	'verifyClaimedChatIdentityOnChain verifies signature (verifyTransactionSignatures)',
	/verifyTransactionSignatures\s*\(/.test(claimedFnBody),
	CHAIN_VERIFY
);

// 3. The orchestrator tries the claimed op first.
const orchMatch = chainVerify.match(/verifyPeerChatIdentityOnChain[\s\S]*?\n\}/g);
const orchBody = orchMatch ? orchMatch[orchMatch.length - 1] : '';
check(
	'verifyPeerChatIdentityOnChain tries the claimed op first',
	/verifyClaimedChatIdentityOnChain\s*\(/.test(orchBody),
	CHAIN_VERIFY
);

// 4. Both call sites wire the claimed-op orchestrator and no longer reference
//    the raw history walk directly (that walk survives ONLY inside chainVerify
//    as the fallback).
check(
	'chatService wires verifyPeerChatIdentityOnChain',
	/verifyPeerChatIdentityOnChain\s*\(/.test(chatService),
	CHAT_SERVICE
);
check(
	'chatService no longer references the raw history walk',
	!chatService.includes('fetchLatestChatIdentityFromChainQuorum'),
	`${CHAT_SERVICE} still mentions fetchLatestChatIdentityFromChainQuorum (should route through verifyPeerChatIdentityOnChain)`
);
check(
	'peerPubFetch wires verifyPeerChatIdentityOnChain',
	/verifyPeerChatIdentityOnChain\s*\(/.test(peerPubFetch),
	PEER_PUB_FETCH
);
check(
	'peerPubFetch no longer references the raw history walk',
	!peerPubFetch.includes('fetchLatestChatIdentityFromChainQuorum'),
	`${PEER_PUB_FETCH} still mentions fetchLatestChatIdentityFromChainQuorum`
);

// 5. pubPin threads the indexer's claimed ref into verifyOnChain, so the
//    primary path can chase the exact op rather than re-deriving "the latest".
check(
	'pubPin passes the claimed ref into verifyOnChain',
	/verifyOnChain\s*\(\s*peer\s*,\s*indexerPin\s*\)/.test(pubPin),
	PUB_PIN
);
check(
	'pubPin verifyOnChain signature accepts a claimed ref',
	/verifyOnChain:\s*\(\s*peer:\s*string\s*,\s*claimedRef:\s*ChatPubPin/.test(pubPin),
	PUB_PIN
);

// ── report ─────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
for (const r of results) {
	console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}`);
	if (!r.ok && r.detail) console.log(`      ${r.detail}`);
}
console.log('\n──────────────────────────────────────────────────────');
if (failed.length > 0) {
	console.log(`✗ ${failed.length}/${results.length} scenarios failed`);
	process.exit(1);
}
console.log(`✓ all ${results.length} scenarios passed`);
