/**
 * Chat sender self-copy smoke.
 *
 * The sender wipes the per-message ephemeral private key, so it cannot
 * re-derive the recipient copy of its OWN sent messages from chain. The
 * OPTIONAL self-copy (default "keep history" mode) is the same plaintext under
 * a key the SENDER re-derives from its own private key, the ephemeralPub in the
 * header and — in the v2 envelope the app sends — the static-static term with
 * the recipient's key, so only one of the two parties can have written it.
 * "Destroy" mode omits it.
 *
 * This locks the security-critical properties (v2 unless stated):
 *   - keep mode emits selfCiphertext/selfNonce; the SENDER decrypts them.
 *   - the RECIPIENT still decrypts the main ciphertext exactly as before.
 *   - the RECIPIENT can NEVER open the self-copy (different key + AAD).
 *   - the SENDER can NOT open the recipient copy with its own key (that's the
 *     whole reason the self-copy exists).
 *   - destroy mode → no self-copy; decryptSelfCopy rejects.
 *   - a self-copy forged with only the sender's PUBLIC key does not open.
 *   - the legacy v1 self-copy still opens (older messages).
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
	encryptToRecipientV1,
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

const SENDER = 'alice';
const RECIPIENT = 'bob';
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
	const opened = async (env: ChatEnvelopeWire, id: typeof recipientId, pubs: Uint8Array[]) =>
		(await decryptFromSender(env, id, SENDER, RECIPIENT, pubs)).text;
	await scenario('keep mode emits selfCiphertext + selfNonce (v2 envelope)', async () => {
		keep = await encryptToRecipient(MSG, recipientId.pub, senderId, SENDER, RECIPIENT, true);
		if (keep.v !== 2) throw new Error('not a v2 envelope');
		if (keep.selfCiphertext === undefined || keep.selfNonce === undefined) {
			throw new Error('self-copy fields missing');
		}
		if (keep.selfCiphertext === keep.ciphertext) {
			throw new Error('self ciphertext must differ from the recipient ciphertext');
		}
	});

	await scenario('recipient decrypts the MAIN ciphertext (unchanged behavior)', async () => {
		assertEqual(await opened(keep, recipientId, [senderId.pub]), MSG, 'recipient');
	});

	await scenario('SENDER decrypts its own SELF-copy (the new capability)', async () => {
		assertEqual(
			await decryptSelfCopy(keep, senderId, SENDER, RECIPIENT, [recipientId.pub]),
			MSG,
			'sender self'
		);
	});

	await scenario('recipient CANNOT open the self-copy', async () => {
		await assertRejects(
			() => decryptSelfCopy(keep, recipientId, SENDER, RECIPIENT, [senderId.pub]),
			'recip self'
		);
	});

	await scenario('sender CANNOT open the recipient copy with its own key', async () => {
		// This is exactly why the self-copy is needed: the sender's key does not
		// open the recipient ciphertext.
		await assertRejects(
			() => decryptFromSender(keep, senderId, SENDER, RECIPIENT, [senderId.pub, recipientId.pub]),
			'sender main'
		);
	});

	await scenario('a THIRD party opens neither copy', async () => {
		await assertRejects(
			() => decryptFromSender(keep, thirdId, SENDER, RECIPIENT, [senderId.pub]),
			'third main'
		);
		await assertRejects(
			() => decryptSelfCopy(keep, thirdId, SENDER, RECIPIENT, [recipientId.pub]),
			'third self'
		);
	});

	// ── PFS "destroy" mode: NO self-copy ────────────────────────────────
	await scenario('destroy mode (includeSelfCopy=false) omits the self-copy', async () => {
		const pfs = await encryptToRecipient(MSG, recipientId.pub, senderId, SENDER, RECIPIENT, false);
		if (pfs.selfCiphertext !== undefined || pfs.selfNonce !== undefined) {
			throw new Error('destroy mode must not emit a self-copy');
		}
		assertEqual(await opened(pfs, recipientId, [senderId.pub]), MSG, 'pfs recipient');
		await assertRejects(
			() => decryptSelfCopy(pfs, senderId, SENDER, RECIPIENT, [recipientId.pub]),
			'pfs sender self'
		);
	});

	await scenario("a self-copy forged with only the sender's PUBLIC key does not open", async () => {
		const v1 = await encryptToRecipientV1(
			'fake',
			recipientId.pub,
			SENDER,
			RECIPIENT,
			senderId.pub,
			true
		);
		const forged: ChatEnvelopeWire = { ...v1, v: 2 };
		await assertRejects(
			() => decryptSelfCopy(forged, senderId, SENDER, RECIPIENT, [recipientId.pub]),
			'forged self'
		);
	});

	// ── legacy v1 envelopes (older messages): still readable ────────────
	await scenario(
		'legacy v1 self-copy and recipient copy still open (recipient copy unauthenticated)',
		async () => {
			const legacy = await encryptToRecipientV1(
				MSG,
				recipientId.pub,
				SENDER,
				RECIPIENT,
				senderId.pub,
				true
			);
			const r = await decryptFromSender(legacy, recipientId, SENDER, RECIPIENT, [senderId.pub]);
			assertEqual(r, { text: MSG, authenticated: false }, 'legacy recipient');
			assertEqual(await decryptSelfCopy(legacy, senderId, SENDER, RECIPIENT), MSG, 'legacy self');
		}
	);

	// ── tamper detection on the self-copy ───────────────────────────────
	await scenario('tampered selfCiphertext → rejected', async () => {
		const t = { ...keep };
		const bytes = Buffer.from(t.selfCiphertext!, 'base64');
		bytes[0] ^= 0xff;
		const tampered: ChatEnvelopeWire = { ...t, selfCiphertext: bytes.toString('base64') };
		await assertRejects(
			() => decryptSelfCopy(tampered, senderId, SENDER, RECIPIENT, [recipientId.pub]),
			'tamper cipher'
		);
	});
	await scenario('wrong-account AAD on self-copy → rejected', async () => {
		// Same envelope, but claim a different recipient: the self-copy AAD binds
		// (sender, recipient), so decrypt with a mismatched pair must fail.
		await assertRejects(
			() => decryptSelfCopy(keep, senderId, SENDER, THIRD, [recipientId.pub]),
			'aad mismatch'
		);
	});

	// ── Unicode round-trips through the self-copy ───────────────────────
	await scenario('Unicode plaintext round-trips via the self-copy', async () => {
		const u = 'café ☕ — envíame 0.5 BLURT 请稍等 🙏';
		const env = await encryptToRecipient(u, recipientId.pub, senderId, SENDER, RECIPIENT, true);
		assertEqual(
			await decryptSelfCopy(env, senderId, SENDER, RECIPIENT, [recipientId.pub]),
			u,
			'unicode self'
		);
		assertEqual(await opened(env, recipientId, [senderId.pub]), u, 'unicode recip');
	});

	console.log(`\nchat-self-copy-smoke: ${scenarios - failures}/${scenarios} passed`);
	if (failures > 0) {
		console.log(`chat-self-copy-smoke: ${failures} FAILED`);
		process.exit(1);
	}
	console.log(`✓ all ${scenarios} chat-self-copy scenarios passed`);
}

void main();
