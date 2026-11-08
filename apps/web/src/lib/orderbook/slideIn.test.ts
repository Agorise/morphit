// @vitest-environment jsdom
/**
 * v1.23.4 — owner: a new order on the live orderbook should "slide in to place
 * over the course of 1 second" instead of blinking and popping in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NEW_ORDER_SLIDE_MS, measureTops, playSlideIn } from './slideIn';

type Call = { key: string; frames: Keyframe[]; opts: KeyframeAnimationOptions };

function list(tops: Record<string, number>) {
	const ul = document.createElement('ul');
	const calls: Call[] = [];
	for (const [key, top] of Object.entries(tops)) {
		const li = document.createElement('li');
		li.dataset.orderKey = key;
		li.getBoundingClientRect = () => ({ top }) as DOMRect;
		li.animate = ((frames: Keyframe[], opts: KeyframeAnimationOptions) => {
			calls.push({ key, frames, opts });
			return {} as Animation;
		}) as never;
		ul.append(li);
	}
	return { ul, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('slideIn', () => {
	it('reads where each card is, by its order key', () => {
		const { ul } = list({ 'a/1': 100, 'b/2': 300 });
		expect([...measureTops(ul)]).toEqual([
			['a/1', 100],
			['b/2', 300]
		]);
		expect(measureTops(null).size).toBe(0);
	});

	it('the new card fades and slides into place over 1 s; the cards it pushed glide from where they were', () => {
		const before = new Map([
			['a/1', 100],
			['b/2', 300]
		]);
		// After the insert: the new card on top, the others 200 px lower.
		const { ul, calls } = list({ 'new/9': 100, 'a/1': 300, 'b/2': 500 });
		expect(playSlideIn(ul, before, 'new/9')).toBe(3);
		expect(NEW_ORDER_SLIDE_MS).toBe(1000);
		const byKey = Object.fromEntries(calls.map((c) => [c.key, c]));
		expect(byKey['new/9']!.frames[0]).toMatchObject({ opacity: 0 });
		expect(byKey['new/9']!.frames[1]).toMatchObject({ opacity: 1, transform: 'translateY(0)' });
		expect(byKey['a/1']!.frames[0]).toEqual({ transform: 'translateY(-200px)' });
		expect(byKey['b/2']!.frames[0]).toEqual({ transform: 'translateY(-200px)' });
		for (const c of calls) expect(c.opts.duration).toBe(1000);
	});

	it('a card that did not move, or was not there before, is left alone', () => {
		const before = new Map([['a/1', 100]]);
		const { ul, calls } = list({ 'new/9': 0, 'a/1': 100, 'z/7': 400 });
		playSlideIn(ul, before, 'new/9');
		expect(calls.map((c) => c.key)).toEqual(['new/9']);
	});

	it('review: a second order while the first still slides — the pushed cards add to the running glide, no jump', () => {
		// Mid-flight the rects include the running transform, so dy is only the
		// newest card's height; replacing the running animation would drop the
		// rest of the first glide in one frame. Adding to it keeps the motion
		// continuous.
		const before = new Map([
			['new/9', 0],
			['a/1', 113]
		]);
		const { ul, calls } = list({ 'new/10': 0, 'new/9': 200, 'a/1': 313 });
		playSlideIn(ul, before, 'new/10');
		const pushed = calls.filter((c) => c.key !== 'new/10');
		expect(pushed.map((c) => c.key)).toEqual(['new/9', 'a/1']);
		for (const c of pushed) expect(c.opts.composite).toBe('add');
		// The arriving card's own entrance still replaces (it has nothing running).
		expect(calls.find((c) => c.key === 'new/10')!.opts.composite).toBeUndefined();
	});

	it('reduced motion: nothing moves', () => {
		vi.stubGlobal(
			'matchMedia',
			(q: string) => ({ matches: q.includes('reduce') }) as MediaQueryList
		);
		const { ul, calls } = list({ 'new/9': 0, 'a/1': 300 });
		expect(playSlideIn(ul, new Map([['a/1', 100]]), 'new/9')).toBe(0);
		expect(calls).toHaveLength(0);
	});
});
