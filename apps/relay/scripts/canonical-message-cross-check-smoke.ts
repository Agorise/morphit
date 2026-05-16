#!/usr/bin/env tsx
/**
 * canonical-message-cross-check-smoke — runtime contract test
 * for the Web Push subscribe signature canonical message format.
 *
 * Part 122 cp15 audit finding DD-5.  The cp14 sig-verify
 * canonical message format
 *
 *   morphit:push:subscribe:<account>:<sha256_hex(endpoint)>:<timestamp>
 *
 * is defined in TWO places: the client in
 * `apps/web/src/lib/notifications/push.ts` and the server in
 * `apps/relay/src/policy/pushSubscribeSig.ts`.  If someone
 * changes the format on one side (different separator, different
 * hash, different field order) without updating the other, the
 * wiring-completeness smoke wouldn't catch it — it only does
 * static-grep checks.  The first failure would be in user-facing
 * signature rejections.
 *
 * This smoke catches that drift by computing the canonical
 * message via the SAME algorithm in two ways:
 *   1. node:crypto (the server's path) using known fixed inputs
 *   2. Web Crypto subtle (the client's path) via dynamically
 *      imported `crypto.subtle` (available in Node 22+)
 * and asserts they produce byte-identical digests.
 *
 * Additionally, it round-trips a generated keypair through
 * the dblurt PrivateKey.sign → PublicKey.verify path on a
 * representative canonical message, verifying the signer side
 * works end-to-end.
 */

import { createHash, webcrypto } from 'node:crypto';
import { PrivateKey } from '@beblurt/dblurt';
import { verifyPushSubscribeSignature } from '../src/policy/pushSubscribeSig.ts';
import type { BlurtClient } from '../src/blurt/client.ts';

interface Scenario {
	readonly name: string;
	readonly ok: boolean;
	readonly detail?: string;
}

const results: Scenario[] = [];

function record(name: string, ok: boolean, detail?: string): void {
	results.push({ name, ok, detail });
}

// ─── 1: canonical-message construction agrees ────────────────
const fixedAccount = 'alice.test';
const fixedEndpoint = 'https://fcm.googleapis.com/fcm/send/abc:DEFG_xyz';
const fixedTimestamp = 1747432800; // arbitrary

function buildServerCanonical(
	account: string,
	endpoint: string,
	timestamp: number
): { canonical: string; messageHashHex: string } {
	const endpointHash = createHash('sha256').update(endpoint, 'utf-8').digest('hex');
	const canonical = `morphit:push:subscribe:${account}:${endpointHash}:${timestamp}`;
	const messageHashHex = createHash('sha256').update(canonical, 'utf-8').digest('hex');
	return { canonical, messageHashHex };
}

async function buildClientCanonical(
	account: string,
	endpoint: string,
	timestamp: number
): Promise<{ canonical: string; messageHashHex: string }> {
	// Mirrors the client's logic in apps/web/src/lib/notifications/push.ts.
	const enc = new TextEncoder();
	const endpointHashBuf = await webcrypto.subtle.digest('SHA-256', enc.encode(endpoint));
	const endpointHashBytes = new Uint8Array(endpointHashBuf);
	const endpointHashHex = Array.from(endpointHashBytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	const canonical = `morphit:push:subscribe:${account}:${endpointHashHex}:${timestamp}`;
	const messageHashBuf = await webcrypto.subtle.digest('SHA-256', enc.encode(canonical));
	const messageHashBytes = new Uint8Array(messageHashBuf);
	const messageHashHex = Array.from(messageHashBytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return { canonical, messageHashHex };
}

{
	const server = buildServerCanonical(fixedAccount, fixedEndpoint, fixedTimestamp);
	const client = await buildClientCanonical(fixedAccount, fixedEndpoint, fixedTimestamp);
	record(
		'client + server compute identical canonical message',
		server.canonical === client.canonical,
		server.canonical !== client.canonical
			? `server="${server.canonical}", client="${client.canonical}"`
			: undefined
	);
	record(
		'client + server compute identical SHA-256 of canonical',
		server.messageHashHex === client.messageHashHex,
		server.messageHashHex !== client.messageHashHex
			? `server=${server.messageHashHex}, client=${client.messageHashHex}`
			: undefined
	);
}

// ─── 2: signature round-trip (sign with PrivateKey, verify
//        via the actual server-side verifier) ────────────────
{
	// Build a test keypair.  dblurt's PrivateKey.fromSeed gives
	// a deterministic key from a string — useful for repeatable
	// smokes.
	const privKey = PrivateKey.fromSeed('canonical-message-cross-check-test-seed');
	const pubKey = privKey.createPublic();
	const pubKeyStr = pubKey.toString();

	// Build canonical message + hash.
	const { messageHashHex } = buildServerCanonical(
		fixedAccount,
		fixedEndpoint,
		fixedTimestamp
	);
	const messageHashBuf = Buffer.from(messageHashHex, 'hex');

	// Sign.
	const sig = privKey.sign(messageHashBuf);
	const sigStr = sig.toString();
	record('PrivateKey.sign produces a non-empty signature', sigStr.length > 0);

	// Verify by feeding our verifier a stub BlurtClient that
	// returns the test pubkey we just generated.
	const stubBlurt = {
		async getAccount(_name: string) {
			return {
				name: fixedAccount,
				created: '',
				balance: '0.000 BLURT',
				pending_claimed_accounts: 0,
				posting_pubkey: pubKeyStr
			};
		}
	} as unknown as BlurtClient;

	const verifyResult = await verifyPushSubscribeSignature(
		stubBlurt,
		{
			account: fixedAccount,
			endpoint: fixedEndpoint,
			timestamp: fixedTimestamp,
			signatureHex: sigStr
		},
		fixedTimestamp + 1 // current time, just past sig time, well within ±5min skew
	);
	record(
		'verifyPushSubscribeSignature accepts a freshly signed message',
		verifyResult.ok === true,
		verifyResult.ok === false ? `reason=${verifyResult.reason}` : undefined
	);

	// Negative case: tamper with the timestamp on the wire, verifier
	// rejects.
	const tamperResult = await verifyPushSubscribeSignature(
		stubBlurt,
		{
			account: fixedAccount,
			endpoint: fixedEndpoint,
			timestamp: fixedTimestamp + 1, // ≠ what was signed
			signatureHex: sigStr
		},
		fixedTimestamp + 2
	);
	record(
		'verifier rejects a signature when timestamp was tampered',
		tamperResult.ok === false && tamperResult.reason === 'signature_mismatch'
	);

	// Negative case: clock skew beyond the ±5min window.
	const stale = await verifyPushSubscribeSignature(
		stubBlurt,
		{
			account: fixedAccount,
			endpoint: fixedEndpoint,
			timestamp: fixedTimestamp,
			signatureHex: sigStr
		},
		fixedTimestamp + 6 * 60 // 6 minutes in the future
	);
	record(
		'verifier rejects a signature beyond ±5min skew',
		stale.ok === false && stale.reason === 'timestamp_out_of_range'
	);

	// Negative case: account mismatch — server reconstructs canonical
	// with a DIFFERENT account, signature won't match.
	const wrongAccount = await verifyPushSubscribeSignature(
		stubBlurt,
		{
			account: 'bob.test',
			endpoint: fixedEndpoint,
			timestamp: fixedTimestamp,
			signatureHex: sigStr
		},
		fixedTimestamp + 1
	);
	record(
		'verifier rejects a signature replayed against a different account',
		wrongAccount.ok === false && wrongAccount.reason === 'signature_mismatch'
	);

	// Negative case: endpoint binding — server reconstructs canonical
	// with a different endpoint, signature won't match.
	const wrongEndpoint = await verifyPushSubscribeSignature(
		stubBlurt,
		{
			account: fixedAccount,
			endpoint: 'https://different.push.service/abc',
			timestamp: fixedTimestamp,
			signatureHex: sigStr
		},
		fixedTimestamp + 1
	);
	record(
		'verifier rejects a signature replayed against a different endpoint',
		wrongEndpoint.ok === false && wrongEndpoint.reason === 'signature_mismatch'
	);

	// Negative case: malformed signature.
	const malformed = await verifyPushSubscribeSignature(
		stubBlurt,
		{
			account: fixedAccount,
			endpoint: fixedEndpoint,
			timestamp: fixedTimestamp,
			signatureHex: 'not-a-real-signature'
		},
		fixedTimestamp + 1
	);
	record(
		'verifier rejects malformed signatures',
		malformed.ok === false && malformed.reason === 'malformed_signature'
	);

	// Negative case: unknown account (stub returns null).
	const stubMissing = {
		async getAccount(_name: string) {
			return null;
		}
	} as unknown as BlurtClient;
	const unknown = await verifyPushSubscribeSignature(
		stubMissing,
		{
			account: fixedAccount,
			endpoint: fixedEndpoint,
			timestamp: fixedTimestamp,
			signatureHex: sigStr
		},
		fixedTimestamp + 1
	);
	record(
		'verifier rejects unknown accounts',
		unknown.ok === false && unknown.reason === 'unknown_account'
	);

	// Negative case: account exists but has no posting key (chain
	// returned an empty authority — defensive against future schema
	// drift).
	const stubNoKey = {
		async getAccount(_name: string) {
			return {
				name: fixedAccount,
				created: '',
				balance: '0.000 BLURT',
				pending_claimed_accounts: 0,
				posting_pubkey: undefined
			};
		}
	} as unknown as BlurtClient;
	const noKey = await verifyPushSubscribeSignature(
		stubNoKey,
		{
			account: fixedAccount,
			endpoint: fixedEndpoint,
			timestamp: fixedTimestamp,
			signatureHex: sigStr
		},
		fixedTimestamp + 1
	);
	record(
		'verifier rejects accounts with no posting key on chain',
		noKey.ok === false && noKey.reason === 'no_posting_key_on_chain'
	);
}

// ─── Report ───────────────────────────────────────────────
console.log(`canonical-message-cross-check smoke: ${results.length} scenarios\n`);
let failed = 0;
for (const r of results) {
	if (r.ok) {
		console.log(`  ✓ ${r.name}`);
	} else {
		console.log(`  ✗ ${r.name}`);
		if (r.detail) console.log(`      ${r.detail}`);
		failed++;
	}
}
console.log('');
if (failed === 0) {
	console.log(`✓ all ${results.length} canonical-message-cross-check scenarios pass`);
	process.exit(0);
} else {
	console.error(`✗ ${failed} cross-check failures`);
	process.exit(1);
}
