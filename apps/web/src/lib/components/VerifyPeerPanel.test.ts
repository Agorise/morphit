// @vitest-environment jsdom
/**
 * Verify peer (v1.21.13 review: H1, M3, M4, L3). The panel compares the keys
 * messages actually use, by the same rule as sending; it never pins anything
 * by being opened; Accept pins exactly the keys whose number was shown, and
 * only that kind; each "nothing to compare" case says the right thing.
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
let status: () => Promise<'current' | 'stale' | 'none'>;
let keys: Record<string, Uint8Array[] | null | Error>;
let peerResult: unknown;
vi.mock('$lib/chat/chatService', () => ({
	ownChatKeyStatus: () => status(),
	orderPostingPubs: (k: unknown) => k
}));
vi.mock('$blurt/accountKeys', () => ({
	fetchAccountKeys: async (_o: string, account: string) => {
		const v = keys[account];
		if (v instanceof Error) throw v;
		return v ?? null;
	}
}));
vi.mock('$lib/chat/peerPubFetch', () => ({
	fetchPeerChatPubChainVerified: async () => peerResult
}));
vi.mock('$lib/chat/crypto', () => ({
	deriveChatIdentity: async () => ({ priv: new Uint8Array(32), pub: new Uint8Array(32).fill(9) }),
	decodeChatPub: () => new Uint8Array(32).fill(8)
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

async function open(): Promise<HTMLElement> {
	const { mount, flushSync } = await import('svelte');
	const { default: Panel } = await import('./VerifyPeerPanel.svelte');
	const target = document.createElement('div');
	document.body.appendChild(target);
	mount(Panel, { target, props: { me: 'anna', peer: 'bob', onClose: () => undefined } });
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
	return target;
}
const text = (t: HTMLElement) => t.textContent ?? '';

beforeEach(() => {
	localStorage.clear();
	computeSafetyNumber.mockClear();
	status = async () => 'none';
	keys = { anna: [K(1)], bob: [K(2)] };
	peerResult = { kind: 'ok', pub: new Uint8Array(32).fill(7) };
});
afterEach(() => {
	document.body.innerHTML = '';
});

describe('VerifyPeerPanel', () => {
	it('our key not published: posting keys — ours from chain, theirs; opening the panel pins nothing', async () => {
		const t = await open();
		expect(text(t)).toContain('P1');
		expect(text(t)).toContain('P2');
		expect(pin.pinnedPostingFor('bob')).toEqual([]);
	});

	it('both current: chat keys, as before', async () => {
		status = async () => 'current';
		const t = await open();
		expect(text(t)).toContain('C9');
		expect(text(t)).toContain('C7');
	});

	it('a chat key pinned here that the indexer now calls absent: the tamper warning, no number', async () => {
		status = async () => 'current';
		peerResult = { kind: 'not_published' };
		pin.setPin('bob', { blockNum: 1, trxId: 'a'.repeat(40), pubB64: 'AAAA' });
		const t = await open();
		expect(text(t)).toContain('chat.verify_peer.tamper_heading');
		expect(text(t)).toContain('pub_pin_withdrawn');
		expect(computeSafetyNumber).not.toHaveBeenCalled();
	});

	it('a key added to their account: the NEW number; Accept pins exactly those keys, posting kind only', async () => {
		await pin.resolvePostingKeyPin('bob', [b64(K(2))]);
		keys.bob = [K(2), K(4)];
		localStorage.setItem(
			'morphit.chat.pub_pin_pending',
			JSON.stringify({ bob: { blockNum: 2, trxId: 'b'.repeat(40), pubB64: 'NEW' } })
		);
		const t = await open();
		expect(text(t)).toContain('chat.verify_peer.key_changed_heading');
		expect(text(t)).toContain('P2.4');
		expect(pin.pinnedPostingFor('bob')).toEqual([b64(K(2))]); // not yet
		const accept = [...t.querySelectorAll('button')].find((b) =>
			(b.textContent ?? '').includes('chat.verify_peer.key_changed_accept')
		)!;
		accept.click();
		expect(pin.pinnedPostingFor('bob')).toEqual([b64(K(2)), b64(K(4))]);
		expect(pin.pendingKeyChange('bob')?.pubB64).toBe('NEW'); // the chat change is untouched
	});

	it('no account / no posting key of its own: said so, no number', async () => {
		keys.bob = null;
		expect(text(await open())).toContain('chat.verify_peer.no_account');
		document.body.innerHTML = '';
		keys.bob = [];
		expect(text(await open())).toContain('chat.verify_peer.no_posting_key');
		expect(computeSafetyNumber).not.toHaveBeenCalled();
	});

	it('the chain cannot be asked (our status, or their keys): the "try again" copy, not a tamper warning', async () => {
		keys.bob = new Error('timed out');
		let t = await open();
		expect(text(t)).toContain('chat.verify_peer.error_chain_unreachable');
		expect(text(t)).not.toContain('tamper');
		document.body.innerHTML = '';
		status = async () => {
			throw new Error('down');
		};
		t = await open();
		expect(text(t)).toContain('chat.verify_peer.error_chain_unreachable');
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

	it('first posting keys of a peer whose chat key is pinned: shown as a change to accept, not as ready', async () => {
		pin.setPin('bob', { blockNum: 1, trxId: 'a'.repeat(40), pubB64: 'AAAA' });
		const t = await open();
		expect(text(t)).toContain('chat.verify_peer.key_changed_heading');
		expect(text(t)).toContain('P2');
		expect(text(t)).not.toContain('chat.verify_peer.first_use_accept');
	});

	it('our key current, but posting keys of theirs wait for the user: those are compared', async () => {
		status = async () => 'current';
		pin.setPin('bob', { blockNum: 1, trxId: 'a'.repeat(40), pubB64: 'AAAA' });
		await pin
			.resolvePostingKeyPin('bob', [b64(K(2))], { needsConsent: true })
			.catch(() => undefined);
		const t = await open();
		expect(text(t)).toContain('chat.verify_peer.key_changed_heading');
		expect(text(t)).toContain('P2');
		expect(text(t)).not.toContain('C7');
	});

	it('our key on chain is an old one: the number, with the note that theirs may differ until it is replaced', async () => {
		status = async () => 'stale';
		const t = await open();
		expect(text(t)).toContain('P1');
		expect(text(t)).toContain('chat.verify_peer.own_key_stale');
	});
});
