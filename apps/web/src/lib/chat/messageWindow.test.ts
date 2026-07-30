import { describe, it, expect } from 'vitest';
import { advanceMessageWindow, type MessageWindowState } from './messageWindow';

const INITIAL = 30;
const start = (): MessageWindowState => ({ prevPeer: null, prevLen: 0, visibleCount: INITIAL });

describe('advanceMessageWindow', () => {
	it('does not establish a baseline before the first populated snapshot', () => {
		// Empty message list (controller has not delivered yet): state is
		// unchanged, and crucially prevPeer stays null so the next populated
		// run is still an initial load.
		const s0 = start();
		const s1 = advanceMessageWindow(s0, 0, 'alice', INITIAL);
		expect(s1).toEqual(s0);
		expect(s1.prevPeer).toBeNull();
	});

	it('treats the first populated snapshot as an initial load, not an append', () => {
		// THE REGRESSION GUARD. A conversation with 50 messages must render the
		// newest INITIAL slice, not expand the window to all 50. The old inline
		// code seeded the length tracker to 0, so this 0→50 jump grew the window
		// to 50 and rendered every bubble on first open.
		let s = start();
		s = advanceMessageWindow(s, 0, 'alice', INITIAL); // empty pre-snapshot run
		s = advanceMessageWindow(s, 50, 'alice', INITIAL); // first snapshot
		expect(s.visibleCount).toBe(INITIAL); // NOT 50, NOT 80
		expect(s.prevLen).toBe(50);
		expect(s.prevPeer).toBe('alice');
		// windowStart = max(0, len - visibleCount) = 20 → newest 30 render.
		expect(Math.max(0, 50 - s.visibleCount)).toBe(20);
	});

	it('shows all messages when the first snapshot is smaller than the window', () => {
		let s = start();
		s = advanceMessageWindow(s, 3, 'alice', INITIAL);
		expect(s.visibleCount).toBe(INITIAL);
		expect(Math.max(0, 3 - s.visibleCount)).toBe(0); // all 3 render
	});

	it('grows the window by the delta on a genuine append (windowStart stays put)', () => {
		let s = start();
		s = advanceMessageWindow(s, 50, 'alice', INITIAL); // initial load
		const startBefore = Math.max(0, 50 - s.visibleCount);
		s = advanceMessageWindow(s, 51, 'alice', INITIAL); // one message arrives
		expect(s.visibleCount).toBe(INITIAL + 1);
		expect(s.prevLen).toBe(51);
		// windowStart is unchanged, so already-revealed older messages don't slide off.
		expect(Math.max(0, 51 - s.visibleCount)).toBe(startBefore);
	});

	it('accumulates multiple appends', () => {
		let s = start();
		s = advanceMessageWindow(s, 50, 'alice', INITIAL);
		s = advanceMessageWindow(s, 52, 'alice', INITIAL); // +2
		s = advanceMessageWindow(s, 55, 'alice', INITIAL); // +3
		expect(s.visibleCount).toBe(INITIAL + 5);
	});

	it('resets to the newest slice when the peer switches', () => {
		let s = start();
		s = advanceMessageWindow(s, 50, 'alice', INITIAL);
		s = advanceMessageWindow(s, 55, 'alice', INITIAL); // grow to 35
		expect(s.visibleCount).toBe(35);
		s = advanceMessageWindow(s, 80, 'bob', INITIAL); // switch peer
		expect(s.visibleCount).toBe(INITIAL); // reset, NOT 35 + delta
		expect(s.prevPeer).toBe('bob');
		expect(s.prevLen).toBe(80);
	});

	it('does not shrink the window when the message count drops (slice clamps instead)', () => {
		let s = start();
		s = advanceMessageWindow(s, 55, 'alice', INITIAL);
		s = advanceMessageWindow(s, 60, 'alice', INITIAL); // visibleCount 35
		const before = s.visibleCount;
		s = advanceMessageWindow(s, 58, 'alice', INITIAL); // fewer than before
		expect(s.visibleCount).toBe(before); // unchanged
		expect(s.prevLen).toBe(58); // baseline follows down
	});

	it('respects a manual visibleCount extension (reveal-older) across a later append', () => {
		// maybeRevealOlder() bumps visibleCount directly outside the reducer.
		// The next append must grow from that extended value, not clobber it.
		let s = start();
		s = advanceMessageWindow(s, 50, 'alice', INITIAL);
		s = { ...s, visibleCount: s.visibleCount + 40 }; // user scrolled up → +OLDER_CHUNK
		s = advanceMessageWindow(s, 51, 'alice', INITIAL); // then a message arrives
		expect(s.visibleCount).toBe(INITIAL + 40 + 1);
	});
});
