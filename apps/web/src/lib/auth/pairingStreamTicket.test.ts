/**
 * A paired desktop gets live chat (v1.21.14 full chat audit, S-M8): the chat
 * streams need a ticket signed by the posting key, the desktop holds no key,
 * so the phone signs one for the desktop's instance and seals it in the
 * pairing envelope; the desktop keeps it in its paired-session record.
 */
import { describe, expect, it } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';

import {
	buildDeliveryPayload,
	buildPairingBundle,
	buildQrPayload,
	generateDesktopEphemeralKeys,
	validateQrWireForm,
	verifyDeliveryPayload,
	type BundleSigner,
	type SignatureVerifier
} from './desktopPairing';

const ORIGIN = 'https://desk.example';
const NOW = Math.floor(Date.now() / 1000);

async function pair(streamTicket: string | undefined) {
	await sodium.ready;
	const kp = sodium.crypto_sign_seed_keypair(sodium.randombytes_buf(32));
	const signer: BundleSigner = async (b) => sodium.crypto_sign_detached(b, kp.privateKey);
	const verifier: SignatureVerifier = async (acct, b, sig) =>
		acct === 'grandma' && sodium.crypto_sign_verify_detached(sig, b, kp.publicKey);
	const desktop = await generateDesktopEphemeralKeys();
	const { compactWire } = await buildQrPayload({
		epk_pub: desktop.epk_pub,
		origin: ORIGIN,
		relay: ORIGIN,
		nowSeconds: NOW
	});
	const v = validateQrWireForm(compactWire, NOW + 1);
	if (v.kind !== 'ok') throw new Error('QR rejected');
	const bundle = buildPairingBundle({
		qr: v.payload,
		account: 'grandma',
		accountChatPubkey: 'chat-pub-0123456789',
		nowSeconds: NOW + 2,
		deviceLabel: 'phone'
	});
	const delivery = await buildDeliveryPayload({
		bundle,
		signer,
		desktopEpkPub: desktop.epk_pub,
		streamTicket
	});
	return verifyDeliveryPayload({
		delivery,
		desktopEpkPriv: new Uint8Array(desktop.epk_priv),
		desktopEpkPub: desktop.epk_pub,
		desktopOrigin: ORIGIN,
		expectedPid: v.payload.pid,
		nowSeconds: NOW + 3,
		verifier
	});
}

describe('the stream ticket in a pairing', () => {
	it('reaches the desktop sealed in the envelope', async () => {
		const r = await pair('payload.sig');
		expect(r.kind).toBe('ok');
		if (r.kind === 'ok') expect(r.envelope.stream_ticket).toBe('payload.sig');
	});

	it('an older phone that sends none still pairs', async () => {
		const r = await pair(undefined);
		expect(r.kind).toBe('ok');
		if (r.kind === 'ok') expect(r.envelope.stream_ticket).toBeUndefined();
	});

	it('an oversized ticket is dropped, the pairing still goes through', async () => {
		const r = await pair('x'.repeat(601));
		expect(r.kind).toBe('ok');
		if (r.kind === 'ok') expect(r.envelope.stream_ticket).toBeUndefined();
	});
});
