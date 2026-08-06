#!/usr/bin/env tsx
/*
 * onchain-user-privacy — v1.5.0 (tt.txt I) guard.
 *
 * Ken: "ALL of this stuff that we are posting to the chain now, please
 * remember to keep our users absolutely PRIVATE. please VERIFY that is so."
 *
 * Blurt is a PUBLIC, PERMANENT chain: anything broadcast in the clear is
 * readable by anyone forever and can never be redacted. So every op that
 * carries USER CONTENT must be either (a) encrypted client-side, or
 * (b) deliberately public because the feature IS publication (a public
 * order, a public review). This sentinel pins that split so a future edit
 * can't quietly move something from column (a) to column (b).
 *
 * Existing neighbours (kept, not duplicated): chat-folders-onchain-smoke
 * pins the folder op's own wiring; rpc-privacy-routing-smoke pins that the
 * browser never talks to a third-party node. This one is the CROSS-OP
 * invariant: what is allowed to be plaintext, per op.
 *
 * Metadata honesty: this does NOT claim chat metadata is hidden. Who
 * messaged whom, when, roughly how big, and which order it concerns ARE
 * plaintext on chain by design (the indexer must route + thread without
 * decrypting). That is documented in the FAQ. What must NEVER be plaintext
 * is the CONTENT: the message body, the shared crypto address + amount, the
 * user's settings, and which threads they filed.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');
const REPO = resolve(WEB, '..', '..');

let pass = 0;
let fail = 0;
function ok(msg: string): void {
	pass++;
	console.log(`  ✓ ${msg}`);
}
function bad(scope: string, msg: string): void {
	fail++;
	console.log(`  ✗ ${scope}: ${msg}`);
}
const read = (p: string): string => readFileSync(resolve(REPO, p), 'utf8');
const flat = (s: string): string => s.replace(/\s+/g, ' ');

// ── 1. Chat body — ENCRYPTED (this is also how a shared crypto
//      address + amount travels: inside the chat ciphertext). ────────
const chatSvc = flat(read('apps/web/src/lib/chat/chatService.ts'));
if (/ciphertext: envelope\.ciphertext/.test(chatSvc) && /encryptToRecipient/.test(chatSvc)) {
	ok('chat: the on-chain body is ciphertext from encryptToRecipient (X25519 + ChaCha20-Poly1305)');
} else {
	bad(
		'chat',
		'the chat op no longer broadcasts encryptToRecipient ciphertext — a message body (and every crypto address shared through chat) would be readable by the world, forever.'
	);
}
// The self-copy (keep-history) must be ciphertext too — it is the sender's
// own message, and a plaintext copy leaks the same content.
if (/self_ciphertext: envelope\.selfCiphertext/.test(chatSvc)) {
	ok('chat: the sender self-copy is ciphertext too (not a plaintext archive)');
} else {
	bad('chat', 'the sender self-copy is no longer ciphertext — it would leak the same content the main body protects.');
}

// ── 2. Shared crypto address — never broadcast outside chat ─────────
const addrModal = flat(read('apps/web/src/lib/components/AddressShareModal.svelte'));
if (/await onShare\(wire\)/.test(addrModal)) {
	ok('address share: leaves ONLY via onShare → the encrypted chat path');
} else {
	bad('address share', 'the modal no longer hands its payload to onShare — verify it has not gained a direct broadcast that would bypass chat encryption.');
}
if (/broadcastCustomJson|broadcast_transaction/.test(addrModal)) {
	bad(
		'address share',
		'the modal now broadcasts directly. A crypto address must travel ONLY inside chat ciphertext — a direct custom_json would publish it in the clear, permanently.'
	);
} else {
	ok('address share: the modal never broadcasts a custom_json itself');
}

// ── 3. Address history — device-local, never transmitted ────────────
// The moment Morphit learns "user X uses address Y", it becomes a
// correlation database. It must stay in localStorage.
const addrHist = read('apps/web/src/lib/privacy/addressHistory.ts');
const addrHistCode = addrHist.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
if (/localStorage/.test(addrHistCode) && !/\bfetch\s*\(/.test(addrHistCode) && !/broadcast/i.test(addrHistCode)) {
	ok('address history: localStorage only — never fetched, never broadcast');
} else {
	bad(
		'address history',
		'the address history module gained a fetch/broadcast. It records which addresses a user has shared; transmitting it would build exactly the correlation database Morphit exists to avoid.'
	);
}

// ── 4. Settings + chat folders — ENCRYPTED blobs ────────────────────
// Folders name the PEERS and ORDERS a user filed: plaintext would expose
// their whole counterparty graph on a public chain.
const folders = flat(read('apps/web/src/lib/blurt/ops/chatFolders.ts'));
if (/encryptFolderState/.test(folders) && /\{ v: 1, enc \}/.test(folders)) {
	ok('chat folders: broadcast as { v: 1, enc } — the filed peers/orders are never in the clear');
} else {
	bad('chat folders', 'the folder op no longer broadcasts an encrypted blob — a user\'s counterparty graph would be public.');
}
const settings = flat(read('apps/web/src/lib/blurt/ops/settings.ts'));
if (/encryptSettingsState/.test(settings) && /enc/.test(settings)) {
	ok('settings: broadcast as an encrypted blob (operator stores only opaque bytes)');
} else {
	bad('settings', 'the settings op no longer broadcasts an encrypted blob.');
}

// ── 5. Public-by-design ops must still redact secrets ───────────────
// A review reply IS publication — but a user pasting a private key into
// the box must never publish it.
const reply = flat(read('apps/web/src/lib/components/RespondToFeedbackForm.svelte'));
if (/const outgoing = redactPrivateKeys\(comment\)/.test(reply) && /comment: outgoing/.test(reply)) {
	ok('feedback reply: private keys are redacted BEFORE the (public, permanent) broadcast');
} else {
	bad(
		'feedback reply',
		'the reply no longer redacts private keys before broadcasting. This op is public + permanent — a pasted key would be published irrevocably.'
	);
}

// ── 6. The public RPC-health endpoint leaks no raw error text ───────
// cp471 added failure reasons. A raw error message can carry internal
// paths/IPs/hostnames, and this endpoint is public + unauthenticated.
const rpcHealth = read('apps/indexer/src/api/rpcHealth.ts');
const rpcCode = rpcHealth.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
if (/failure_reason/.test(rpcCode) && !/\.message/.test(rpcCode) && !/String\(err\)/.test(rpcCode)) {
	ok('rpc health: publishes only the reason enum + numeric status — never a raw error message');
} else {
	bad(
		'rpc health',
		'the public /v1/rpc-endpoints response may now carry raw error text (.message / String(err)). Raw errors can leak internal paths, IPs or upstream hostnames on an unauthenticated endpoint — publish the enum only.'
	);
}

console.log('\n' + '─'.repeat(56));
if (fail === 0) {
	console.log(`✓ all ${pass} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${fail} of ${pass + fail} scenarios FAILED`);
	process.exit(1);
}
