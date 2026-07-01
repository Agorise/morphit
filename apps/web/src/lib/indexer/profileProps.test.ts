// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { extractLabelPropsFromProfile } from './profileProps';
import type { ProfileResponse } from '@morphit/indexer-client';

function mockProfile(overrides: Partial<ProfileResponse> = {}): ProfileResponse {
	return {
		account: 'alice',
		display_name: 'Alice',
		json_metadata: {},
		source_block_num: 1,
		updated_at: '2026-04-23T12:00:00.000Z',
		...overrides
	};
}

describe('extractLabelPropsFromProfile', () => {
	it('returns all nulls for null / undefined profile', () => {
		const nullResult = extractLabelPropsFromProfile(null);
		const undefResult = extractLabelPropsFromProfile(undefined);
		const allNull = {
			displayName: null,
			avatarSvg: null,
			avatarDataUri: null,
			nostrUrl: null,
			blurtMediaUrl: null,
			shortBio: null
		};
		expect(nullResult).toEqual(allNull);
		expect(undefResult).toEqual(allNull);
	});

	it('extracts short_bio from json_metadata (cp346 — settings hydration)', () => {
		const r = extractLabelPropsFromProfile(
			mockProfile({ json_metadata: { short_bio: 'Counter-economist & coffee snob' } })
		);
		expect(r.shortBio).toBe('Counter-economist & coffee snob');
		const empty = extractLabelPropsFromProfile(mockProfile({ json_metadata: { short_bio: '' } }));
		expect(empty.shortBio).toBeNull();
		const none = extractLabelPropsFromProfile(mockProfile({ display_name: 'Bob' }));
		expect(none.shortBio).toBeNull();
	});

	it('extracts display_name when non-empty', () => {
		const r = extractLabelPropsFromProfile(mockProfile({ display_name: 'Alice' }));
		expect(r.displayName).toBe('Alice');
	});

	it('returns null displayName for empty-string display_name', () => {
		const r = extractLabelPropsFromProfile(mockProfile({ display_name: '' }));
		expect(r.displayName).toBeNull();
	});

	it('returns all metadata nulls when json_metadata is not an object', () => {
		const r = extractLabelPropsFromProfile(mockProfile({ json_metadata: 'not an object' }));
		expect(r.avatarSvg).toBeNull();
		expect(r.avatarDataUri).toBeNull();
		expect(r.nostrUrl).toBeNull();
		expect(r.blurtMediaUrl).toBeNull();
		// display_name is not in json_metadata so it's preserved.
		expect(r.displayName).toBe('Alice');
	});

	it('returns all metadata nulls when json_metadata is null', () => {
		const r = extractLabelPropsFromProfile(mockProfile({ json_metadata: null }));
		expect(r.avatarSvg).toBeNull();
		expect(r.avatarDataUri).toBeNull();
	});

	it('happy path: extracts every known metadata key', () => {
		// Use a well-formed minimal SVG that survives sanitization.
		// Pre-G2.2 fix the helper passed avatar_svg through verbatim;
		// post-fix it re-sanitizes via $lib/avatar's sanitizeSvg.
		// The sanitizer normalizes whitespace and serializes via the
		// browser's XMLSerializer, so we don't assert on exact byte
		// equality — we assert the SVG round-tripped to a valid
		// serialized form.
		const cleanSvg =
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="red"/></svg>';
		// Post-O3.2: avatar_data_uri must match data:image/...;base64,...
		// regex.  Tiny valid base64 fragment used here as a placeholder
		// stand-in (real values are ~2KB of webp bytes).
		const cleanDataUri = 'data:image/webp;base64,UklGRg==';
		const r = extractLabelPropsFromProfile(
			mockProfile({
				display_name: 'Alice',
				json_metadata: {
					avatar_svg: cleanSvg,
					avatar_data_uri: cleanDataUri,
					nostr_url: 'nostr:npub1xyz',
					blurt_media_url: 'https://blurt.media/alice'
				}
			})
		);
		expect(r.displayName).toBe('Alice');
		expect(r.avatarDataUri).toBe(cleanDataUri);
		expect(r.nostrUrl).toBe('nostr:npub1xyz');
		expect(r.blurtMediaUrl).toBe('https://blurt.media/alice');
		// SVG survived — has the circle that the input contained.
		expect(r.avatarSvg).not.toBeNull();
		expect(r.avatarSvg).toContain('circle');
	});

	it('returns null for individual empty-string metadata fields', () => {
		const r = extractLabelPropsFromProfile(
			mockProfile({
				json_metadata: {
					avatar_svg: '',
					avatar_data_uri: '',
					nostr_url: ''
				}
			})
		);
		expect(r.avatarSvg).toBeNull();
		expect(r.avatarDataUri).toBeNull();
		expect(r.nostrUrl).toBeNull();
	});

	it('returns null for non-string metadata fields', () => {
		const r = extractLabelPropsFromProfile(
			mockProfile({
				json_metadata: {
					avatar_svg: 42,
					avatar_data_uri: { nested: 'object' },
					nostr_url: null
				}
			})
		);
		expect(r.avatarSvg).toBeNull();
		expect(r.avatarDataUri).toBeNull();
		expect(r.nostrUrl).toBeNull();
	});

	it('ignores unrelated metadata keys', () => {
		const r = extractLabelPropsFromProfile(
			mockProfile({
				json_metadata: {
					nostr_url: 'nostr:npub1xyz',
					random_other_key: 'ignored',
					future_feature: { complex: 'value' }
				}
			})
		);
		expect(r.nostrUrl).toBe('nostr:npub1xyz');
		// No other unexpected fields on the result.
		expect(Object.keys(r).sort()).toEqual([
			'avatarDataUri',
			'avatarSvg',
			'blurtMediaUrl',
			'displayName',
			'nostrUrl',
			'shortBio'
		]);
	});

	// ─── G2.2 — re-sanitize indexer-supplied SVG ─────────────────
	//
	// The frontend trusts the indexer for profile data, but the
	// chain doesn't enforce SVG sanitization and a malicious
	// indexer can return arbitrary content.  IdentityLabel inlines
	// avatar_svg via {@html}, so unsafe content there is full XSS.
	// extractLabelPropsFromProfile re-sanitizes on receive.

	describe('G2.2: re-sanitize avatar_svg from indexer', () => {
		it('strips <script> tags', () => {
			const hostile =
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
				'<script>alert(1)</script>' +
				'<circle cx="16" cy="16" r="12"/>' +
				'</svg>';
			const r = extractLabelPropsFromProfile(
				mockProfile({ json_metadata: { avatar_svg: hostile } })
			);
			expect(r.avatarSvg).not.toBeNull();
			expect(r.avatarSvg).not.toContain('<script');
			expect(r.avatarSvg).not.toContain('alert');
		});

		it('strips event-handler attributes (onload)', () => {
			const hostile =
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
				'<circle cx="16" cy="16" r="12" onload="alert(1)"/>' +
				'</svg>';
			const r = extractLabelPropsFromProfile(
				mockProfile({ json_metadata: { avatar_svg: hostile } })
			);
			expect(r.avatarSvg).not.toBeNull();
			expect(r.avatarSvg).not.toContain('onload');
			expect(r.avatarSvg).not.toContain('alert');
		});

		it('strips javascript: URLs in href', () => {
			const hostile =
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
				'<a href="javascript:alert(1)">' +
				'<circle cx="16" cy="16" r="12"/>' +
				'</a>' +
				'</svg>';
			const r = extractLabelPropsFromProfile(
				mockProfile({ json_metadata: { avatar_svg: hostile } })
			);
			expect(r.avatarSvg).not.toBeNull();
			expect(r.avatarSvg).not.toContain('javascript:');
			expect(r.avatarSvg).not.toContain('alert');
		});

		it('strips foreignObject (HTML embedding vector)', () => {
			// Note: avoid nested `xmlns="http://www.w3.org/1999/xhtml"`
			// declarations on inner elements — real browser DOMParser
			// handles them, jsdom's chokes on the namespace switch and
			// returns a <parsererror>. The simpler form below still
			// demonstrates the foreignObject vector and exercises the
			// attribute-stripping path the same way.
			const hostile =
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
				'<foreignObject>' +
				'<a href="javascript:alert(1)">x</a>' +
				'</foreignObject>' +
				'</svg>';
			const r = extractLabelPropsFromProfile(
				mockProfile({ json_metadata: { avatar_svg: hostile } })
			);
			expect(r.avatarSvg).not.toBeNull();
			expect(r.avatarSvg).not.toContain('foreignObject');
			expect(r.avatarSvg).not.toContain('alert');
		});

		it('returns null for unparseable SVG', () => {
			const r = extractLabelPropsFromProfile(
				mockProfile({
					json_metadata: { avatar_svg: '<<not-an-svg>>' }
				})
			);
			expect(r.avatarSvg).toBeNull();
		});

		it('returns null for non-SVG content masquerading as avatar_svg', () => {
			// A malicious indexer could return raw HTML. Sanitizer
			// rejects on missing <svg> root.
			const r = extractLabelPropsFromProfile(
				mockProfile({
					json_metadata: {
						avatar_svg: '<div onmouseover="alert(1)">hi</div>'
					}
				})
			);
			expect(r.avatarSvg).toBeNull();
		});

		it('preserves clean SVG content unchanged after sanitization', () => {
			const clean =
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
				'<circle cx="16" cy="16" r="12" fill="#ff0000"/>' +
				'</svg>';
			const r = extractLabelPropsFromProfile(mockProfile({ json_metadata: { avatar_svg: clean } }));
			expect(r.avatarSvg).not.toBeNull();
			expect(r.avatarSvg).toContain('circle');
			expect(r.avatarSvg).toContain('cx="16"');
			expect(r.avatarSvg).toContain('#ff0000');
		});
	});

	describe('O3.2: validate avatar_data_uri shape', () => {
		// Pre-fix profileProps accepted any non-empty string for
		// avatar_data_uri and passed it to <img src>.  An attacker
		// could embed a tracking-pixel URL or unsafe scheme.
		// Post-fix only data:image/(webp|png|jpeg|gif);base64,...
		// passes through; everything else is null.

		it('rejects http(s) URL masquerading as avatar', () => {
			const r = extractLabelPropsFromProfile(
				mockProfile({
					json_metadata: {
						avatar_data_uri: 'https://tracker.example/pixel.gif'
					}
				})
			);
			expect(r.avatarDataUri).toBeNull();
		});

		it('rejects javascript: scheme', () => {
			const r = extractLabelPropsFromProfile(
				mockProfile({
					json_metadata: { avatar_data_uri: 'javascript:alert(1)' }
				})
			);
			expect(r.avatarDataUri).toBeNull();
		});

		it('rejects data:text/html (must be image MIME)', () => {
			const r = extractLabelPropsFromProfile(
				mockProfile({
					json_metadata: {
						avatar_data_uri: 'data:text/html;base64,PHNjcmlwdD4='
					}
				})
			);
			expect(r.avatarDataUri).toBeNull();
		});

		it('rejects data:image/svg+xml (SVG must use avatar_svg path)', () => {
			// Allowing data:image/svg+xml here would bypass the
			// SVG sanitizer in the sister field.  The split keeps
			// the sanitization chokepoint clear.
			const r = extractLabelPropsFromProfile(
				mockProfile({
					json_metadata: {
						avatar_data_uri: 'data:image/svg+xml;base64,PHN2Zz4='
					}
				})
			);
			expect(r.avatarDataUri).toBeNull();
		});

		it('rejects oversize data URI (> 16KB)', () => {
			const huge = 'data:image/webp;base64,' + 'A'.repeat(17000);
			const r = extractLabelPropsFromProfile(
				mockProfile({ json_metadata: { avatar_data_uri: huge } })
			);
			expect(r.avatarDataUri).toBeNull();
		});

		it('rejects malformed base64 segment', () => {
			const r = extractLabelPropsFromProfile(
				mockProfile({
					json_metadata: {
						// Contains a space which isn't valid base64.
						avatar_data_uri: 'data:image/webp;base64,UklG Rg=='
					}
				})
			);
			expect(r.avatarDataUri).toBeNull();
		});

		it('accepts data:image/webp', () => {
			const r = extractLabelPropsFromProfile(
				mockProfile({
					json_metadata: {
						avatar_data_uri: 'data:image/webp;base64,UklGRg=='
					}
				})
			);
			expect(r.avatarDataUri).toBe('data:image/webp;base64,UklGRg==');
		});

		it('accepts data:image/png', () => {
			const r = extractLabelPropsFromProfile(
				mockProfile({
					json_metadata: {
						avatar_data_uri: 'data:image/png;base64,iVBORw0='
					}
				})
			);
			expect(r.avatarDataUri).toBe('data:image/png;base64,iVBORw0=');
		});

		it('accepts data:image/jpeg', () => {
			const r = extractLabelPropsFromProfile(
				mockProfile({
					json_metadata: {
						avatar_data_uri: 'data:image/jpeg;base64,/9j/4AA='
					}
				})
			);
			expect(r.avatarDataUri).toBe('data:image/jpeg;base64,/9j/4AA=');
		});

		it('accepts data:image/gif', () => {
			const r = extractLabelPropsFromProfile(
				mockProfile({
					json_metadata: {
						avatar_data_uri: 'data:image/gif;base64,R0lGODlh'
					}
				})
			);
			expect(r.avatarDataUri).toBe('data:image/gif;base64,R0lGODlh');
		});
	});
});
