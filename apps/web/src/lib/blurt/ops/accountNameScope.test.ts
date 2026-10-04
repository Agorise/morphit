// @vitest-environment jsdom
/**
 * A "just this session" sign-in must not leave the account name behind: the
 * app reads that name on every later visit (orders, chat stream, settings),
 * so a name left in localStorage announces the account to the operator from
 * then on, signed in or not, and a new import on the device inherits it.
 *
 *   - not remembered → the name lives in this tab's sessionStorage only;
 *   - remembered (its keystore is the one on disk) → localStorage, as before,
 *     including when Remember-me is committed after the unlock;
 *   - a tab handed the session by a sibling gets the name with it;
 *   - boot: a localStorage name with no keystore and no paired session on the
 *     device (left by an older build) is forgotten;
 *   - the chat state that names peers (read state, recent peers) follows the
 *     same rule as the name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));

const ENV = {
	v: 1,
	kdf: 'argon2id',
	kdfParams: { opslimit: 2, memlimit: 64 * 1024 * 1024 },
	salt: 'c2FsdA==',
	nonce: 'bm9uY2U=',
	ciphertext: 'Y3Q=',
	createdAt: 1
};
const live = () => ({
	createdAt: 1,
	origin: 'posting-only',
	posting: {
		role: 'posting',
		publicKey: new Uint8Array(33).fill(3),
		privateKey: new Uint8Array(32).fill(4)
	},
	memo: null,
	ownerPublicKey: null,
	activePublicKey: null
});

/** Every account-name key in a storage area. */
function names(store: Storage): string[] {
	const out: string[] = [];
	for (let i = 0; i < store.length; i++) {
		const k = store.key(i)!;
		if (k === 'morphit.blurtAccount' || k.startsWith('morphit.blurtAccount.'))
			out.push(`${k}=${store.getItem(k)}`);
	}
	return out;
}

async function load() {
	vi.resetModules();
	const identity = await import('$stores/identity');
	const profile = await import('$blurt/ops/profile');
	const keystore = await import('$crypto/persistentKeystore');
	const { ensureSodium } = await import('$crypto/sodium');
	await ensureSodium();
	return { identity, profile, keystore };
}

/** This tab unlocked by a sibling's handoff. */
function unlock(identity: Awaited<ReturnType<typeof load>>['identity'], account?: string): void {
	identity.handleSessionHandoffMessage(
		{ t: 'offer', payload: { state: 'unlocked', live: live(), envelope: ENV }, account },
		() => {}
	);
}

beforeEach(() => {
	window.localStorage.clear();
	window.sessionStorage.clear();
});
afterEach(async () => {
	const { reset } = await import('$stores/identity');
	reset();
});

describe('where the account name goes', () => {
	it('"just this session": the tab only, nothing in localStorage', async () => {
		const { identity, profile } = await load();
		unlock(identity);
		profile.setUserBlurtAccount('alice');
		expect(names(window.localStorage)).toEqual([]);
		expect(profile.getUserBlurtAccount()).toBe('alice');
	});

	it('remembered on this device: localStorage, as before', async () => {
		window.localStorage.setItem('morphit.keystore.mode', 'password');
		window.localStorage.setItem('morphit.keystore.envelope', JSON.stringify(ENV));
		const { identity, profile } = await load();
		unlock(identity);
		profile.setUserBlurtAccount('alice');
		expect(names(window.localStorage)).toContain('morphit.blurtAccount=alice');
	});

	it('Remember-me committed after the unlock moves the name to localStorage', async () => {
		const { identity, profile, keystore } = await load();
		unlock(identity);
		profile.setUserBlurtAccount('alice');
		keystore.writeKeystoreMode('password');
		keystore.writeEnvelope(ENV as never);
		expect(names(window.localStorage)).toContain('morphit.blurtAccount=alice');
		expect(names(window.sessionStorage)).toEqual([]);
	});

	it('a tab handed the session by a sibling gets the name with it', async () => {
		const { identity, profile } = await load();
		unlock(identity, 'alice');
		expect(profile.getUserBlurtAccount()).toBe('alice');
		expect(names(window.localStorage)).toEqual([]);
	});
});

/** Chat state that names peers: read state and recent peers. */
async function chat() {
	return {
		readState: await import('$lib/chat/readState'),
		recentPeers: await import('$lib/chat/recentPeers')
	};
}

/** Every storage entry, key or value, that mentions `peer`. */
function naming(store: Storage, peer: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < store.length; i++) {
		const k = store.key(i)!;
		const v = store.getItem(k) ?? '';
		if (k.includes(peer) || v.includes(peer)) out.push(k);
	}
	return out;
}

describe('where the chat state naming peers goes', () => {
	it('"just this session": usable in the tab, gone with it, never on disk', async () => {
		const { identity } = await load();
		const { readState, recentPeers } = await chat();
		unlock(identity, 'alice');
		readState.markConversationRead('carol', 'sell-btc-1');
		recentPeers.recordRecentPeer('carol');
		expect(recentPeers.loadRecentPeers()).toEqual(['carol']);
		expect(readState.getLastVisited('carol', 'sell-btc-1')).not.toBeNull();
		// Only this tab's sessionStorage holds them, so closing the tab forgets them.
		expect(naming(window.localStorage, 'carol')).toEqual([]);
		expect(naming(window.sessionStorage, 'carol').sort()).toEqual([
			'morphit.chat.read_state',
			'morphit.chat.recent_peers'
		]);
	});

	it('remembered on this device: localStorage, as before', async () => {
		window.localStorage.setItem('morphit.keystore.mode', 'password');
		window.localStorage.setItem('morphit.keystore.envelope', JSON.stringify(ENV));
		const { identity } = await load();
		const { readState, recentPeers } = await chat();
		unlock(identity, 'alice');
		readState.markConversationRead('carol', 'sell-btc-1');
		recentPeers.recordRecentPeer('carol');
		expect(naming(window.localStorage, 'carol').sort()).toEqual([
			'morphit.chat.read_state',
			'morphit.chat.recent_peers'
		]);
	});

	it('Remember-me committed after the unlock moves the chat state to localStorage', async () => {
		const { identity, keystore } = await load();
		const { recentPeers } = await chat();
		unlock(identity, 'alice');
		recentPeers.recordRecentPeer('carol');
		keystore.writeKeystoreMode('password');
		keystore.writeEnvelope(ENV as never);
		expect(naming(window.localStorage, 'carol')).toEqual(['morphit.chat.recent_peers']);
		expect(naming(window.sessionStorage, 'carol')).toEqual([]);
		expect(recentPeers.loadRecentPeers()).toEqual(['carol']);
	});
});

describe('boot', () => {
	it('a name with nothing on this device to sign in with is forgotten', async () => {
		window.localStorage.setItem('morphit.blurtAccount', 'alice');
		window.localStorage.setItem('morphit.blurtAccount.0303030303030303', 'alice');
		const { profile } = await load();
		expect(names(window.localStorage)).toEqual([]);
		expect(profile.getUserBlurtAccount()).toBeNull();
	});

	it('a remembered keystore keeps its name', async () => {
		window.localStorage.setItem('morphit.keystore.mode', 'password');
		window.localStorage.setItem('morphit.keystore.envelope', JSON.stringify(ENV));
		window.localStorage.setItem('morphit.blurtAccount', 'alice');
		const { profile } = await load();
		expect(profile.getUserBlurtAccount()).toBe('alice');
	});
});
