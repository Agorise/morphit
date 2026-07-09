import { describe, expect, it } from 'vitest';
import { readAckTimestamp } from './readState';

const iso = (s: string) => new Date(s);

describe('readAckTimestamp', () => {
	it('uses the local clock when there is nothing to point at', () => {
		const now = iso('2026-07-09T12:00:00Z');
		expect(readAckTimestamp(null, now)).toBe(now);
	});

	// The bug: last_message_at is a CHAIN timestamp. If the browser clock lags,
	// the message you just watched arrive is "newer" than your ack, and the
	// inbox card stays green forever.
	it('takes the chain timestamp when the chain is ahead of our clock', () => {
		const now = iso('2026-07-09T12:00:00Z');
		const chain = iso('2026-07-09T12:00:03Z'); // 3s of skew
		expect(readAckTimestamp(chain, now)).toBe(chain);
	});

	it('keeps the local clock when it is ahead (we have seen everything up to now)', () => {
		const now = iso('2026-07-09T12:00:10Z');
		const chain = iso('2026-07-09T12:00:03Z');
		expect(readAckTimestamp(chain, now)).toBe(now);
	});

	it('ignores an unparseable timestamp rather than poisoning read state', () => {
		const now = iso('2026-07-09T12:00:00Z');
		expect(readAckTimestamp(new Date('nonsense'), now)).toBe(now);
	});

	it('an ack at exactly the last message time marks it read (isUnread uses strict >)', () => {
		const t = iso('2026-07-09T12:00:00Z');
		expect(readAckTimestamp(t, t).getTime()).toBe(t.getTime());
	});
});
