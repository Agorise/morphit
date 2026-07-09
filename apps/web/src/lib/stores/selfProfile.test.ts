/**
 * Unit tests — selfProfile store (#2).
 *
 * The bug: `getProfileCached` swallows fetch failures and returns a bare
 * `null`, identical to an authoritative "this account has no profile". The
 * store applied that null unconditionally, so ONE transient indexer blip
 * CLEARED a perfectly good avatar back to the identicon — and it stuck for the
 * whole session, because the store is only refreshed again on an account
 * change or a profile broadcast.
 *
 * Fixed by `getProfileCachedDetailed`, which reports whether the null came
 * from a failure (soft) or an answer (hard). On failure we keep the current
 * value for this account and retry; we only blank on an account SWITCH.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

import { selfProfile, refreshSelfProfile, clearSelfProfile, setSelfAvatar } from './selfProfile';
import { clearProfileCache } from '$lib/indexer/profileCache';

const AVATAR_URI =
	'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

function mockProfileWithAvatar(account: string) {
	return {
		account,
		display_name: `${account} display`,
		json_metadata: { avatar_data_uri: AVATAR_URI },
		source_block_num: 1,
		updated_at: '2026-07-08T00:00:00.000Z'
	};
}

function mockBatchResponse(profiles: Record<string, unknown>) {
	return { ok: true, status: 200, json: async () => ({ profiles }) } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
	vi.stubGlobal('window', { location: { origin: 'https://morphit.io' } });
	clearProfileCache();
	clearSelfProfile();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('refreshSelfProfile', () => {
	it('publishes the avatar on a successful fetch', async () => {
		fetchMock.mockResolvedValueOnce(mockBatchResponse({ alice: mockProfileWithAvatar('alice') }));
		await refreshSelfProfile('alice');
		const v = get(selfProfile);
		expect(v.account).toBe('alice');
		expect(v.avatarDataUri).toBe(AVATAR_URI);
	});

	it('does NOT clobber a good avatar when the fetch FAILS (the #2 bug)', async () => {
		// Prior good state, e.g. from a confirmed broadcast or an earlier fetch.
		setSelfAvatar('alice', null, AVATAR_URI);

		// Every attempt fails (network down). Retries are awaited via fake timers.
		fetchMock.mockRejectedValue(new TypeError('network down'));
		vi.useFakeTimers();
		const p = refreshSelfProfile('alice');
		await vi.runAllTimersAsync();
		await p;

		const v = get(selfProfile);
		expect(v.account).toBe('alice');
		// Pre-fix this was null — the identicon replaced a real avatar.
		expect(v.avatarDataUri).toBe(AVATAR_URI);
	});

	it('retries a failed fetch and recovers when the indexer comes back', async () => {
		setSelfAvatar('alice', null, null);
		fetchMock
			.mockRejectedValueOnce(new TypeError('network down'))
			.mockResolvedValueOnce(mockBatchResponse({ alice: mockProfileWithAvatar('alice') }));

		vi.useFakeTimers();
		const p = refreshSelfProfile('alice');
		await vi.runAllTimersAsync();
		await p;

		expect(get(selfProfile).avatarDataUri).toBe(AVATAR_URI);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('APPLIES an authoritative "no profile" null (account really has no avatar)', async () => {
		setSelfAvatar('alice', null, AVATAR_URI);
		// HTTP 200, alice absent ⇒ authoritative, not a failure.
		fetchMock.mockResolvedValueOnce(mockBatchResponse({}));
		await refreshSelfProfile('alice');
		expect(get(selfProfile).avatarDataUri).toBeNull();
	});

	it('blanks the avatar on an account SWITCH even when the fetch fails', async () => {
		setSelfAvatar('alice', null, AVATAR_URI);
		fetchMock.mockRejectedValue(new TypeError('network down'));

		vi.useFakeTimers();
		const p = refreshSelfProfile('bob');
		await vi.runAllTimersAsync();
		await p;

		const v = get(selfProfile);
		// Never show alice's avatar while bob is signed in.
		expect(v.account).toBe('bob');
		expect(v.avatarDataUri).toBeNull();
	});

	it('clears on sign-out (null account)', async () => {
		setSelfAvatar('alice', null, AVATAR_URI);
		await refreshSelfProfile(null);
		expect(get(selfProfile)).toEqual({ account: null, avatarSvg: null, avatarDataUri: null });
	});

	it('bustCache bypasses the browser HTTP cache (cache: reload)', async () => {
		fetchMock.mockResolvedValueOnce(mockBatchResponse({ alice: mockProfileWithAvatar('alice') }));
		await refreshSelfProfile('alice', { bustCache: true });
		const init = fetchMock.mock.calls[0]![1] as RequestInit;
		// Without this, the endpoint's `max-age=90` lets the browser replay the
		// PRE-broadcast response and the user can't see their own new avatar.
		expect(init.cache).toBe('reload');
	});

	it('a normal refresh does not force-reload the HTTP cache', async () => {
		fetchMock.mockResolvedValueOnce(mockBatchResponse({ alice: mockProfileWithAvatar('alice') }));
		await refreshSelfProfile('alice');
		const init = fetchMock.mock.calls[0]![1] as RequestInit;
		expect(init.cache).toBeUndefined();
	});
});
