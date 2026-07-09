import { describe, expect, it, vi, afterEach } from 'vitest';
import { pinToBottom } from './pinToBottom';

function fakeEl(scrollHeight: number) {
	return { scrollTop: 0, scrollHeight };
}
function installRaf() {
	const q: Array<() => void> = [];
	vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
		q.push(cb);
		return q.length;
	});
	vi.stubGlobal('cancelAnimationFrame', () => {});
	vi.stubGlobal('ResizeObserver', undefined);
	return { flush: (n: number) => { for (let i = 0; i < n; i++) q.shift()?.(); } };
}

afterEach(() => vi.unstubAllGlobals());

describe('pinToBottom', () => {
	it('jumps to the bottom immediately (no animation toward a stale target)', () => {
		installRaf();
		const el = fakeEl(1000);
		pinToBottom(el);
		expect(el.scrollTop).toBe(1000);
	});

	// The bug: content keeps growing after the first scroll (bubbles, identicons,
	// day separators, web fonts), so a one-shot scroll lands mid-history.
	it('re-pins while the content is still growing', () => {
		const raf = installRaf();
		let t = 0;
		const el = fakeEl(1000);
		pinToBottom(el, { now: () => t, settleMs: 100 });
		expect(el.scrollTop).toBe(1000);

		(el as { scrollHeight: number }).scrollHeight = 2500; // late layout pass
		raf.flush(1);
		expect(el.scrollTop).toBe(2500);
	});

	it('stops re-pinning after the settle window', () => {
		const raf = installRaf();
		let t = 0;
		const el = fakeEl(1000);
		pinToBottom(el, { now: () => t, settleMs: 100 });
		t = 101;
		raf.flush(1);
		(el as { scrollHeight: number }).scrollHeight = 5000;
		raf.flush(3);
		expect(el.scrollTop).toBe(1000); // left alone
	});

	it('cancel() stops it dead — never fight a user who scrolled', () => {
		const raf = installRaf();
		const el = fakeEl(1000);
		const cancel = pinToBottom(el, { now: () => 0, settleMs: 10_000 });
		cancel();
		(el as { scrollHeight: number }).scrollHeight = 9000;
		raf.flush(5);
		expect(el.scrollTop).toBe(1000);
	});

	it('is a no-op on a null element', () => {
		installRaf();
		expect(() => pinToBottom(null)()).not.toThrow();
	});
});
