/**
 * Operator-register handler — tsx smoke runner.
 *
 * Exercises the morphit_operator_register_v1 op handler with a
 * mock pg client.  Covers:
 *  - Payload shape rejections
 *  - Tag validation
 *  - Display name validation (including post-O1.1 rules: NFC,
 *    leading-@, homograph)
 *  - Contact URL validation (including post-O1.2: https-only,
 *    no userinfo)
 *  - Happy path (insert + audit row)
 *  - Idempotency (already-registered account)
 *  - Tag race (UNIQUE conflict)
 *
 * Same style as block-handler-smoke.ts and friends.  Loadable
 * without a real Postgres / node_modules.
 *
 * Usage (from apps/indexer):
 *   tsx scripts/operator-register-handler-smoke.ts
 */

import handler from '../src/indexer/handlers/operatorRegister.ts';
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

console.log('\n── Operator-register handler ─────────────────────────');

// ─── Payload shape ───────────────────────────────────────────────

await scenario('rejects non-object payload', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({ signer: 'alice', payload: 'not an object' as unknown }),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'payload_not_object' }, 'result');
});

await scenario('rejects array payload', async () => {
	const mock = makeMockClient();
	const r = await handler(makeCtx({ signer: 'alice', payload: ['array'] as unknown }), mock.client);
	assertEqual(r, { ok: false, reason: 'payload_not_object' }, 'result');
});

// ─── Tag validation ──────────────────────────────────────────────

await scenario('rejects non-string tag', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 123, display_name: 'Alice' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'tag_not_string' }, 'result');
});

await scenario('rejects empty tag', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: '', display_name: 'Alice' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'tag_too_short' }, 'result');
});

await scenario('rejects tag > 64 chars', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'a'.repeat(65), display_name: 'Alice' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'tag_too_long' }, 'result');
});

await scenario('rejects tag with uppercase', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'AcmeNode', display_name: 'Alice' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'tag_invalid_chars' }, 'result');
});

await scenario('rejects tag with whitespace', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'acme node', display_name: 'Alice' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'tag_invalid_chars' }, 'result');
});

await scenario('P6-3: rejects reserved tag "morphit"', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'morphit', display_name: 'Alice' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'tag_reserved' }, 'result');
});

await scenario('P6-3: rejects reserved tag "morphit-fees"', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'morphit-fees', display_name: 'Alice' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'tag_reserved' }, 'result');
});

await scenario('P6-3: rejects reserved tag "agorise"', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'agorise', display_name: 'Alice' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'tag_reserved' }, 'result');
});

await scenario('P6-3: accepts non-reserved tag containing "morphit"', async () => {
	const mock = makeMockClient([
		{ match: 'SELECT account FROM operators', rows: [] },
		{ match: 'INSERT INTO operators', rows: [{ account: 'alice' }], rowCount: 1 },
		{ match: 'INSERT INTO operator_registration_events', rowCount: 1 }
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'mymorphit', display_name: 'Alice' }
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
});

await scenario('accepts tag with allowed characters', async () => {
	const mock = makeMockClient([
		{ match: 'SELECT account FROM operators', rows: [] },
		{ match: 'INSERT INTO operators', rows: [{ account: 'alice' }], rowCount: 1 },
		{ match: 'INSERT INTO operator_registration_events', rowCount: 1 }
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'acme-node.v2_3', display_name: 'Alice' }
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
});

// ─── Display name validation (O1.1) ──────────────────────────────

await scenario('rejects non-string display_name', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'acme', display_name: 42 }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'display_name_not_string' }, 'result');
});

await scenario('rejects empty display_name', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'acme', display_name: '   ' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'display_name_too_short' }, 'result');
});

await scenario('rejects display_name > 64 codepoints', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'acme', display_name: 'a'.repeat(65) }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'display_name_too_long' }, 'result');
});

await scenario('rejects display_name with control chars', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'acme', display_name: 'Alice\u0007' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'display_name_forbidden_char' }, 'result');
});

await scenario('rejects display_name with bidi override', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'acme', display_name: 'Al\u202Eice' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'display_name_forbidden_char' }, 'result');
});

// O1.1 — leading @ rejection (ASCII)
await scenario('O1.1: rejects display_name starting with @', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'acme', display_name: '@morphit-fees' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'display_name_leading_at' }, 'result');
});

// O1.1 — leading @ rejection (fullwidth)
await scenario('O1.1: rejects display_name starting with fullwidth ＠', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'acme', display_name: '\uFF20morphit-fees' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'display_name_leading_at' }, 'result');
});

// O1.1 — homograph confusable
await scenario('O1.1: rejects display_name impersonating reserved name', async () => {
	const mock = makeMockClient();
	// Cyrillic 'е' (U+0435) for Latin 'e' in "morphit-fees"
	const homograph = 'morphit-f\u0435\u0435s';
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'acme', display_name: homograph }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'display_name_impersonates_reserved' }, 'result');
});

// O1.1 — NFC normalization happens (codepoint-count is post-NFC)
await scenario('O1.1: NFC-normalizes display_name before length check', async () => {
	const mock = makeMockClient([
		{ match: 'SELECT account FROM operators', rows: [] },
		{ match: 'INSERT INTO operators', rows: [{ account: 'alice' }], rowCount: 1 },
		{ match: 'INSERT INTO operator_registration_events', rowCount: 1 }
	]);
	// Decomposed é (e + combining acute) — pre-NFC this is 2
	// codepoints, post-NFC it's 1.  A name that fits the limit
	// only after NFC should pass.
	const decomposed = 'e\u0301'.repeat(64); // 128 codepoints decomposed, 64 NFC
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'acme', display_name: decomposed }
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
});

// ─── Contact URL validation (O1.2) ───────────────────────────────

await scenario('contact_url is optional (omitted is OK)', async () => {
	const mock = makeMockClient([
		{ match: 'SELECT account FROM operators', rows: [] },
		{ match: 'INSERT INTO operators', rows: [{ account: 'alice' }], rowCount: 1 },
		{ match: 'INSERT INTO operator_registration_events', rowCount: 1 }
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'acme', display_name: 'Alice' }
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
});

await scenario('rejects non-string contact_url', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'acme', display_name: 'Alice', contact_url: 12345 }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'contact_url_not_string' }, 'result');
});

await scenario('rejects contact_url > 2048 chars', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: {
				tag: 'acme',
				display_name: 'Alice',
				contact_url: 'https://example.com/' + 'a'.repeat(2050)
			}
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'contact_url_too_long' }, 'result');
});

// O1.2 — http rejected
await scenario('O1.2: rejects http:// contact_url (https-only)', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: {
				tag: 'acme',
				display_name: 'Alice',
				contact_url: 'http://example.com/contact'
			}
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'contact_url_bad_scheme' }, 'result');
});

await scenario('rejects javascript: contact_url', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: {
				tag: 'acme',
				display_name: 'Alice',
				contact_url: 'javascript:alert(1)'
			}
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'contact_url_bad_scheme' }, 'result');
});

// O1.2 — userinfo rejected
await scenario('O1.2: rejects contact_url with userinfo', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: {
				tag: 'acme',
				display_name: 'Alice',
				contact_url: 'https://user:pw@example.com/'
			}
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'contact_url_has_userinfo' }, 'result');
});

await scenario('accepts well-formed https contact_url', async () => {
	const mock = makeMockClient([
		{ match: 'SELECT account FROM operators', rows: [] },
		{ match: 'INSERT INTO operators', rows: [{ account: 'alice' }], rowCount: 1 },
		{ match: 'INSERT INTO operator_registration_events', rowCount: 1 }
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: {
				tag: 'acme',
				display_name: 'Alice',
				contact_url: 'https://example.com/about'
			}
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
});

await scenario('treats empty contact_url as omitted', async () => {
	const mock = makeMockClient([
		{ match: 'SELECT account FROM operators', rows: [] },
		{ match: 'INSERT INTO operators', rows: [{ account: 'alice' }], rowCount: 1 },
		{ match: 'INSERT INTO operator_registration_events', rowCount: 1 }
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'acme', display_name: 'Alice', contact_url: '' }
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
});

// ─── Idempotency / race conditions ───────────────────────────────

await scenario('rejects when account is already registered', async () => {
	const mock = makeMockClient([
		// Existing-account check returns a row.
		{
			match: 'SELECT account FROM operators',
			rows: [{ account: 'alice' }],
			rowCount: 1
		}
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'acme', display_name: 'Alice' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'account_already_registered' }, 'result');
});

await scenario('rejects when tag is already claimed by another account', async () => {
	const mock = makeMockClient([
		// This account hasn't registered yet.
		{ match: 'SELECT account FROM operators', rows: [] },
		// But the tag UNIQUE constraint fires (rowCount=0 from
		// ON CONFLICT DO NOTHING).
		{ match: 'INSERT INTO operators', rows: [], rowCount: 0 }
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'taken-tag', display_name: 'Alice' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'tag_already_claimed' }, 'result');
});

// ─── Origin field (Phase D.5) ────────────────────────────────────

await scenario('Phase D.5: happy path with origin populates known_instances', async () => {
	const mock = makeMockClient([
		{ match: 'SELECT account FROM operators', rows: [] },
		{ match: 'INSERT INTO operators', rows: [{ account: 'alice' }], rowCount: 1 },
		{ match: 'INSERT INTO known_instances', rowCount: 1 },
		{ match: 'INSERT INTO operator_registration_events', rowCount: 1 }
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: {
				tag: 'alice',
				display_name: 'Alice in Berlin',
				origin: 'https://alice-morphit.example'
			}
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
});

await scenario('Phase D.5: happy path WITHOUT origin skips known_instances insert', async () => {
	// The known_instances INSERT is conditional on origin being
	// present.  If the test is correctly NOT inserting, the mock
	// only needs to expect operators + events (no known_instances).
	const mock = makeMockClient([
		{ match: 'SELECT account FROM operators', rows: [] },
		{ match: 'INSERT INTO operators', rows: [{ account: 'alice' }], rowCount: 1 },
		{ match: 'INSERT INTO operator_registration_events', rowCount: 1 }
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'alice', display_name: 'Alice in Berlin' }
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
});

await scenario('Phase D.5: empty-string origin treated as omitted', async () => {
	// No known_instances insert expected — empty string means
	// "operator is not federation-publishing yet."
	const mock = makeMockClient([
		{ match: 'SELECT account FROM operators', rows: [] },
		{ match: 'INSERT INTO operators', rows: [{ account: 'alice' }], rowCount: 1 },
		{ match: 'INSERT INTO operator_registration_events', rowCount: 1 }
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'alice', display_name: 'Alice', origin: '' }
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
});

await scenario('Phase D.5: rejects non-string origin', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { tag: 'alice', display_name: 'Alice', origin: 12345 }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'origin_not_string' }, 'result');
});

await scenario('Phase D.5: rejects origin > 2048 chars', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: {
				tag: 'alice',
				display_name: 'Alice',
				origin: 'https://example.com/' + 'a'.repeat(2050)
			}
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'origin_too_long' }, 'result');
});

await scenario('Phase D.5: rejects malformed origin', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: {
				tag: 'alice',
				display_name: 'Alice',
				origin: 'not a url at all'
			}
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'origin_not_url' }, 'result');
});

await scenario('Phase D.5: rejects http:// origin (https-only)', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: {
				tag: 'alice',
				display_name: 'Alice',
				origin: 'http://example.com'
			}
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'origin_bad_scheme' }, 'result');
});

await scenario('Phase D.5: rejects javascript: origin', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: {
				tag: 'alice',
				display_name: 'Alice',
				origin: 'javascript:alert(1)'
			}
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'origin_bad_scheme' }, 'result');
});

await scenario('Phase D.5: rejects origin with userinfo', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: {
				tag: 'alice',
				display_name: 'Alice',
				origin: 'https://user:pw@example.com'
			}
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'origin_has_userinfo' }, 'result');
});

await scenario('Phase D.5: rejects origin with path', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: {
				tag: 'alice',
				display_name: 'Alice',
				origin: 'https://example.com/morphit'
			}
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'origin_has_path' }, 'result');
});

await scenario('Phase D.5: rejects origin with query', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: {
				tag: 'alice',
				display_name: 'Alice',
				origin: 'https://example.com?id=42'
			}
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'origin_has_query' }, 'result');
});

await scenario('Phase D.5: rejects origin with fragment', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: {
				tag: 'alice',
				display_name: 'Alice',
				origin: 'https://example.com#section'
			}
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'origin_has_fragment' }, 'result');
});

await scenario('Phase D.5: accepts origin with custom port', async () => {
	const mock = makeMockClient([
		{ match: 'SELECT account FROM operators', rows: [] },
		{ match: 'INSERT INTO operators', rows: [{ account: 'alice' }], rowCount: 1 },
		{ match: 'INSERT INTO known_instances', rowCount: 1 },
		{ match: 'INSERT INTO operator_registration_events', rowCount: 1 }
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: {
				tag: 'alice',
				display_name: 'Alice',
				origin: 'https://alice.example:8443'
			}
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
});

await scenario('Phase D.5: accepts origin with trailing slash (normalized)', async () => {
	// URL parser sees "https://alice.example/" — pathname='/'.
	// Our validator allows pathname='' or '/' (no further path).
	const mock = makeMockClient([
		{ match: 'SELECT account FROM operators', rows: [] },
		{ match: 'INSERT INTO operators', rows: [{ account: 'alice' }], rowCount: 1 },
		{ match: 'INSERT INTO known_instances', rowCount: 1 },
		{ match: 'INSERT INTO operator_registration_events', rowCount: 1 }
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: {
				tag: 'alice',
				display_name: 'Alice',
				origin: 'https://alice.example/'
			}
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
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
