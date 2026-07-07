// @vitest-environment jsdom
/**
 * Tests for the chain-anchored chat-pub pinning module.
 *
 * Covers every branch of comparePin (no_pin, match,
 * same_ref_different_pub, older_ref, newer_ref) plus the
 * read/write/clear API and the validation guards.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	comparePin,
	getPin,
	setPin,
	clearPin,
	clearAllPins,
	__listPinnedPeers,
	resolveChatPubFromIndexer,
	PUB_PIN_ERROR,
	PubPinError,
	type ChatPubPin,
	type ChainPubResult
} from './pubPin';

const VALID_TRX = 'a'.repeat(40); // 40-char hex
const OTHER_TRX = 'b'.repeat(40);
const VALID_PUB_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; // base64 of 32 zero bytes
const VALID_PUB_B = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='; // base64 of 32 0x01 bytes

function makePin(overrides: Partial<ChatPubPin> = {}): ChatPubPin {
	return {
		blockNum: 1000,
		trxId: VALID_TRX,
		pubB64: VALID_PUB_A,
		...overrides
	};
}

describe('pubPin — read/write/clear', () => {
	beforeEach(() => {
		try {
			localStorage.clear();
		} catch {
			// noop
		}
	});

	afterEach(() => {
		try {
			localStorage.clear();
		} catch {
			// noop
		}
	});

	it('returns null when no pin is set', () => {
		expect(getPin('alice')).toBeNull();
	});

	it('round-trips a pin via set/get', () => {
		const pin = makePin();
		setPin('alice', pin);
		expect(getPin('alice')).toEqual(pin);
	});

	it('rejects pins for invalid account names', () => {
		const pin = makePin();
		// Invalid: starts with digit
		setPin('1alice', pin);
		expect(getPin('1alice')).toBeNull();
		// Invalid: too short
		setPin('ab', pin);
		expect(getPin('ab')).toBeNull();
		// Invalid: contains uppercase
		setPin('Alice', pin);
		expect(getPin('Alice')).toBeNull();
	});

	it('rejects pins with malformed trxId', () => {
		setPin('alice', makePin({ trxId: 'too-short' }));
		expect(getPin('alice')).toBeNull();
		setPin('alice', makePin({ trxId: 'X'.repeat(40) })); // not lowercase hex
		expect(getPin('alice')).toBeNull();
	});

	it('rejects pins with negative or non-finite blockNum', () => {
		setPin('alice', makePin({ blockNum: -1 }));
		expect(getPin('alice')).toBeNull();
		setPin('alice', makePin({ blockNum: NaN }));
		expect(getPin('alice')).toBeNull();
		setPin('alice', makePin({ blockNum: Infinity }));
		expect(getPin('alice')).toBeNull();
	});

	it('overwrites an existing pin', () => {
		setPin('alice', makePin({ blockNum: 1000 }));
		setPin('alice', makePin({ blockNum: 2000 }));
		expect(getPin('alice')?.blockNum).toBe(2000);
	});

	it('clearPin removes a single peer', () => {
		setPin('alice', makePin());
		setPin('bob', makePin({ blockNum: 2000 }));
		clearPin('alice');
		expect(getPin('alice')).toBeNull();
		expect(getPin('bob')).not.toBeNull();
	});

	it('clearAllPins wipes the entire map', () => {
		setPin('alice', makePin());
		setPin('bob', makePin({ blockNum: 2000 }));
		setPin('carol', makePin({ blockNum: 3000 }));
		clearAllPins();
		expect(getPin('alice')).toBeNull();
		expect(getPin('bob')).toBeNull();
		expect(getPin('carol')).toBeNull();
		expect(__listPinnedPeers()).toEqual([]);
	});

	it('survives a corrupted store (returns null instead of throwing)', () => {
		try {
			localStorage.setItem('morphit.chat.pub_pins', 'not json {');
		} catch {
			// noop
		}
		expect(getPin('alice')).toBeNull();
		expect(__listPinnedPeers()).toEqual([]);
	});

	it('drops malformed entries on read', () => {
		// Manually plant a mix of valid and invalid entries.
		try {
			localStorage.setItem(
				'morphit.chat.pub_pins',
				JSON.stringify({
					alice: { blockNum: 1000, trxId: VALID_TRX, pubB64: VALID_PUB_A },
					'1bad-account': { blockNum: 1, trxId: VALID_TRX, pubB64: VALID_PUB_A },
					bob: { blockNum: 'not-a-number', trxId: VALID_TRX, pubB64: VALID_PUB_A },
					carol: { blockNum: 1000, trxId: 'short', pubB64: VALID_PUB_A },
					dan: 'not even an object'
				})
			);
		} catch {
			// noop — if storage isn't available, the test is moot.
			return;
		}
		expect(getPin('alice')).not.toBeNull();
		expect(getPin('1bad-account')).toBeNull();
		expect(getPin('bob')).toBeNull();
		expect(getPin('carol')).toBeNull();
		expect(getPin('dan')).toBeNull();
	});
});

describe('pubPin — comparePin branches', () => {
	beforeEach(() => {
		try {
			localStorage.clear();
		} catch {
			// noop
		}
	});

	it('no_pin when peer has never been pinned', () => {
		expect(comparePin('alice', makePin()).kind).toBe('no_pin');
	});

	it('match when incoming === pinned', () => {
		const pin = makePin();
		setPin('alice', pin);
		expect(comparePin('alice', pin).kind).toBe('match');
	});

	it('same_ref_different_pub when (block,trx) match but pub differs', () => {
		setPin('alice', makePin({ pubB64: VALID_PUB_A }));
		const incoming = makePin({ pubB64: VALID_PUB_B });
		const r = comparePin('alice', incoming);
		expect(r.kind).toBe('same_ref_different_pub');
		if (r.kind === 'same_ref_different_pub') {
			expect(r.oldPin.pubB64).toBe(VALID_PUB_A);
			expect(r.newRef.pubB64).toBe(VALID_PUB_B);
		}
	});

	it('older_ref when incoming blockNum < pinned blockNum', () => {
		setPin('alice', makePin({ blockNum: 2000 }));
		const incoming = makePin({ blockNum: 1500, trxId: OTHER_TRX });
		const r = comparePin('alice', incoming);
		expect(r.kind).toBe('older_ref');
	});

	it('newer_ref when incoming blockNum > pinned blockNum', () => {
		setPin('alice', makePin({ blockNum: 1000 }));
		const incoming = makePin({ blockNum: 2000, trxId: OTHER_TRX });
		const r = comparePin('alice', incoming);
		expect(r.kind).toBe('newer_ref');
		if (r.kind === 'newer_ref') {
			expect(r.oldPin.blockNum).toBe(1000);
			expect(r.newRef.blockNum).toBe(2000);
		}
	});

	it('older_ref when blockNum equal but trxId differs (different op same block)', () => {
		// Edge case: two different morphit_chat_identity_v1 ops in
		// the same block.  Highly unusual but possible if the user
		// signed two ops back-to-back.  We treat the pinned one as
		// authoritative and require the user to clear pin to
		// accept a divergent same-block ref.
		setPin('alice', makePin({ blockNum: 1000, trxId: VALID_TRX }));
		const incoming = makePin({ blockNum: 1000, trxId: OTHER_TRX });
		const r = comparePin('alice', incoming);
		expect(r.kind).toBe('older_ref');
	});

	it('comparePin does not mutate storage', () => {
		const pin = makePin({ blockNum: 1000 });
		setPin('alice', pin);
		comparePin('alice', makePin({ blockNum: 2000, trxId: OTHER_TRX }));
		expect(getPin('alice')?.blockNum).toBe(1000);
	});
});

describe('pubPin — resolveChatPubFromIndexer state machine', () => {
	beforeEach(() => {
		try {
			localStorage.clear();
		} catch {
			// noop
		}
	});

	const PUB_C = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=';

	function makeChain(result: ChainPubResult | null | Error) {
		let calls = 0;
		const fn = async (): Promise<ChainPubResult | null> => {
			calls += 1;
			if (result instanceof Error) throw result;
			return result;
		};
		return {
			fn,
			get calls() {
				return calls;
			}
		};
	}

	it('no_pin: TOFU first contact verifies via chain quorum, then pins (audit 2-9)', async () => {
		// Audit 2026-05 finding 2-9: TOFU path now goes through
		// chain quorum verify before pinning, so a hostile indexer
		// cannot substitute a pub on first contact.
		const indexer = makePin();
		const chain = makeChain({
			chatPubB64: VALID_PUB_A,
			blockNum: 100,
			trxId: 'a'.repeat(40)
		});
		const pubB64 = await resolveChatPubFromIndexer('alice', indexer, chain.fn);
		expect(pubB64).toBe(VALID_PUB_A);
		expect(chain.calls).toBe(1);
		expect(getPin('alice')?.pubB64).toBe(VALID_PUB_A);
	});

	it('no_pin: hostile indexer + truthful chain → chain wins, indexer pub never pinned', async () => {
		// Indexer claims VALID_PUB_B; chain says VALID_PUB_A.  The
		// fix means chain wins.
		const indexer = makePin({ pubB64: VALID_PUB_B });
		const chain = makeChain({
			chatPubB64: VALID_PUB_A,
			blockNum: 100,
			trxId: 'a'.repeat(40)
		});
		const pubB64 = await resolveChatPubFromIndexer('alice', indexer, chain.fn);
		expect(pubB64).toBe(VALID_PUB_A);
		expect(getPin('alice')?.pubB64).toBe(VALID_PUB_A);
	});

	it('no_pin: chain reports none → throws chain_reports_none', async () => {
		const indexer = makePin();
		const chain = makeChain(null);
		await expect(resolveChatPubFromIndexer('alice', indexer, chain.fn)).rejects.toMatchObject({
			code: PUB_PIN_ERROR.chain_reports_none,
			peer: 'alice'
		});
		expect(getPin('alice')).toBeNull();
	});

	it('match: returns pinned pub, no chain call', async () => {
		const pin = makePin();
		setPin('alice', pin);
		const chain = makeChain(new Error('should not be called'));
		const pubB64 = await resolveChatPubFromIndexer('alice', pin, chain.fn);
		expect(pubB64).toBe(VALID_PUB_A);
		expect(chain.calls).toBe(0);
	});

	it('same_ref_different_pub throws PubPinError(tampered_same_ref), pin preserved', async () => {
		setPin('alice', makePin({ pubB64: VALID_PUB_A }));
		const indexer = makePin({ pubB64: VALID_PUB_B });
		const chain = makeChain(new Error('should not be called'));
		await expect(resolveChatPubFromIndexer('alice', indexer, chain.fn)).rejects.toThrowError(
			PubPinError
		);
		await expect(resolveChatPubFromIndexer('alice', indexer, chain.fn)).rejects.toMatchObject({
			code: PUB_PIN_ERROR.tampered_same_ref,
			peer: 'alice'
		});
		expect(chain.calls).toBe(0);
		expect(getPin('alice')?.pubB64).toBe(VALID_PUB_A);
	});

	it('older_ref throws PubPinError(older_indexer_ref), pin preserved', async () => {
		setPin('alice', makePin({ blockNum: 2000 }));
		const indexer = makePin({ blockNum: 1500, trxId: OTHER_TRX });
		const chain = makeChain(new Error('should not be called'));
		await expect(resolveChatPubFromIndexer('alice', indexer, chain.fn)).rejects.toMatchObject({
			code: PUB_PIN_ERROR.older_indexer_ref
		});
		expect(getPin('alice')?.blockNum).toBe(2000);
	});

	it('equal blockNum + different trxId is treated as older_ref (same-block divergence)', async () => {
		setPin('alice', makePin({ blockNum: 1000, trxId: VALID_TRX }));
		const indexer = makePin({ blockNum: 1000, trxId: OTHER_TRX });
		const chain = makeChain(new Error('should not be called'));
		await expect(resolveChatPubFromIndexer('alice', indexer, chain.fn)).rejects.toMatchObject({
			code: PUB_PIN_ERROR.older_indexer_ref
		});
	});

	it('newer_ref + chain confirms with same pub: pin updates to chain', async () => {
		setPin('alice', makePin({ blockNum: 1000, trxId: VALID_TRX, pubB64: VALID_PUB_A }));
		const indexer = makePin({
			blockNum: 2000,
			trxId: OTHER_TRX,
			pubB64: VALID_PUB_B
		});
		const chain = makeChain({
			blockNum: 2000,
			trxId: OTHER_TRX,
			chatPubB64: VALID_PUB_B
		});
		const pubB64 = await resolveChatPubFromIndexer('alice', indexer, chain.fn);
		expect(pubB64).toBe(VALID_PUB_B);
		expect(chain.calls).toBe(1);
		expect(getPin('alice')?.blockNum).toBe(2000);
		expect(getPin('alice')?.pubB64).toBe(VALID_PUB_B);
	});

	it('newer_ref + chain DISAGREES with indexer: chain wins (active-MITM defense)', async () => {
		// Indexer claims pub VALID_PUB_B at block 2000; chain says
		// the actual published pub at block 2000 is PUB_C.  The
		// resolver MUST trust the chain.  A bug here is silent
		// MITM.
		setPin('alice', makePin({ blockNum: 1000, pubB64: VALID_PUB_A }));
		const indexer = makePin({
			blockNum: 2000,
			trxId: OTHER_TRX,
			pubB64: VALID_PUB_B
		});
		const chain = makeChain({
			blockNum: 2000,
			trxId: OTHER_TRX,
			chatPubB64: PUB_C // different from indexer
		});
		const pubB64 = await resolveChatPubFromIndexer('alice', indexer, chain.fn);
		expect(pubB64).toBe(PUB_C);
		expect(getPin('alice')?.pubB64).toBe(PUB_C);
	});

	it('newer_ref + chain returns null: throws chain_reports_none, pin preserved', async () => {
		setPin('alice', makePin({ blockNum: 1000 }));
		const indexer = makePin({ blockNum: 2000, trxId: OTHER_TRX });
		const chain = makeChain(null);
		await expect(resolveChatPubFromIndexer('alice', indexer, chain.fn)).rejects.toMatchObject({
			code: PUB_PIN_ERROR.chain_reports_none
		});
		expect(getPin('alice')?.blockNum).toBe(1000);
	});

	it('newer_ref + chain reports older than pin: throws chain_older_than_pin', async () => {
		setPin('alice', makePin({ blockNum: 5000 }));
		const indexer = makePin({ blockNum: 6000, trxId: OTHER_TRX });
		const chain = makeChain({
			blockNum: 4000,
			trxId: OTHER_TRX,
			chatPubB64: PUB_C
		});
		await expect(resolveChatPubFromIndexer('alice', indexer, chain.fn)).rejects.toMatchObject({
			code: PUB_PIN_ERROR.chain_older_than_pin
		});
		expect(getPin('alice')?.blockNum).toBe(5000);
	});

	it('newer_ref + chain RPC throws: underlying error propagates, pin unchanged', async () => {
		setPin('alice', makePin({ blockNum: 1000, pubB64: VALID_PUB_A }));
		const indexer = makePin({ blockNum: 2000, trxId: OTHER_TRX });
		const chain = makeChain(new Error('all RPC endpoints down'));
		await expect(resolveChatPubFromIndexer('alice', indexer, chain.fn)).rejects.toThrow(
			'all RPC endpoints down'
		);
		// Critical: pin must NOT have been silently updated to
		// indexer's claim when verification failed.
		expect(getPin('alice')?.pubB64).toBe(VALID_PUB_A);
	});
});
