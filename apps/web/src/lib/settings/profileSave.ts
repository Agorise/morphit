/**
 * The profile op a Settings "Save & broadcast" button sends: only the field
 * that button owns.
 *
 * The indexer merges a profile op into the stored profile: a field the op
 * omits keeps its on-chain value, an empty string clears it. A button that
 * sent every field from page state therefore wiped the others whenever the
 * page had not loaded them (the profile read failed) and overwrote them with
 * stale values otherwise. (`display_name` is omitted unless the button owns
 * it; the op then carries an empty name, which the indexer reads as "no
 * name in this op" and keeps the stored one.)
 */
import type { ProfilePayload } from '$blurt/ops/profile';

export type ProfileFieldSave =
	| { readonly field: 'display_name'; readonly value: string }
	| {
			readonly field: 'short_bio' | 'nostr_url' | 'streaming_url' | 'website_url';
			readonly value: string;
	  }
	| { readonly field: 'preferred_langs'; readonly value: readonly string[] }
	| { readonly field: 'avatar'; readonly svg: string; readonly dataUri: string };

export function profileSavePayload(save: ProfileFieldSave): ProfilePayload {
	switch (save.field) {
		case 'avatar':
			// Both halves: the one not in use is cleared ('').
			return { avatar_svg: save.svg, avatar_data_uri: save.dataUri };
		case 'preferred_langs':
			return { preferred_langs: save.value };
		case 'display_name':
			return { display_name: save.value };
		default:
			return { [save.field]: save.value };
	}
}
