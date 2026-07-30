import { describe, expect, it } from 'vitest';
import { peersNeedingProfile, mergeProfileMap, type ProfileMap } from './profileMerge';
import type { ProfileResponse } from '@morphit/indexer-client';

const profile = (name: string): ProfileResponse =>
	({ account: name, display_name: `${name} display` }) as unknown as ProfileResponse;

describe('peersNeedingProfile', () => {
	it('asks for peers we have never seen', () => {
		expect(peersNeedingProfile(['alice', 'bob'], {})).toEqual(['alice', 'bob']);
	});

	it('does NOT re-ask for peers whose profile we already hold', () => {
		const map: ProfileMap = { alice: profile('alice') };
		expect(peersNeedingProfile(['alice', 'bob'], map)).toEqual(['bob']);
	});

	// The bug: `!(p in map)` treated a null as an answer and never retried.
	it('RE-asks for a peer whose last answer was null (the @username bug)', () => {
		const map: ProfileMap = { alice: null };
		expect(peersNeedingProfile(['alice'], map)).toEqual(['alice']);
	});

	it('re-asks for an explicitly-undefined entry too', () => {
		const map = { alice: undefined } as unknown as ProfileMap;
		expect(peersNeedingProfile(['alice'], map)).toEqual(['alice']);
	});
});

describe('mergeProfileMap', () => {
	it('adds newly fetched profiles', () => {
		const out = mergeProfileMap({}, new Map([['alice', profile('alice')]]));
		expect(out.alice).not.toBeNull();
	});

	it('NEVER downgrades a known-good profile to null on a transient failure', () => {
		const prev: ProfileMap = { alice: profile('alice') };
		const out = mergeProfileMap(prev, new Map([['alice', null]]));
		expect(out.alice).toEqual(profile('alice'));
	});

	it('records a null for a peer we had nothing for (so the UI can fall back)', () => {
		const out = mergeProfileMap({}, new Map([['bob', null]]));
		expect(out.bob).toBeNull();
		// …and that null must not stop the next poll from retrying:
		expect(peersNeedingProfile(['bob'], out)).toEqual(['bob']);
	});

	it('does not mutate the previous map', () => {
		const prev: ProfileMap = { alice: profile('alice') };
		const out = mergeProfileMap(prev, new Map([['bob', profile('bob')]]));
		expect(prev.bob).toBeUndefined();
		expect(out.bob).not.toBeNull();
	});

	it('a later success replaces an earlier null', () => {
		const prev: ProfileMap = { alice: null };
		const out = mergeProfileMap(prev, new Map([['alice', profile('alice')]]));
		expect(out.alice).toEqual(profile('alice'));
	});

	it('survives a full round-trip: fail, retry, succeed', () => {
		let map: ProfileMap = {};
		map = mergeProfileMap(map, new Map([['alice', null]])); // batch failed
		expect(peersNeedingProfile(['alice'], map)).toEqual(['alice']); // retried
		map = mergeProfileMap(map, new Map([['alice', profile('alice')]])); // succeeded
		expect(peersNeedingProfile(['alice'], map)).toEqual([]); // settled
		map = mergeProfileMap(map, new Map([['alice', null]])); // later blip
		expect(map.alice).toEqual(profile('alice')); // name survives
	});
});
