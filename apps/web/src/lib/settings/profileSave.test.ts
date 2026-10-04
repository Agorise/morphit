/**
 * Each Settings save sends only its own field: the op the bio button
 * builds names no link and no language, so a page whose profile read failed
 * cannot wipe them, and the name save does not replace the languages.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: false, dev: false, building: false, version: 't' }));

import { buildProfileBody } from '$lib/blurt/ops/profile';
import { profileSavePayload } from './profileSave';

const body = (p: Parameters<typeof profileSavePayload>[0]) =>
	buildProfileBody(profileSavePayload(p), 1);

describe('profileSavePayload', () => {
	it('the bio save carries only the bio (no name, links or languages)', () => {
		const b = body({ field: 'short_bio', value: 'new bio' });
		expect(b.json_metadata).toEqual({ short_bio: 'new bio' });
		expect(b.display_name).toBe('');
	});
	it('the name save carries only the name', () => {
		const b = body({ field: 'display_name', value: 'Alice' });
		expect(b.display_name).toBe('Alice');
		expect(b.json_metadata).toBeUndefined();
	});
	it('a link save carries only that link; clearing it sends an empty value', () => {
		expect(body({ field: 'website_url', value: '' }).json_metadata).toEqual({ website_url: '' });
		expect(body({ field: 'nostr_url', value: 'nostr:npub1x' }).json_metadata).toEqual({
			nostr_url: 'nostr:npub1x'
		});
	});
	it('the language save carries only the languages', () => {
		expect(body({ field: 'preferred_langs', value: ['ru', 'pl'] }).json_metadata).toEqual({
			preferred_langs: ['ru', 'pl']
		});
	});
	it('the avatar save carries both avatar halves and nothing else', () => {
		expect(
			body({ field: 'avatar', svg: '', dataUri: 'data:image/webp;base64,AA' }).json_metadata
		).toEqual({
			avatar_svg: '',
			avatar_data_uri: 'data:image/webp;base64,AA'
		});
	});
});
