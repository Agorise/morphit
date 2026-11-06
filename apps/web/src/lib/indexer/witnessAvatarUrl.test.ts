// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { witnessAvatarUrl } from './client';

describe('witnessAvatarUrl', () => {
	it('only this instance’s picture paths', () => {
		expect(witnessAvatarUrl('/v1/witnesses/avatar/khrom?v=0123abcd4567')).toMatch(
			/\/v1\/witnesses\/avatar\/khrom\?v=0123abcd4567$/
		);
		expect(witnessAvatarUrl('/v1/witnesses/avatar/blurt.one')).toMatch(
			/\/v1\/witnesses\/avatar\/blurt\.one$/
		);
		for (const bad of [
			'https://evil.example/x.png',
			'//evil.example/x.png',
			'/v1/witnesses/avatar/../../x',
			'/v1/other/khrom',
			'/v1/witnesses/avatar/khrom?v=zz',
			'javascript:alert(1)'
		]) {
			expect(witnessAvatarUrl(bad), bad).toBeUndefined();
		}
	});
});
