// @vitest-environment jsdom
/**
 * A pinned peer's chat key must never change silently.
 *
 * The "chain" check behind a newer chat-identity reference goes through the
 * operator's own indexer (/v1/chain/condenser). A hostile operator can answer
 * with a transaction signed by its own key and an authority that lists that
 * key, so that check cannot be what moves a pin. A changed key is therefore
 * held back until the user confirms "safety number changed" — after comparing
 * the new safety number with the peer.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as pin from './pubPin';

const TRX_A = 'a'.repeat(40);
const TRX_B = 'b'.repeat(40);
const PUB_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const PUB_OPERATOR = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';

beforeEach(() => localStorage.clear());

describe('a pinned key that changes waits for the user', () => {
	it('a newer reference carrying a DIFFERENT key, "verified" through the relay, does not re-pin', async () => {
		pin.setPin('alice', { blockNum: 1000, trxId: TRX_A, pubB64: PUB_A });
		const operatorVerifier = async () => ({
			blockNum: 2000,
			trxId: TRX_B,
			chatPubB64: PUB_OPERATOR
		});
		let used: string | null = null;
		let code: string | null = null;
		try {
			used = await pin.resolveChatPubFromIndexer(
				'alice',
				{ blockNum: 2000, trxId: TRX_B, pubB64: PUB_OPERATOR },
				operatorVerifier
			);
		} catch (e) {
			code = (e as { code?: string }).code ?? null;
		}
		expect(used).toBeNull();
		expect(code).toBe('pub_pin_key_changed');
		expect(pin.getPin('alice')?.pubB64).toBe(PUB_A);
	});

	it('after the user confirms, the new key is pinned and used', async () => {
		pin.setPin('alice', { blockNum: 1000, trxId: TRX_A, pubB64: PUB_A });
		const verifier = async () => ({ blockNum: 2000, trxId: TRX_B, chatPubB64: PUB_OPERATOR });
		await expect(
			pin.resolveChatPubFromIndexer(
				'alice',
				{ blockNum: 2000, trxId: TRX_B, pubB64: PUB_OPERATOR },
				verifier
			)
		).rejects.toBeTruthy();
		const m = pin as unknown as {
			pendingKeyChange?: (p: string) => unknown;
			acceptKeyChange?: (p: string) => boolean;
		};
		expect(m.pendingKeyChange?.('alice')).toMatchObject({ pubB64: PUB_OPERATOR });
		expect(m.acceptKeyChange?.('alice')).toBe(true);
		expect(pin.getPin('alice')?.pubB64).toBe(PUB_OPERATOR);
		const used = await pin.resolveChatPubFromIndexer(
			'alice',
			{ blockNum: 2000, trxId: TRX_B, pubB64: PUB_OPERATOR },
			verifier
		);
		expect(used).toBe(PUB_OPERATOR);
	});

	it('a newer reference with the SAME key (republished identity) moves the pin without asking', async () => {
		pin.setPin('alice', { blockNum: 1000, trxId: TRX_A, pubB64: PUB_A });
		const verifier = async () => ({ blockNum: 2000, trxId: TRX_B, chatPubB64: PUB_A });
		const used = await pin.resolveChatPubFromIndexer(
			'alice',
			{ blockNum: 2000, trxId: TRX_B, pubB64: PUB_A },
			verifier
		);
		expect(used).toBe(PUB_A);
		expect(pin.getPin('alice')?.blockNum).toBe(2000);
	});
});
