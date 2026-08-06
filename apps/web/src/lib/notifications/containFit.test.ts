import { describe, expect, it } from 'vitest';
import {
	containFit,
	FAVICON_INTRINSIC_WIDTH,
	FAVICON_INTRINSIC_HEIGHT
} from './containFit';

describe('containFit', () => {
	it('never distorts a wide logo (the favicon bug)', () => {
		const fit = containFit(FAVICON_INTRINSIC_WIDTH, FAVICON_INTRINSIC_HEIGHT, 32);
		const srcAspect = FAVICON_INTRINSIC_WIDTH / FAVICON_INTRINSIC_HEIGHT;
		expect(fit.dw / fit.dh).toBeCloseTo(srcAspect, 10);
	});

	it('fills the box on its constrained axis and centres the other', () => {
		const fit = containFit(20, 10, 32); // 2:1 wide
		expect(fit.dw).toBe(32);
		expect(fit.dh).toBe(16);
		expect(fit.dx).toBe(0);
		expect(fit.dy).toBe(8); // letterboxed, centred
	});

	it('handles a tall source', () => {
		const fit = containFit(10, 20, 32);
		expect(fit.dh).toBe(32);
		expect(fit.dw).toBe(16);
		expect(fit.dx).toBe(8);
		expect(fit.dy).toBe(0);
	});

	it('is the identity for a square source', () => {
		expect(containFit(64, 64, 32)).toEqual({ dx: 0, dy: 0, dw: 32, dh: 32 });
	});

	it('never overflows the box', () => {
		for (const [w, h] of [[100, 3], [3, 100], [1, 1], [10.889, 7.049]]) {
			const f = containFit(w!, h!, 32);
			expect(f.dw).toBeLessThanOrEqual(32 + 1e-9);
			expect(f.dh).toBeLessThanOrEqual(32 + 1e-9);
			expect(f.dx).toBeGreaterThanOrEqual(-1e-9);
			expect(f.dy).toBeGreaterThanOrEqual(-1e-9);
		}
	});

	it('falls back to filling the box when the browser reports no intrinsic size', () => {
		// Better a square logo than no logo.
		expect(containFit(0, 0, 32)).toEqual({ dx: 0, dy: 0, dw: 32, dh: 32 });
		expect(containFit(NaN, 7, 32)).toEqual({ dx: 0, dy: 0, dw: 32, dh: 32 });
	});
});
