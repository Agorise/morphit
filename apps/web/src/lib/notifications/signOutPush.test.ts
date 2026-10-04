/**
 * Signing out stops this browser's notifications.
 *
 * broadcastSignOut() used to leave both halves of the push subscription alive:
 * the browser's subscription AND the relay row linking the account to this
 * device. On a shared browser the next person kept receiving OS notifications
 * naming who messaged the signed-out user. These cases run the real
 * broadcastSignOut with only the browser's push API and the network faked, and
 * check that the browser subscription is cancelled and the relay is asked to
 * drop the row — signed with the posting key that the sign-out then wipes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { createHash } from 'node:crypto';

const fetchWithTimeout = vi.fn(async (..._a: unknown[]) => new Response('{}'));
vi.mock('$net/fetchWithTimeout', () => ({
	fetchWithTimeout: (...a: unknown[]) => fetchWithTimeout(...a)
}));

import {
	bootFromEnvelope,
	bootFromPairedSession,
	broadcastSignOut,
	identity,
	reset
} from '$lib/stores/identity';
import { blurtAccountName } from '$blurt/ops/profile';
import { encryptIdentity } from '$crypto/keystore';
import { generateFullIdentity } from '$crypto/keygen';
import { ensureSodium } from '$crypto/sodium';

const ENDPOINT = 'https://push.example/send/abc123';
const PASSWORD = 'correct-horse-battery-staple';

let browserUnsubscribe: ReturnType<typeof vi.fn>;

beforeEach(async () => {
	await ensureSodium();
	fetchWithTimeout.mockClear();
	browserUnsubscribe = vi.fn(async () => true);
	const subscription = { endpoint: ENDPOINT, unsubscribe: browserUnsubscribe };
	const registration = { pushManager: { getSubscription: async () => subscription } };
	vi.stubGlobal('window', {
		Notification: function Notification() {},
		PushManager: function PushManager() {},
		location: new URL('https://morphit.example/')
	});
	vi.stubGlobal('navigator', {
		serviceWorker: {
			getRegistration: async () => registration,
			// `ready` never settles when no worker is registered; the sign-out
			// path must not depend on it.
			ready: new Promise(() => undefined)
		}
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	reset();
	blurtAccountName.set(null);
});

function relayCall(): { url: string; body: Record<string, unknown> } | null {
	const call = fetchWithTimeout.mock.calls.find(([u]) =>
		String(u).endsWith('/v1/push/unsubscribe')
	);
	if (!call) return null;
	const init = call[1] as { body: string };
	return { url: String(call[0]), body: JSON.parse(init.body) as Record<string, unknown> };
}

describe('sign-out cancels push for this browser', () => {
	it('an unlocked session: browser unsubscribed, relay row dropped with a valid signature', async () => {
		const full = await generateFullIdentity();
		await bootFromEnvelope(await encryptIdentity(full, PASSWORD), PASSWORD);
		expect(get(identity).state).toBe('unlocked');
		blurtAccountName.set('alice'); // what the app records once signed in
		const { PrivateKey, Signature } = await import('@beblurt/dblurt');
		const live = get(identity) as { live: { posting: { privateKey: Uint8Array } } };
		const pub = new PrivateKey(Buffer.from(live.live.posting.privateKey)).createPublic();

		broadcastSignOut();
		expect(get(identity).state).toBe('locked');

		await vi.waitFor(() => expect(relayCall()).not.toBeNull());
		expect(browserUnsubscribe).toHaveBeenCalledTimes(1);
		const { body } = relayCall()!;
		expect(body.account).toBe('alice');
		expect(body.endpoint).toBe(ENDPOINT);
		expect(typeof body.signature).toBe('string');
		// The signature is the relay's canonical unsubscribe message, signed by
		// this account's posting key — not by the zeroed key the wipe leaves.
		const endpointHash = createHash('sha256').update(ENDPOINT).digest('hex');
		const canonical = `morphit:push:unsubscribe:alice:${endpointHash}:${String(body.timestamp)}`;
		const digest = createHash('sha256').update(canonical, 'utf-8').digest();
		expect(pub.verify(digest, Signature.fromString(body.signature as string))).toBe(true);
	});

	it('a read-only paired session (no posting key): still unsubscribed, relay asked unsigned', async () => {
		expect(
			bootFromPairedSession({
				v: 1,
				account: 'alice',
				chatPubkey: 'STM5jZtLoV8YbxCxr4imnbWn61zMB24wwonpnVhfXRmv7j6fk3HVH',
				pairingId: 'pid-test-12345678',
				pairedAt: Math.floor(Date.now() / 1000)
			})
		).toBe(true);
		expect(get(identity).state).toBe('paired-readonly');
		blurtAccountName.set('alice');

		broadcastSignOut();

		await vi.waitFor(() => expect(relayCall()).not.toBeNull());
		expect(browserUnsubscribe).toHaveBeenCalledTimes(1);
		const { body } = relayCall()!;
		expect(body).toEqual({ account: 'alice', endpoint: ENDPOINT });
	});

	it('no push subscription on this browser: nothing is sent', async () => {
		vi.stubGlobal('navigator', {
			serviceWorker: { getRegistration: async () => undefined, ready: new Promise(() => undefined) }
		});
		broadcastSignOut();
		// Let the dynamic import and the lookups settle.
		for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
		expect(fetchWithTimeout).not.toHaveBeenCalled();
	});
});
