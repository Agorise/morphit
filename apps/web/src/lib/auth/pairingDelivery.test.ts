/**
 * v1.20.0 — the phone's half of cross-instance QR sign-in.
 *
 * The phone must never address another instance itself (its CSP forbids it,
 * the other indexer's CORS refuses it, and on a hidden page it cannot reach
 * the other network at all): a QR from another instance goes to the phone's
 * OWN indexer, which forwards it. A QR from the phone's own instance goes where
 * it always went. Driven with a real QR, a real signed and sealed bundle, and a
 * desktop that decrypts and verifies what arrives.
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
	type PairingQrPayload,
	type SignatureVerifier
} from './desktopPairing';
import { checkPairingTarget, deliverPairingBundle, pairingRouteFor } from './pairingDelivery';

const A = 'https://a.example';
const B = 'https://b.example';
const A_ONION = 'http://f6cijlm7vn32tc4kxr3vxve5pkbysoq2etlihvx25spwtkpqsa25siad.onion';
const NOW = 1_714_867_200;

interface Call {
	url: string;
	init?: RequestInit;
	timeoutMs?: number;
}
function fakeFetch(answer: (c: Call) => Response): {
	fetchImpl: (u: string, i?: RequestInit, t?: number) => Promise<Response>;
	calls: Call[];
} {
	const calls: Call[] = [];
	return {
		calls,
		fetchImpl: async (url, init, timeoutMs) => {
			const c = { url, init, timeoutMs };
			calls.push(c);
			return answer(c);
		}
	};
}
const json = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function scenario(desktopOrigin: string) {
	await sodium.ready;
	const kp = sodium.crypto_sign_seed_keypair(sodium.randombytes_buf(32));
	const signer: BundleSigner = async (b) => sodium.crypto_sign_detached(b, kp.privateKey);
	const verifier: SignatureVerifier = async (acct, b, sig) =>
		acct === 'grandma' && sodium.crypto_sign_verify_detached(sig, b, kp.publicKey);
	const desktop = await generateDesktopEphemeralKeys();
	const { payload, compactWire } = await buildQrPayload({
		epk_pub: desktop.epk_pub,
		origin: desktopOrigin,
		relay: desktopOrigin,
		nowSeconds: NOW
	});
	const v = validateQrWireForm(compactWire, NOW + 2);
	if (v.kind !== 'ok') throw new Error(`QR rejected: ${JSON.stringify(v)}`);
	const bundle = buildPairingBundle({
		qr: v.payload,
		account: 'grandma',
		accountChatPubkey: 'chat-pub',
		nowSeconds: NOW + 3,
		deviceLabel: 'Mozilla/5.0 (Linux; Android 14) '
	});
	const delivery = await buildDeliveryPayload({ bundle, signer, desktopEpkPub: desktop.epk_pub });
	const desktopVerifies = (d: unknown) =>
		verifyDeliveryPayload({
			delivery: d as typeof delivery,
			desktopEpkPriv: new Uint8Array(desktop.epk_priv),
			desktopEpkPub: desktop.epk_pub,
			desktopOrigin,
			expectedPid: payload.pid,
			nowSeconds: NOW + 5,
			verifier
		});
	return { qr: v.payload, delivery, desktopVerifies };
}

describe('pairing delivery — phone side', () => {
	it('phone on B, desktop on A: sent ONLY to B’s own indexer, and A’s desktop verifies it', async () => {
		const s = await scenario(A);
		const f = fakeFetch(() => json(200, { ok: true }));
		const out = await deliverPairingBundle({
			qr: s.qr,
			delivery: s.delivery,
			ownIndexerBase: B,
			fetchImpl: f.fetchImpl
		});
		expect(out).toBe('delivered');
		expect(f.calls.map((c) => c.url)).toEqual([`${B}/v1/pairing/forward`]);
		expect(f.calls.every((c) => new URL(c.url).origin === B)).toBe(true);
		const sent = JSON.parse(String(f.calls[0]!.init!.body)) as Record<string, unknown>;
		expect(Object.keys(sent).sort()).toEqual(['delivery', 'pid', 'target']);
		expect(sent.target).toBe(A);
		expect(sent.pid).toBe(s.qr.pid);
		// What B forwards is what A's desktop needs: it decrypts and verifies.
		const r = await s.desktopVerifies(sent.delivery);
		expect(r.kind).toBe('ok');
	});

	it('a desktop on A’s .onion page from a phone on B clearnet: forwarded, never dialled', async () => {
		const s = await scenario(A_ONION);
		const f = fakeFetch(() => json(200, { ok: true }));
		expect(
			await deliverPairingBundle({
				qr: s.qr,
				delivery: s.delivery,
				ownIndexerBase: B,
				fetchImpl: f.fetchImpl
			})
		).toBe('delivered');
		expect(f.calls.map((c) => c.url)).toEqual([`${B}/v1/pairing/forward`]);
		const body = String(f.calls[0]!.init!.body);
		expect(JSON.parse(body).target).toBe(A_ONION);
		// A real forward (longest origin, longest device label) sits far inside
		// the indexer's limits: 4096 bytes for the request (the proxies' /v1/
		// cap) and 3000 base64 characters of ciphertext.
		expect(new TextEncoder().encode(body).length).toBeLessThan(2048);
		expect(JSON.parse(body).delivery.ciphertext.length).toBeLessThan(1500);
	});

	it('same instance: the direct deliver, byte for byte as before', async () => {
		const s = await scenario(B);
		const f = fakeFetch(() => json(200, { ok: true }));
		const out = await deliverPairingBundle({
			qr: s.qr,
			delivery: s.delivery,
			ownIndexerBase: B,
			fetchImpl: f.fetchImpl
		});
		expect(out).toBe('delivered');
		expect(f.calls).toHaveLength(1);
		expect(f.calls[0]!.url).toBe(
			new URL(`/v1/login-pairing/${encodeURIComponent(s.qr.pid)}/deliver`, s.qr.relay).toString()
		);
		expect(f.calls[0]!.init).toEqual({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(s.delivery)
		});
		expect(f.calls[0]!.timeoutMs).toBeUndefined();
		expect((await s.desktopVerifies(JSON.parse(String(f.calls[0]!.init!.body)))).kind).toBe('ok');
	});

	it('an instance not in the directory: refused calmly, as its own outcome', async () => {
		const s = await scenario(A);
		const f = fakeFetch(() =>
			json(404, { status: 'error', code: 'not_found', message: 'x', reason: 'unknown_instance' })
		);
		expect(
			await deliverPairingBundle({
				qr: s.qr,
				delivery: s.delivery,
				ownIndexerBase: B,
				fetchImpl: f.fetchImpl
			})
		).toBe('not_in_directory');
		// Any other failure is a plain failure.
		const g = fakeFetch(() => json(502, { reason: 'target_unreachable' }));
		expect(
			await deliverPairingBundle({
				qr: s.qr,
				delivery: s.delivery,
				ownIndexerBase: B,
				fetchImpl: g.fetchImpl
			})
		).toBe('failed');
		const h = fakeFetch(() => {
			throw new TypeError('NetworkError');
		});
		expect(
			await deliverPairingBundle({
				qr: s.qr,
				delivery: s.delivery,
				ownIndexerBase: B,
				fetchImpl: h.fetchImpl
			})
		).toBe('failed');
	});

	it('a foreign QR whose relay is not the site it shows is refused with no request at all', async () => {
		const s = await scenario(A);
		const hostile: PairingQrPayload = { ...s.qr, relay: 'https://collector.example' };
		expect(pairingRouteFor(hostile, B)).toEqual({ kind: 'not_in_directory' });
		const f = fakeFetch(() => json(200, { ok: true }));
		expect(
			await deliverPairingBundle({
				qr: hostile,
				delivery: s.delivery,
				ownIndexerBase: B,
				fetchImpl: f.fetchImpl
			})
		).toBe('not_in_directory');
		expect(f.calls).toEqual([]);
	});

	it('the directory preflight asks the phone’s own indexer only', async () => {
		const f = fakeFetch((c) =>
			json(200, { status: 'ok', known: new URL(c.url).searchParams.get('origin') === A })
		);
		expect(await checkPairingTarget(A, B, f.fetchImpl)).toBe('known');
		expect(await checkPairingTarget('https://evil.example', B, f.fetchImpl)).toBe('unknown');
		expect(f.calls.every((c) => c.url.startsWith(`${B}/v1/pairing/target?origin=`))).toBe(true);
		const down = fakeFetch(() => json(503, {}));
		expect(await checkPairingTarget(A, B, down.fetchImpl)).toBe('error');
	});
});
