import { describe, it, expect } from 'vitest';
import { buildProfileBody } from './profile';

/**
 * v1.4.8 (t.txt #1) — profile-field CLEAR contract.
 *
 * The bug: tapping "Clear" on the blurt.media URL card + "Save & broadcast"
 * saved an op to chain, but the URL reappeared on reload. Root cause: the wire
 * builder only added a text field to json_metadata when it was NON-empty, so a
 * cleared field was OMITTED — and the indexer merge reads an omitted key as
 * "keep prior", never clearing it.
 *
 * The contract (matches the indexer merge + the avatar fields):
 *   - value present  ⇒ set
 *   - '' (cleared)   ⇒ INCLUDED as '' — an explicit clear signal the indexer drops
 *   - undefined      ⇒ OMITTED — "not part of this update", prior value preserved
 *
 * This must hold for ALL text profile fields (Ken: "make sure none of the other
 * settings fields are buggy like that"), consistent with avatar_svg /
 * avatar_data_uri which already behaved this way.
 */
const TS = 1_700_000_000;
const TEXT_FIELDS = ['nostr_url', 'blurt_media_url', 'short_bio'] as const;

describe('buildProfileBody — clear signal for text fields', () => {
	it('INCLUDES a cleared field as an empty string (so the indexer clears it)', () => {
		for (const f of TEXT_FIELDS) {
			const body = buildProfileBody({ display_name: 'ken', [f]: '' }, TS);
			const meta = body.json_metadata ?? {};
			// present, and empty — NOT dropped
			expect(Object.prototype.hasOwnProperty.call(meta, f)).toBe(true);
			expect(meta[f]).toBe('');
		}
	});

	it('OMITS an undefined field (keeps the prior on-chain value)', () => {
		const body = buildProfileBody({ display_name: 'ken' }, TS);
		const meta = body.json_metadata ?? {};
		for (const f of TEXT_FIELDS) {
			expect(Object.prototype.hasOwnProperty.call(meta, f)).toBe(false);
		}
	});

	it('SETS a non-empty field to its (trimmed) value', () => {
		const body = buildProfileBody(
			{
				display_name: 'ken',
				nostr_url: '  npub1abc  ',
				blurt_media_url: 'https://blurt.media/@ken',
				short_bio: 'agorist'
			},
			TS
		);
		const meta = body.json_metadata ?? {};
		expect(meta.nostr_url).toBe('npub1abc');
		expect(meta.blurt_media_url).toBe('https://blurt.media/@ken');
		expect(meta.short_bio).toBe('agorist');
	});

	it('treats whitespace-only as a clear (trims to empty ⇒ included as "")', () => {
		const body = buildProfileBody({ display_name: 'ken', blurt_media_url: '   ' }, TS);
		const meta = body.json_metadata ?? {};
		expect(meta.blurt_media_url).toBe('');
	});

	it('mixed update: clear one field, set another, leave a third untouched', () => {
		// User had blurt_media + nostr set; clears blurt_media, keeps nostr,
		// never touched short_bio (undefined).
		const body = buildProfileBody(
			{ display_name: 'ken', blurt_media_url: '', nostr_url: 'npub1keep' },
			TS
		);
		const meta = body.json_metadata ?? {};
		expect(meta.blurt_media_url).toBe(''); // cleared
		expect(meta.nostr_url).toBe('npub1keep'); // set/kept
		expect(Object.prototype.hasOwnProperty.call(meta, 'short_bio')).toBe(false); // omitted
	});

	it('parity with avatar fields: empty avatar is also a clear signal', () => {
		const body = buildProfileBody({ display_name: 'ken', avatar_svg: '' }, TS);
		const meta = body.json_metadata ?? {};
		expect(meta.avatar_svg).toBe('');
	});
});
