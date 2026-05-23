/**
 * Operator-payment-method handler — tsx smoke runner.
 *
 * Mirrors operator-block-handler-smoke: exercises gating,
 * payload validation, key-collision protection, length caps,
 * sanitization, and state transitions without spinning up a
 * real Postgres.
 */

import handler from '../src/indexer/handlers/operatorPaymentMethod.ts';
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

const validAdd = {
	v: 1,
	action: 'add',
	key: 'promptpay',
	name: 'PromptPay',
	description: 'Thai instant retail payments using mobile or NID lookup.',
	category: 'online',
	url: 'https://www.bot.or.th/en/our-roles/payment-systems/PromptPay.html',
	ts: 1
};

console.log('\n── Operator-payment-method handler ───────────────────────');

// ─── Gate ──────────────────────────────────────────────────────

await scenario('rejects non-operator signer', async () => {
	const mock = makeMockClient();
	const r = await handler(makeCtx({ signer: 'alice', payload: validAdd }), mock.client);
	assertEqual(r, { ok: false, reason: 'not_operator' }, 'result');
	if (mock.queries.length !== 0) throw new Error('queries leaked');
});

// ─── Payload-shape validation ───────────────────────────────────

await scenario('rejects non-object payload', async () => {
	const mock = makeMockClient();
	const r = await handler(makeCtx({ signer: 'morphit', payload: null }), mock.client);
	assertEqual(r, { ok: false, reason: 'payload_not_object' }, 'result');
});

await scenario('rejects unsupported version', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({ signer: 'morphit', payload: { ...validAdd, v: 2 } }),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'unsupported_version' }, 'result');
});

await scenario('rejects invalid action', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({ signer: 'morphit', payload: { ...validAdd, action: 'destroy' } }),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'action_invalid' }, 'result');
});

// ─── Key validation ─────────────────────────────────────────────

await scenario('rejects malformed key (uppercase)', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({ signer: 'morphit', payload: { ...validAdd, key: 'PromptPay' } }),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'key_invalid' }, 'result');
});

await scenario('rejects key starting with digit', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({ signer: 'morphit', payload: { ...validAdd, key: '1pay' } }),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'key_invalid' }, 'result');
});

await scenario('rejects key with hyphen', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({ signer: 'morphit', payload: { ...validAdd, key: 'pay-pal' } }),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'key_invalid' }, 'result');
});

await scenario('rejects key too short', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({ signer: 'morphit', payload: { ...validAdd, key: 'pp' } }),
		mock.client
	);
	// 'pp' (2 chars) fails the regex (which requires 2+ after the
	// leading letter, so 'pp' = 1 char after letter = invalid).
	// Actual reason is key_invalid because the regex catches it.
	if (r.ok || (r.reason !== 'key_invalid' && r.reason !== 'key_length_invalid')) {
		throw new Error(`expected key_invalid|key_length_invalid, got ${JSON.stringify(r)}`);
	}
});

await scenario('rejects key too long (>24 chars)', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'morphit',
			payload: { ...validAdd, key: 'a'.repeat(25) }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'key_length_invalid' }, 'result');
});

// ─── Reserved-key gate (the critical security test) ─────────────

await scenario('rejects reserved canonical key (paypal)', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({ signer: 'morphit', payload: { ...validAdd, key: 'paypal' } }),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'key_reserved' }, 'result');
	// Critically, no DB writes should have occurred.
	if (mock.queries.length !== 0) {
		throw new Error('queries leaked on reserved-key reject');
	}
});

await scenario('rejects reserved canonical key (zelle)', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({ signer: 'morphit', payload: { ...validAdd, key: 'zelle' } }),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'key_reserved' }, 'result');
});

await scenario('rejects reserved canonical key (cash_in_person)', async () => {
	// cp120: 'cash' was split into 'cash_in_person' + 'cash_by_mail'.
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({ signer: 'morphit', payload: { ...validAdd, key: 'cash_in_person' } }),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'key_reserved' }, 'result');
});

await scenario('rejects reserved canonical key (cash_by_mail)', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({ signer: 'morphit', payload: { ...validAdd, key: 'cash_by_mail' } }),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'key_reserved' }, 'result');
});

// ─── Field-shape validation ─────────────────────────────────────

await scenario('rejects missing name', async () => {
	const mock = makeMockClient();
	const { name: _name, ...rest } = validAdd;
	const r = await handler(makeCtx({ signer: 'morphit', payload: rest }), mock.client);
	assertEqual(r, { ok: false, reason: 'name_invalid' }, 'result');
});

await scenario('rejects empty name', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({ signer: 'morphit', payload: { ...validAdd, name: '' } }),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'name_invalid' }, 'result');
});

await scenario('rejects name too long (>64 chars)', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'morphit',
			payload: { ...validAdd, name: 'A'.repeat(65) }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'name_too_long' }, 'result');
});

await scenario('rejects description too long (>300 chars)', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'morphit',
			payload: { ...validAdd, description: 'x'.repeat(301) }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'description_too_long' }, 'result');
});

await scenario('rejects invalid category', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({ signer: 'morphit', payload: { ...validAdd, category: 'invalid' } }),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'category_invalid' }, 'result');
});

await scenario('rejects http (non-https) URL', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'morphit',
			payload: { ...validAdd, url: 'http://example.com' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'url_must_be_https' }, 'result');
});

await scenario('rejects javascript: URL', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'morphit',
			payload: { ...validAdd, url: 'javascript:alert(1)' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'url_must_be_https' }, 'result');
});

await scenario('P6-13: rejects URL with userinfo (phishing pattern)', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'morphit',
			payload: { ...validAdd, url: 'https://attacker@victim.com/' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'url_has_userinfo' }, 'result');
});

await scenario('P6-13: rejects URL with user:password userinfo', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'morphit',
			payload: { ...validAdd, url: 'https://user:pw@victim.com/' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'url_has_userinfo' }, 'result');
});

await scenario('P6-13: rejects malformed URL', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'morphit',
			payload: { ...validAdd, url: 'https://' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'url_invalid' }, 'result');
});

await scenario('P6-13: accepts well-formed URL with path/query', async () => {
	const mock = makeMockClient([
		{ match: /SELECT state FROM instance_payment_methods/, rows: [] },
		{ match: /INSERT INTO instance_payment_methods/, rowCount: 1 }
	]);
	const r = await handler(
		makeCtx({
			signer: 'morphit',
			payload: { ...validAdd, url: 'https://example.com/path?ref=morphit' }
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
});

await scenario('accepts null url', async () => {
	const mock = makeMockClient([
		{ match: /SELECT state FROM instance_payment_methods/, rows: [] },
		{ match: /INSERT INTO instance_payment_methods/, rowCount: 1 }
	]);
	const r = await handler(
		makeCtx({ signer: 'morphit', payload: { ...validAdd, url: null } }),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
});

// ─── Sanitization ───────────────────────────────────────────────

await scenario('strips bidi-override codepoints from name', async () => {
	const mock = makeMockClient([
		{ match: /SELECT state FROM instance_payment_methods/, rows: [] },
		{ match: /INSERT INTO instance_payment_methods/, rowCount: 1 }
	]);
	// U+202E is RIGHT-TO-LEFT OVERRIDE — could reverse the
	// displayed name's apparent direction.
	const r = await handler(
		makeCtx({
			signer: 'morphit',
			payload: { ...validAdd, name: 'Pay\u202EPal' }
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
	const insert = mock.queries.find((q) => /INSERT/.test(q.text));
	if (!insert) throw new Error('no insert');
	// Third positional param is the name; should be stripped.
	const nameParam = insert.params[2];
	if (typeof nameParam !== 'string' || nameParam.includes('\u202E')) {
		throw new Error(`bidi not stripped: ${JSON.stringify(nameParam)}`);
	}
});

await scenario('strips zero-width chars from description', async () => {
	const mock = makeMockClient([
		{ match: /SELECT state FROM instance_payment_methods/, rows: [] },
		{ match: /INSERT INTO instance_payment_methods/, rowCount: 1 }
	]);
	const r = await handler(
		makeCtx({
			signer: 'morphit',
			payload: { ...validAdd, description: 'Thai\u200B retail payments' }
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
	const insert = mock.queries.find((q) => /INSERT/.test(q.text));
	const descParam = insert?.params[3];
	if (typeof descParam !== 'string' || descParam.includes('\u200B')) {
		throw new Error(`zero-width not stripped: ${JSON.stringify(descParam)}`);
	}
});

// ─── State transitions ─────────────────────────────────────────

await scenario('fresh add inserts new row', async () => {
	const mock = makeMockClient([
		{ match: /SELECT state FROM instance_payment_methods/, rows: [] },
		{ match: /INSERT INTO instance_payment_methods/, rowCount: 1 }
	]);
	const r = await handler(makeCtx({ signer: 'morphit', payload: validAdd }), mock.client);
	assertEqual(r, { ok: true }, 'result');
	if (mock.queries.length !== 2) throw new Error('expected 2 queries');
});

await scenario('re-add after removal flips state to active', async () => {
	const mock = makeMockClient([
		{
			match: /SELECT state FROM instance_payment_methods/,
			rows: [{ state: 'removed' }]
		},
		{ match: /UPDATE instance_payment_methods/, rowCount: 1 }
	]);
	const r = await handler(makeCtx({ signer: 'morphit', payload: validAdd }), mock.client);
	assertEqual(r, { ok: true }, 'result');
});

await scenario('add to existing active row updates metadata', async () => {
	const mock = makeMockClient([
		{
			match: /SELECT state FROM instance_payment_methods/,
			rows: [{ state: 'active' }]
		},
		{ match: /UPDATE instance_payment_methods/, rowCount: 1 }
	]);
	const r = await handler(makeCtx({ signer: 'morphit', payload: validAdd }), mock.client);
	assertEqual(r, { ok: true }, 'result');
});

await scenario('remove on existing active flips to removed', async () => {
	const mock = makeMockClient([
		{
			match: /SELECT state FROM instance_payment_methods/,
			rows: [{ state: 'active' }]
		},
		{ match: /UPDATE instance_payment_methods/, rowCount: 1 }
	]);
	const r = await handler(
		makeCtx({
			signer: 'morphit',
			payload: { v: 1, action: 'remove', key: 'promptpay', ts: 1 }
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
});

await scenario('remove on already-removed is idempotent', async () => {
	const mock = makeMockClient([
		{
			match: /SELECT state FROM instance_payment_methods/,
			rows: [{ state: 'removed' }]
		}
	]);
	const r = await handler(
		makeCtx({
			signer: 'morphit',
			payload: { v: 1, action: 'remove', key: 'promptpay', ts: 1 }
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
	// Only the SELECT should have run; no UPDATE on a no-op.
	if (mock.queries.length !== 1) {
		throw new Error(`expected 1 query, got ${mock.queries.length}`);
	}
});

await scenario('remove on never-existed returns no_prior_addition', async () => {
	const mock = makeMockClient([{ match: /SELECT state FROM instance_payment_methods/, rows: [] }]);
	const r = await handler(
		makeCtx({
			signer: 'morphit',
			payload: { v: 1, action: 'remove', key: 'unknown', ts: 1 }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'no_prior_addition' }, 'result');
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
