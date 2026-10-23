// @vitest-environment jsdom
/**
 * Verify peer (v1.21.13 review: H1, M3, M4, L3; v1.21.14). The panel compares
 * the keys messages actually use — POSTING keys only since v1.21.14 (every
 * message is sent to and proved by them; chat relies on the posting key only);
 * it never pins anything by being opened; Accept pins exactly the keys whose
 * number was shown; each "nothing to compare" case says the right thing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

vi.mock(
	'svelte',
	async () =>
		await import(
			/* @vite-ignore */ '../../../../../node_modules/svelte/src/index-client.js' as string
		)
);
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.mock('svelte-i18n', async (orig) => ({
	...((await orig()) as object),
	_: readable((k: string) => k),
	locale: readable('en')
}));
const live = { posting: { privateKey: new Uint8Array(32).fill(3) } };
vi.mock('$stores/identity', () => ({
	isUnlocked: readable(true),
	identity: readable({ state: 'unlocked', live })
}));

const K = (n: number) => new Uint8Array(33).fill(n);
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
let keys: Record<string, Uint8Array[] | null | Error>;
vi.mock('$lib/chat/chatService', () => ({
	orderPostingPubs: (k: unknown) => k
}));
vi.mock('$blurt/accountKeys', () => ({
	fetchAccountKeys: async (_o: string, account: string) => {
		const v = keys[account];
		if (v instanceof Error) throw v;
		return v ?? null;
	}
}));
/** The "number" names the keys it was made from, so the test sees which. */
const computeSafetyNumber = vi.fn(
	async (
		a: { postingKeys?: Uint8Array[]; pub?: Uint8Array },
		b: { postingKeys?: Uint8Array[]; pub?: Uint8Array }
	) => {
		const id = (p: typeof a) =>
			p.postingKeys !== undefined
				? `P${p.postingKeys.map((k) => k[0]).join('.')}`
				: `C${p.pub![0]}`;
		return [id(a), id(b)];
	}
);
vi.mock('$lib/chat/fingerprint', () => ({ computeSafetyNumber }));

const pin = await import('$lib/chat/pubPin');

async function settle(): Promise<void> {
	const { flushSync } = await import('svelte');
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}
async function open(extra: Record<string, unknown> = {}): Promise<HTMLElement> {
	const { mount } = await import('svelte');
	const { default: Panel } = await import('./VerifyPeerPanel.svelte');
	const target = document.createElement('div');
	document.body.appendChild(target);
	mount(Panel, {
		target,
		props: { me: 'anna', peer: 'bob', onClose: () => undefined, ...extra } as never
	});
	await settle();
	return target;
}
const text = (t: HTMLElement) => t.textContent ?? '';

beforeEach(() => {
	localStorage.clear();
	computeSafetyNumber.mockClear();
	keys = { anna: [K(1)], bob: [K(2)] };
});
afterEach(() => {
	document.body.innerHTML = '';
});

describe('VerifyPeerPanel', () => {
	it('posting keys — ours from chain, theirs; opening the panel pins nothing', async () => {
		const t = await open();
		expect(text(t)).toContain('P1');
		expect(text(t)).toContain('P2');
		expect(pin.pinnedPostingFor('bob')).toEqual([]);
	});

	it('posting keys even when a chat key of theirs is pinned (chat keys are never compared now)', async () => {
		pin.setPin('bob', { blockNum: 1, trxId: 'a'.repeat(40), pubB64: 'AAAA' });
		const t = await open();
		expect(text(t)).toContain('P2');
		expect(
			computeSafetyNumber.mock.calls.every(([a, b]) => a.pub === undefined && b.pub === undefined)
		).toBe(true);
	});

	it('first posting keys of a peer whose chat key is pinned: an ordinary first use, not a "change" (v1.21.14)', async () => {
		pin.setPin('bob', { blockNum: 1, trxId: 'a'.repeat(40), pubB64: 'AAAA' });
		const t = await open();
		expect(text(t)).not.toContain('chat.verify_peer.key_changed_heading');
		expect(text(t)).toContain('chat.verify_peer.first_use_accept');
	});

	it('a pending entry the old hold left (nothing pinned): an ordinary first use, and "use these keys" clears it', async () => {
		localStorage.setItem(
			'morphit.chat.posting_pin_pending',
			JSON.stringify({ bob: { blockNum: 0, trxId: '0'.repeat(40), pubB64: b64(K(2)) } })
		);
		const t = await open();
		expect(text(t)).not.toContain('chat.verify_peer.key_changed_heading');
		[...t.querySelectorAll('button')]
			.find((b) => (b.textContent ?? '').includes('chat.verify_peer.first_use_accept'))!
			.click();
		expect(pin.pinnedPostingFor('bob')).toEqual([b64(K(2))]);
		expect(pin.pendingPostingKeyChange('bob')).toBeNull();
	});

	it('a key added to their account: the NEW number; Accept pins exactly those keys', async () => {
		await pin.resolvePostingKeyPin('bob', [b64(K(2))]);
		keys.bob = [K(2), K(4)];
		const accepted = vi.fn();
		const t = await open({ onAccepted: accepted });
		expect(text(t)).toContain('chat.verify_peer.key_changed_heading');
		expect(text(t)).toContain('P2.4');
		expect(pin.pinnedPostingFor('bob')).toEqual([b64(K(2))]); // not yet
		const accept = [...t.querySelectorAll('button')].find((b) =>
			(b.textContent ?? '').includes('chat.verify_peer.key_changed_accept')
		)!;
		accept.click();
		expect(pin.pinnedPostingFor('bob')).toEqual([b64(K(2)), b64(K(4))]);
		expect(accepted).toHaveBeenCalledTimes(1);
	});

	// v1.21.14 full chat audit, W-M2: Accept pins the keys the number was made
	// from — not whatever the account lists by the time of the tap.
	it('Accept pins the keys shown, never a set that replaced them meanwhile', async () => {
		await pin.resolvePostingKeyPin('bob', [b64(K(2))]);
		keys.bob = [K(4)];
		const t = await open();
		expect(text(t)).toContain('P4');
		keys.bob = [K(5)]; // the account changes again before the tap
		[...t.querySelectorAll('button')]
			.find((b) => (b.textContent ?? '').includes('chat.verify_peer.key_changed_accept'))!
			.click();
		expect(pin.pinnedPostingFor('bob')).toEqual([b64(K(4))]);
	});

	it('no account / no posting key of its own: said so, no number', async () => {
		keys.bob = null;
		expect(text(await open())).toContain('chat.verify_peer.no_account');
		document.body.innerHTML = '';
		keys.bob = [];
		expect(text(await open())).toContain('chat.verify_peer.no_posting_key');
		expect(computeSafetyNumber).not.toHaveBeenCalled();
	});

	it('the chain cannot be asked: the "try again" copy, not a tamper warning', async () => {
		keys.bob = new Error('timed out');
		const t = await open();
		expect(text(t)).toContain('chat.verify_peer.error_chain_unreachable');
		expect(text(t)).not.toContain('tamper');
	});

	it('first use: the number is shown, nothing pinned until "use these keys", which pins exactly them', async () => {
		const t = await open();
		expect(text(t)).toContain('chat.verify_peer.first_use_note');
		expect(pin.pinnedPostingFor('bob')).toEqual([]);
		const use = [...t.querySelectorAll('button')].find((b) =>
			(b.textContent ?? '').includes('chat.verify_peer.first_use_accept')
		)!;
		use.click();
		expect(pin.pinnedPostingFor('bob')).toEqual([b64(K(2))]);
	});
});

describe('your own half is checked against the key you signed in with (v1.21.14 review C, H1)', () => {
	// Your half of the number was made from what THIS instance says your posting
	// keys are. An instance serving both people could add a key of its own to
	// your account's list: the peer's client pins it at first contact and
	// encrypts every message to you for it too, and your half — built from the
	// same list — matched theirs. The number compared equal while the operator
	// read, and could sign, messages "from" you.
	afterEach(() => {
		delete (live.posting as { publicKey?: Uint8Array }).publicKey;
	});

	it('the instance lists a key besides yours: the number is shown with that key named, as a warning', async () => {
		(live.posting as { publicKey?: Uint8Array }).publicKey = K(1);
		const { PrivateKey } = await import('@beblurt/dblurt');
		const op = PrivateKey.fromSeed('operator-key').createPublic();
		const opBytes = new Uint8Array((op as unknown as { key: Uint8Array }).key);
		keys = { anna: [K(1), opBytes], bob: [K(2)] };
		const t = await open();
		// The key is written out as a BLT string (an async encoder): give it time.
		await vi.waitFor(() => expect(text(t)).toContain('chat.verify_peer.own_extra_heading'), {
			timeout: 3000
		});
		expect(text(t)).toContain(op.toString());
	});

	it('the instance does not list the key you signed in with: no number, said so', async () => {
		(live.posting as { publicKey?: Uint8Array }).publicKey = K(7);
		keys = { anna: [K(1)], bob: [K(2)] };
		const t = await open();
		expect(text(t)).toContain('chat.verify_peer.own_key_missing');
		expect(text(t)).not.toContain('P1');
	});

	it('only your own key listed: the ordinary number, no warning', async () => {
		(live.posting as { publicKey?: Uint8Array }).publicKey = K(1);
		keys = { anna: [K(1)], bob: [K(2)] };
		const t = await open();
		expect(text(t)).toContain('P1');
		expect(text(t)).not.toContain('own_extra_heading');
		expect(text(t)).not.toContain('own_key_missing');
	});
});
