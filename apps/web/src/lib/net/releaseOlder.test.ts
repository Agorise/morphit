/**
 * A verified release OLDER than the build this site runs is not the current
 * release: the instance (or two operators that agree) may serve an old genuine
 * release, one whose treasury may since have been retired. Such an answer
 * never supplies the chain-pinned treasury — a newer release this browser
 * already verified keeps supplying it — the integrity check says it could not
 * confirm the release instead of comparing against the old one, and the answer
 * is re-checked within the hour, not remembered for a day. Nor is an unsigned
 * field of the block (its timestamp) passed on as the release's.
 *
 * The real store → releaseFetch → chainRelay stack runs; only `fetch` is
 * replaced by the instance's agreed-read relay serving a small simulated
 * chain (./releaseTestInstance.ts), and the pinned key by a test key whose
 * private half signs the genuine releases.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNNING_VERSION, olderThan } from './releaseTestVersions';
import { PrivateKey } from '@beblurt/dblurt';
import {
	ATTACKER_BTC,
	GENUINE_BTC,
	browserStorage,
	instance,
	releaseJson,
	releaseTx,
	serving,
	stubInstance
} from './releaseTestInstance';

const OFFICIAL = PrivateKey.fromSeed('morphit release budget test key');

vi.mock('$net/config', async (importOriginal) => {
	const real = (await importOriginal()) as Record<string, unknown>;
	return {
		...real,
		MORPHIT_OFFICIAL_POSTING_PUBKEY: PrivateKey.fromSeed('morphit release budget test key')
			.createPublic('BLT')
			.toString()
	};
});

const CURRENT = releaseTx(releaseJson(RUNNING_VERSION, GENUINE_BTC), OFFICIAL, 1);
const honest = serving(CURRENT, 64_000_000);
const OLD_WITH_RETIRED_TREASURY = releaseTx(releaseJson(olderThan(), ATTACKER_BTC), OFFICIAL, 9);

beforeEach(() => {
	vi.resetModules();
	stubInstance();
	vi.stubGlobal('navigator', {});
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

/** A page load: a fresh copy of the store, booted. */
async function pageLoad() {
	vi.resetModules();
	const store = await import('$stores/release');
	const { get } = await import('svelte/store');
	await store.initRelease();
	return {
		treasury: get(store.chainPinnedTreasury)?.btc?.address ?? null,
		staleBuild: get(store.staleBuild),
		integrity: get(store.integritySummary)
	};
}
const later = (ms: number): void => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(Date.now() + ms);
};

describe('a verified release older than this build', () => {
	it('the instance serves it: its treasury is not pinned, and the check says why', async () => {
		browserStorage();
		instance.answer = serving(OLD_WITH_RETIRED_TREASURY, 64_000_000);
		const page = await pageLoad();
		expect(page.treasury).toBeNull();
		expect(page.staleBuild).not.toBe(true);
		expect(page.integrity.kind).toBe('unconfirmed');
	});

	it('is re-checked within the hour, not remembered for a day', async () => {
		browserStorage();
		instance.answer = serving(OLD_WITH_RETIRED_TREASURY, 64_000_000);
		await pageLoad();
		instance.answer = honest; // the operators catch up
		later(61 * 60 * 1000);
		const page = await pageLoad();
		expect(page.treasury).toBe(GENUINE_BTC);
		expect(page.integrity.kind).not.toBe('unconfirmed');
	});

	it('a newer release this browser already verified keeps supplying the treasury', async () => {
		browserStorage();
		instance.answer = honest;
		expect((await pageLoad()).treasury).toBe(GENUINE_BTC);
		later(25 * 60 * 60 * 1000); // the day's answer has expired
		instance.answer = serving(OLD_WITH_RETIRED_TREASURY, 64_000_000);
		const page = await pageLoad();
		expect(page.treasury).toBe(GENUINE_BTC);
		expect(page.staleBuild).toBe(false);
	});
});

describe('only what @morphit signed is passed on', () => {
	it("the block's unsigned timestamp is not passed on as the release's", async () => {
		instance.answer = (method, params) => {
			const v = honest(method, params);
			if (method === 'condenser_api.get_block' && v && typeof v === 'object')
				return { ...(v as object), timestamp: '1999-01-01T00:00:00' };
			return v;
		};
		const { fetchVerifiedRelease } = await import('$net/releaseFetch');
		const r = await fetchVerifiedRelease();
		expect(r.ok).toBe(true);
		expect(JSON.stringify(r)).not.toContain('1999-01-01T00:00:00');
	});
});
