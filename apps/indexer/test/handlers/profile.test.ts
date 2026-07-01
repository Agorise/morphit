import { describe, expect, it } from 'vitest';

import handler from '$indexer/handlers/profile';
import { makeCtx } from '../testutils/context';
import { makeMockClient } from '../testutils/mockClient';

describe('profile handler', () => {
	it('upserts a valid payload', async () => {
		const mock = makeMockClient([
			{ match: 'SELECT json_metadata' },
			{ match: 'INSERT INTO profiles' }
		]);
		const r = await handler(
			makeCtx({
				signer: 'alice',
				payload: { display_name: 'Alice the Great' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		// A read-before-write SELECT (for the json_metadata merge) precedes
		// the upsert, so there are two queries; the INSERT is the second.
		expect(mock.queries).toHaveLength(2);
		expect(mock.queries[1]!.params[0]).toBe('alice');
		expect(mock.queries[1]!.params[1]).toBe('Alice the Great');
	});

	it('accepts optional json_metadata as a plain object', async () => {
		const mock = makeMockClient([
			{ match: 'SELECT json_metadata' },
			{ match: 'INSERT INTO profiles' }
		]);
		const r = await handler(
			makeCtx({
				payload: {
					display_name: 'Bob',
					json_metadata: { short_bio: 'hi there' }
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
	});

	it('rejects non-object payloads', async () => {
		const mock = makeMockClient();
		const r = await handler(makeCtx({ payload: 'not an object' as unknown }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'payload_not_object' });
		expect(mock.queries).toHaveLength(0);
	});

	it('allows a missing display_name (avatar/links-only profile)', async () => {
		const mock = makeMockClient([
			{ match: 'SELECT json_metadata' },
			{ match: 'INSERT INTO profiles' }
		]);
		const r = await handler(makeCtx({ payload: {} }), mock.client);
		expect(r).toEqual({ ok: true });
		// Empty name is written; the upsert's CASE keeps any existing name.
		expect(mock.queries[1]!.params[1]).toBe('');
	});

	it('rejects a non-string display_name', async () => {
		const mock = makeMockClient();
		const r = await handler(makeCtx({ payload: { display_name: 42 } }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'display_name_not_string' });
	});

	it('allows an empty/whitespace display_name (treated as no name)', async () => {
		const mock = makeMockClient([
			{ match: 'SELECT json_metadata' },
			{ match: 'INSERT INTO profiles' }
		]);
		const r = await handler(makeCtx({ payload: { display_name: '   ' } }), mock.client);
		expect(r).toEqual({ ok: true });
		expect(mock.queries[1]!.params[1]).toBe('');
	});

	it('MERGES json_metadata: a field the op omits is preserved from the prior profile', async () => {
		// Prior profile has an avatar; the op only updates short_bio. The
		// avatar MUST survive (regression: a short-bio broadcast used to
		// orphan a previously-set avatar under full-replace).
		const mock = makeMockClient([
			{
				match: 'SELECT json_metadata',
				rows: [{ json_metadata: { avatar_data_uri: 'data:image/webp;base64,AAA' } }]
			},
			// Avatar-uniqueness probe: no OTHER account holds this image,
			// so the merged avatar survives.
			{ match: "json_metadata->>'avatar_data_uri'", rowCount: 0 },
			{ match: 'INSERT INTO profiles' }
		]);
		const r = await handler(
			makeCtx({
				signer: 'kentest3',
				payload: { display_name: 'Ken', json_metadata: { short_bio: 'hello' } }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		const merged = JSON.parse(mock.queries[2]!.params[2] as string);
		expect(merged.avatar_data_uri).toBe('data:image/webp;base64,AAA');
		expect(merged.short_bio).toBe('hello');
	});

	it('MERGES json_metadata: an explicit empty string clears that field', async () => {
		const mock = makeMockClient([
			{
				match: 'SELECT json_metadata',
				rows: [{ json_metadata: { avatar_svg: '<svg/>', short_bio: 'keep me' } }]
			},
			{ match: 'INSERT INTO profiles' }
		]);
		const r = await handler(
			makeCtx({
				payload: { display_name: 'Ken', json_metadata: { avatar_svg: '' } }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		const merged = JSON.parse(mock.queries[1]!.params[2] as string);
		expect('avatar_svg' in merged).toBe(false);
		expect(merged.short_bio).toBe('keep me');
	});

	it('avatar uniqueness: a duplicate of ANOTHER account reverts to prior', async () => {
		const mock = makeMockClient([
			{ match: 'SELECT json_metadata', rows: [{ json_metadata: { avatar_svg: '<svg>old</svg>' } }] },
			// Another account already holds the incoming image.
			{ match: "json_metadata->>'avatar_svg'", rowCount: 1, rows: [{ ok: 1 }] },
			{ match: 'INSERT INTO profiles' }
		]);
		const r = await handler(
			makeCtx({
				signer: 'kentest',
				payload: { display_name: 'Ken', json_metadata: { avatar_svg: '<svg>stolen</svg>' } }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		// Duplicate rejected → the account keeps its OWN prior avatar; the
		// rest of the profile op still applies.
		const merged = JSON.parse(mock.queries[2]!.params[2] as string);
		expect(merged.avatar_svg).toBe('<svg>old</svg>');
	});

	it('avatar uniqueness: a duplicate with NO prior avatar is dropped', async () => {
		const mock = makeMockClient([
			{ match: 'SELECT json_metadata', rows: [{ json_metadata: {} }] },
			{ match: "json_metadata->>'avatar_svg'", rowCount: 1, rows: [{ ok: 1 }] },
			{ match: 'INSERT INTO profiles' }
		]);
		const r = await handler(
			makeCtx({
				signer: 'kentest',
				payload: { display_name: 'Ken', json_metadata: { avatar_svg: '<svg>stolen</svg>' } }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		const merged = JSON.parse(mock.queries[2]!.params[2] as string);
		expect('avatar_svg' in merged).toBe(false);
	});

	it('avatar uniqueness: re-uploading your OWN image is allowed (probe excludes signer)', async () => {
		const mock = makeMockClient([
			{ match: 'SELECT json_metadata', rows: [{ json_metadata: {} }] },
			{ match: "json_metadata->>'avatar_svg'", rowCount: 0 },
			{ match: 'INSERT INTO profiles' }
		]);
		const r = await handler(
			makeCtx({
				signer: 'kentest',
				payload: { display_name: 'Ken', json_metadata: { avatar_svg: '<svg>mine</svg>' } }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		// The exclusion clause is what lets a user re-upload their own
		// image without tripping the guard.
		const probe = mock.queries[1]!;
		expect(probe.text).toContain('account <> $1');
		expect(probe.params[0]).toBe('kentest');
		expect(probe.params[1]).toBe('<svg>mine</svg>');
		const merged = JSON.parse(mock.queries[2]!.params[2] as string);
		expect(merged.avatar_svg).toBe('<svg>mine</svg>');
	});

	it('rejects display_name exceeding 64 code points', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: { display_name: 'a'.repeat(65) }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'display_name_too_long' });
	});

	it('counts code points, not UTF-16 units, for length', async () => {
		// "👋 Hello" has 7 code points but 8 UTF-16 units.
		const mock = makeMockClient([
			{ match: 'SELECT json_metadata' },
			{ match: 'INSERT INTO profiles' }
		]);
		// 64 emoji (each 2 UTF-16 units, 1 code point) — exactly at the limit.
		const name = '👋'.repeat(64);
		const r = await handler(makeCtx({ payload: { display_name: name } }), mock.client);
		expect(r).toEqual({ ok: true });
	});

	it('rejects non-object json_metadata', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: { display_name: 'Carol', json_metadata: 'foo' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'json_metadata_not_object' });
	});

	// Profile uses MAX_JSONB_BYTES_PROFILE = 8192 (larger than the
	// default 4KB to make room for inline avatars).  The earlier
	// version of this test claimed "4KB cap" with a 4100-char
	// payload — that would NOT trip the 8KB cap, so the test was
	// rotted.  Fixed: use a payload that genuinely exceeds 8KB.
	it('rejects json_metadata exceeding 8KB serialized', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				payload: {
					display_name: 'Carol',
					json_metadata: { padding: 'x'.repeat(8200) }
				}
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'json_metadata_too_large' });
		expect(mock.queries).toHaveLength(0);
	});

	// ─── O3.1 — NFC normalization + homograph defense ────────────

	it('O3.1: NFC-normalizes display_name before length check', async () => {
		// Decomposed é (e + U+0301 combining acute) — pre-NFC this
		// is 2 codepoints, post-NFC it's 1.  64 NFC-form chars
		// should pass even when input is 128 codepoints decomposed.
		const mock = makeMockClient([
			{ match: 'SELECT json_metadata' },
			{ match: 'INSERT INTO profiles' }
		]);
		const decomposed = 'e\u0301'.repeat(64);
		const r = await handler(makeCtx({ payload: { display_name: decomposed } }), mock.client);
		expect(r).toEqual({ ok: true });
		// The stored value should be NFC-normalized (the INSERT is the
		// second query, after the merge SELECT).
		const stored = mock.queries[1]!.params[1] as string;
		expect([...stored].length).toBe(64);
		// And byte-equal to the precomposed é × 64.
		expect(stored).toBe('é'.repeat(64));
	});

	it('O3.1: rejects NFD-decomposed homograph of reserved name', async () => {
		// "morphit-fées" with é written as e + combining acute.
		// Pre-O3.1, the indexer didn't NFC-normalize before running
		// impersonatesReservedName, and the regex character classes
		// contain precomposed \u00e9 but not the bare 2-codepoint
		// sequence — so this would slip through as an accepted name
		// that VISUALLY impersonates "morphit-fees".
		const mock = makeMockClient();
		const decomposed = 'morphit-fe\u0301e\u0301s';
		const r = await handler(makeCtx({ payload: { display_name: decomposed } }), mock.client);
		expect(r).toEqual({
			ok: false,
			reason: 'display_name_impersonates_reserved'
		});
		expect(mock.queries).toHaveLength(0);
	});

	it('rejects display_name with leading @ (ASCII)', async () => {
		const mock = makeMockClient();
		const r = await handler(makeCtx({ payload: { display_name: '@morphit-fees' } }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'display_name_leading_at' });
	});

	it('rejects display_name with leading ＠ (fullwidth)', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({ payload: { display_name: '\uFF20morphit-fees' } }),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'display_name_leading_at' });
	});

	it('rejects direct Cyrillic homograph of reserved name', async () => {
		const mock = makeMockClient();
		// Cyrillic 'е' (U+0435) for Latin 'e' in "morphit-fees".
		const homograph = 'morphit-f\u0435\u0435s';
		const r = await handler(makeCtx({ payload: { display_name: homograph } }), mock.client);
		expect(r).toEqual({
			ok: false,
			reason: 'display_name_impersonates_reserved'
		});
	});

	it('rejects display_name with control character', async () => {
		const mock = makeMockClient();
		const r = await handler(makeCtx({ payload: { display_name: 'Alice\u0007Bob' } }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'display_name_forbidden_char' });
	});

	it('rejects display_name with bidi override', async () => {
		const mock = makeMockClient();
		const r = await handler(makeCtx({ payload: { display_name: 'Al\u202Eice' } }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'display_name_forbidden_char' });
	});

	it('rejects display_name with zero-width joiner', async () => {
		const mock = makeMockClient();
		const r = await handler(makeCtx({ payload: { display_name: 'Al\u200Dice' } }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'display_name_forbidden_char' });
	});

	it('legitimate exact-match reserved name from the operator does NOT impersonate (byte-equal)', async () => {
		// The byte-equality escape: an operator who LEGITIMATELY
		// owns the reserved name should be able to use it as their
		// display_name.  impersonatesReservedName returns false on
		// byte-equal match.
		const mock = makeMockClient([
			{ match: 'SELECT json_metadata' },
			{ match: 'INSERT INTO profiles' }
		]);
		const r = await handler(
			makeCtx({
				signer: 'morphit-fees',
				payload: { display_name: 'morphit-fees' }
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
	});
});
