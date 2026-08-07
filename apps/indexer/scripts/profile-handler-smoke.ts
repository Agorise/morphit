/**
 * Profile handler — tsx smoke runner.
 *
 * Exercises the morphit_profile_v1 op handler with a mock pg
 * client.  Mirrors the vitest scenarios in
 * apps/indexer/test/handlers/profile.test.ts but runs in any
 * environment with tsx (no vitest required).  The vitest file
 * is canonical; this exists so audit verification can run in
 * sandboxes that lack vitest.
 *
 * Usage (from apps/indexer):
 *   tsx scripts/profile-handler-smoke.ts
 */

import handler from '../src/indexer/handlers/profile.ts';
import { makeCtx } from '../test/testutils/context.ts';
import { makeMockClient } from '../test/testutils/mockClient.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void | Promise<void>): Promise<void> {
	scenarios++;
	return Promise.resolve()
		.then(fn)
		.then(
			() => {
				console.log(`  ✓ ${name}`);
			},
			(err) => {
				failures++;
				console.log(`  ✗ ${name}`);
				console.log(`      ${err instanceof Error ? err.message : String(err)}`);
			}
		);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${label}: expected ${e}, got ${a}`);
	}
}

console.log('\n── Profile handler ────────────────────────────────────');

// ─── Payload shape ───────────────────────────────────────────────

await scenario('rejects non-object payload', async () => {
	const mock = makeMockClient();
	const r = await handler(makeCtx({ payload: 'not an object' as unknown }), mock.client);
	assertEqual(r, { ok: false, reason: 'payload_not_object' }, 'result');
});

await scenario('allows missing display_name (avatar/links-only profile)', async () => {
	const mock = makeMockClient([
		{ match: 'SELECT json_metadata' },
		{ match: 'INSERT INTO profiles' }
	]);
	const r = await handler(makeCtx({ payload: {} }), mock.client);
	assertEqual(r, { ok: true }, 'result');
});

await scenario('rejects a non-string display_name', async () => {
	const mock = makeMockClient();
	const r = await handler(makeCtx({ payload: { display_name: 42 } }), mock.client);
	assertEqual(r, { ok: false, reason: 'display_name_not_string' }, 'result');
});

await scenario('allows empty display_name (whitespace only → no name)', async () => {
	const mock = makeMockClient([
		{ match: 'SELECT json_metadata' },
		{ match: 'INSERT INTO profiles' }
	]);
	const r = await handler(makeCtx({ payload: { display_name: '   ' } }), mock.client);
	assertEqual(r, { ok: true }, 'result');
});

// ─── Length validation ───────────────────────────────────────────

await scenario('rejects display_name > 64 codepoints', async () => {
	const mock = makeMockClient();
	const r = await handler(makeCtx({ payload: { display_name: 'a'.repeat(65) } }), mock.client);
	assertEqual(r, { ok: false, reason: 'display_name_too_long' }, 'result');
});

await scenario('accepts 64 emoji (1 codepoint each)', async () => {
	const mock = makeMockClient([
		{ match: 'SELECT json_metadata' },
		{ match: 'INSERT INTO profiles' }
	]);
	const r = await handler(makeCtx({ payload: { display_name: '👋'.repeat(64) } }), mock.client);
	assertEqual(r, { ok: true }, 'result');
});

// ─── O3.1 — NFC normalization ────────────────────────────────────

await scenario('O3.1: NFC-normalizes before length check (decomposed → 64)', async () => {
	const mock = makeMockClient([
		{ match: 'SELECT json_metadata' },
		{ match: 'INSERT INTO profiles' }
	]);
	// 64 NFC chars decomposed = 128 codepoints, which would have
	// failed pre-O3.1 even though the user-perceived length is 64.
	const decomposed = 'e\u0301'.repeat(64);
	const r = await handler(makeCtx({ payload: { display_name: decomposed } }), mock.client);
	assertEqual(r, { ok: true }, 'result');
	const stored = mock.queries[1]!.params[1] as string;
	if ([...stored].length !== 64) {
		throw new Error(`stored codepoint count: expected 64, got ${[...stored].length}`);
	}
	if (stored !== 'é'.repeat(64)) {
		throw new Error('stored value not NFC-normalized');
	}
});

await scenario('O3.1: rejects NFD-decomposed homograph of reserved name', async () => {
	// "morphit-fées" with é written as e + combining acute.
	// Pre-O3.1, this slipped through impersonatesReservedName.
	const mock = makeMockClient();
	const decomposed = 'morphit-fe\u0301e\u0301s';
	const r = await handler(makeCtx({ payload: { display_name: decomposed } }), mock.client);
	assertEqual(r, { ok: false, reason: 'display_name_impersonates_reserved' }, 'result');
});

// ─── Leading-@ rejection ─────────────────────────────────────────

await scenario('rejects leading @ (ASCII)', async () => {
	const mock = makeMockClient();
	const r = await handler(makeCtx({ payload: { display_name: '@morphit-fees' } }), mock.client);
	assertEqual(r, { ok: false, reason: 'display_name_leading_at' }, 'result');
});

await scenario('rejects leading ＠ (fullwidth U+FF20)', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({ payload: { display_name: '\uFF20morphit-fees' } }),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'display_name_leading_at' }, 'result');
});

// ─── Direct homograph ────────────────────────────────────────────

await scenario('rejects Cyrillic homograph of morphit-fees', async () => {
	const mock = makeMockClient();
	const homograph = 'morphit-f\u0435\u0435s';
	const r = await handler(makeCtx({ payload: { display_name: homograph } }), mock.client);
	assertEqual(r, { ok: false, reason: 'display_name_impersonates_reserved' }, 'result');
});

// ─── Forbidden chars ─────────────────────────────────────────────

await scenario('rejects control character', async () => {
	const mock = makeMockClient();
	const r = await handler(makeCtx({ payload: { display_name: 'Alice\u0007Bob' } }), mock.client);
	assertEqual(r, { ok: false, reason: 'display_name_forbidden_char' }, 'result');
});

await scenario('rejects bidi override', async () => {
	const mock = makeMockClient();
	const r = await handler(makeCtx({ payload: { display_name: 'Al\u202Eice' } }), mock.client);
	assertEqual(r, { ok: false, reason: 'display_name_forbidden_char' }, 'result');
});

await scenario('rejects zero-width space (ZWSP still blocked)', async () => {
	const mock = makeMockClient();
	const r = await handler(makeCtx({ payload: { display_name: 'Al\u200Bice' } }), mock.client);
	assertEqual(r, { ok: false, reason: 'display_name_forbidden_char' }, 'result');
});

// cp671 — ZWNJ (U+200C) and ZWJ (U+200D) are NO LONGER forbidden: essential
// cursive joiners for Persian/Arabic-script + Indic text. A ZWNJ name must not
// be rejected as a forbidden char.
await scenario('accepts ZWNJ (Persian half-space) - not a forbidden char', async () => {
	const mock = makeMockClient();
	const r = await handler(makeCtx({ payload: { display_name: 'A\u200Cli\u200Cce' } }), mock.client);
	const isForbidden = typeof r === 'object' && r !== null && 'reason' in r && (r as { reason?: string }).reason === 'display_name_forbidden_char';
	assertEqual(isForbidden, false, 'ZWNJ name not rejected as forbidden_char');
});

// ─── json_metadata ───────────────────────────────────────────────

await scenario('rejects non-object json_metadata', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({ payload: { display_name: 'Carol', json_metadata: 'foo' } }),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'json_metadata_not_object' }, 'result');
});

await scenario('rejects json_metadata > 8KB serialized', async () => {
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
	assertEqual(r, { ok: false, reason: 'json_metadata_too_large' }, 'result');
});

// ─── Happy paths ─────────────────────────────────────────────────

await scenario('upserts a valid payload', async () => {
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
	assertEqual(r, { ok: true }, 'result');
});

await scenario('legitimate operator using their own reserved name passes', async () => {
	// Byte-equal match is the legitimate-operator escape from the
	// homograph regex — they own the reserved name and should be
	// able to use it.
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
	assertEqual(r, { ok: true }, 'result');
});

await scenario('accepts json_metadata with avatar fields', async () => {
	const mock = makeMockClient([
		{ match: 'SELECT json_metadata' },
		{ match: "json_metadata->>'avatar_data_uri'", rowCount: 0 },
		{ match: 'INSERT INTO profiles' }
	]);
	const r = await handler(
		makeCtx({
			payload: {
				display_name: 'Bob',
				json_metadata: {
					avatar_data_uri: 'data:image/webp;base64,UklGRg==',
					nostr_url: 'https://example.com/nostr'
				}
			}
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
});

// ─── Avatar uniqueness across users ──────────────────────────────

await scenario('avatar uniqueness: duplicate of another account reverts to prior', async () => {
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
	assertEqual(r, { ok: true }, 'result');
	const merged = JSON.parse(mock.queries[2]!.params[2] as string);
	assertEqual(merged.avatar_svg, '<svg>old</svg>', 'reverted to prior avatar');
});

await scenario('avatar uniqueness: duplicate with no prior avatar is dropped', async () => {
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
	assertEqual(r, { ok: true }, 'result');
	const merged = JSON.parse(mock.queries[2]!.params[2] as string);
	assertEqual('avatar_svg' in merged, false, 'duplicate avatar dropped');
});

await scenario('avatar uniqueness: re-uploading your own image is allowed', async () => {
	const mock = makeMockClient([
		{ match: 'SELECT json_metadata', rows: [{ json_metadata: {} }] },
		// account <> signer means the signer's own image never appears
		// here → rowCount 0 → accepted.
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
	assertEqual(r, { ok: true }, 'result');
	// The exclusion clause is what lets a user re-upload their own image.
	const probe = mock.queries[1]!;
	if (!probe.text.includes('account <> $1')) {
		throw new Error('uniqueness probe does not exclude the signer');
	}
	assertEqual(probe.params[0], 'kentest', 'probe signer param');
	assertEqual(probe.params[1], '<svg>mine</svg>', 'probe value param');
	const merged = JSON.parse(mock.queries[2]!.params[2] as string);
	assertEqual(merged.avatar_svg, '<svg>mine</svg>', 'own image kept');
});

// ─── Final summary ───────────────────────────────────────────────

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
