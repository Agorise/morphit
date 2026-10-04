/**
 * profile json_metadata values are checked before they are
 * stored: a bio with bidi overrides or zero-width characters, a link that is
 * not a string, a `javascript:` link and a non-image data URI used to be
 * stored as sent (HO-8). From CONSENSUS_V2_ACTIVATION_TIME they are refused;
 * earlier ops keep their verdicts. Rows already stored are cleaned on read
 * with sanitizeStoredProfileMetadata.
 */
import { describe, expect, it } from 'vitest';
import profileHandler, { sanitizeStoredProfileMetadata } from '$indexer/handlers/profile';
import { CONSENSUS_V2_ACTIVATION_TIME } from '$indexer/consensusActivation';
import { makeCtx } from '../testutils/context';

const db = { query: async () => ({ rows: [], rowCount: 0 }) } as never;
const ACTIVATION = Date.parse(CONSENSUS_V2_ACTIVATION_TIME);
const AFTER = new Date(ACTIVATION + 1000);
const BEFORE = new Date(ACTIVATION - 1000);

async function verdict(json_metadata: Record<string, unknown>, blockTime = AFTER): Promise<string> {
	const r = await profileHandler(
		makeCtx({ signer: 'sally', blockTime, payload: { display_name: 'Sally', json_metadata } }),
		db
	);
	return r.ok ? 'ok' : r.reason;
}

describe('profile json_metadata values', () => {
	it('ordinary values are stored', async () => {
		expect(
			await verdict({
				short_bio: 'Trading BTC in Lisbon since 2019',
				website_url: 'https://example.org/me',
				streaming_url: 'https://www.youtube.com/@sally',
				nostr_url: 'nostr:npub1qqqqqqqqqqqqqqqqqqqqqqqq',
				avatar_data_uri: 'data:image/webp;base64,AAAA'
			})
		).toBe('ok');
		expect(await verdict({ website_url: '', short_bio: '' })).toBe('ok');
	});

	for (const [label, meta, reason] of [
		[
			'a bio with a right-to-left override',
			{ short_bio: 'safe ‮txet' },
			'short_bio_forbidden_char'
		],
		['a bio with a zero-width space', { short_bio: 'pay​me' }, 'short_bio_forbidden_char'],
		['a bio over 128 characters', { short_bio: 'x'.repeat(129) }, 'short_bio_too_long'],
		['a bio that is not a string', { short_bio: { html: '<b>' } }, 'short_bio_not_string'],
		['a javascript: link', { website_url: 'javascript:alert(1)' }, 'website_url_invalid'],
		[
			'a data: link',
			{ streaming_url: 'data:text/html,<script>1</script>' },
			'streaming_url_invalid'
		],
		['a link that is not a string', { nostr_url: ['https://x'] }, 'nostr_url_not_string'],
		[
			'an SVG passed as a data URI',
			{ avatar_data_uri: 'data:image/svg+xml;base64,PHN2Zz4=' },
			'avatar_data_uri_invalid'
		],
		['an avatar that is not a string', { avatar_svg: 42 }, 'avatar_svg_not_string']
	] as const) {
		it(`refuses ${label}`, async () => {
			expect(await verdict(meta as Record<string, unknown>)).toBe(reason);
		});
	}

	it('before the activation time the old verdicts stand', async () => {
		expect(await verdict({ website_url: 'javascript:alert(1)' }, BEFORE)).toBe('ok');
	});

	it('a stored row is served without the fields intake would now refuse', () => {
		expect(
			sanitizeStoredProfileMetadata({
				short_bio: 'safe \u202etxet',
				website_url: 'javascript:alert(1)',
				streaming_url: 'https://www.youtube.com/@sally',
				avatar_data_uri: 'data:image/svg+xml;base64,PHN2Zz4=',
				avatar_svg: '<svg/>',
				preferred_langs: ['en'],
				something_else: 1
			})
		).toEqual({
			streaming_url: 'https://www.youtube.com/@sally',
			avatar_svg: '<svg/>',
			preferred_langs: ['en'],
			something_else: 1
		});
		expect(sanitizeStoredProfileMetadata(null)).toEqual({});
		expect(sanitizeStoredProfileMetadata({ website_url: '' })).toEqual({ website_url: '' });
	});
});
