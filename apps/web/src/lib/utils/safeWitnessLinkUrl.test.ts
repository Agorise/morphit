import { describe, expect, it } from 'vitest';

import { safeWitnessLinkUrl } from './safeWitnessLinkUrl';

describe('safeWitnessLinkUrl', () => {
	it('keeps http and https links', () => {
		expect(safeWitnessLinkUrl('https://blurt.blog/@x')).toBe('https://blurt.blog/@x');
		expect(safeWitnessLinkUrl('http://example.com')).toBe('http://example.com/');
	});
	it('refuses every other scheme, credentials, junk and overlong links', () => {
		for (const bad of [
			'javascript:alert(1)',
			' JavaScript:alert(1)',
			'data:text/html,<script>x</script>',
			'vbscript:x',
			'https://u:p@example.com',
			'your-blog-url',
			'',
			'https://example.com/' + 'a'.repeat(600),
			null,
			42
		]) {
			expect(safeWitnessLinkUrl(bad)).toBeNull();
		}
	});
});
