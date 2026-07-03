/**
 * Chat sender self-copy smoke (cp406).
 *
 * The chat crypto is one-sided sender-PFS: the sender wipes the per-message
 * ephemeral private key, so it can never re-derive its OWN sent messages from
 * chain. cp406 adds an OPTIONAL self-copy (default "keep history" mode) — the
 * same plaintext, encrypted under a key the SENDER can re-derive from its own
 * private key + the ephemeralPub already in the header (ECDH against the
 * sender's own pubkey, distinct AAD). PFS "destroy on leave" mode omits it.
 *
 * This locks the security-critical properties:
 *   - keep mode emits selfCiphertext/selfNonce; the SENDER decrypts them.
 *   - the RECIPIENT still decrypts the main ciphertext exactly as before.
 *   - the RECIPIENT can NEVER open the self-copy (different key + AAD).
 *   - the SENDER can NOT open the recipient copy with its own key (that's the
 *     whole reason the self-copy exists).
 *   - PFS mode / legacy (no senderChatPub) → no self-copy; decryptSelfCopy
 *     rejects.
 *   - tampering any self-copy field → rejects (AEAD MAC).
 *   - a THIRD party can't open the self-copy.
 *   - Unicode round-trips (grandma's accents/emoji).
 *
 * Usage:
 *   tsx apps/web/scripts/chat-self-copy-smoke.ts
 */

import {
	deriveChatIdentity,
	encryptToRecipient,
	decryptFromSender,
	decryptSelfCopy,
	DecryptError,
	type ChatEnvelopeWire
} from '../src/lib/chat/crypto.ts';

let failures = 0;
let scenarios = 0;

async function scenario(name: string, fn: () => void | Promise<void>): Promise<void> {
	scenarios++;
	try {
		await fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

async function assertRejects(fn: () => Promise<unknown>, label: string): Promise<void> {
	try {
		await fn();
	} catch (err) {
		if (err instanceof DecryptError) return;
		throw new Error(`${label}: threw the wrong error type: ${String(err)}`);
	}
	throw new Error(`${label}: expected a DecryptError, but it resolved`);
}

const SENDER = 'kentest3';
const RECIPIENT = 'kentest2';
const THIRD = 'mallory1';

// Deterministic 32-byte test "posting privs" — NOT real keys.
function seed(byte: number): Uint8Array {
	return new Uint8Array(32).fill(byte);
}

async function main(): Promise<void> {
	console.log('chat-self-copy-smoke: sender self-copy crypto');

	const senderId = await deriveChatIdentity(seed(0x11), SENDER);
	const recipientId = await deriveChatIdentity(seed(0x22), RECIPIENT);
	const thirdId = await deriveChatIdentity(seed(0x33), THIRD);

	const MSG = 'Send the BLURT to my wallet when ready';

	// ── keep-history mode (default): self-copy present ──────────────────
	let keep: ChatEnvelopeWire;
	await scenario('keep mode emits selfCiphertext + selfNonce', async () => {
		keep = await encryptToRecipient(MSG, recipientId.pub, SENDER, RECIPIENT, senderId.pub, true);
		if (keep.selfCiphertext === undefined || keep.selfNonce === undefined) {
			throw new Error('self-copy fields missing');
		}
		if (keep.selfCiphertext === keep.ciphertext) {
			throw new Error('self ciphertext must differ from the recipient ciphertext');
		}
	});

	await scenario('recipient decrypts the MAIN ciphertext (unchanged behavior)', async () => {
		assertEqual(await decryptFromSender(keep, recipientId, SENDER, RECIPIENT), MSG, 'recipient');
	});

	await scenario('SENDER decrypts its own SELF-copy (the new capability)', async () => {
		assertEqual(await decryptSelfCopy(keep, senderId, SENDER, RECIPIENT), MSG, 'sender self');
	});

	await scenario('recipient CANNOT open the self-copy', async () => {
		await assertRejects(() => decryptSelfCopy(keep, recipientId, SENDER, RECIPIENT), 'recip self');
	});

	await scenario('sender CANNOT open the recipient copy with its own key', async () => {
		// This is exactly why the self-copy is needed: the sender's key does not
		// open the recipient ciphertext.
		await assertRejects(() => decryptFromSender(keep, senderId, SENDER, RECIPIENT), 'sender main');
	});

	await scenario('a THIRD party opens neither copy', async () => {
		await assertRejects(() => decryptFromSender(keep, thirdId, SENDER, RECIPIENT), 'third main');
		await assertRejects(() => decryptSelfCopy(keep, thirdId, SENDER, RECIPIENT), 'third self');
	});

	// ── PFS "destroy" mode: NO self-copy ────────────────────────────────
	await scenario('PFS mode (includeSelfCopy=false) omits the self-copy', async () => {
		const pfs = await encryptToRecipient(MSG, recipientId.pub, SENDER, RECIPIENT, senderId.pub, false);
		if (pfs.selfCiphertext !== undefined || pfs.selfNonce !== undefined) {
			throw new Error('PFS mode must not emit a self-copy');
		}
		assertEqual(await decryptFromSender(pfs, recipientId, SENDER, RECIPIENT), MSG, 'pfs recipient');
		await assertRejects(() => decryptSelfCopy(pfs, senderId, SENDER, RECIPIENT), 'pfs sender self');
	});

	// ── legacy callers (no senderChatPub): unchanged, no self-copy ──────
	await scenario('legacy 4-arg call → no self-copy, recipient still decrypts', async () => {
		const legacy = await encryptToRecipient(MSG, recipientId.pub, SENDER, RECIPIENT);
		if (legacy.selfCiphertext !== undefined) throw new Error('legacy must not emit a self-copy');
		assertEqual(await decryptFromSender(legacy, recipientId, SENDER, RECIPIENT), MSG, 'legacy');
		await assertRejects(() => decryptSelfCopy(legacy, senderId, SENDER, RECIPIENT), 'legacy self');
	});

	// ── tamper detection on the self-copy ───────────────────────────────
	await scenario('tampered selfCiphertext → rejected', async () => {
		const t = { ...keep };
		const bytes = Buffer.from(t.selfCiphertext!, 'base64');
		bytes[0] ^= 0xff;
		const tampered: ChatEnvelopeWire = { ...t, selfCiphertext: bytes.toString('base64') };
		await assertRejects(() => decryptSelfCopy(tampered, senderId, SENDER, RECIPIENT), 'tamper cipher');
	});
	await scenario('wrong-account AAD on self-copy → rejected', async () => {
		// Same envelope, but claim a different recipient: the self-copy AAD binds
		// (sender, recipient), so decrypt with a mismatched pair must fail.
		await assertRejects(() => decryptSelfCopy(keep, senderId, SENDER, THIRD), 'aad mismatch');
	});

	// ── Unicode round-trips through the self-copy ───────────────────────
	await scenario('Unicode plaintext round-trips via the self-copy', async () => {
		const u = 'café ☕ — envíame 0.5 BLURT 请稍等 🙏';
		const env = await encryptToRecipient(u, recipientId.pub, SENDER, RECIPIENT, senderId.pub, true);
		assertEqual(await decryptSelfCopy(env, senderId, SENDER, RECIPIENT), u, 'unicode self');
		assertEqual(await decryptFromSender(env, recipientId, SENDER, RECIPIENT), u, 'unicode recip');
	});

	console.log(`\nchat-self-copy-smoke: ${scenarios - failures}/${scenarios} passed`);
	if (failures > 0) {
		console.log(`chat-self-copy-smoke: ${failures} FAILED`);
		process.exit(1);
	}
}

void main();
