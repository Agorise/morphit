/**
 * witnessRanking — the /witnesses page's stars and order (v1.23.0).
 *
 * The fixtures are real witnesses as condenser_api.get_witnesses_by_vote and
 * get_dynamic_global_properties returned them on 2026-11-05 (head 65087002),
 * the same read the owner's blurtwallet.com screenshot shows: khrom 16.54 M BP
 * with 14013 missed, agorise-witness 419 missed and "Needs 507 K to level up".
 */

import { describe, expect, it } from 'vitest';

import {
	FULL_TIME_WEEKS,
	PRODUCING_WINDOW_BLOCKS,
	isDisabledSigningKey,
	isProducingWitness,
	missedRecently,
	parseVersion,
	profileImageUrl,
	rankWitnesses,
	safeWitnessUrl,
	starsFromScore,
	votesToBp,
	witnessScore,
	type RawWitness
} from '$indexer/witnessRanking';

const CHAIN = {
	head_block_number: 65087002,
	total_vesting_fund_blurt: '396540355.664 BLURT',
	total_vesting_shares: '344824578.602727 VESTS'
};
const NOW = Date.parse('2026-11-05T16:45:54Z');

// In vote order, as the chain lists them.
const RAW: RawWitness[] = [
	{
		owner: 'khrom',
		created: '2022-10-01T21:41:42',
		url: 'https://blurt.pl',
		votes: '14386338618973',
		total_missed: 14013,
		last_confirmed_block_num: 65086993,
		signing_key: 'BLT8F2MsdPmACkzSCnRuCmm1Qz6rQdNDqBZSFCNZJCGn5ACwruVS9',
		running_version: '0.9.1'
	},
	{
		owner: 'agorise-witness',
		created: '2024-10-11T02:44:12',
		url: 'https://Agori.host',
		votes: '13945148499716',
		total_missed: 419,
		last_confirmed_block_num: 65086989,
		signing_key: 'BLT5aVkWQDvELxFJbLccZPUAAFx3etnxw2izj31PoHJH7YFxxt3PC',
		running_version: '0.9.0'
	},
	{
		owner: 'saboin',
		created: '2020-07-04T13:22:45',
		url: 'https://blurt.blog/witness/@saboin/witness-introduction',
		votes: '10174023711135',
		total_missed: 9733,
		last_confirmed_block_num: 65087001,
		signing_key: 'BLT6eTLiRo6Jrm4PMPtNtakWhziFFauKR5QmjyU3dtBAu5Ya1iPpV',
		running_version: '0.9.1'
	},
	{
		owner: 'zahidsun',
		created: '2020-08-23T20:58:00',
		url: 'https://blurt.blog/blurt/@zahidsun/blurt-witness-setup',
		votes: '6830897623269',
		total_missed: 147395,
		last_confirmed_block_num: 65086999,
		signing_key: 'BLT7BpCrF5s5NUqSiVoyCXPozZcfUBmBgLeoXGB6wqchRH15WPotq',
		running_version: '0.9.1'
	},
	{
		owner: 'joviansummer',
		created: '2021-11-07T09:35:12',
		url: 'https://blurt.blog/@joviansummer',
		votes: '3553743880578',
		total_missed: 429,
		last_confirmed_block_num: 65086813,
		signing_key: 'BLT7DDvSZScEzatQnioRKo7pPXUgkVabLZAZ44rfPYuaCgsCXt3KV',
		running_version: '0.9.0'
	},
	{
		owner: 'eastmael',
		created: '2020-08-28T14:04:45',
		url: 'https://blurt.world/blurtopian/@eastmael/eastmael-witness-node',
		votes: '3535897419947',
		total_missed: 11470,
		last_confirmed_block_num: 61165995,
		signing_key: 'BLT1111111111111111111111111111111114T1Anm',
		running_version: '0.9.0'
	},
	{
		owner: 'etainclub',
		created: '2021-06-19T06:49:06',
		url: 'https://blurtter.com/@etainclub',
		votes: '1244856166284',
		total_missed: 118435,
		last_confirmed_block_num: 18271852,
		signing_key: 'BLT5UYPXW7mwRTjLfovFAuGXzzdSDX5f8GYkXRyKzDKRbwb6Dejkf',
		running_version: '0.7.0'
	},
	{
		owner: 'node01',
		created: '2026-05-08T12:28:57',
		url: 'https://blurt.blog/@node01',
		votes: '936523418986',
		total_missed: 35,
		last_confirmed_block_num: 65086994,
		signing_key: 'BLT8aezvgkodzgwdxF2LAtn7ATB3QatjG1tKx7LTaNLUuU9smjYVx',
		running_version: '0.9.1'
	}
];

const byOwner = () => {
	const r = rankWitnesses(RAW, CHAIN, new Map(), NOW);
	return { ...r, get: (o: string) => r.witnesses.find((w) => w.owner === o)! };
};

describe('stars', () => {
	it('round DOWN to a third, within 0..5', () => {
		expect(starsFromScore(4.84)).toBeCloseTo(4 + 2 / 3, 10);
		expect(starsFromScore(4.43)).toBeCloseTo(4 + 1 / 3, 10);
		expect(starsFromScore(1)).toBe(1);
		expect(starsFromScore(0.999)).toBeCloseTo(2 / 3, 10);
		expect(starsFromScore(0.33)).toBe(0);
		expect(starsFromScore(5.2)).toBe(5);
		expect(starsFromScore(-1)).toBe(0);
		expect(starsFromScore(Number.NaN)).toBe(0);
	});

	it('multiply time × reliability × version, so missing a lot is never outweighed by age', () => {
		const r = byOwner();
		// 260 weeks, 1.65 missed a week, 0.9.0 (same major.minor as 0.9.1): 4⅔.
		expect(r.get('joviansummer').weeks).toBe(FULL_TIME_WEEKS);
		expect(r.get('joviansummer').stars).toBeCloseTo(4 + 2 / 3, 10);
		// 213 weeks, ~66 missed a week: 1⅔ although it is rank 1.
		expect(r.get('khrom').stars).toBeCloseTo(1 + 2 / 3, 10);
		// The case an additive formula got wrong: 323 weeks but ~456 missed a week.
		expect(r.get('zahidsun').weeks).toBe(323);
		expect(r.get('zahidsun').stars).toBeCloseTo(1 / 3, 10);
		expect(r.get('zahidsun').score).toBeLessThan(r.get('agorise-witness').score);
	});

	it('0.9.0 counts the same as 0.9.1; a whole version behind costs a quarter', () => {
		const r = byOwner();
		expect(r.newestVersion).toBe('0.9.1');
		expect(r.get('agorise-witness').version_behind).toBe(false);
		const same = witnessScore({
			weeks: 100,
			totalMissed: 0,
			producing: true,
			versionBehind: false
		});
		const behind = witnessScore({
			weeks: 100,
			totalMissed: 0,
			producing: true,
			versionBehind: true
		});
		expect(behind / same).toBeCloseTo(0.75, 10);
	});

	it('only a producing witness gets stars', () => {
		expect(
			witnessScore({ weeks: 300, totalMissed: 0, producing: false, versionBehind: false })
		).toBe(0);
		const r = byOwner();
		expect(r.get('eastmael').disabled).toBe(true);
		expect(r.get('eastmael').producing).toBe(false);
		expect(r.get('eastmael').stars).toBe(0);
		// Enabled, but its last block is years old.
		expect(r.get('etainclub').disabled).toBe(false);
		expect(r.get('etainclub').producing).toBe(false);
		expect(r.get('etainclub').stars).toBe(0);
	});
});

describe('producing', () => {
	it('needs a signing key and a block within 30 days', () => {
		const w = {
			signing_key: 'BLT8F2MsdPmACkzSCnRuCmm1Qz6rQdNDqBZSFCNZJCGn5ACwruVS9',
			last_confirmed_block_num: 1_000_000
		};
		expect(isProducingWitness(w, 1_000_000 + PRODUCING_WINDOW_BLOCKS)).toBe(true);
		expect(isProducingWitness(w, 1_000_001 + PRODUCING_WINDOW_BLOCKS)).toBe(false);
		expect(
			isProducingWitness(
				{ ...w, signing_key: 'BLT1111111111111111111111111111111114T1Anm' },
				1_000_000
			)
		).toBe(false);
		expect(isProducingWitness({ ...w, last_confirmed_block_num: 0 }, 10)).toBe(false);
	});

	it('knows the null signing key', () => {
		expect(isDisabledSigningKey('BLT1111111111111111111111111111111114T1Anm')).toBe(true);
		expect(isDisabledSigningKey('BLT8F2MsdPmACkzSCnRuCmm1Qz6rQdNDqBZSFCNZJCGn5ACwruVS9')).toBe(
			false
		);
		expect(isDisabledSigningKey(undefined)).toBe(true);
	});
});

describe('order and numbers', () => {
	it('producing witnesses first by stars, whatever their rank; the rest by rank', () => {
		const r = byOwner();
		expect(r.witnesses.map((w) => w.owner)).toEqual([
			'joviansummer',
			'saboin',
			'agorise-witness',
			'khrom',
			'zahidsun',
			'node01',
			'eastmael',
			'etainclub'
		]);
		expect(r.get('joviansummer').rank).toBe(5);
	});

	it('BLURT Power and "needs" match the wallet (16.54 M; 507 K to level up)', () => {
		const r = byOwner();
		expect(r.get('khrom').votes_bp / 1e6).toBeCloseTo(16.54, 2);
		expect(r.get('khrom').needs_bp).toBeNull();
		expect(Math.round(r.get('agorise-witness').needs_bp! / 1e3)).toBe(507);
		expect(votesToBp('0', CHAIN)).toBe(0);
		expect(votesToBp('1000000', { ...CHAIN, total_vesting_shares: '0.000000 VESTS' })).toBe(0);
	});

	it('weeks from the creation date', () => {
		const r = byOwner();
		expect(r.get('khrom').weeks).toBe(213);
		expect(r.get('node01').weeks).toBe(25);
	});

	it('parses versions strictly', () => {
		expect(parseVersion('0.9.1')).toEqual([0, 9, 1]);
		expect(parseVersion('0.9')).toBeNull();
		expect(parseVersion('v0.9.1')).toBeNull();
		expect(parseVersion(9)).toBeNull();
	});
});

describe('links a witness gave', () => {
	it('only http(s), no credentials, not too long', () => {
		expect(safeWitnessUrl('https://Agori.host')).toBe('https://agori.host/');
		expect(safeWitnessUrl('http://example.com/x')).toBe('http://example.com/x');
		expect(safeWitnessUrl('javascript:alert(1)')).toBeNull();
		expect(safeWitnessUrl('data:text/html,hi')).toBeNull();
		expect(safeWitnessUrl('https://user:pw@example.com')).toBeNull();
		expect(safeWitnessUrl('https://example.com/' + 'a'.repeat(600))).toBeNull();
		expect(safeWitnessUrl('your-blog-url')).toBeNull();
		expect(safeWitnessUrl(undefined)).toBeNull();
	});

	it('picture: posting metadata first, https on 443 only, never a hidden-service name', () => {
		const meta = (img: string) => JSON.stringify({ profile: { profile_image: img } });
		expect(profileImageUrl({ posting_json_metadata: meta('https://img.blurt.world/a.png') })).toBe(
			'https://img.blurt.world/a.png'
		);
		expect(
			profileImageUrl({
				posting_json_metadata: '{not json',
				json_metadata: meta('https://images.drakernoise.com/a.jpg')
			})
		).toBe('https://images.drakernoise.com/a.jpg');
		expect(profileImageUrl({ posting_json_metadata: meta('http://img.example/a.png') })).toBeNull();
		expect(profileImageUrl({ posting_json_metadata: meta('https://abc.onion/a.png') })).toBeNull();
		expect(
			profileImageUrl({ posting_json_metadata: meta('https://x.example:8443/a.png') })
		).toBeNull();
		expect(
			profileImageUrl({ posting_json_metadata: meta('https://u:p@x.example/a.png') })
		).toBeNull();
		expect(profileImageUrl({})).toBeNull();
	});
});

describe('missed in 24 h', () => {
	const H = 3_600_000;
	it('uses the latest sample at least a day old', () => {
		const r = missedRecently(
			{
				atOrBefore24h: { sampledAtMs: NOW - 24 * H, totalMissed: 100 },
				oldest: { sampledAtMs: NOW - 26 * H, totalMissed: 90 }
			},
			103,
			NOW
		);
		expect(r).toEqual({ missed: 3, windowHours: 24 });
	});

	it('falls back to the oldest sample, saying how long it watched', () => {
		expect(
			missedRecently(
				{ atOrBefore24h: null, oldest: { sampledAtMs: NOW - 5 * H, totalMissed: 10 } },
				11,
				NOW
			)
		).toEqual({
			missed: 1,
			windowHours: 5
		});
	});

	it('says nothing under an hour, nothing without samples, never a negative count', () => {
		expect(
			missedRecently(
				{ atOrBefore24h: null, oldest: { sampledAtMs: NOW - 10 * 60_000, totalMissed: 1 } },
				5,
				NOW
			)
		).toBeNull();
		expect(missedRecently({ atOrBefore24h: null, oldest: null }, 5, NOW)).toBeNull();
		expect(
			missedRecently(
				{ atOrBefore24h: { sampledAtMs: NOW - 25 * H, totalMissed: 9 }, oldest: null },
				5,
				NOW
			)!.missed
		).toBe(0);
	});

	it('is attached to producing witnesses only', () => {
		const samples = new Map([
			['khrom', { atOrBefore24h: { sampledAtMs: NOW - 24 * H, totalMissed: 14010 }, oldest: null }],
			[
				'etainclub',
				{ atOrBefore24h: { sampledAtMs: NOW - 24 * H, totalMissed: 118000 }, oldest: null }
			]
		]);
		const r = rankWitnesses(RAW, CHAIN, samples, NOW);
		expect(r.witnesses.find((w) => w.owner === 'khrom')!.missed_recent).toBe(3);
		expect(r.witnesses.find((w) => w.owner === 'etainclub')!.missed_recent).toBeNull();
	});
});
