import { describe, expect, it } from 'vitest';
import { readAckTimestamp } from './readState';

const iso = (s: string) => new Date(s);

describe('readAckTimestamp', () => {
	// v1.21.14 full chat audit, W-M3: nothing seen, nothing acked — the device
	// clock is never the cursor.
	it('acks nothing when there is nothing to point at', () => {
		const now = iso('2026-07-09T12:00:00Z');
		expect(readAckTimestamp(null, now)).toBeNull();
	});

	// The bug: last_message_at is a CHAIN timestamp. If the browser clock lags,
	// the message you just watched arrive is "newer" than your ack, and the
	// inbox card stays green forever.
	it('takes the chain timestamp when the chain is ahead of our clock', () => {
		const now = iso('2026-07-09T12:00:00Z');
		const chain = iso('2026-07-09T12:00:03Z'); // 3s of skew
		expect(readAckTimestamp(chain, now)).toBe(chain);
	});

	// v1.21.14 full chat audit, W-M3: a clock AHEAD of the chain (here 10
	// minutes) used to become the cursor, so a message arriving 3 minutes after
	// the reader left was already "read" — no badge, no border.
	it('a clock ahead of the chain does not move the ack past what was seen', () => {
		const now = iso('2026-07-09T12:10:00Z');
		const chain = iso('2026-07-09T11:59:55Z');
		expect(readAckTimestamp(chain, now)).toBe(chain);
	});

	it('ignores an unparseable timestamp rather than poisoning read state', () => {
		const now = iso('2026-07-09T12:00:00Z');
		expect(readAckTimestamp(new Date('nonsense'), now)).toBe(now);
	});

	it('an ack at exactly the last message time marks it read (isUnread uses strict >)', () => {
		const t = iso('2026-07-09T12:00:00Z');
		expect(readAckTimestamp(t, t)!.getTime()).toBe(t.getTime());
	});
});
