// @vitest-environment jsdom
/**
 * What the profile cache writes to the device (IndexedDB): a real profile,
 * never a "no profile yet". The batch answers a known account that has not set
 * a profile with a key-only row (display_name / json_metadata /
 * source_block_num null) — not null, so it used to be written to disk and kept
 * for a week, and a later visit drew that account's default picture first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const put = vi.fn(async () => {});
vi.mock('$lib/indexer/profilePersist', () => ({
	idbClearProfiles: vi.fn(async () => {}),
	idbDeleteProfile: vi.fn(async () => {}),
	idbGetProfiles: vi.fn(async () => new Map()),
	idbPutProfiles: (...args: unknown[]) => put(...(args as [])),
	setProfilePersistScope: vi.fn()
}));

const { clearProfileCache, getProfilesBatch } = await import('./profileCache');

const PROFILE = {
	account: 'alice',
	display_name: 'Alice',
	json_metadata: { avatar_svg: '<svg/>' },
	source_block_num: 7,
	updated_at: '2026-11-01T00:00:00.000Z',
	posting_pubkey: null
};
const KEY_ONLY = {
	account: 'keyonly',
	display_name: null,
	json_metadata: null,
	source_block_num: null,
	updated_at: null,
	posting_pubkey: 'BLT6LLegbAgLAy28EHrffBVuANFWcFgmqRMW13wBmTExqFE9SCkg4'
};

beforeEach(() => {
	clearProfileCache();
	put.mockClear();
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				({
					ok: true,
					status: 200,
					json: async () => ({ profiles: { alice: PROFILE, keyonly: KEY_ONLY } })
				}) as Response
		)
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('profile cache → device', () => {
	it('a real profile is written to the device; a key-only row is not', async () => {
		const got = await getProfilesBatch(['alice', 'keyonly']);
		// Both are served in this session …
		expect(got.get('alice')).toMatchObject({ display_name: 'Alice' });
		expect(got.get('keyonly')).toMatchObject({ posting_pubkey: KEY_ONLY.posting_pubkey });
		// … only the profile is kept on disk.
		await vi.waitFor(() => expect(put).toHaveBeenCalled());
		const written = (put.mock.calls as unknown as [{ account: string }[]][]).flatMap(([rows]) =>
			rows.map((r) => r.account)
		);
		expect(written).toEqual(['alice']);
	});
});
