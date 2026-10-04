// @vitest-environment jsdom
/**
 * The reload stash: a plain reload of a "Remember me" session keeps it
 * unlocked, and the decrypted keys never reach storage on the way.
 *
 *   - what pagehide writes holds no key bytes (browsers write sessionStorage
 *     to disk); the key that opens it lives only in the service worker;
 *   - only the REMEMBERED session is stashed — a session whose keystore is
 *     not the one on disk ("just this session", or a second account) never;
 *   - a stash older builds wrote in plaintext is deleted, never used;
 *   - no service worker, a worker that lost the key, a stale stash or a load
 *     that is not a reload → locked.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
	identity,
	handlePageHide,
	handleSessionHandoffMessage,
	reset,
	restoreSessionFromReloadStash
} from './identity';
import { ensureSodium } from '$crypto/sodium';

const ENV_A = {
	v: 1,
	kdf: 'argon2id',
	kdfParams: { opslimit: 2, memlimit: 64 * 1024 * 1024 },
	salt: 'c2FsdC1h',
	nonce: 'bm9uY2UtYQ==',
	ciphertext: 'Y3QtYQ==',
	createdAt: 1
};
const ENV_B = { ...ENV_A, salt: 'c2FsdC1i', ciphertext: 'Y3QtYg==', createdAt: 2 };

/** A recognisable posting private key: 32 bytes of 'Q'. */
const PRIV = new Uint8Array(32).fill(0x51);
const PUB = new Uint8Array(33).fill(0x02);
const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u));

function live() {
	return {
		createdAt: 1,
		origin: 'posting-only',
		posting: { role: 'posting', publicKey: PUB.slice(), privateKey: PRIV.slice() },
		memo: null,
		ownerPublicKey: null,
		activePublicKey: null
	};
}

/** This tab unlocked (a sibling tab's handoff), with keystore `env`. */
function unlockWith(env: object): void {
	handleSessionHandoffMessage(
		{ t: 'offer', payload: { state: 'unlocked', live: live(), envelope: env } },
		() => {}
	);
	expect(get(identity).state).toBe('unlocked');
}

/** "Remember me" on: keystore `env` persisted on this device. */
function remembered(env: object): void {
	window.localStorage.setItem('morphit.keystore.mode', 'password');
	window.localStorage.setItem('morphit.keystore.envelope', JSON.stringify(env));
}

/** A service worker that answers the stash-key protocol from memory. */
let workerKeys: Map<string, Uint8Array>;
function controlledByWorker(): void {
	workerKeys = new Map();
	const controller = {
		postMessage(msg: { type?: string; id?: string; key?: Uint8Array }, transfer?: MessagePort[]) {
			if (msg.type === 'RELOAD_STASH_PUT' && msg.id && msg.key) {
				workerKeys.set(msg.id, msg.key.slice()); // structured clone
			} else if (msg.type === 'RELOAD_STASH_TAKE' && msg.id) {
				const key = workerKeys.get(msg.id) ?? null;
				workerKeys.delete(msg.id);
				transfer?.[0]?.postMessage({ key });
			}
		}
	};
	Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { controller } });
}
function noWorker(): void {
	delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
}
function thisLoadIs(type: string): void {
	vi.spyOn(performance, 'getEntriesByType').mockImplementation(((k: string) =>
		k === 'navigation' ? [{ type }] : []) as unknown as typeof performance.getEntriesByType);
}

/** Everything this tab has in sessionStorage. */
function sessionDump(): string {
	let out = '';
	for (let i = 0; i < window.sessionStorage.length; i++) {
		const k = window.sessionStorage.key(i)!;
		out += `${k}=${window.sessionStorage.getItem(k)}\n`;
	}
	return out;
}

/** The posting private key as the store holds it now (null when locked). */
function postingKey(): number[] | null {
	const s = get(identity);
	return s.state === 'unlocked' ? Array.from(s.live.posting.privateKey) : null;
}

beforeAll(async () => {
	await ensureSodium();
});
beforeEach(() => {
	reset();
	window.sessionStorage.clear();
	window.localStorage.clear();
	noWorker();
});
afterEach(() => {
	reset();
	window.sessionStorage.clear();
	window.localStorage.clear();
	noWorker();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('what a reload leaves on disk', () => {
	it('the stash holds no key bytes, in any encoding', () => {
		remembered(ENV_A);
		controlledByWorker();
		unlockWith(ENV_A);
		handlePageHide(false);
		const dump = sessionDump();
		expect(dump).not.toBe('');
		expect(dump).not.toContain(b64(PRIV));
		expect(dump).not.toContain(String.fromCharCode(...PRIV));
		expect(dump).not.toContain(Array.from(PRIV).join(','));
	});

	it('a session that is not the remembered one is never stashed', () => {
		remembered(ENV_A); // account A is remembered on this device …
		controlledByWorker();
		unlockWith(ENV_B); // … but this tab runs account B, "just this session"
		handlePageHide(false);
		expect(sessionDump()).toBe('');
	});

	it('nothing is stashed without "Remember me"', () => {
		controlledByWorker();
		unlockWith(ENV_A);
		handlePageHide(false);
		expect(sessionDump()).toBe('');
	});
});

describe('the next load', () => {
	it('a plain reload restores the remembered session', async () => {
		remembered(ENV_A);
		controlledByWorker();
		unlockWith(ENV_A);
		handlePageHide(false);
		expect(get(identity).state).toBe('locked');
		thisLoadIs('reload');
		await restoreSessionFromReloadStash();
		expect(postingKey()).toEqual(Array.from(PRIV));
		expect(sessionDump()).toBe('');
		expect(workerKeys.size).toBe(0);
	});

	it('a worker that lost the key (stopped, browser restarted): locked', async () => {
		remembered(ENV_A);
		controlledByWorker();
		unlockWith(ENV_A);
		handlePageHide(false);
		workerKeys.clear();
		thisLoadIs('reload');
		await restoreSessionFromReloadStash();
		expect(get(identity).state).toBe('locked');
		expect(sessionDump()).toBe('');
	});

	it('a hard reload (no controlling worker): locked, stash gone', async () => {
		remembered(ENV_A);
		controlledByWorker();
		unlockWith(ENV_A);
		handlePageHide(false);
		noWorker();
		thisLoadIs('reload');
		await restoreSessionFromReloadStash();
		expect(get(identity).state).toBe('locked');
		expect(sessionDump()).toBe('');
	});

	it('a restored tab 45 s later: locked', async () => {
		remembered(ENV_A);
		controlledByWorker();
		unlockWith(ENV_A);
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
		handlePageHide(false);
		vi.setSystemTime(new Date('2026-10-02T12:00:45Z'));
		thisLoadIs('reload');
		await restoreSessionFromReloadStash();
		expect(get(identity).state).toBe('locked');
	});

	it('a new visit, not a reload: locked', async () => {
		remembered(ENV_A);
		controlledByWorker();
		unlockWith(ENV_A);
		handlePageHide(false);
		thisLoadIs('navigate');
		await restoreSessionFromReloadStash();
		expect(get(identity).state).toBe('locked');
	});

	it('a plaintext stash left by an older build is deleted and never used', async () => {
		remembered(ENV_A);
		controlledByWorker();
		thisLoadIs('reload');
		window.sessionStorage.setItem(
			'morphit.session.reload-stash-v1',
			JSON.stringify({
				at: Date.now(),
				live: {
					...live(),
					posting: {
						role: 'posting',
						publicKey: { __u8__: b64(PUB) },
						privateKey: { __u8__: b64(PRIV) }
					}
				},
				envelope: ENV_A
			})
		);
		await restoreSessionFromReloadStash();
		expect(get(identity).state).toBe('locked');
		expect(window.sessionStorage.getItem('morphit.session.reload-stash-v1')).toBeNull();
	});
});
