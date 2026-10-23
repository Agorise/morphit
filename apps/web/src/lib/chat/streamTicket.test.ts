/**
 * Which ticket a page uses for its chat streams (v1.21.14 full chat audit,
 * S-M8): an unlocked session signs its own; a paired desktop uses the one its
 * phone handed over; otherwise there is none and no stream is opened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';
import { PrivateKey, Signature } from '@beblurt/dblurt';

const live = writable<unknown>(null);
let account: string | null = 'alice';
let paired: unknown = null;
vi.mock('$lib/stores/identity', () => ({ liveIdentity: { subscribe: live.subscribe } }));
vi.mock('$lib/blurt/ops/profile', () => ({ getUserBlurtAccount: () => account }));
vi.mock('$lib/crypto/pairedSession', () => ({ readPairedSession: () => paired }));

const {
	MINTED_TTL_S,
	RENEW_BEFORE_S,
	mintStreamTicket,
	readStreamTicket,
	streamTicketDigest,
	streamTicketFor,
	withStreamTicket,
	_resetStreamTicketsForTest
} = await import('./streamTicket');

const key = PrivateKey.fromSeed('ticket-alice');
const raw = new Uint8Array((key as unknown as { key: Uint8Array }).key);
const signerOf = (t: string): string => {
	const dot = t.lastIndexOf('.');
	return Signature.fromString(t.slice(dot + 1))
		.recover(streamTicketDigest(t.slice(0, dot)) as never)
		.toString();
};

describe('stream tickets in the browser', () => {
	beforeEach(() => {
		_resetStreamTicketsForTest();
		vi.stubGlobal('location', { hostname: 'morphit.example' });
		live.set({ posting: { privateKey: raw } });
		account = 'alice';
		paired = null;
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('an unlocked session signs a ticket with its posting key, for this host', () => {
		const now = 1_800_000_000;
		const t = streamTicketFor('alice', now)!;
		expect(readStreamTicket(t)).toEqual({
			account: 'alice',
			host: 'morphit.example',
			expires: now + MINTED_TTL_S
		});
		expect(signerOf(t)).toBe(key.createPublic().toString());
	});

	it('reuses its ticket until it is close to expiry, then signs a new one', () => {
		const now = 1_800_000_000;
		const first = streamTicketFor('alice', now)!;
		expect(streamTicketFor('alice', now + 60)).toBe(first);
		const later = now + MINTED_TTL_S - RENEW_BEFORE_S + 1;
		const renewed = streamTicketFor('alice', later)!;
		expect(renewed).not.toBe(first);
		expect(readStreamTicket(renewed)?.expires).toBe(later + MINTED_TTL_S);
	});

	it('no ticket for another account, or when locked with nothing paired', () => {
		expect(streamTicketFor('bob')).toBeNull();
		live.set(null);
		expect(streamTicketFor('alice')).toBeNull();
		expect(withStreamTicket('/v1/chat-activity/alice/stream', 'alice')).toBeNull();
	});

	it("a paired desktop uses its phone's ticket — only for its account and this host, while valid", () => {
		live.set(null);
		const now = Math.floor(Date.now() / 1000);
		const phone = mintStreamTicket(raw, 'alice', 'morphit.example', 30 * 86400, now);
		paired = { account: 'alice', streamTicket: phone };
		expect(streamTicketFor('alice')).toBe(phone);
		expect(streamTicketFor('bob')).toBeNull();
		paired = {
			account: 'alice',
			streamTicket: mintStreamTicket(raw, 'alice', 'other.example', 3600, now)
		};
		expect(streamTicketFor('alice')).toBeNull();
		paired = {
			account: 'alice',
			streamTicket: mintStreamTicket(raw, 'alice', 'morphit.example', 10, now - 100)
		};
		expect(streamTicketFor('alice')).toBeNull();
	});

	it('adds the ticket to the stream URL', () => {
		const u = withStreamTicket('/v1/chat/alice/bob/stream', 'alice')!;
		expect(u.startsWith('/v1/chat/alice/bob/stream?ticket=')).toBe(true);
		const t = decodeURIComponent(u.split('ticket=')[1]!);
		expect(readStreamTicket(t)?.account).toBe('alice');
		expect(withStreamTicket('/x?y=1', 'alice')!.startsWith('/x?y=1&ticket=')).toBe(true);
	});
});

describe('a cached ticket belongs to the key that signed it (v1.21.14 review C, L2)', () => {
	beforeEach(() => {
		_resetStreamTicketsForTest();
		vi.stubGlobal('location', { hostname: 'morphit.example' });
		account = 'alice';
		paired = null;
	});
	afterEach(() => vi.unstubAllGlobals());

	it('after the posting key changes, the new key signs a new ticket at once', () => {
		live.set({ posting: { privateKey: raw } });
		const now = 1_800_000_000;
		const first = streamTicketFor('alice', now)!;
		expect(signerOf(first)).toBe(key.createPublic().toString());
		const rotated = PrivateKey.fromSeed('ticket-alice-rotated');
		live.set({
			posting: { privateKey: new Uint8Array((rotated as unknown as { key: Uint8Array }).key) }
		});
		const second = streamTicketFor('alice', now + 60)!;
		expect(signerOf(second)).toBe(rotated.createPublic().toString());
	});

	it('Sign Out forgets the tickets this page signed', async () => {
		live.set({ posting: { privateKey: raw } });
		const now = 1_800_000_000;
		expect(streamTicketFor('alice', now)).not.toBeNull();
		const { resetChatOnSignOut } = await import('./signOutReset');
		resetChatOnSignOut();
		live.set(null);
		expect(streamTicketFor('alice', now + 60)).toBeNull();
	});
});
