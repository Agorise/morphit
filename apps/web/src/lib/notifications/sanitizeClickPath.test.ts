import { describe, expect, it } from 'vitest';
import { sanitizeClickPath } from './sanitizeClickPath';

const ORIGIN = 'https://morphit.io';

describe('sanitizeClickPath', () => {
	// ─── Safe inputs pass through ─────────────────────────────
	it('passes through a simple root path', () => {
		expect(sanitizeClickPath('/', ORIGIN)).toBe('/');
	});

	it('passes through a normal pathname', () => {
		expect(sanitizeClickPath('/orders/123', ORIGIN)).toBe('/orders/123');
	});

	it('preserves query string', () => {
		expect(sanitizeClickPath('/search?q=btc', ORIGIN)).toBe('/search?q=btc');
	});

	it('preserves hash', () => {
		expect(sanitizeClickPath('/faq#how-to-buy', ORIGIN)).toBe('/faq#how-to-buy');
	});

	it('preserves query + hash together', () => {
		expect(sanitizeClickPath('/x?a=1#b', ORIGIN)).toBe('/x?a=1#b');
	});

	it('normalizes path traversal that stays same-origin', () => {
		// /../bar resolves to /bar — still same-origin, accepted.
		expect(sanitizeClickPath('/foo/../bar', ORIGIN)).toBe('/bar');
	});

	// ─── Cross-origin attacks rejected ────────────────────────
	it("rejects protocol-relative URL '//evil.com/'", () => {
		expect(sanitizeClickPath('//evil.com/login', ORIGIN)).toBe('/');
	});

	it('rejects fully-qualified cross-origin URL', () => {
		expect(sanitizeClickPath('https://evil.com/login', ORIGIN)).toBe('/');
	});

	it('rejects http:// to a different host', () => {
		expect(sanitizeClickPath('http://evil.com/', ORIGIN)).toBe('/');
	});

	it('rejects same-host different-port (different origin)', () => {
		// morphit.io:8443 has different origin from morphit.io (implicit 443)
		expect(sanitizeClickPath('https://morphit.io:8443/', ORIGIN)).toBe('/');
	});

	// ─── Scheme attacks rejected ──────────────────────────────
	it("rejects 'javascript:' URLs", () => {
		expect(sanitizeClickPath('javascript:alert(1)', ORIGIN)).toBe('/');
	});

	it("rejects 'data:' URLs", () => {
		expect(sanitizeClickPath('data:text/html,<script>alert(1)</script>', ORIGIN)).toBe('/');
	});

	it("rejects 'mailto:' URLs", () => {
		expect(sanitizeClickPath('mailto:a@b.com', ORIGIN)).toBe('/');
	});

	it("rejects 'file:' URLs", () => {
		expect(sanitizeClickPath('file:///etc/passwd', ORIGIN)).toBe('/');
	});

	it("rejects 'blob:' URLs", () => {
		expect(sanitizeClickPath('blob:https://morphit.io/abc', ORIGIN)).toBe('/');
	});

	// ─── Type / parsing edge cases ────────────────────────────
	it('returns / for undefined', () => {
		expect(sanitizeClickPath(undefined, ORIGIN)).toBe('/');
	});

	it('returns / for null', () => {
		expect(sanitizeClickPath(null, ORIGIN)).toBe('/');
	});

	it('returns / for number', () => {
		expect(sanitizeClickPath(42, ORIGIN)).toBe('/');
	});

	it('returns / for object', () => {
		expect(sanitizeClickPath({ path: '/foo' }, ORIGIN)).toBe('/');
	});

	it('returns / for empty string (parses but origin-normalizes to base)', () => {
		// `new URL('', 'https://morphit.io')` resolves to the base URL itself.
		// Same origin, so the empty resolves to '/' from pathname.
		expect(sanitizeClickPath('', ORIGIN)).toBe('/');
	});

	// ─── Realistic operator payloads (from PushSender) ────────
	it('accepts the order-detail click path', () => {
		expect(sanitizeClickPath('/orders/abc123', ORIGIN)).toBe('/orders/abc123');
	});

	it('accepts the chat-thread click path', () => {
		expect(sanitizeClickPath('/chat/alice', ORIGIN)).toBe('/chat/alice');
	});

	it('accepts the feedback-pending click path', () => {
		expect(sanitizeClickPath('/my/orders', ORIGIN)).toBe('/my/orders');
	});

	// ─── Localized routes ─────────────────────────────────────
	it('accepts a localized route path', () => {
		expect(sanitizeClickPath('/fr/orderbook', ORIGIN)).toBe('/fr/orderbook');
	});

	// ─── Origin parameter must be respected ───────────────────
	it('uses the passed origin, not a hardcoded one', () => {
		// Different operator deploy uses a different origin
		const altOrigin = 'https://bob.example.org';
		expect(sanitizeClickPath('/foo', altOrigin)).toBe('/foo');
		expect(sanitizeClickPath('https://morphit.io/foo', altOrigin)).toBe('/');
	});
});
