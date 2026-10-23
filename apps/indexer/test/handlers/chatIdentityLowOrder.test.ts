/**
 * Small-order chat keys: the verdict stays what every node has always given
 * (v1.21.14 review A, F4).
 *
 * The audit (S-L3) found that the handler's byte list misses encodings X25519
 * reduces to a small-order point — p and p + 1 (non-canonical 0 and 1), and 0
 * and 1 with bit 255 set — and refused them by comparing keys as numbers. That
 * is a new rejection rule: on history it disagreed with every older node about
 * the same op, and from the consensus-v2 activation it would need every
 * instance on it first. Since v1.21.14 no client sends to a chat key, so the
 * stricter rule protects nothing; the byte list stands, at every block time.
 */
import { describe, expect, it } from 'vitest';

import handler from '$indexer/handlers/chatIdentity';
import { makeCtx } from '../testutils/context';
import { makeMockClient } from '../testutils/mockClient';

const P = (1n << 255n) - 19n;
const le = (n: bigint): Buffer => {
	const b = Buffer.alloc(32);
	for (let i = 0; i < 32; i++) b[i] = Number((n >> BigInt(8 * i)) & 0xffn);
	return b;
};
const HIGH = 1n << 255n;
const BEFORE_V2 = new Date('2026-10-01T00:00:00Z');
const AFTER_V2 = new Date('2026-11-02T00:00:00Z');

const publish = async (bytes: Buffer, blockTime: Date) => {
	const mock = makeMockClient([{ match: 'INSERT INTO chat_identities', rowCount: 1 }]);
	return handler(
		makeCtx({ signer: 'alice', blockTime, payload: { chat_pub: bytes.toString('base64') } }),
		mock.client
	);
};

describe('chat identity: small-order keys', () => {
	const listed: [string, bigint][] = [
		['0', 0n],
		['1', 1n],
		['p - 1', P - 1n],
		['p - 1 with bit 255 set', HIGH | (P - 1n)]
	];
	for (const [what, n] of listed)
		for (const t of [BEFORE_V2, AFTER_V2])
			it(`refuses ${what} (the byte list), block ${t.toISOString().slice(0, 10)}`, async () => {
				expect(await publish(le(n), t)).toEqual({ ok: false, reason: 'chat_pub_low_order' });
			});

	const notListed: [string, bigint][] = [
		['p (a non-canonical 0)', P],
		['p + 1 (a non-canonical 1)', P + 1n],
		['0 with bit 255 set', HIGH],
		['1 with bit 255 set', HIGH | 1n],
		['p with bit 255 set', HIGH | P],
		['p + 1 with bit 255 set', HIGH | (P + 1n)]
	];
	for (const [what, n] of notListed)
		for (const t of [BEFORE_V2, AFTER_V2])
			it(`${what}: the verdict every node gave before (accepted), block ${t.toISOString().slice(0, 10)}`, async () => {
				expect(await publish(le(n), t)).toEqual({ ok: true });
			});

	it('accepts an ordinary key', async () => {
		expect(await publish(le(9n), AFTER_V2)).toEqual({ ok: true });
		expect(await publish(le(P - 2n), AFTER_V2)).toEqual({ ok: true });
	});
});
