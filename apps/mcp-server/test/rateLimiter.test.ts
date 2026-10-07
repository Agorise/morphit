/**
 * The MCP's rate-limit key is the client's address. Morphit keeps no IPs:
 * the limiter may hold one only while it still limits that client. A bucket
 * is full again 60 s after its last request, so from then on it is the same
 * as no entry. The old sweep ran only past 4096 clients, so on a normal
 * instance every address stayed in memory until the process restarted.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../src/rateLimiter';

afterEach(() => vi.useRealTimers());

describe('the MCP rate limiter', () => {
	it('limits a client to perMin per minute', () => {
		const l = new RateLimiter(3);
		expect([l.take('a'), l.take('a'), l.take('a'), l.take('a')]).toEqual([true, true, true, false]);
		expect(l.take('b')).toBe(true);
	});

	it('takes several tokens at once, or none', () => {
		const l = new RateLimiter(5);
		expect(l.take('a', 3)).toBe(true);
		expect(l.take('a', 3)).toBe(false); // 2 left: refused, nothing taken
		expect(l.take('a', 2)).toBe(true);
		expect(l.take('a')).toBe(false);
	});

	it('holds no address once its bucket has refilled (a few minutes at most)', () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const l = new RateLimiter(60);
		l.take('203.0.113.7');
		vi.advanceTimersByTime(30_000);
		expect(l.size(), 'dropped while it still limits the client').toBe(1);
		// No further request at all: the address must still go.
		vi.advanceTimersByTime(2 * 60_000 + 1);
		expect(l.size(), 'an idle client address is still held').toBe(0);
		l.close();
	});
});
