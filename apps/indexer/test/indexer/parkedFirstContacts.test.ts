/**
 * Parked first contacts are bounded per sender (independent review 2,
 * finding 9): a few accounts pushing messages they never broadcast must not
 * fill the shared table, or a real paid first contact that arrives before its
 * fee is never parked — and waits out the durable delay.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
	PARK_PER_SENDER,
	PARK_TTL_MS,
	parkFirstContact,
	parkedFirstContactsStatus,
	releaseFirstContacts,
	_resetParkedFirstContactsForTest
} from '$indexer/parkedFirstContacts';
import type { LocatedChatOp } from '$indexer/headTailer';

const item = (signer: string, recipient: string, n: number) => ({
	located: {
		signer,
		recipient,
		ciphertext: 'AAAA',
		header: {},
		clientTag: `t${n}`,
		orderPermlink: null
	} as unknown as LocatedChatOp,
	trxId: `${signer}-${recipient}-${n}`,
	createdAt: new Date(),
	gateAt: new Date(),
	blocked: async () => false,
	gate: async () => true,
	notify: async () => undefined
});

describe('parked first contacts', () => {
	beforeEach(() => _resetParkedFirstContactsForTest());

	it('one sender parks at most PARK_PER_SENDER, across recipients', () => {
		const now = 1_000_000;
		for (let i = 0; i < 40; i++) parkFirstContact(item('junk', `r${i}`, i), now);
		expect(parkedFirstContactsStatus().parked).toBe(PARK_PER_SENDER);
		// Another sender is not affected.
		parkFirstContact(item('buyer', 'seller', 1), now);
		expect(parkedFirstContactsStatus().parked).toBe(PARK_PER_SENDER + 1);
	});

	it("a sender's slots come back when its messages are released or expire", async () => {
		const now = 1_000_000;
		for (let i = 0; i < PARK_PER_SENDER; i++) parkFirstContact(item('s', `r${i}`, i), now);
		await releaseFirstContacts('s', 'r0', now);
		parkFirstContact(item('s', 'r-new', 99), now);
		expect(parkedFirstContactsStatus().parked).toBe(PARK_PER_SENDER);
		// After the park time, everything of theirs has expired: room again.
		parkFirstContact(item('s', 'r-later', 100), now + PARK_TTL_MS + 1);
		expect(parkedFirstContactsStatus().parked).toBe(1);
	});
});
