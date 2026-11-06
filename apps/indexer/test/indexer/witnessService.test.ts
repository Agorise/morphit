/**
 * WitnessService — the /witnesses page's list, missed-block samples and
 * pictures (v1.23.0), with a stub chain, database and picture fetch.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	ACCOUNTS_TTL_MS,
	AVATAR_FAIL_TTL_MS,
	AVATAR_PROXY_REDIRECTS,
	AVATAR_TTL_MS,
	LIST_TTL_MS,
	SAMPLE_KEEP_MS,
	WITNESS_PAGE,
	WitnessService,
	avatarVersion,
	sniffImageType
} from '$indexer/witnessService';
import * as IMG from '../fixtures/witnessAvatarImages';

// A real 7×5 PNG (the dimensions check reads its header since the review).
const PNG = new Uint8Array(Buffer.from(IMG.PNG, 'base64'));
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = new TextEncoder().encode('GIF89a....');
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const SVG = new TextEncoder().encode(
	'<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>'
);
const HTML = new TextEncoder().encode('<!doctype html><title>404</title>');

const HEAD = 65087002;
const KEY = 'BLT8F2MsdPmACkzSCnRuCmm1Qz6rQdNDqBZSFCNZJCGn5ACwruVS9';
const witness = (owner: string, extra: Record<string, unknown> = {}) => ({
	owner,
	created: '2022-10-01T21:41:42',
	url: 'https://blurt.pl',
	votes: '1000000000000',
	total_missed: 10,
	last_confirmed_block_num: HEAD - 10,
	signing_key: KEY,
	running_version: '0.9.1',
	...extra
});
const meta = (img: string) => JSON.stringify({ profile: { profile_image: img } });

function setup(
	opts: {
		witnesses?: Array<Record<string, unknown>>;
		pictures?: Record<string, string>;
		avatarsAllowed?: boolean | (() => boolean);
		fetchImage?: (
			url: string,
			o?: { readonly sameOriginRedirects?: number }
		) => Promise<{ bytes: Uint8Array }>;
		pageOf?: (start: string) => unknown;
	} = {}
) {
	let now = Date.parse('2026-11-05T16:45:54Z');
	const list = opts.witnesses ?? [witness('khrom'), witness('saboin'), witness('fervi')];
	const pictures = { ...(opts.pictures ?? { khrom: 'https://img.blurt.world/khrom.png' }) };
	const calls = {
		witnesses: [] as string[],
		accounts: 0,
		dgp: 0,
		fetch: [] as string[],
		fetchOpts: [] as Array<{ readonly sameOriginRedirects?: number } | undefined>,
		sql: [] as Array<{ text: string; params?: unknown[] }>
	};
	const blurt = {
		callCondenser: vi.fn(async (method: string, params: readonly unknown[]) => {
			expect(method).toBe('get_witnesses_by_vote');
			calls.witnesses.push(params[0] as string);
			return opts.pageOf ? opts.pageOf(params[0] as string) : list;
		}),
		getDynamicGlobalProperties: vi.fn(async () => {
			calls.dgp++;
			return {
				head_block_number: HEAD,
				last_irreversible_block_num: HEAD - 20,
				total_vesting_fund_blurt: '396540355.664 BLURT',
				total_vesting_shares: '344824578.602727 VESTS'
			};
		}),
		getAccounts: vi.fn(async (names: readonly string[]) => {
			calls.accounts++;
			const m = new Map<string, unknown>();
			for (const n of names)
				m.set(n, {
					name: n,
					posting_json_metadata: pictures[n] ? meta(pictures[n]!) : '',
					witness_votes: ['khrom'],
					proxy: ''
				});
			return m;
		})
	};
	const db = {
		query: vi.fn(async (text: string, params?: unknown[]) => {
			calls.sql.push({ text, params });
			return { rows: [] };
		})
	};
	const fetchImage =
		opts.fetchImage ??
		(async (url: string) => {
			calls.fetch.push(url);
			return { bytes: PNG };
		});
	const svc = new WitnessService({
		blurt: blurt as never,
		db: db as never,
		apiDb: db as never,
		now: () => now,
		avatarsAllowed: () =>
			typeof opts.avatarsAllowed === 'function'
				? opts.avatarsAllowed()
				: (opts.avatarsAllowed ?? true),
		fetchImage: async (u, o) => {
			if (opts.fetchImage) calls.fetch.push(u);
			calls.fetchOpts.push(o);
			return fetchImage(u, o);
		}
	});
	return { svc, calls, pictures, advance: (ms: number) => (now += ms), blurt };
}

describe('sniffImageType', () => {
	it('knows PNG, JPEG, GIF and WebP by their first bytes, and nothing else', () => {
		expect(sniffImageType(PNG)).toBe('image/png');
		expect(sniffImageType(JPEG)).toBe('image/jpeg');
		expect(sniffImageType(GIF)).toBe('image/gif');
		expect(sniffImageType(WEBP)).toBe('image/webp');
		expect(sniffImageType(SVG)).toBeNull();
		expect(sniffImageType(HTML)).toBeNull();
		expect(sniffImageType(new Uint8Array())).toBeNull();
	});
});

describe('the list', () => {
	it('reads the chain at most once a minute, and once for many visitors at once', async () => {
		const { svc, calls, advance } = setup();
		await Promise.all([svc.getList(), svc.getList(), svc.getList()]);
		expect(calls.witnesses).toHaveLength(1);
		advance(LIST_TTL_MS - 1);
		await svc.getList();
		expect(calls.witnesses).toHaveLength(1);
		advance(2);
		await svc.getList();
		expect(calls.witnesses).toHaveLength(2);
	});

	it('pages past the 1000-per-call limit, from the last witness, without repeating it', async () => {
		const first = Array.from({ length: WITNESS_PAGE }, (_, i) =>
			witness(`w${String(i).padStart(4, '0')}`)
		);
		const second = [first[first.length - 1]!, witness('zz-last')];
		const { svc, calls } = setup({ pageOf: (start) => (start === '' ? first : second) });
		const body = await svc.getList();
		expect(calls.witnesses).toEqual(['', 'w0999']);
		expect(body.witnesses).toHaveLength(WITNESS_PAGE + 1);
		expect(new Set(body.witnesses.map((w) => w.owner)).size).toBe(WITNESS_PAGE + 1);
	});

	it('drops malformed rows instead of failing', async () => {
		const { svc } = setup({
			witnesses: [witness('khrom'), { owner: 'BAD NAME' }, { nope: 1 }, witness('saboin')]
		});
		const body = await svc.getList();
		expect(body.witnesses.map((w) => w.owner).sort()).toEqual(['khrom', 'saboin']);
	});

	it('names each picture by a tag of its URL', async () => {
		const { svc } = setup();
		const body = await svc.getList();
		const k = body.witnesses.find((w) => w.owner === 'khrom')!;
		expect(k.avatar).toBe(
			`/v1/witnesses/avatar/khrom?v=${avatarVersion('https://img.blurt.world/khrom.png')}`
		);
		expect(body.witnesses.find((w) => w.owner === 'saboin')!.avatar).toBeNull();
		expect(body.avatars).toBe(true);
	});

	it('on a hidden-only instance: no pictures, and no account reads for them', async () => {
		const { svc, calls } = setup({ avatarsAllowed: false });
		const body = await svc.getList();
		expect(body.avatars).toBe(false);
		expect(body.witnesses.every((w) => w.avatar === null)).toBe(true);
		expect(calls.accounts).toBe(0);
		expect(await svc.getAvatar('khrom')).toBeNull();
		expect(calls.fetch).toHaveLength(0);
	});
});

describe('pictures', () => {
	it('never fetched once the instance refuses clearnet, even with picture URLs already known', async () => {
		let allowed = true;
		const { svc, calls } = setup({ avatarsAllowed: () => allowed });
		await svc.getList();
		allowed = false;
		expect(await svc.getAvatar('khrom')).toBeNull();
		expect(calls.fetch).toHaveLength(0);
	});

	it('fetched once, then served from the cache for a day, then fetched again', async () => {
		const { svc, calls, advance } = setup();
		expect((await svc.getAvatar('khrom'))!.type).toBe('image/png');
		expect((await svc.getAvatar('khrom'))!.type).toBe('image/png');
		expect(calls.fetch).toEqual(['https://img.blurt.world/khrom.png']);
		advance(AVATAR_TTL_MS + 1);
		await svc.getAvatar('khrom');
		expect(calls.fetch).toHaveLength(2);
	});

	it('only for a witness in the list, and only one with a picture', async () => {
		const { svc, calls } = setup();
		expect(await svc.getAvatar('someone-else')).toBeNull();
		expect(await svc.getAvatar('saboin')).toBeNull();
		expect(calls.fetch).toHaveLength(0);
	});

	it('refuses anything that is not a raster image (an SVG can carry script)', async () => {
		const { svc } = setup({ fetchImage: async () => ({ bytes: SVG }) });
		expect(await svc.getAvatar('khrom')).toBeNull();
	});

	it('remembers a failure for an hour', async () => {
		// v1.23.1: one attempt is the witness's own picture, then the Blurt image
		// proxy; a failure of both is remembered for the hour.
		let n = 0;
		const { svc, calls, advance } = setup({
			fetchImage: async () => {
				n++;
				throw new Error('HTTP 500');
			}
		});
		expect(await svc.getAvatar('khrom')).toBeNull();
		expect(await svc.getAvatar('khrom')).toBeNull();
		expect(n).toBe(2);
		advance(AVATAR_FAIL_TTL_MS + 1);
		await svc.getAvatar('khrom');
		expect(n).toBe(4);
		expect(calls.fetch).toEqual([
			'https://img.blurt.world/khrom.png',
			'https://imgp.blurt.blog/profileimage/khrom/64x64',
			'https://img.blurt.world/khrom.png',
			'https://imgp.blurt.blog/profileimage/khrom/64x64'
		]);
	});

	describe("v1.23.1: the Blurt image proxy when the picture's own host fails", () => {
		it('a dead host (no DNS records) → the same picture from imgp.blurt.blog, following its own redirects only', async () => {
			const { svc, calls } = setup({
				fetchImage: async (u) => {
					if (u.startsWith('https://img.blurt.world/'))
						throw new Error('fetchJson: hostname img.blurt.world has no DNS records');
					return { bytes: PNG };
				}
			});
			const pic = await svc.getAvatar('khrom');
			expect(pic!.type).toBe('image/png');
			expect(calls.fetch).toEqual([
				'https://img.blurt.world/khrom.png',
				'https://imgp.blurt.blog/profileimage/khrom/64x64'
			]);
			// The witness's own host: no redirects (as before). The proxy: up to two,
			// and only on its own origin (fetchPublicBytes enforces that).
			expect(calls.fetchOpts).toEqual([undefined, { sameOriginRedirects: AVATAR_PROXY_REDIRECTS }]);
			expect(AVATAR_PROXY_REDIRECTS).toBe(3);
			// Served from the cache afterwards, like any picture.
			await svc.getAvatar('khrom');
			expect(calls.fetch).toHaveLength(2);
		});

		it('the proxy is not asked when the own picture works', async () => {
			const { svc, calls } = setup();
			await svc.getAvatar('khrom');
			expect(calls.fetch).toEqual(['https://img.blurt.world/khrom.png']);
		});

		it("nor for a witness that set no picture (it keeps the plain head, not the proxy's default)", async () => {
			const { svc, calls } = setup();
			expect(await svc.getAvatar('saboin')).toBeNull();
			expect(calls.fetch).toHaveLength(0);
		});

		it('what the proxy sends must pass the same checks (a raster image, sane size)', async () => {
			const { svc } = setup({
				fetchImage: async (u) => {
					if (u.startsWith('https://img.blurt.world/')) throw new Error('HTTP 404');
					return { bytes: HTML };
				}
			});
			expect(await svc.getAvatar('khrom')).toBeNull();
		});

		it('a picture already hosted on the proxy is not fetched twice', async () => {
			const own = 'https://imgp.blurt.blog/profileimage/khrom/64x64';
			let n = 0;
			const { svc, calls } = setup({
				pictures: { khrom: own },
				fetchImage: async () => {
					n++;
					throw new Error('HTTP 502');
				}
			});
			expect(await svc.getAvatar('khrom')).toBeNull();
			expect(n).toBe(1);
			expect(calls.fetch).toEqual([own]);
		});

		it("a picture on the proxy in another form is fetched once, with the proxy's redirects allowed (review)", async () => {
			const own = 'https://imgp.blurt.blog/64x64/https://img.blurt.world/khrom.png';
			const { svc, calls } = setup({ pictures: { khrom: own } });
			expect((await svc.getAvatar('khrom'))!.type).toBe('image/png');
			expect(calls.fetch).toEqual([own]);
			expect(calls.fetchOpts).toEqual([{ sameOriginRedirects: AVATAR_PROXY_REDIRECTS }]);
		});
	});

	it('a new picture URL is picked up at the next accounts read', async () => {
		const { svc, calls, pictures, advance } = setup();
		await svc.getAvatar('khrom');
		pictures.khrom = 'https://img.blurt.world/khrom-new.png';
		advance(LIST_TTL_MS + 1);
		await svc.getAvatar('khrom');
		// Accounts are read again only after an hour.
		expect(calls.fetch).toEqual(['https://img.blurt.world/khrom.png']);
		advance(ACCOUNTS_TTL_MS);
		const body = await svc.getList();
		expect(body.witnesses.find((w) => w.owner === 'khrom')!.avatar).toContain(
			avatarVersion(pictures.khrom)
		);
		await svc.getAvatar('khrom');
		expect(calls.fetch).toEqual([
			'https://img.blurt.world/khrom.png',
			'https://img.blurt.world/khrom-new.png'
		]);
	});

	it('one fetch for many visitors asking at once', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let n = 0;
		const { svc } = setup({
			fetchImage: async () => {
				n++;
				await gate;
				return { bytes: PNG };
			}
		});
		await svc.getList();
		const all = Promise.all([
			svc.getAvatar('khrom'),
			svc.getAvatar('khrom'),
			svc.getAvatar('khrom')
		]);
		await Promise.resolve();
		release();
		const got = await all;
		expect(n).toBe(1);
		expect(got.every((g) => g?.type === 'image/png')).toBe(true);
	});
});

describe('missed-block samples', () => {
	it('writes producing witnesses only, and deletes rows over 26 hours old', async () => {
		const { svc, calls } = setup({
			witnesses: [
				witness('khrom', { total_missed: 14013 }),
				witness('eastmael', { signing_key: 'BLT1111111111111111111111111111111114T1Anm' }),
				witness('etainclub', { last_confirmed_block_num: 18271852 })
			]
		});
		await svc.sample();
		const insert = calls.sql.find((q) => q.text.includes('INSERT INTO witness_missed_samples'))!;
		expect(insert.params![1]).toEqual(['khrom']);
		expect(insert.params![2]).toEqual([14013]);
		const del = calls.sql.find((q) => q.text.includes('DELETE FROM witness_missed_samples'))!;
		expect(Date.parse(insert.params![0] as string) - Date.parse(del.params![0] as string)).toBe(
			SAMPLE_KEEP_MS
		);
	});

	it('a failed read writes nothing and does not throw', async () => {
		const { svc, calls, blurt } = setup();
		blurt.callCondenser.mockRejectedValueOnce(new Error('all nodes down'));
		await expect(svc.sample()).resolves.toBeUndefined();
		expect(calls.sql).toHaveLength(0);
	});
});

describe('votes', () => {
	it('reads the account’s witness votes and proxy', async () => {
		const { svc } = setup();
		expect(await svc.getVotes('kencode')).toEqual({
			account: 'kencode',
			votes: ['khrom'],
			proxy: null,
			max_votes: 30
		});
	});
});
