// @vitest-environment jsdom
/**
 * An explicit Sign Out in one tab reaches every other open tab, including a
 * tab that was handed a "just this session" sign-in by the handoff — whose
 * account name lives in ITS OWN sessionStorage, which the tab that signed out
 * cannot reach.
 *
 * This file is that sibling tab: it is unlocked by a handoff, has a
 * conversation open and the chat badge running; then the other tab signs out
 * (sweeps the shared localStorage and posts 'signout'). Afterwards this tab
 * must not name the account to the operator, keep the name, or write the
 * signed-out person's peers back to disk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));

/** Every account named in a request to the operator, in order. */
const named: string[] = [];
vi.mock('$lib/indexer/client', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/indexer/client')>();
	const empty = async (account: string) => {
		named.push(account);
		return { ok: true as const, data: { items: [] } };
	};
	return { ...actual, getConversations: empty, getChatReadState: empty };
});

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

/** Every key and value in a storage area that mentions `needle`. */
function mentions(store: Storage, needle: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < store.length; i++) {
		const k = store.key(i)!;
		const v = store.getItem(k) ?? '';
		if (k.includes(needle) || v.includes(needle)) out.push(`${k}=${v}`);
	}
	return out;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let stopBadge: (() => void) | null = null;

/** This tab: handed the session, a conversation with `evil` open, badge on;
 *  then the OTHER tab signs out. */
async function siblingAfterSignOut() {
	vi.resetModules();
	const identity = await import('$stores/identity');
	const profile = await import('$blurt/ops/profile');
	const readState = await import('$lib/chat/readState');
	const { startChatUnreadChannel } = await import('$lib/notifications/chatUnread');
	const { sweepAccountStorageOnSignOut } = await import('$lib/storage/signOutSweep');
	const { ensureSodium } = await import('$crypto/sodium');
	await ensureSodium();

	identity.handleSessionHandoffMessage(
		{ t: 'offer', payload: { state: 'unlocked', live: live(), envelope: ENV }, account: 'zedsess' },
		() => {}
	);
	expect(profile.getUserBlurtAccount()).toBe('zedsess');
	readState.markConversationRead('evil', '');
	stopBadge = startChatUnreadChannel();
	await wait(20);
	expect(named).toContain('zedsess'); // the badge does poll while signed in

	// The other tab signs out: it sweeps the shared localStorage and tells us.
	sweepAccountStorageOnSignOut();
	identity.handleSessionHandoffMessage({ t: 'signout' }, () => {});
	await wait(1_100);
	named.length = 0;
	return { profile, readState };
}

beforeEach(() => {
	window.localStorage.clear();
	window.sessionStorage.clear();
	named.length = 0;
});
afterEach(async () => {
	stopBadge?.();
	stopBadge = null;
	const { reset } = await import('$stores/identity');
	reset();
});

describe('Sign Out in another tab', () => {
	it("forgets this tab's own account name", async () => {
		const { profile } = await siblingAfterSignOut();
		expect(mentions(window.sessionStorage, 'zedsess')).toEqual([]);
		expect(profile.getUserBlurtAccount()).toBeNull();
	});

	it('stops every request that names the account', async () => {
		await siblingAfterSignOut();
		document.dispatchEvent(new Event('visibilitychange')); // the badge's re-poll
		await wait(50);
		expect(named).toEqual([]);
	});

	it("a conversation view closing later writes none of the person's peers", async () => {
		const { readState } = await siblingAfterSignOut();
		readState.markConversationRead('evil', ''); // the view unmounts
		await wait(50);
		expect(mentions(window.localStorage, 'evil')).toEqual([]);
		expect(mentions(window.sessionStorage, 'evil')).toEqual([]);
	});
});
