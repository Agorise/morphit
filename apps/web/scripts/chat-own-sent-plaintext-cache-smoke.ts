#!/usr/bin/env tsx
/**
 * chat-own-sent-plaintext-cache-smoke (cp402 [3]).
 *
 * Pins the fix for "my own messages show (encrypted) after navigating
 * away and back". The chat crypto (crypto.ts) is ephemeral sender-PFS:
 * the ephemeral private key is wiped immediately after encrypting, so we
 * can NEVER re-decrypt our own sent messages from chain history. During a
 * live session the composer keeps the plaintext as a local optimistic
 * echo, but a fresh controller (after navigating away and back) has no
 * echo — mergePollResponse's our-own-sent branch fails to reconcile by
 * client_tag and would render the placeholder. The fix is an in-memory
 * own-sent plaintext cache, keyed by account + client_tag, that a fresh
 * controller reads to restore the text.
 *
 * SAFETY / PRIVACY INVARIANTS this smoke guards (source-assertion, same
 * rationale as chat-blocks-race-guard-smoke — the full flow needs the
 * live chat runtime + libsodium, which a smoke can't cheaply stand up):
 *
 *   • WRITE — sendMessage remembers our plaintext keyed by (me, tag).
 *   • READ — the our-own-sent merge branch restores from the cache, and
 *     the read is GATED on getLiveIdentity(): a LOCKED session shows the
 *     placeholder, consistent with incoming messages. Falls back to the
 *     placeholder when the plaintext isn't cached (sent from another
 *     device / cache cleared).
 *   • IN-MEMORY ONLY (forward secrecy) — the cache is a plain Map and
 *     chatService NEVER touches localStorage/sessionStorage/indexedDB, so
 *     plaintext is never written to disk; the on-disk / on-chain PFS
 *     guarantee is unchanged.
 *   • CLEARED ON LOCK + SIGN-OUT — identity.ts lockSession() AND reset()
 *     both clear the cache so message content never lingers in memory
 *     past a lock, and one account's plaintext never leaks into another's
 *     session.
 *   • BOUNDED — a cap with oldest-eviction keeps a long reload-free
 *     session from growing the cache without bound.
 *
 * Usage:
 *   cd apps/web && npx tsx scripts/chat-own-sent-plaintext-cache-smoke.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');

interface Scenario {
	readonly name: string;
	readonly file: string;
	readonly mustHave: readonly string[];
	readonly mustNotHave?: readonly string[];
}

const SVC = 'src/lib/chat/chatService.ts';
const IDENT = 'src/lib/stores/identity.ts';

const SCENARIOS: readonly Scenario[] = [
	{
		name: '1 — chatService declares the in-memory own-sent cache + primitives + exported clear',
		file: SVC,
		mustHave: [
			'const OWN_SENT_CACHE_MAX = 1000;',
			'const ownSentPlaintext = new Map<string, string>();',
			'function ownSentKey(me: string, clientTag: string): string {',
			'function rememberOwnSent(me: string, clientTag: string, plaintext: string): void {',
			'export function clearOwnSentPlaintextCache(): void {',
			'ownSentPlaintext.clear();'
		]
	},
	{
		name: '2 — cache is bounded (oldest-eviction over the cap)',
		file: SVC,
		mustHave: ['if (ownSentPlaintext.size > OWN_SENT_CACHE_MAX) {', 'ownSentPlaintext.keys().next().value']
	},
	{
		name: '3 — sendMessage remembers OUR plaintext keyed by (me, clientTag)',
		file: SVC,
		mustHave: [
			'const clientTag = deps.generateClientTag();',
			'rememberOwnSent(deps.me, clientTag, trimmed);'
		]
	},
	{
		name: '4 — our-own-sent merge branch restores from cache, GATED on getLiveIdentity(), placeholder fallback',
		file: SVC,
		mustHave: [
			'const ownTag = clientTagFromHeader(rec.header);',
			'deps.getLiveIdentity() !== null && ownTag !== null',
			'ownSentPlaintext.get(ownSentKey(deps.me, ownTag))',
			'text: ownCached ?? ENCRYPTED_PLACEHOLDER'
		],
		mustNotHave: [
			// Pre-fix: our own historical messages were ALWAYS placeholder.
			// The literal placeholder-only push in this branch is gone.
			'clientTag: clientTagFromHeader(rec.header),\n\t\t\t\t\ttext: ENCRYPTED_PLACEHOLDER,'
		]
	},
	{
		name: '5 — IN-MEMORY ONLY: chatService never persists to disk (forward secrecy preserved)',
		file: SVC,
		mustHave: ['const ownSentPlaintext = new Map<string, string>();'],
		mustNotHave: ['localStorage', 'sessionStorage', 'indexedDB']
	},
	{
		name: '6 — identity.ts lockSession() clears the cache on lock (memory hygiene)',
		file: IDENT,
		mustHave: [
			'the own-sent plaintext cache IS cleared here',
			"void import('$lib/chat/chatService').then((m) => m.clearOwnSentPlaintextCache());"
		]
	},
	{
		name: '7 — identity.ts reset() clears the cache on sign-out / device-leave',
		file: IDENT,
		mustHave: [
			'clear the own-sent plaintext cache (message content must',
			"void import('$lib/chat/chatService').then((m) => m.clearOwnSentPlaintextCache());"
		]
	}
];

let failures = 0;
let scenarios = 0;

function check(s: Scenario): void {
	scenarios++;
	const path = join(REPO, s.file);
	let body: string;
	try {
		body = readFileSync(path, 'utf8');
	} catch (err) {
		failures++;
		console.log(`  ✗ ${s.name}`);
		console.log(`      could not read ${s.file}: ${err instanceof Error ? err.message : err}`);
		return;
	}
	const missing = s.mustHave.filter((m) => !body.includes(m));
	const regressed = (s.mustNotHave ?? []).filter((m) => body.includes(m));
	if (missing.length === 0 && regressed.length === 0) {
		console.log(`  ✓ ${s.name}`);
		return;
	}
	failures++;
	console.log(`  ✗ ${s.name}`);
	if (missing.length > 0) {
		console.log(`      missing sentinel(s):`);
		for (const m of missing) console.log(`        - ${JSON.stringify(m)}`);
	}
	if (regressed.length > 0) {
		console.log(`      regressed sentinel(s) (pre-fix pattern reappeared):`);
		for (const m of regressed) console.log(`        - ${JSON.stringify(m)}`);
	}
}

console.log('chat-own-sent-plaintext-cache smoke:\n');
for (const s of SCENARIOS) check(s);

console.log(`\n${scenarios} scenarios, ${failures} failed`);
if (failures > 0) {
	console.error('chat-own-sent-plaintext-cache-smoke FAILED');
	process.exit(1);
}
// Canonical success line — run-smokes.sh greps for `^✓ all` to tally.
console.log(`✓ all ${SCENARIOS.length} chat-own-sent-plaintext-cache scenarios passed`);
