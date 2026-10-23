/**
 * The browser's stream ticket against the INDEXER's check (v1.21.14):
 *
 *   - a ticket the browser signs opens the stream; one for another host, or
 *     signed by another key, does not;
 *   - device clocks that are off (review B, F2; review C, L1): a device hours or
 *     a day slow, a phone days fast, and a paired desktop's ticket lasting as
 *     long as the pairing.
 *
 * Here, in the web workspace, because the web module needs nothing generated:
 * imported from the indexer's tests it needed apps/web/.svelte-kit (the web
 * tsconfig extends a generated file), which a fresh checkout lacks until a
 * build has run — vitest-must-pass failed on every clean tree.
 */
import { describe, expect, it } from 'vitest';

import {
	STREAM_TICKET_MAX_TTL_S,
	verifyStreamTicket,
	_resetStreamTicketsForTest
} from '../../../../indexer/src/api/streamTicket';

const TEST_STREAM_HOST = 'morphit.test';

describe("the browser's ticket (apps/web streamTicketCore) — interop", () => {
	it('a ticket the browser signs opens the stream here; one for another host does not', async () => {
		const { mintStreamTicket } = await import('./streamTicketCore');
		const { PrivateKey } = await import('@beblurt/dblurt');
		const key = PrivateKey.fromSeed('stream-ticket-alice');
		const raw = new Uint8Array((key as unknown as { key: Buffer }).key);
		const lookup = async () => key.createPublic().toString();
		const nowS = Math.floor(Date.now() / 1000);
		const good = mintStreamTicket(raw, 'alice', 'Morphit.Test', 3600, nowS);
		expect(await verifyStreamTicket(good, ['alice'], [TEST_STREAM_HOST], lookup)).toMatchObject({
			ok: true
		});
		const elsewhere = mintStreamTicket(raw, 'alice', 'other.example', 3600, nowS);
		expect(
			await verifyStreamTicket(elsewhere, ['alice'], [TEST_STREAM_HOST], lookup)
		).toMatchObject({ ok: false, reason: 'wrong_host' });
		const otherKey = mintStreamTicket(
			new Uint8Array((PrivateKey.fromSeed('mallory') as unknown as { key: Buffer }).key),
			'alice',
			TEST_STREAM_HOST,
			3600,
			nowS
		);
		expect(await verifyStreamTicket(otherKey, ['alice'], [TEST_STREAM_HOST], lookup)).toMatchObject(
			{ ok: false, reason: 'bad_signature' }
		);
	});
});

describe('device clocks that are off (v1.21.14 review B, F2; review C, L1)', () => {
	// The browser dates a ticket by its own clock and keeps using it; the indexer
	// judges it by the server's. A device hours slow (a dual-boot machine keeping
	// local time in the hardware clock, a phone set by hand) signed tickets that
	// were already expired here, and kept reusing them: no live chat, silently,
	// for good. A phone a day fast made its paired desktop's ticket "too long".
	// And a paired desktop's ticket lasted 30 days of a pairing accepted for 365.
	const HOUR = 3600;
	const DAY = 24 * HOUR;
	async function setup() {
		const core = await import('./streamTicketCore');
		const { PrivateKey } = await import('@beblurt/dblurt');
		const key = PrivateKey.fromSeed('stream-ticket-alice');
		const raw = new Uint8Array((key as unknown as { key: Buffer }).key);
		const lookup = async () => key.createPublic().toString();
		return { core, raw, lookup };
	}
	const server = () => Math.floor(Date.now() / 1000);

	for (const slowBy of [7 * HOUR, 26 * HOUR]) {
		it(`a session ticket from a device ${slowBy / HOUR} h slow opens the stream, fresh and at its last reuse`, async () => {
			const { core, raw, lookup } = await setup();
			const deviceMint = server() - slowBy;
			const t = core.mintStreamTicket(
				raw,
				'alice',
				TEST_STREAM_HOST,
				core.MINTED_TTL_S,
				deviceMint
			);
			expect(await verifyStreamTicket(t, ['alice'], [TEST_STREAM_HOST], lookup)).toMatchObject({
				ok: true
			});
			// The browser reuses it until RENEW_BEFORE_S remains BY ITS OWN CLOCK.
			const lastReuseServer = deviceMint + core.MINTED_TTL_S - core.RENEW_BEFORE_S + slowBy;
			expect(lastReuseServer).toBeLessThan(deviceMint + core.MINTED_TTL_S);
			_resetStreamTicketsForTest();
			expect(
				await verifyStreamTicket(t, ['alice'], [TEST_STREAM_HOST], lookup, lastReuseServer * 1000)
			).toMatchObject({ ok: true });
		});
	}

	it('a paired ticket from a phone two days fast is not "too long"', async () => {
		const { core, raw, lookup } = await setup();
		const t = core.mintStreamTicket(
			raw,
			'alice',
			TEST_STREAM_HOST,
			core.PAIRED_TTL_S,
			server() + 2 * DAY
		);
		expect(await verifyStreamTicket(t, ['alice'], [TEST_STREAM_HOST], lookup)).toMatchObject({
			ok: true
		});
	});

	it("a paired desktop's ticket lasts as long as the pairing (a year)", async () => {
		const { core } = await setup();
		expect(core.PAIRED_TTL_S).toBeGreaterThanOrEqual(365 * DAY);
		expect(core.PAIRED_TTL_S + 3 * DAY).toBeLessThanOrEqual(STREAM_TICKET_MAX_TTL_S);
	});
});
