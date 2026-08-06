// @vitest-environment jsdom
/**
 * v1.8.15 (cp555) — witness chat-identity chain verification.
 *
 * THE BUG THIS GUARDS AGAINST. Ken and @mariuszkarowski (mk), on live
 * morphit.io: neither could open a chat with the Blurt witness @khrom — every
 * send died with the red "tamper detected — the blockchain reports none"
 * banner (pub_pin_chain_reports_none) — yet the two of them could chat with
 * each other fine. @khrom is a block PRODUCER: ~1.98M account-history entries,
 * almost all `producer_reward` virtual ops (~1,430/day), which bury the single
 * `morphit_chat_identity_v1` op far beyond get_account_history's 10000-entry
 * per-call cap (barely a week of a witness's activity). The old chain check
 * WALKED that window, found no identity op, and returned null → false tamper.
 * mk (a non-producer) verified fine because its identity op sat inside the
 * window.
 *
 * The fix verifies the indexer's CLAIMED op directly by trx_id
 * (verifyClaimedChatIdentityOnChain): O(1) and immune to account activity, so
 * it works for witnesses and ordinary accounts alike. These tests pin that a
 * claimed op which get_transaction resolves is trusted EVEN WHEN a history
 * walk would find nothing, and that a bogus / hostile / unsigned claim is still
 * rejected (so the tamper alarm still means something).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// `vi.mock` factories are hoisted above every top-level statement, so shared
// mutable state they close over must be hoisted with them.
const h = vi.hoisted(() => ({
	/** get_transaction(trxId) → registered tx, or null if absent. */
	txByTrx: new Map<string, unknown>(),
	/** get_accounts([[peer]]) → [{ posting }]; absent name → []. */
	postingByName: new Map<string, unknown>(),
	/** verdict returned by the (mocked) local signature verifier. */
	sigOk: true as boolean
}));

vi.mock('$net/chainRelay', () => ({
	ChainRelayError: class ChainRelayError extends Error {},
	chainRelay: vi.fn(async (method: string, params: unknown[]) => {
		if (method === 'get_transaction') {
			const trxId = params[0] as string;
			return h.txByTrx.has(trxId) ? h.txByTrx.get(trxId) : null;
		}
		if (method === 'get_accounts') {
			const names = (params[0] as string[]) ?? [];
			const posting = h.postingByName.get(names[0] ?? '');
			return posting === undefined ? [] : [{ posting }];
		}
		// Fallback history-walk path: empty history → the walk yields null.
		if (method === 'get_account_history') return [];
		return null;
	})
}));

vi.mock('./chainOpVerify', () => {
	const verdict = () =>
		h.sigOk
			? { ok: true, weightSum: 1, threshold: 1 }
			: { ok: false, code: 'weight_below_threshold', message: 'mock-fail' };
	return {
		verifyChainOpSignature: vi.fn(async () => verdict()),
		verifyTransactionSignatures: vi.fn(async () => verdict())
	};
});

// chainVerify imports getBlurtClient at module top (used only by the non-quorum
// helper, which these tests don't exercise) — the import must still resolve.
vi.mock('$blurt/client', () => ({
	getBlurtClient: () => ({ getLatestCustomJson: async () => null })
}));

import { verifyClaimedChatIdentityOnChain, verifyPeerChatIdentityOnChain } from './chainVerify';
import { OP_IDS } from '$net/config';

const KHROM = 'khrom';
const PUB_A = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
const TRX_A = 'a'.repeat(40);

/** Build a get_transaction result carrying a chat-identity custom_json op. */
function chatIdentityTx(opts: {
	author: string;
	pubB64: string;
	blockNum?: number;
	viaActiveAuth?: boolean;
	id?: string;
}): Record<string, unknown> {
	const usePosting = opts.viaActiveAuth !== true;
	const op = [
		'custom_json',
		{
			id: opts.id ?? OP_IDS.chatIdentity,
			required_auths: usePosting ? [] : [opts.author],
			required_posting_auths: usePosting ? [opts.author] : [],
			json: JSON.stringify({ v: 1, chat_pub: opts.pubB64, ts: 1_700_000_000 })
		}
	];
	return {
		ref_block_num: 1,
		ref_block_prefix: 1,
		expiration: '2026-01-01T00:00:00',
		operations: [op],
		extensions: [],
		signatures: ['00deadbeef'],
		block_num: opts.blockNum ?? 62_000_000
	};
}

beforeEach(() => {
	h.txByTrx.clear();
	h.postingByName.clear();
	h.sigOk = true;
	// khrom has an on-chain posting authority by default.
	h.postingByName.set(KHROM, { weight_threshold: 1, account_auths: [], key_auths: [['BLT_x', 1]] });
});

describe('verifyClaimedChatIdentityOnChain — witness fix (cp555)', () => {
	it('resolves the claimed op via get_transaction even when a history walk would find nothing', async () => {
		// THE REGRESSION: no account-history is provided (simulating a witness
		// whose identity op is buried beyond the window), yet the claimed trx
		// resolves and verifies. Pre-fix this returned null → chain_reports_none.
		h.txByTrx.set(TRX_A, chatIdentityTx({ author: KHROM, pubB64: PUB_A, blockNum: 62_123_456 }));
		const res = await verifyClaimedChatIdentityOnChain(KHROM, {
			blockNum: 62_123_456,
			trxId: TRX_A
		});
		expect(res).not.toBeNull();
		expect(res?.chatPubB64).toBe(PUB_A);
		expect(res?.trxId).toBe(TRX_A);
		expect(res?.blockNum).toBe(62_123_456); // chain's annotated block_num wins
	});

	it('accepts an op authored via required_auths as well as required_posting_auths', async () => {
		h.txByTrx.set(TRX_A, chatIdentityTx({ author: KHROM, pubB64: PUB_A, viaActiveAuth: true }));
		const res = await verifyClaimedChatIdentityOnChain(KHROM, { blockNum: 1, trxId: TRX_A });
		expect(res?.chatPubB64).toBe(PUB_A);
	});

	it('rejects a claimed trx not authored by peer (indexer pointing at a foreign op)', async () => {
		h.txByTrx.set(TRX_A, chatIdentityTx({ author: 'someoneelse', pubB64: PUB_A }));
		expect(
			await verifyClaimedChatIdentityOnChain(KHROM, { blockNum: 1, trxId: TRX_A })
		).toBeNull();
	});

	it('rejects a chat-identity op whose signature does not verify (fabricated body)', async () => {
		h.txByTrx.set(TRX_A, chatIdentityTx({ author: KHROM, pubB64: PUB_A }));
		h.sigOk = false;
		expect(
			await verifyClaimedChatIdentityOnChain(KHROM, { blockNum: 1, trxId: TRX_A })
		).toBeNull();
	});

	it('rejects when get_transaction returns null (fabricated / unknown trx_id)', async () => {
		expect(
			await verifyClaimedChatIdentityOnChain(KHROM, { blockNum: 1, trxId: TRX_A })
		).toBeNull();
	});

	it('rejects a malformed trx_id without any RPC round-trip', async () => {
		expect(
			await verifyClaimedChatIdentityOnChain(KHROM, { blockNum: 1, trxId: 'not-hex' })
		).toBeNull();
	});

	it('rejects when the op id is not the chat-identity id', async () => {
		h.txByTrx.set(
			TRX_A,
			chatIdentityTx({ author: KHROM, pubB64: PUB_A, id: 'morphit_chat_message_v1' })
		);
		expect(
			await verifyClaimedChatIdentityOnChain(KHROM, { blockNum: 1, trxId: TRX_A })
		).toBeNull();
	});

	it('rejects when peer has no on-chain posting authority', async () => {
		h.txByTrx.set(TRX_A, chatIdentityTx({ author: KHROM, pubB64: PUB_A }));
		h.postingByName.delete(KHROM);
		expect(
			await verifyClaimedChatIdentityOnChain(KHROM, { blockNum: 1, trxId: TRX_A })
		).toBeNull();
	});

	it('falls back to the claimed block when a non-conformant node omits block_num', async () => {
		const tx = chatIdentityTx({ author: KHROM, pubB64: PUB_A });
		delete tx.block_num;
		h.txByTrx.set(TRX_A, tx);
		const res = await verifyClaimedChatIdentityOnChain(KHROM, { blockNum: 999, trxId: TRX_A });
		expect(res?.blockNum).toBe(999);
	});
});

describe('verifyPeerChatIdentityOnChain — claimed-op-first orchestrator', () => {
	it('returns the claimed-op result without needing the history-walk fallback', async () => {
		h.txByTrx.set(TRX_A, chatIdentityTx({ author: KHROM, pubB64: PUB_A }));
		const res = await verifyPeerChatIdentityOnChain(KHROM, { blockNum: 1, trxId: TRX_A });
		expect(res?.chatPubB64).toBe(PUB_A);
	});

	it('falls back to the history walk when the claimed op is unresolvable (empty walk → null)', async () => {
		// No tx registered → claimed-op null → fallback walk → empty history → null.
		expect(await verifyPeerChatIdentityOnChain(KHROM, { blockNum: 1, trxId: TRX_A })).toBeNull();
	});
});
