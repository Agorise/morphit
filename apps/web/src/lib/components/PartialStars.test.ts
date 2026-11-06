// @vitest-environment jsdom
/**
 * PartialStars — full, two-thirds, one-third and empty stars (v1.23.0).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// The browser build of svelte (vitest resolves the server one), as the other
// component tests do.
vi.mock(
	'svelte',
	async () =>
		await import(
			/* @vite-ignore */ '../../../../../node_modules/svelte/src/index-client.js' as string
		)
);
const { flushSync, mount, unmount } = await import('svelte');
const { default: PartialStars } = await import('./PartialStars.svelte');

let app: ReturnType<typeof mount> | null = null;
afterEach(() => {
	if (app) unmount(app);
	app = null;
	document.body.innerHTML = '';
});

function render(value: number, rtl = false) {
	const target = document.createElement('div');
	document.body.appendChild(target);
	app = mount(PartialStars, { target, props: { value, rtl, label: `${value} of 5 stars` } });
	flushSync();
	const svgs = [...target.querySelectorAll('svg')];
	return {
		target,
		// per star: 'full' | the clip width of a part-filled star | 'empty'
		fills: svgs.map((s) => {
			const filled = s.querySelectorAll('path.fill-amber-400');
			if (filled.length === 0) return 'empty';
			const rect = s.querySelector('clipPath rect');
			return rect ? Number(rect.getAttribute('width')) : 'full';
		})
	};
}

describe('PartialStars', () => {
	it('right-to-left: a part-filled star fills from its right edge, next to the full ones', () => {
		const { target, fills } = render(4 + 2 / 3, true);
		expect(fills[4]).toBeCloseTo(16, 6);
		const rect = target.querySelectorAll('svg')[4]?.querySelector('clipPath rect');
		expect(Number(rect?.getAttribute('x'))).toBeCloseTo(8, 6);
		// No mirroring transform: the star is symmetric, only the clip moves.
		expect(target.innerHTML).not.toMatch(/scale-x/);
	});

	it('left-to-right: the clip starts at the left edge', () => {
		const { target } = render(1 + 1 / 3);
		const rect = target.querySelectorAll('svg')[1]?.querySelector('clipPath rect');
		expect(Number(rect?.getAttribute('x'))).toBe(0);
	});

	it('4⅔: four full, one two-thirds', () => {
		const { fills } = render(4 + 2 / 3);
		expect(fills.slice(0, 4)).toEqual(['full', 'full', 'full', 'full']);
		expect(fills[4]).toBeCloseTo(16, 6);
	});

	it('1⅓: one full, one third, three empty', () => {
		const { fills } = render(1 + 1 / 3);
		expect(fills[0]).toBe('full');
		expect(fills[1]).toBeCloseTo(8, 6);
		expect(fills.slice(2)).toEqual(['empty', 'empty', 'empty']);
	});

	it('0 and 5, and nonsense as 0', () => {
		expect(render(0).fills).toEqual(['empty', 'empty', 'empty', 'empty', 'empty']);
		unmount(app!);
		app = null;
		expect(render(5).fills).toEqual(['full', 'full', 'full', 'full', 'full']);
		unmount(app!);
		app = null;
		expect(render(Number.NaN).fills).toEqual(['empty', 'empty', 'empty', 'empty', 'empty']);
	});

	it('is one labelled image; two on a page never share a clip-path id', () => {
		const a = render(2 + 1 / 3);
		const img = a.target.querySelector('[role="img"]')!;
		expect(img.getAttribute('aria-label')).toBe(`${2 + 1 / 3} of 5 stars`);
		const target2 = document.createElement('div');
		document.body.appendChild(target2);
		// Same value: the part-filled star sits at the same position in both.
		const app2 = mount(PartialStars, { target: target2, props: { value: 2 + 1 / 3, label: 'x' } });
		flushSync();
		const ids = [...document.querySelectorAll('clipPath')].map((c) => c.id);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
		unmount(app2);
	});
});
