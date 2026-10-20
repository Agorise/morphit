/**
 * v1.21.13: opening chat no longer broadcasts a chat key on the user's own
 * BLURT. Messages to an account without one go to its posting key. A key
 * published earlier is still kept current after a posting-key change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

const live = { posting: { privateKey: new Uint8Array(32).fill(5) } };
vi.mock('$stores/identity', () => ({ isUnlocked: readable(true), liveIdentity: readable(live) }));
vi.mock('$blurt/ops/profile', () => ({ getUserBlurtAccount: () => 'anna-new' }));
const broadcastChatIdentity = vi.fn(async () => ({ trx_id: 't', block_num: 1 }));
vi.mock('$blurt/ops/chatIdentity', () => ({ broadcastChatIdentity }));
let indexer:
	| { ok: true; data: { chat_pub: string } }
	| { ok: false; code: string; message: string } = {
	ok: false,
	code: 'not_found',
	message: 'no chat identity'
};
vi.mock('$lib/indexer/client', () => ({ getChatIdentity: async () => indexer }));

const { ensureChatIdentityPublished } = await import('./ensureChatIdentity');

beforeEach(() => broadcastChatIdentity.mockClear());

describe('ensureChatIdentityPublished', () => {
	it('never published: nothing is broadcast (no fee taken for opening chat)', async () => {
		indexer = { ok: false, code: 'not_found', message: 'no chat identity' };
		expect(await ensureChatIdentityPublished()).toEqual({
			kind: 'skipped',
			reason: 'not_published'
		});
		expect(broadcastChatIdentity).not.toHaveBeenCalled();
	});
	it('published earlier but stale (the posting key changed): re-published', async () => {
		indexer = { ok: true, data: { chat_pub: 'AAAA' } };
		expect((await ensureChatIdentityPublished()).kind).toBe('re_published');
		expect(broadcastChatIdentity).toHaveBeenCalledTimes(1);
	});
});
