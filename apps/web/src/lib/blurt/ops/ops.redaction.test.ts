/**
 * Per-op-builder redaction tests.
 *
 * Every builder that accepts user free-text runs it through
 * `redactPrivateKeys` at the chokepoint before broadcast.
 * These tests verify that invariant holds for every builder —
 * if someone adds a new free-text field and forgets the
 * redaction call, the test for that field fails.
 *
 * We test the pure body-builder functions (not the broadcast
 * wrappers), which means no mocking, no network, no DOM. The
 * builders were deliberately extracted from the broadcast
 * wrappers for this purpose; the extraction matches the
 * existing `buildOrderPayload` / `payload.test.ts` pattern.
 *
 * The detector itself has 42 tests in privateKeyDetector.test.ts;
 * here we only check that each builder calls it on every
 * appropriate field.
 */

import { describe, it, expect } from 'vitest';
import { buildFeedbackBody, type FeedbackPayload } from './feedback';
import { buildFeedbackResponseBody, type FeedbackResponsePayload } from './feedbackResponse';
import { buildProfileBody, type ProfilePayload } from './profile';
import { buildOperatorRegisterBody, type OperatorRegisterPayload } from './operatorRegister';
import { buildCommentOperation, type CommentPayload } from './comment';

// ─── Shared test fixtures ───────────────────────────────────────

/** Synthetic 51-char WIF that the detector treats as a key.
 *  Not associated with any real wallet. Identical to the one
 *  used in payload.test.ts so test failures are traceable to
 *  a single piece of test data. */
const FAKE_WIF = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFDe';
// Follows truncateKey() convention (6 prefix + … + 4 suffix);
// see apps/web/src/lib/security/privateKeyDetector.ts:50.
const TRUNCATED_WIF = '5KQwrP…vFDe';

/** BIP-39 test-vector mnemonic. The detector redacts this too. */
const FAKE_MNEMONIC =
	'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TRUNCATED_MNEMONIC = 'abando…bout';

/** Helper: assert that a stringified JSON blob never contains
 *  the raw key material. Defense-in-depth check beyond
 *  field-by-field equality — catches a new field added to the
 *  body without a redaction call. */
function assertNoRawKeyAnywhere(body: unknown): void {
	const serialized = JSON.stringify(body);
	expect(serialized).not.toContain(FAKE_WIF);
	expect(serialized).not.toContain(FAKE_MNEMONIC);
}

// ─── buildFeedbackBody ──────────────────────────────────────────

describe('buildFeedbackBody — redaction chokepoint', () => {
	function mkPayload(overrides: Partial<FeedbackPayload> = {}): FeedbackPayload {
		return {
			subject: 'alice',
			rating: 5,
			...overrides
		};
	}

	it('passes through a clean payload unchanged', () => {
		const body = buildFeedbackBody(mkPayload({ comment: 'Smooth trade' }));
		expect(body).toEqual({
			subject: 'alice',
			rating: 5,
			comment: 'Smooth trade'
		});
	});

	it('redacts a WIF in the comment field', () => {
		const body = buildFeedbackBody(
			mkPayload({ comment: `Great trader. Sent me this key: ${FAKE_WIF}` })
		);
		expect(body.comment).toContain(TRUNCATED_WIF);
		expect(body.comment).not.toContain(FAKE_WIF);
		assertNoRawKeyAnywhere(body);
	});

	it('redacts a BIP-39 mnemonic in the comment field', () => {
		const body = buildFeedbackBody(mkPayload({ comment: `Phrase pasted: ${FAKE_MNEMONIC}` }));
		expect(body.comment).toContain(TRUNCATED_MNEMONIC);
		expect(body.comment).not.toContain(FAKE_MNEMONIC);
		assertNoRawKeyAnywhere(body);
	});

	it('omits the comment field when undefined', () => {
		const body = buildFeedbackBody(mkPayload({ comment: undefined }));
		expect('comment' in body).toBe(false);
	});

	it('omits the comment field when empty string', () => {
		const body = buildFeedbackBody(mkPayload({ comment: '' }));
		expect('comment' in body).toBe(false);
	});

	it('includes order_permlink when provided', () => {
		const body = buildFeedbackBody(mkPayload({ order_permlink: 'morphit-order-xyz' }));
		expect(body.order_permlink).toBe('morphit-order-xyz');
	});

	it('omits order_permlink when undefined', () => {
		const body = buildFeedbackBody(mkPayload({ order_permlink: undefined }));
		expect('order_permlink' in body).toBe(false);
	});
});

// ─── buildFeedbackResponseBody ──────────────────────────────────

describe('buildFeedbackResponseBody — redaction chokepoint', () => {
	function mkPayload(overrides: Partial<FeedbackResponsePayload> = {}): FeedbackResponsePayload {
		return {
			feedback_trx_id: 'a'.repeat(40),
			comment: 'Thanks for the honest review.',
			...overrides
		};
	}

	it('passes through a clean payload unchanged', () => {
		const body = buildFeedbackResponseBody(mkPayload());
		expect(body).toEqual({
			feedback_trx_id: 'a'.repeat(40),
			comment: 'Thanks for the honest review.'
		});
	});

	it('redacts a WIF in the comment field', () => {
		const body = buildFeedbackResponseBody(
			mkPayload({ comment: `About that key: ${FAKE_WIF} — dont paste keys` })
		);
		expect(body.comment).toContain(TRUNCATED_WIF);
		expect(body.comment).not.toContain(FAKE_WIF);
		assertNoRawKeyAnywhere(body);
	});

	it('redacts a BIP-39 mnemonic', () => {
		const body = buildFeedbackResponseBody(mkPayload({ comment: FAKE_MNEMONIC }));
		expect(body.comment).not.toContain(FAKE_MNEMONIC);
		assertNoRawKeyAnywhere(body);
	});

	it('preserves feedback_trx_id verbatim (not free-text, not redacted)', () => {
		// trx_id is a 40-char hex string from the chain. It isn't
		// free-text and shouldn't be redacted — but also couldn't
		// match the WIF detector's Base58 alphabet shape.
		const body = buildFeedbackResponseBody(mkPayload({ feedback_trx_id: 'deadbeef'.repeat(5) }));
		expect(body.feedback_trx_id).toBe('deadbeef'.repeat(5));
	});
});

// ─── buildProfileBody ───────────────────────────────────────────

describe('buildProfileBody — redaction chokepoint', () => {
	const FIXED_TS = 1_700_000_000;

	function mkPayload(overrides: Partial<ProfilePayload> = {}): ProfilePayload {
		return {
			display_name: 'Alice',
			...overrides
		};
	}

	it('passes through a clean minimal payload', () => {
		const body = buildProfileBody(mkPayload(), FIXED_TS);
		expect(body).toEqual({
			v: 1,
			display_name: 'Alice',
			ts: FIXED_TS
		});
		expect('json_metadata' in body).toBe(false);
	});

	it('uses the caller-supplied timestamp verbatim', () => {
		const body = buildProfileBody(mkPayload(), 42);
		expect(body.ts).toBe(42);
	});

	it('redacts a WIF in display_name', () => {
		const body = buildProfileBody(mkPayload({ display_name: `Alice ${FAKE_WIF}` }), FIXED_TS);
		expect(body.display_name).toContain(TRUNCATED_WIF);
		expect(body.display_name).not.toContain(FAKE_WIF);
		assertNoRawKeyAnywhere(body);
	});

	it('redacts a WIF in nostr_url (nested in json_metadata)', () => {
		const body = buildProfileBody(
			mkPayload({ nostr_url: `https://example.com/${FAKE_WIF}` }),
			FIXED_TS
		);
		expect(body.json_metadata).toBeDefined();
		const meta = body.json_metadata as Record<string, unknown>;
		expect(meta.nostr_url).not.toContain(FAKE_WIF);
		expect(meta.nostr_url).toContain(TRUNCATED_WIF);
		assertNoRawKeyAnywhere(body);
	});

	it('redacts a WIF in blurt_media_url', () => {
		const body = buildProfileBody(
			mkPayload({ blurt_media_url: `https://blurt.media/${FAKE_WIF}` }),
			FIXED_TS
		);
		const meta = body.json_metadata as Record<string, unknown>;
		expect(meta.blurt_media_url).not.toContain(FAKE_WIF);
		assertNoRawKeyAnywhere(body);
	});

	it('redacts a WIF accidentally embedded in an SVG text node (avatar_svg)', () => {
		// Very unusual but the chokepoint discipline runs redaction
		// on avatar_svg anyway. A WIF in an SVG <text> element
		// survives the sanitizer (text content is user data) —
		// this is the last-line-of-defense catch.
		const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text>${FAKE_WIF}</text></svg>`;
		const body = buildProfileBody(mkPayload({ avatar_svg: svg }), FIXED_TS);
		const meta = body.json_metadata as Record<string, unknown>;
		expect(meta.avatar_svg).not.toContain(FAKE_WIF);
		assertNoRawKeyAnywhere(body);
	});

	it('preserves empty avatar_svg as the explicit-clear signal', () => {
		// Empty string is a deliberate "clear my avatar" signal per
		// the profile op's contract. redactPrivateKeys on empty
		// string returns empty string, so this round-trips clean.
		const body = buildProfileBody(mkPayload({ avatar_svg: '' }), FIXED_TS);
		const meta = body.json_metadata as Record<string, unknown>;
		expect(meta.avatar_svg).toBe('');
	});

	it('omits nostr_url when absent or whitespace-only', () => {
		const body1 = buildProfileBody(mkPayload({ nostr_url: '' }), FIXED_TS);
		expect(body1.json_metadata).toBeUndefined();
		const body2 = buildProfileBody(mkPayload({ nostr_url: '   ' }), FIXED_TS);
		expect(body2.json_metadata).toBeUndefined();
	});

	it('trims whitespace around nostr_url / blurt_media_url before redacting', () => {
		const body = buildProfileBody(
			mkPayload({ nostr_url: '  https://iris.to/npub1xyz  ' }),
			FIXED_TS
		);
		const meta = body.json_metadata as Record<string, unknown>;
		expect(meta.nostr_url).toBe('https://iris.to/npub1xyz');
	});
});

// ─── buildOperatorRegisterBody ──────────────────────────────────

describe('buildOperatorRegisterBody — redaction chokepoint', () => {
	const FIXED_TS = 1_700_000_000;

	function mkPayload(overrides: Partial<OperatorRegisterPayload> = {}): OperatorRegisterPayload {
		return {
			tag: 'my-op',
			display_name: 'My Operator',
			...overrides
		};
	}

	it('passes through a clean payload', () => {
		const body = buildOperatorRegisterBody(mkPayload(), FIXED_TS);
		expect(body).toEqual({
			v: 1,
			tag: 'my-op',
			display_name: 'My Operator',
			ts: FIXED_TS
		});
		expect('contact_url' in body).toBe(false);
	});

	it('uses the caller-supplied timestamp verbatim', () => {
		const body = buildOperatorRegisterBody(mkPayload(), 42);
		expect(body.ts).toBe(42);
	});

	it('redacts a WIF in display_name', () => {
		const body = buildOperatorRegisterBody(
			mkPayload({ display_name: `Shady ${FAKE_WIF}` }),
			FIXED_TS
		);
		expect(body.display_name).not.toContain(FAKE_WIF);
		assertNoRawKeyAnywhere(body);
	});

	it('redacts a WIF in contact_url', () => {
		const body = buildOperatorRegisterBody(
			mkPayload({ contact_url: `https://example.com/${FAKE_WIF}` }),
			FIXED_TS
		);
		expect(body.contact_url).not.toContain(FAKE_WIF);
		assertNoRawKeyAnywhere(body);
	});

	it('trims whitespace on display_name and contact_url', () => {
		const body = buildOperatorRegisterBody(
			mkPayload({
				display_name: '  Alice  ',
				contact_url: '  https://example.com  '
			}),
			FIXED_TS
		);
		expect(body.display_name).toBe('Alice');
		expect(body.contact_url).toBe('https://example.com');
	});

	it('omits contact_url when empty or whitespace-only', () => {
		const body1 = buildOperatorRegisterBody(mkPayload({ contact_url: '' }), FIXED_TS);
		expect('contact_url' in body1).toBe(false);
		const body2 = buildOperatorRegisterBody(mkPayload({ contact_url: '   ' }), FIXED_TS);
		expect('contact_url' in body2).toBe(false);
	});

	it('preserves tag verbatim (validated, not redacted)', () => {
		// tag has its own regex validator at the broadcast layer;
		// the builder isn't responsible for it. Just verify the
		// value round-trips without modification.
		const body = buildOperatorRegisterBody(mkPayload({ tag: 'another-tag' }), FIXED_TS);
		expect(body.tag).toBe('another-tag');
	});
});

// ─── buildCommentOperation ──────────────────────────────────────

describe('buildCommentOperation — redaction chokepoint', () => {
	function mkPayload(overrides: Partial<CommentPayload> = {}): CommentPayload {
		return {
			permlink: 'morphit-announce-test',
			primaryTag: 'morphit',
			tags: ['morphit'],
			title: 'New order',
			body: 'Hello world',
			...overrides
		};
	}

	it('returns a well-formed [comment, fields] tuple', () => {
		const op = buildCommentOperation(mkPayload(), 'alice');
		expect(op[0]).toBe('comment');
		expect(op[1]).toMatchObject({
			parent_author: '',
			parent_permlink: 'morphit',
			author: 'alice',
			permlink: 'morphit-announce-test',
			title: 'New order',
			body: 'Hello world'
		});
	});

	it('uses the caller-supplied account as author', () => {
		const op = buildCommentOperation(mkPayload(), 'bob');
		expect(op[1].author).toBe('bob');
	});

	it('redacts a WIF in title', () => {
		const op = buildCommentOperation(mkPayload({ title: `Leak: ${FAKE_WIF}` }), 'alice');
		expect(op[1].title).not.toContain(FAKE_WIF);
		assertNoRawKeyAnywhere(op);
	});

	it('redacts a WIF in body', () => {
		const op = buildCommentOperation(mkPayload({ body: `About my key: ${FAKE_WIF}` }), 'alice');
		expect(op[1].body).not.toContain(FAKE_WIF);
		assertNoRawKeyAnywhere(op);
	});

	it('redacts a BIP-39 mnemonic in body', () => {
		const op = buildCommentOperation(
			mkPayload({ body: `Recovery phrase: ${FAKE_MNEMONIC}` }),
			'alice'
		);
		expect(op[1].body).not.toContain(FAKE_MNEMONIC);
		assertNoRawKeyAnywhere(op);
	});

	it('serializes json_metadata as a string', () => {
		// The Blurt comment op requires json_metadata to be a
		// JSON-encoded STRING (not a plain object) — builder
		// handles that serialization.
		const op = buildCommentOperation(mkPayload({ tags: ['morphit', 'announcement'] }), 'alice');
		expect(typeof op[1].json_metadata).toBe('string');
		const meta = JSON.parse(op[1].json_metadata as string);
		expect(meta.tags).toEqual(['morphit', 'announcement']);
		expect(meta.app).toBeDefined();
		expect(meta.format).toBe('markdown');
	});

	it('merges extraMetadata into json_metadata', () => {
		const op = buildCommentOperation(
			mkPayload({ extraMetadata: { image: ['https://example.com/x.png'] } }),
			'alice'
		);
		const meta = JSON.parse(op[1].json_metadata as string);
		expect(meta.image).toEqual(['https://example.com/x.png']);
	});
});
