// @vitest-environment jsdom
/**
 * Chat Security (v1.23.2): "delete this chat from this computer after you
 * leave" = lock Morphit on this computer when you leave the chat. Your own
 * messages always keep their on-chain copy, so nothing is ever lost.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
	readChatSecurityMode,
	readLockOnLeave,
	shouldAttachSelfCopy,
	writeLockOnLeave
} from './chatSecurity';

beforeEach(() => {
	window.localStorage.clear();
});

describe('Chat Security: lock on leaving (v1.23.2)', () => {
	it('is off by default', () => {
		expect(readLockOnLeave('alice', 'bob', 'order-x')).toBe(false);
	});

	it('is per chat: this partner and this order, for this account', () => {
		writeLockOnLeave('alice', 'bob', 'order-x', true);
		expect(readLockOnLeave('alice', 'bob', 'order-x')).toBe(true);
		expect(readLockOnLeave('alice', 'bob', null)).toBe(false);
		expect(readLockOnLeave('alice', 'carol', 'order-x')).toBe(false);
		expect(readLockOnLeave('dave', 'bob', 'order-x')).toBe(false);
		writeLockOnLeave('alice', 'bob', 'order-x', false);
		expect(readLockOnLeave('alice', 'bob', 'order-x')).toBe(false);
	});

	it('nothing is stored for an empty account', () => {
		writeLockOnLeave('', 'bob', null, true);
		expect(window.localStorage.length).toBe(0);
		expect(readLockOnLeave('', 'bob', null)).toBe(false);
	});

	it('your own messages always keep their copy now: nothing is ever lost', () => {
		window.localStorage.setItem('morphit.chatSecurity.mode.alice', 'destroy');
		expect(readChatSecurityMode('alice')).toBe('keep');
		expect(shouldAttachSelfCopy(readChatSecurityMode('alice'))).toBe(true);
	});

	it('someone who chose the old "don\'t keep my copy" gets lock-on-leaving in every chat, until they say No in one', () => {
		window.localStorage.setItem('morphit.chatSecurity.mode.alice', 'destroy');
		expect(readLockOnLeave('alice', 'bob', 'order-x')).toBe(true);
		expect(readLockOnLeave('alice', 'carol', null)).toBe(true);
		writeLockOnLeave('alice', 'bob', 'order-x', false);
		expect(readLockOnLeave('alice', 'bob', 'order-x')).toBe(false);
		expect(readLockOnLeave('alice', 'carol', null)).toBe(true);
		// Another account on the same computer is not affected.
		expect(readLockOnLeave('dave', 'bob', 'order-x')).toBe(false);
	});
});
