/**
 * The /witnesses page's server side after its deep review (v1.23.0): each
 * test fails without its fix.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	AVATAR_FETCH_CONCURRENCY,
	AVATAR_FAIL_TTL_MS,
	LIST_TTL_MS,
	WitnessService,
	imageDimensions,
	sniffImageType
} from '$indexer/witnessService';
import { newestVersionOf, rankWitnesses } from '$indexer/witnessRanking';
import { fetchPublicBytes, resolvePublicIpCares } from '$indexer/federationProbe';
import * as IMG from '../fixtures/witnessAvatarImages';

const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
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
const CHAIN = {
	head_block_number: HEAD,
	last_irreversible_block_num: HEAD - 20,
	total_vesting_fund_blurt: '396540355.664 BLURT',
	total_vesting_shares: '344824578.602727 VESTS'
};

function service(opts: {
	witnesses: Array<Record<string, unknown>>;
	pictures: Record<string, string>;
	fetchImage?: (url: string) => Promise<{ bytes: Uint8Array }>;
}) {
	let now = Date.parse('2026-11-05T16:45:54Z');
	let fail = false;
	const blurt = {
		callCondenser: async () => {
			if (fail) throw new Error('all nodes down');
			return opts.witnesses;
		},
		getDynamicGlobalProperties: async () => CHAIN,
		getAccounts: vi.fn(async (names: readonly string[]) => {
			const m = new Map<string, unknown>();
			for (const n of names)
				m.set(n, {
					name: n,
					posting_json_metadata: opts.pictures[n]
						? JSON.stringify({ profile: { profile_image: opts.pictures[n] } })
						: ''
				});
			return m;
		})
	};
	const db = { query: async () => ({ rows: [] }) };
	const svc = new WitnessService({
		blurt: blurt as never,
		db: db as never,
		apiDb: db as never,
		now: () => now,
		avatarsAllowed: () => true,
		fetchImage: opts.fetchImage ?? (async () => ({ bytes: b64(IMG.PNG) }))
	});
	return {
		svc,
		blurt,
		advance: (ms: number) => (now += ms),
		setFail: (v: boolean) => (fail = v)
	};
}

describe('the newest version needs several producing witnesses', () => {
	it('one witness reporting 0.255.0 changes nothing for the others', () => {
		const raw = [
			witness('liar', { running_version: '0.255.0' }),
			witness('a'),
			witness('b'),
			witness('c', { running_version: '0.9.0' })
		];
		const r = rankWitnesses(raw as never, CHAIN, new Map(), Date.parse('2026-11-05T16:45:54Z'));
		expect(r.newestVersion).toBe('0.9.1');
		expect(r.witnesses.filter((w) => w.version_behind)).toEqual([]);
		// The liar is not behind either, and gains nothing over an honest witness.
		const liar = r.witnesses.find((w) => w.owner === 'liar')!;
		const honest = r.witnesses.find((w) => w.owner === 'a')!;
		expect(liar.score).toBe(honest.score);
	});

	it('a whole version behind still counts once three run the newer one', () => {
		expect(
			newestVersionOf([
				{ running_version: '0.9.1' },
				{ running_version: '0.9.0' },
				{ running_version: '0.9.1' },
				{ running_version: '0.8.2' }
			])
		).toEqual([0, 9, 1]);
	});

	it('on a tiny network: the major.minor most of them run', () => {
		expect(
			newestVersionOf([
				{ running_version: '0.9.1' },
				{ running_version: '0.8.2' },
				{ running_version: '0.8.1' }
			])
		).toEqual([0, 8, 2]);
		expect(newestVersionOf([{ running_version: 'x' }])).toBeNull();
	});
});

describe('pictures: producing witnesses only', () => {
	it('a witness that is not producing gets no picture path and no fetch', async () => {
		let fetched = 0;
		const { svc } = service({
			witnesses: [witness('khrom'), witness('spam', { last_confirmed_block_num: 0 })],
			pictures: { khrom: 'https://img.example/k.png', spam: 'https://attacker.example/x.png' },
			fetchImage: async () => {
				fetched++;
				return { bytes: b64(IMG.PNG) };
			}
		});
		const body = await svc.getList();
		expect(body.witnesses.find((w) => w.owner === 'spam')!.avatar).toBeNull();
		expect(body.witnesses.find((w) => w.owner === 'khrom')!.avatar).not.toBeNull();
		expect(await svc.getAvatar('spam')).toBeNull();
		expect(fetched).toBe(0);
	});
});

describe('pictures: each gate on its own', () => {
	it('the accounts of witnesses not producing are never read for pictures', async () => {
		const { svc, blurt } = service({
			witnesses: [witness('khrom'), witness('spam', { last_confirmed_block_num: 0 })],
			pictures: { khrom: 'https://img.example/k.png', spam: 'https://attacker.example/x.png' }
		});
		await svc.getList();
		const asked = blurt.getAccounts.mock.calls.flatMap((c) => [...(c[0] as readonly string[])]);
		expect(asked).toEqual(['khrom']);
	});

	it('a witness that stops producing gets no fetch, though its picture URL is still known', async () => {
		const list = [witness('khrom'), witness('fading')];
		let fetched = 0;
		const { svc, advance } = service({
			witnesses: list,
			pictures: { khrom: 'https://img.example/k.png', fading: 'https://img.example/f.png' },
			fetchImage: async () => {
				fetched++;
				return { bytes: b64(IMG.PNG) };
			}
		});
		await svc.getList();
		// Within the hour the accounts are not read again; the witness stops producing.
		list[1] = witness('fading', { last_confirmed_block_num: 0 });
		advance(LIST_TTL_MS + 1);
		expect(await svc.getAvatar('fading')).toBeNull();
		expect(fetched).toBe(0);
	});
});

describe('the fetch limit is never exceeded', () => {
	// A finishing fetch frees its slot and wakes the next queued one; a new
	// request arriving in the microtasks between used to get in as well, one
	// over the limit. Sweep where in that window the new request lands.
	for (let k = 0; k <= 8; k++) {
		it(`at most ${AVATAR_FETCH_CONCURRENCY} at once, a new request ${k} microtasks after a fetch ends`, async () => {
			const owners = Array.from({ length: AVATAR_FETCH_CONCURRENCY + 2 }, (_, i) => `wit${i}`);
			const gates = new Map<string, () => void>();
			let active = 0;
			let peak = 0;
			const { svc } = service({
				witnesses: owners.map((o) => witness(o)),
				pictures: Object.fromEntries(owners.map((o) => [o, `https://img.example/${o}.png`])),
				fetchImage: async (url) => {
					active++;
					peak = Math.max(peak, active);
					await new Promise<void>((r) => gates.set(url, r));
					active--;
					return { bytes: b64(IMG.PNG) };
				}
			});
			await svc.getList();
			// Fill every slot, and queue one more.
			const first = owners.slice(0, AVATAR_FETCH_CONCURRENCY + 1).map((o) => svc.getAvatar(o));
			for (let i = 0; i < 20; i++) await Promise.resolve();
			expect(peak).toBe(AVATAR_FETCH_CONCURRENCY);
			// One fetch ends; the new request lands k microtasks later.
			gates.get('https://img.example/wit0.png')!();
			for (let i = 0; i < k; i++) await Promise.resolve();
			const late = svc.getAvatar(owners[owners.length - 1]!);
			for (let i = 0; i < 20; i++) await Promise.resolve();
			expect(peak).toBeLessThanOrEqual(AVATAR_FETCH_CONCURRENCY);
			for (const g of gates.values()) g();
			for (let i = 0; i < 20; i++) await Promise.resolve();
			for (const g of gates.values()) g();
			await Promise.all([...first, late]);
		});
	}
});

describe('failures are forgotten', () => {
	it('expired failures are dropped when a new one is noted', async () => {
		const owners = ['aaa', 'bbb', 'ccc'];
		const { svc, advance } = service({
			witnesses: owners.map((o) => witness(o)),
			pictures: Object.fromEntries(owners.map((o) => [o, `https://img.example/${o}.png`])),
			fetchImage: async () => {
				throw new Error('HTTP 500');
			}
		});
		await svc.getAvatar('aaa');
		await svc.getAvatar('bbb');
		advance(AVATAR_FAIL_TTL_MS + 1);
		await svc.getAvatar('ccc');
		const failed = (svc as unknown as { avatarFailed: Map<string, number> }).avatarFailed;
		expect([...failed.keys()]).toEqual(['ccc\nhttps://img.example/ccc.png']);
	});
});

describe('the chain unreachable: the last list, not an error', () => {
	it('serves the last list (and its pictures) while the chain cannot be read', async () => {
		const { svc, advance, setFail } = service({
			witnesses: [witness('khrom')],
			pictures: { khrom: 'https://img.example/k.png' }
		});
		const first = await svc.getList();
		await svc.getAvatar('khrom');
		advance(LIST_TTL_MS + 1);
		setFail(true);
		expect((await svc.getList()).generated_at).toBe(first.generated_at);
		expect(await svc.getAvatar('khrom')).not.toBeNull();
	});

	it('with no list yet, it still fails', async () => {
		const { svc, setFail } = service({ witnesses: [witness('khrom')], pictures: {} });
		setFail(true);
		await expect(svc.getList()).rejects.toThrow(/all nodes down/);
	});
});

describe('image headers', () => {
	it('reads the size of real PNG, GIF, JPEG and the three WebP kinds', () => {
		for (const [name, data] of [
			['png', IMG.PNG],
			['gif', IMG.GIF],
			['jpeg', IMG.JPEG],
			['webp lossy', IMG.WEBP_LOSSY],
			['webp lossless', IMG.WEBP_LOSSLESS],
			['webp alpha', IMG.WEBP_ALPHA]
		] as const) {
			const b = b64(data);
			const t = sniffImageType(b);
			expect(t, name).not.toBeNull();
			expect(imageDimensions(b, t!), name).toEqual({ w: 7, h: 5 });
		}
	});

	it('a small file declaring a huge image is refused', async () => {
		for (const data of [IMG.PNG_HUGE, IMG.JPEG_HUGE]) {
			const { svc } = service({
				witnesses: [witness('khrom')],
				pictures: { khrom: 'https://img.example/k.png' },
				fetchImage: async () => ({ bytes: b64(data) })
			});
			expect(await svc.getAvatar('khrom')).toBeNull();
		}
	});
});

describe('DNS for a picture host', () => {
	it('the deadline covers the lookup: a name server that never answers costs the timeout, no more', async () => {
		const t0 = Date.now();
		await expect(
			fetchPublicBytes('https://never-answers.example/a.png', {
				timeoutMs: 60,
				resolve: () => new Promise(() => {})
			})
		).rejects.toThrow(/DNS lookup timed out/);
		expect(Date.now() - t0).toBeLessThan(2_000);
	});

	it('c-ares: every A and AAAA record must be public', async () => {
		const stub = (v4: string[] | Error, v6: string[] | Error) => ({
			resolve4: async () => {
				if (v4 instanceof Error) throw v4;
				return v4;
			},
			resolve6: async () => {
				if (v6 instanceof Error) throw v6;
				return v6;
			}
		});
		expect(
			await resolvePublicIpCares('x.example', stub(['93.184.216.34'], new Error('ENODATA')))
		).toEqual({
			address: '93.184.216.34',
			family: 4
		});
		expect(
			await resolvePublicIpCares('x.example', stub(new Error('ENODATA'), ['2606:2800:21f:cb07::1']))
		).toEqual({
			address: '2606:2800:21f:cb07::1',
			family: 6
		});
		await expect(
			resolvePublicIpCares('x.example', stub(['93.184.216.34'], ['::1']))
		).rejects.toThrow(/private/);
		await expect(resolvePublicIpCares('x.example', stub(['10.0.0.1'], []))).rejects.toThrow(
			/private/
		);
		await expect(
			resolvePublicIpCares('x.example', stub(new Error('x'), new Error('y')))
		).rejects.toThrow(/no DNS records/);
	});
});
