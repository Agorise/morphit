// @vitest-environment jsdom
/**
 * Where the person's chat state lives as a session changes how long it is
 * remembered — and that one tab never picks up another account's copy.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { personGet, personSet, setPersonStorageTier } from './personStorage';

const K = 'morphit.chat.recent_peers';

beforeEach(() => {
	setPersonStorageTier(null);
	window.localStorage.clear();
	window.sessionStorage.clear();
});

describe('person storage', () => {
	it('no session: nothing is read or written', () => {
		window.localStorage.setItem(K, '["carol"]');
		expect(personGet(K)).toBeNull();
		personSet(K, '["dave"]');
		expect(window.localStorage.getItem(K)).toBe('["carol"]');
		expect(window.sessionStorage.getItem(K)).toBeNull();
	});

	it("Remember me committed: this tab's state replaces the device copy", () => {
		window.localStorage.setItem(K, '["someone-else"]');
		setPersonStorageTier('session');
		personSet(K, '["carol"]');
		setPersonStorageTier('local');
		expect(window.localStorage.getItem(K)).toBe('["carol"]');
		expect(window.sessionStorage.getItem(K)).toBeNull();
	});

	it('…and with no state of its own, the old device copy goes', () => {
		window.localStorage.setItem(K, '["someone-else"]');
		setPersonStorageTier('session');
		setPersonStorageTier('local');
		expect(window.localStorage.getItem(K)).toBeNull();
	});

	it('another account remembered from another tab: nothing on the device is copied into this tab', () => {
		setPersonStorageTier('local');
		window.localStorage.setItem(K, '["the-other-account-peer"]');
		setPersonStorageTier('session');
		expect(personGet(K)).toBeNull();
		expect(window.localStorage.getItem(K)).toBe('["the-other-account-peer"]');
	});
});
