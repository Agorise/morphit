/**
 * Chat streams need a ticket signed by the account (v1.21.14 full chat audit,
 * S-M8), and a ticketed stream through the shared Tor/I2P key counts against
 * its account, not the allowance every anonymous visitor shares (S-M7).
 *
 * S-M8: the two chat streams answered anyone, and every instance shows a
 * message on the sender's own instance first — so anyone watching an account's
 * stream on every instance could tell which instance it uses. S-M7: one
 * anonymous client could hold every hidden-service stream slot.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { chatActivityStreamRoute } from '$api/chatActivityStream';
import { chatStreamRoute } from '$api/chatStream';
import { acquireStreamSlot, _resetStreamCapsForTest, _setStreamCapsForTest } from '$api/streamCaps';
import {
	instanceHosts,
	TICKET_RECOVER_KNOWN_PER_SEC,
	TICKET_RECOVER_PER_SEC,
	requestHost,
	STREAM_TICKET_MAX_TTL_S,
	verifyStreamTicket,
	_resetStreamTicketsForTest
} from '$api/streamTicket';
import { configureTrustedProxies, requestClient } from '$api/middleware/ratelimit';
import { streamTickets, TEST_STREAM_HOST } from '../testutils/streamTickets';

const T = await streamTickets();

const db = {
	query: async () => ({ rows: [], rowCount: 0 })
};
const poller = { getStatus: () => ({ indexedBlock: 1 }) };

beforeEach(() => {
	_resetStreamTicketsForTest();
	_resetStreamCapsForTest();
});
afterEach(() => {
	_resetStreamCapsForTest();
	configureTrustedProxies(undefined);
});

const activity = () => chatActivityStreamRoute(T.routeOpts);
const pair = () => chatStreamRoute(db as never, poller as never, T.routeOpts);
const open = async (
	app: ReturnType<typeof activity>,
	path: string,
	ticket?: string,
	host = TEST_STREAM_HOST
) => {
	const res = await app.request(
		ticket === undefined ? path : `${path}?ticket=${encodeURIComponent(ticket)}`,
		{ headers: { host } },
		{ incoming: { socket: { remoteAddress: '127.0.0.1' } } }
	);
	const status = res.status;
	await res.body?.cancel();
	return status;
};

describe('activity stream (S-M8)', () => {
	it('opens with a ticket the account signed for this host', async () => {
		expect(await open(activity(), '/alice/stream', T.ticketFor('alice'))).toBe(200);
	});
	it('no ticket: refused', async () => {
		expect(await open(activity(), '/alice/stream')).toBe(403);
	});
	it("someone else's ticket: refused", async () => {
		expect(await open(activity(), '/alice/stream', T.ticketFor('mallory'))).toBe(403);
	});
	it('a ticket naming alice but signed by another key: refused', async () => {
		expect(
			await open(activity(), '/alice/stream', T.ticketFor('alice', { signer: 'mallory' }))
		).toBe(403);
	});
	it('a ticket for another instance: refused (cannot be replayed elsewhere)', async () => {
		expect(
			await open(activity(), '/alice/stream', T.ticketFor('alice', { host: 'other.example' }))
		).toBe(403);
	});
	it('an expired ticket: refused', async () => {
		expect(await open(activity(), '/alice/stream', T.ticketFor('alice', { ttlS: -5 }))).toBe(403);
	});
	it('a ticket running longer than allowed: refused', async () => {
		expect(
			await open(
				activity(),
				'/alice/stream',
				T.ticketFor('alice', { ttlS: STREAM_TICKET_MAX_TTL_S + 3600 })
			)
		).toBe(403);
	});
	it('a tampered ticket: refused', async () => {
		const t = T.ticketFor('alice');
		const [p, s] = [t.slice(0, t.lastIndexOf('.')), t.slice(t.lastIndexOf('.') + 1)];
		const other = Buffer.from(
			JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), e: 9_999_999_999 })
		).toString('base64url');
		expect(await open(activity(), '/alice/stream', `${other}.${s}`)).toBe(403);
	});
	it('the host is compared without its port and case', () => {
		expect(requestHost('Morphit.Test:8080')).toBe('morphit.test');
		expect(requestHost('abc.onion')).toBe('abc.onion');
	});
	it("an instance's names: its configured origins and hidden addresses", () => {
		expect(
			instanceHosts(
				['https://Shop.Example', undefined, `${'a'.repeat(56)}.onion`, 'http://x.b32.i2p:8080', ''],
				'front:80'
			).sort()
		).toEqual([`${'a'.repeat(56)}.onion`, 'shop.example', 'x.b32.i2p']);
	});
	it('the name a request arrived under counts only for a hidden network with no configured address', () => {
		const onion = `${'b'.repeat(56)}.onion`;
		// No onion configured: the onion the visitor used is this instance's.
		expect(instanceHosts(['https://shop.example'], onion)).toContain(onion);
		// An onion configured: another onion in the Host header is the caller's word.
		expect(instanceHosts(['https://shop.example', `${'c'.repeat(56)}.onion`], onion)).not.toContain(
			onion
		);
		// A clearnet Host header never counts.
		expect(instanceHosts(['https://shop.example'], 'evil.example')).not.toContain('evil.example');
	});
	it('a ticket for another clearnet instance is refused whatever Host the request names', async () => {
		const app = chatActivityStreamRoute({
			lookupKey: T.lookupKey,
			instanceHosts: ['https://shop.example']
		});
		expect(
			await open(
				app,
				'/alice/stream',
				T.ticketFor('alice', { host: 'other.example' }),
				'other.example'
			)
		).toBe(403);
	});
	it('a ticket for a configured name opens the stream whatever Host the edge proxy forwards', async () => {
		const app = chatActivityStreamRoute({
			lookupKey: T.lookupKey,
			instanceHosts: ['https://shop.example']
		});
		expect(
			await open(app, '/alice/stream', T.ticketFor('alice', { host: 'shop.example' }), 'frontend')
		).toBe(200);
	});
});

describe('conversation stream (S-M8)', () => {
	it('either participant may watch it', async () => {
		expect(await open(pair(), '/alice/bob/stream', T.ticketFor('alice'))).toBe(200);
		expect(await open(pair(), '/alice/bob/stream', T.ticketFor('bob'))).toBe(200);
	});
	it('nobody else may', async () => {
		expect(await open(pair(), '/alice/bob/stream', T.ticketFor('carol'))).toBe(403);
		expect(await open(pair(), '/alice/bob/stream')).toBe(403);
	});
});

describe('cost bounds', () => {
	it(`past ${TICKET_RECOVER_PER_SEC} new tickets a second, the next waits (503, retry)`, async () => {
		const app = activity();
		const now = Date.now();
		const v: boolean[] = [];
		for (let i = 0; i < TICKET_RECOVER_PER_SEC; i++)
			v.push(
				(
					await verifyStreamTicket(
						T.ticketFor('mallory', { ttlS: 3600 + i }),
						['mallory'],
						[TEST_STREAM_HOST],
						async () => null,
						now
					)
				).ok
			);
		expect(v.every((x) => x === false)).toBe(true);
		// Another account whose key this instance does not hold: waits.
		const busy = await verifyStreamTicket(
			T.ticketFor('alice'),
			['alice'],
			[TEST_STREAM_HOST],
			async (a: string, opts?: { network?: boolean }) =>
				opts?.network === false ? null : T.lookupKey(a),
			now
		);
		expect(busy).toEqual({ ok: false, reason: 'busy' });
		void app;
	});
	it(`a member whose key this instance holds is checked under its own budget (review 2, finding 3)`, async () => {
		const now = Date.now();
		// A flood naming made-up accounts uses up the budget for unknown keys…
		for (let i = 0; i < TICKET_RECOVER_PER_SEC + 5; i++)
			await verifyStreamTicket(
				T.ticketFor(`junk${i % 26 === 0 ? 'a' : 'b'}${String.fromCharCode(97 + (i % 26))}x`, {
					ttlS: 3600 + i
				}),
				[`junk${i % 26 === 0 ? 'a' : 'b'}${String.fromCharCode(97 + (i % 26))}x`],
				[TEST_STREAM_HOST],
				async () => null,
				now
			);
		// …a member's ticket still opens…
		const member = await verifyStreamTicket(
			T.ticketFor('alice'),
			['alice'],
			[TEST_STREAM_HOST],
			T.lookupKey,
			now
		);
		expect(member.ok).toBe(true);
		// …until the members' budget itself is used up.
		const v: boolean[] = [];
		for (let i = 0; i < TICKET_RECOVER_KNOWN_PER_SEC; i++)
			v.push(
				(
					await verifyStreamTicket(
						T.ticketFor('bob', { ttlS: 3600 + i }),
						['bob'],
						[TEST_STREAM_HOST],
						T.lookupKey,
						now
					)
				).ok
			);
		expect(v.filter((x) => x).length).toBe(TICKET_RECOVER_KNOWN_PER_SEC - 1);
	});
	it('a chain read made for a ticket is charged to the ticket budget', async () => {
		const budgets: unknown[] = [];
		await verifyStreamTicket(
			T.ticketFor('alice'),
			['alice'],
			[TEST_STREAM_HOST],
			async (_a: string, opts?: { budget?: string }) => {
				budgets.push(opts?.budget);
				return null;
			}
		);
		expect(budgets.length).toBeGreaterThan(0);
		expect(budgets.every((b) => b === 'ticket')).toBe(true);
	});
	it('junk tickets cannot spend the key reads message delivery needs', async () => {
		const { postingKeyLookupFromDb, _resetKeyRefreshForTest } = await import(
			'$indexer/chatFastFederation'
		);
		_resetKeyRefreshForTest();
		let chainReads = 0;
		const real = (await T.lookupKey('carol'))!;
		const lookup = postingKeyLookupFromDb(
			{ query: async () => ({ rows: [], rowCount: 0 }) } as never,
			async (account: string) => {
				chainReads++;
				return account === 'carol' ? real : null;
			}
		);
		// 70 junk tickets, each naming a different made-up account and signed by
		// the attacker's own key.
		for (let i = 0; i < 70; i++)
			await verifyStreamTicket(
				T.ticketFor(`made-up${i}`, { signer: 'mallory' }),
				[`made-up${i}`],
				[TEST_STREAM_HOST],
				lookup,
				Date.now() + i * 30
			);
		const spent = chainReads;
		// A real account with no row still gets its key for a message.
		expect(await lookup('carol')).toBe(real);
		expect(chainReads).toBe(spent + 1);
		_resetKeyRefreshForTest();
	});
});

describe('a key on file the account has rotated away from', () => {
	it('is looked up again on the chain once, and the ticket then opens', async () => {
		const real = (await T.lookupKey('alice'))!;
		const stale = (await T.lookupKey('someone-else'))!;
		const asked: unknown[] = [];
		const lookup = async (_a: string, opts?: { refresh?: boolean }) => {
			asked.push(opts?.refresh === true);
			return opts?.refresh === true ? real : stale;
		};
		const v = await verifyStreamTicket(T.ticketFor('alice'), ['alice'], [TEST_STREAM_HOST], lookup);
		expect(v.ok).toBe(true);
		expect(asked).toEqual([false, true]);
	});
	it('a key the chain does not confirm either: refused', async () => {
		const stale = (await T.lookupKey('someone-else'))!;
		const v = await verifyStreamTicket(
			T.ticketFor('alice'),
			['alice'],
			[TEST_STREAM_HOST],
			async () => stale
		);
		expect(v.ok).toBe(false);
	});
});

describe('a verified ticket', () => {
	it('remembered, still only opens its own account on its own host', async () => {
		const t = T.ticketFor('alice');
		expect((await verifyStreamTicket(t, ['alice'], [TEST_STREAM_HOST], T.lookupKey)).ok).toBe(true);
		expect((await verifyStreamTicket(t, ['bob'], [TEST_STREAM_HOST], T.lookupKey)).ok).toBe(false);
		expect((await verifyStreamTicket(t, ['alice'], ['other.example'], T.lookupKey)).ok).toBe(false);
	});

	it('is looked up again after ten minutes (a rotated-away key stops working)', async () => {
		let key = (await T.lookupKey('alice'))!;
		const lookup = async () => key;
		const t = T.ticketFor('alice', { ttlS: 86_400 });
		const now = Date.now();
		expect((await verifyStreamTicket(t, ['alice'], [TEST_STREAM_HOST], lookup, now)).ok).toBe(true);
		key = (await T.lookupKey('rotated'))!;
		expect(
			(await verifyStreamTicket(t, ['alice'], [TEST_STREAM_HOST], lookup, now + 60_000)).ok
		).toBe(true);
		expect(
			(await verifyStreamTicket(t, ['alice'], [TEST_STREAM_HOST], lookup, now + 11 * 60_000)).ok
		).toBe(false);
	});
});

describe('stream caps through the shared Tor/I2P key (S-M7)', () => {
	// A hidden-service visitor as the indexer sees it behind the frontend: the
	// socket peer is the frontend container, the forwarded address its bridge.
	const torVisitor = () =>
		({
			env: { incoming: { socket: { remoteAddress: '172.20.0.5' } } },
			req: { header: (n: string) => ({ 'x-forwarded-for': '172.20.0.1' })[n.toLowerCase()] }
		}) as never;

	it('anonymous streams filling their allowance do not stop a ticketed chat stream', () => {
		_setStreamCapsForTest({ perClient: 24, global: 1000, shared: 15, anonShared: 10 });
		expect(requestClient(torVisitor()).shared).toBe(true);
		const held = Array.from({ length: 10 }, () => acquireStreamSlot(torVisitor()));
		expect(held.every((r) => r !== null)).toBe(true);
		expect(acquireStreamSlot(torVisitor())).toBeNull();
		expect(acquireStreamSlot(torVisitor(), 'alice')).not.toBeNull();
	});

	it('ticketed hidden-service streams count toward the shared total: clearnet keeps its share', () => {
		// Independent review of the audit fixes, finding 5.
		_setStreamCapsForTest({ perClient: 24, global: 20, shared: 12, anonShared: 6, perAccount: 4 });
		const got = ['a1', 'a2', 'a3', 'a4'].flatMap((a) =>
			Array.from({ length: 4 }, () => acquireStreamSlot(torVisitor(), a))
		);
		expect(got.filter((r) => r !== null)).toHaveLength(12);
		expect(acquireStreamSlot(torVisitor())).toBeNull();
		const clearnet = (ip: string) =>
			({
				env: { incoming: { socket: { remoteAddress: ip } } },
				req: { header: () => undefined }
			}) as never;
		const open = Array.from({ length: 8 }, (_, i) =>
			acquireStreamSlot(clearnet(`203.0.113.${i + 1}`))
		);
		expect(open.every((r) => r !== null)).toBe(true);
		// Releasing a ticketed stream frees a shared slot.
		got.find((r) => r !== null)!();
		expect(acquireStreamSlot(torVisitor(), 'a9')).not.toBeNull();
	});

	it('one account through the shared key is capped on its own', () => {
		_setStreamCapsForTest({ perClient: 24, global: 1000, shared: 10, perAccount: 3 });
		const got = Array.from({ length: 5 }, () => acquireStreamSlot(torVisitor(), 'alice'));
		expect(got.map((r) => r !== null)).toEqual([true, true, true, false, false]);
		expect(acquireStreamSlot(torVisitor(), 'bob')).not.toBeNull();
	});
});

// The browser-ticket interop and the device-clock checks live in the web
// workspace (apps/web/src/lib/chat/streamTicketInterop.test.ts): imported from
// here, the web module needed apps/web/.svelte-kit (its tsconfig extends a
// generated file), which a fresh checkout does not have until a build has run —
// so this suite failed in vitest-must-pass on a clean tree (v1.21.14 review).
