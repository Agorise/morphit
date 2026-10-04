/**
 * What a push subscription tells the relay: only what delivery needs. The
 * browser's user-agent string and its navigator.language (which can name a
 * region) are never sent — the relay would store them per account, tying the
 * account to a browser build and a region in a seized database or backup.
 *
 * Runs the real subscribe() with an unlocked session; only the browser's push
 * API and the network are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithTimeout = vi.fn();
vi.mock('$net/fetchWithTimeout', () => ({
	fetchWithTimeout: (...a: unknown[]) => fetchWithTimeout(...a)
}));

import { locale } from 'svelte-i18n';
import { bootFromEnvelope, reset } from '$lib/stores/identity';
import { encryptIdentity } from '$crypto/keystore';
import { generateFullIdentity } from '$crypto/keygen';
import { ensureSodium } from '$crypto/sodium';
import { SUPPORTED_LOCALES } from '$i18n/locales';
import { subscribe } from './push';

const PASSWORD = 'correct-horse-battery-staple';
const VAPID = 'B'.repeat(87);

beforeEach(async () => {
	await ensureSodium();
	// The app's UI language (before `window` exists here: svelte-i18n writes
	// <html lang> when it does).
	locale.set('fa');
	fetchWithTimeout.mockReset();
	fetchWithTimeout.mockImplementation(async (url: string) =>
		String(url).endsWith('/v1/push/vapid-public-key')
			? new Response(JSON.stringify({ vapid_public_key: VAPID }))
			: new Response(JSON.stringify({ status: 'subscribed', privacy_mode: 'standard' }))
	);
	const sub = {
		toJSON: () => ({ endpoint: 'https://push.example/send/xyz', keys: { p256dh: 'p', auth: 'a' } })
	};
	const registration = {
		pushManager: { getSubscription: async () => null, subscribe: async () => sub }
	};
	vi.stubGlobal('Notification', { permission: 'granted' });
	vi.stubGlobal('window', {
		Notification: { permission: 'granted' },
		PushManager: function PushManager() {},
		location: new URL('https://morphit.example/')
	});
	vi.stubGlobal('navigator', {
		userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
		language: 'fa-IR',
		serviceWorker: { ready: Promise.resolve(registration) }
	});
	await bootFromEnvelope(await encryptIdentity(await generateFullIdentity(), PASSWORD), PASSWORD);
});

afterEach(() => {
	vi.unstubAllGlobals();
	reset();
});

function subscribeBody(): Record<string, unknown> {
	const call = fetchWithTimeout.mock.calls.find(([u]) => String(u).endsWith('/v1/push/subscribe'));
	if (!call) throw new Error('no subscribe request');
	return JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
}

describe('the push subscription request', () => {
	it('carries exactly what delivery needs, no user agent', async () => {
		await subscribe('alice');
		expect(Object.keys(subscribeBody()).sort()).toEqual(
			[
				'account',
				'locale',
				'muted_categories',
				'privacy_mode',
				'signature',
				'subscription',
				'timestamp'
			].sort()
		);
		expect(JSON.stringify(subscribeBody())).not.toContain('Firefox');
	});

	it('names the UI language as a supported code, never the browser region', async () => {
		await subscribe('alice');
		const sent = subscribeBody().locale;
		expect(SUPPORTED_LOCALES.map((l) => l.code)).toContain(sent);
		expect(sent).toBe('fa');
	});
});
