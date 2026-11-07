/**
 * Accounts' Blurt profile pictures, for every page (v1.23.3): the URL an
 * account set, read from the chain in batches and kept an hour; the picture
 * fetched by this instance; nothing at all on a hidden-only instance.
 */
import { describe, expect, it, vi } from 'vitest';

import {
	AVATAR_FAILED_MAX,
	AVATAR_FETCH_CONCURRENCY,
	AVATAR_QUEUE_MAX,
	AccountPictures,
	PICTURE_URL_TTL_MS,
	avatarProxyUrl
} from '$indexer/accountPictures';
import { setLogSink, type LogRecord } from '$log';
import * as IMG from '../fixtures/witnessAvatarImages';

const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

function setup(opts: {
	pictures: Record<string, string>;
	allowed?: boolean;
	fetchImage?: (url: string) => Promise<{ bytes: Uint8Array }>;
}) {
	let now = Date.parse('2026-11-06T20:00:00Z');
	const getAccounts = vi.fn(async (names: readonly string[]) => {
		const m = new Map<string, unknown>();
		for (const n of names) {
			if (n === 'nobody') continue; // no such account
			m.set(n, {
				name: n,
				posting_json_metadata: opts.pictures[n]
					? JSON.stringify({ profile: { profile_image: opts.pictures[n] } })
					: ''
			});
		}
		return m;
	});
	const fetched: string[] = [];
	const pics = new AccountPictures({
		blurt: { getAccounts } as never,
		now: () => now,
		allowed: () => opts.allowed ?? true,
		fetchImage:
			opts.fetchImage ??
			(async (url) => {
				fetched.push(url);
				return { bytes: b64(IMG.PNG) };
			})
	});
	return { pics, getAccounts, fetched, advance: (ms: number) => (now += ms) };
}

describe('AccountPictures (v1.23.3)', () => {
	it('the accounts asked for at once share one chain read; the answer is kept an hour', async () => {
		const { pics, getAccounts } = setup({
			pictures: { alice: 'https://img.example/a.png', bob: 'https://img.example/b.png' }
		});
		const [a, b, c] = await Promise.all([
			pics.urlOf('alice'),
			pics.urlOf('bob'),
			pics.urlOf('carol')
		]);
		expect([a, b, c]).toEqual(['https://img.example/a.png', 'https://img.example/b.png', null]);
		expect(getAccounts).toHaveBeenCalledTimes(1);
		expect(getAccounts.mock.calls[0]![0]).toEqual(['alice', 'bob', 'carol']);
		await pics.urlOf('carol'); // "no picture" is kept too
		expect(getAccounts).toHaveBeenCalledTimes(1);
	});

	it('a page asking one by one, a moment apart, still costs one chain read', async () => {
		const { pics, getAccounts } = setup({ pictures: {} });
		const first = pics.urlOf('alice');
		await new Promise((r) => setTimeout(r, 5));
		const second = pics.urlOf('bob');
		await Promise.all([first, second]);
		expect(getAccounts).toHaveBeenCalledTimes(1);
		expect(getAccounts.mock.calls[0]![0]).toEqual(['alice', 'bob']);
	});

	it('read again after an hour', async () => {
		const { pics, getAccounts, advance } = setup({
			pictures: { alice: 'https://img.example/a.png' }
		});
		await pics.urlOf('alice');
		advance(PICTURE_URL_TTL_MS + 1);
		await pics.urlOf('alice');
		expect(getAccounts).toHaveBeenCalledTimes(2);
	});

	it('the picture: fetched once, then from the cache; none set, or no account: nothing fetched', async () => {
		const { pics, fetched } = setup({ pictures: { alice: 'https://img.example/a.png' } });
		const first = await pics.pictureOf('alice');
		expect(first?.type).toBe('image/png');
		await pics.pictureOf('alice');
		expect(fetched).toEqual(['https://img.example/a.png']);
		expect(await pics.pictureOf('carol')).toBeNull();
		expect(await pics.pictureOf('nobody')).toBeNull();
		expect(fetched).toHaveLength(1);
	});

	it('a hidden-only instance reads and fetches nothing', async () => {
		const { pics, getAccounts, fetched } = setup({
			pictures: { alice: 'https://img.example/a.png' },
			allowed: false
		});
		expect(await pics.pictureOf('alice')).toBeNull();
		expect(getAccounts).not.toHaveBeenCalled();
		expect(fetched).toEqual([]);
	});

	it("the picture's own host gone: the Blurt image proxy's copy", async () => {
		const asked: string[] = [];
		const { pics } = setup({
			pictures: { alice: 'https://img.blurt.world/a.png' },
			fetchImage: async (url) => {
				asked.push(url);
				if (url.startsWith('https://img.blurt.world')) throw new Error('no DNS records');
				return { bytes: b64(IMG.PNG) };
			}
		});
		expect((await pics.pictureOf('alice'))?.type).toBe('image/png');
		expect(asked).toEqual(['https://img.blurt.world/a.png', avatarProxyUrl('alice')]);
	});

	it('what the chain said in bulk (the witness list) is used without another read', async () => {
		const { pics, getAccounts } = setup({ pictures: {} });
		pics.noteUrl('khrom', 'https://img.example/k.png');
		pics.noteUrl('saboin', null);
		expect(await pics.urlOf('khrom')).toBe('https://img.example/k.png');
		expect(await pics.urlOf('saboin')).toBeNull();
		expect(getAccounts).not.toHaveBeenCalled();
	});

	it('the chain cannot be read: nothing noted, asked again next time', async () => {
		const { pics, getAccounts } = setup({ pictures: {} });
		getAccounts.mockRejectedValueOnce(new Error('all nodes down'));
		expect(await pics.urlOf('alice')).toBeNull();
		await pics.urlOf('alice');
		expect(getAccounts).toHaveBeenCalledTimes(2);
	});

	it('review: the waiting queue is bounded — beyond it, "nothing now", no failure noted', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const fetched: string[] = [];
		const { pics } = setup({
			pictures: {},
			fetchImage: async (url) => {
				fetched.push(url);
				await gate;
				return { bytes: b64(IMG.PNG) };
			}
		});
		const n = AVATAR_FETCH_CONCURRENCY + AVATAR_QUEUE_MAX;
		for (let i = 0; i <= n; i++) pics.noteUrl(`acct${i}`, `https://img.example/${i}.png`);
		const waiting = Array.from({ length: n }, (_, i) => pics.pictureOf(`acct${i}`));
		await new Promise((r) => setTimeout(r, 0));
		expect(await pics.pictureOf(`acct${n}`)).toBeNull(); // over the limit, at once
		release();
		await Promise.all(waiting);
		expect(fetched).toHaveLength(n);
		// Not noted as a failure: asked again, it is fetched.
		expect((await pics.pictureOf(`acct${n}`))?.type).toBe('image/png');
	});

	it('review: the failures remembered are bounded', async () => {
		const { pics } = setup({
			pictures: {},
			fetchImage: async () => {
				throw new Error('HTTP 500');
			}
		});
		// Each failure logs a line; kept here, not printed — ten thousand of them
		// overflowed the vitest-must-pass smoke's output buffer (v1.23.3).
		const logged: LogRecord[] = [];
		const restore = setLogSink((r) => logged.push(r));
		try {
			for (let i = 0; i < AVATAR_FAILED_MAX + 5; i++) {
				pics.noteUrl(`x${i}`, `https://img.example/${i}.png`);
				await pics.pictureOf(`x${i}`);
			}
		} finally {
			restore();
		}
		expect(logged.filter((r) => r.event === 'avatar_unavailable')).toHaveLength(
			AVATAR_FAILED_MAX + 5
		);
		const failed = (pics as unknown as { failed: Map<string, number> }).failed;
		expect(failed.size).toBe(AVATAR_FAILED_MAX);
		expect(failed.has('x0\nhttps://img.example/0.png')).toBe(false);
	});
});
