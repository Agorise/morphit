/**
 * Chat failures are logged without account names (v1.21.14 full chat audit,
 * S-L6). A failed push enqueue, a failed notify gate and a failed activity
 * replay used to log the recipient at warn level — a server-side record of
 * who was being written to, on disk, in exactly the cases nobody reads.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { setLogSink } from '$log';
import { enqueueChatPush } from '$indexer/chatPushEnqueue';
import { HeadTailer, type LocatedChatOp } from '$indexer/headTailer';

const failingDb = {
	query: async () => {
		throw new Error('database is down');
	}
};
let restore: (() => void) | null = null;
afterEach(() => {
	restore?.();
	restore = null;
});
const capture = (): string[] => {
	const records: string[] = [];
	restore = setLogSink((r) => records.push(JSON.stringify(r)));
	return records;
};

describe('no account names in chat failure logs (S-L6)', () => {
	it('a failed push enqueue', async () => {
		const records = capture();
		await enqueueChatPush(failingDb as never, {
			recipient: 'davereceiver',
			sender: 'carolsender',
			orderPermlink: null,
			sourceTrxId: 'trx1',
			eventAt: new Date()
		});
		expect(records.some((r) => r.includes('push_enqueue_failed'))).toBe(true);
		expect(records.filter((r) => /davereceiver|carolsender/.test(r))).toEqual([]);
	});

	it('a failed notify gate and a failed fast notify in the head tailer', async () => {
		const records = capture();
		const tailer = new HeadTailer({} as never, failingDb as never, {} as never, {
			signedBySigner: async () => true
		});
		const located = {
			signer: 'carolsender',
			recipient: 'davereceiver',
			ciphertext: 'AAAA',
			header: {},
			clientTag: 't',
			orderPermlink: null
		} as unknown as LocatedChatOp;
		const t = tailer as unknown as {
			fastNotifyAllowed(l: LocatedChatOp, at: Date): Promise<boolean>;
			maybeFastNotify(l: LocatedChatOp, id: string, at: Date): Promise<void>;
		};
		expect(await t.fastNotifyAllowed(located, new Date())).toBe(false);
		await t.maybeFastNotify(located, 'trx2', new Date());
		expect(records.length).toBeGreaterThan(0);
		expect(records.filter((r) => /davereceiver|carolsender/.test(r))).toEqual([]);
		tailer.stop();
	});
});
