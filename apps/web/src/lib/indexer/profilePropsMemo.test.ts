// @vitest-environment jsdom
/**
 * Every order row and chat message draws its trader's avatar, and the avatar
 * is sanitized again on the way to the screen (profileProps). The result
 * depends on the SVG alone, so each distinct SVG is sanitized once — the
 * sanitizer is no longer cheap (v1.21.21: a second pass proves the output is
 * a fixed point) — and the memo stays bounded.
 */
import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock('$lib/avatar', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/avatar')>();
	return {
		...real,
		sanitizeSvg: (s: string) => {
			calls.n++;
			return real.sanitizeSvg(s);
		}
	};
});

const { extractLabelPropsFromProfile } = await import('./profileProps');

const svg = (r: number) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle r="${r}"/></svg>`;
const profile = (avatar: string) => ({
	account: 'alice',
	display_name: 'Alice',
	json_metadata: { avatar_svg: avatar },
	source_block_num: 1,
	updated_at: '2026-11-01T00:00:00.000Z'
});

describe('avatar sanitizing on the way to the screen', () => {
	it('the same avatar 30 times is sanitized once, and drawn the same each time', () => {
		calls.n = 0;
		const first = extractLabelPropsFromProfile(profile(svg(3))).avatarSvg;
		for (let i = 0; i < 29; i++) {
			expect(extractLabelPropsFromProfile(profile(svg(3))).avatarSvg).toBe(first);
		}
		expect(first).toContain('<circle');
		expect(calls.n).toBe(1);
	});

	it('a refused avatar is remembered as refused', () => {
		calls.n = 0;
		for (let i = 0; i < 3; i++) {
			expect(extractLabelPropsFromProfile(profile('<not-svg')).avatarSvg).toBeNull();
		}
		expect(calls.n).toBe(1);
	});

	it('the memo is bounded: an old avatar is sanitized again after 256 others', () => {
		extractLabelPropsFromProfile(profile(svg(1000)));
		for (let i = 0; i < 256; i++) extractLabelPropsFromProfile(profile(svg(2000 + i)));
		calls.n = 0;
		extractLabelPropsFromProfile(profile(svg(1000)));
		expect(calls.n).toBe(1);
	});
});
