/**
 * Block handler — tsx smoke runner.
 *
 * Executes the core block-handler scenarios without vitest. Same
 * style as apps/relay/scripts/drain-defense-live-fire.ts — a
 * sanity check that the handler logic actually runs correctly
 * end-to-end, not just that it typechecks.
 *
 * Usage (from apps/indexer):
 *   tsx scripts/block-handler-smoke.ts
 */

import handler from '../src/indexer/handlers/block.ts';
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

console.log('\n── Block handler ────────────────────────────────────');

await scenario('rejects non-object payload', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({ signer: 'alice', payload: 'not an object' as unknown }),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'payload_not_object' }, 'result');
});

await scenario('rejects invalid blocked account name', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({ signer: 'alice', payload: { blocked: 'X', action: 'block' } }),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'blocked_invalid' }, 'result');
});

await scenario('rejects self-block', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { blocked: 'alice', action: 'block' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'self_block' }, 'result');
});

await scenario('rejects invalid action', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({ signer: 'alice', payload: { blocked: 'bob', action: 'delete' } }),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'action_invalid' }, 'result');
});

await scenario('fresh block: inserts row', async () => {
	const mock = makeMockClient([
		{ match: 'SELECT state FROM blocks', rows: [] },
		{ match: 'INSERT INTO blocks' }
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { blocked: 'bob', action: 'block' },
			blockNum: 12345
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
	if (mock.queries.length !== 2) {
		throw new Error(`expected 2 queries, got ${mock.queries.length}`);
	}
	const insert = mock.queries[1]!;
	if (!insert.text.includes("'blocked'")) {
		throw new Error(`INSERT missing 'blocked' state literal: ${insert.text}`);
	}
	if (!insert.params.includes(12345)) {
		throw new Error(`INSERT missing blockNum param: ${JSON.stringify(insert.params)}`);
	}
});

await scenario('fresh unblock: rejects with no_prior_block', async () => {
	const mock = makeMockClient([{ match: 'SELECT state FROM blocks', rows: [] }]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { blocked: 'bob', action: 'unblock' }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'no_prior_block' }, 'result');
	if (mock.queries.length !== 1) {
		throw new Error(`expected only SELECT, got ${mock.queries.length} queries`);
	}
});

await scenario('re-block while blocked: idempotent no-op', async () => {
	const mock = makeMockClient([
		{ match: 'SELECT state FROM blocks', rows: [{ state: 'blocked' }] }
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { blocked: 'bob', action: 'block' }
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
	if (mock.queries.length !== 1) {
		throw new Error(`expected only SELECT on no-op, got ${mock.queries.length}`);
	}
});

await scenario('re-unblock while unblocked: idempotent no-op', async () => {
	const mock = makeMockClient([
		{ match: 'SELECT state FROM blocks', rows: [{ state: 'unblocked' }] }
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { blocked: 'bob', action: 'unblock' }
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
	if (mock.queries.length !== 1) {
		throw new Error(`expected only SELECT on no-op, got ${mock.queries.length}`);
	}
});

await scenario('block-after-unblock: rewinds since_*', async () => {
	const mock = makeMockClient([
		{ match: 'SELECT state FROM blocks', rows: [{ state: 'unblocked' }] },
		{ match: 'UPDATE blocks' }
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { blocked: 'bob', action: 'block' },
			blockNum: 67890
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
	const update = mock.queries[1]!;
	if (!update.text.includes("state = 'blocked'")) {
		throw new Error(`UPDATE should set state to blocked: ${update.text}`);
	}
	if (!update.text.includes('since_block_num')) {
		throw new Error(`UPDATE should rewind since_block_num: ${update.text}`);
	}
	if (!update.params.includes(67890)) {
		throw new Error(`UPDATE should carry the new blockNum`);
	}
});

await scenario('unblock-after-block: flips state, preserves since_*', async () => {
	const mock = makeMockClient([
		{ match: 'SELECT state FROM blocks', rows: [{ state: 'blocked' }] },
		{ match: 'UPDATE blocks' }
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { blocked: 'bob', action: 'unblock' },
			blockNum: 67890
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
	const update = mock.queries[1]!;
	if (!update.text.includes("state = 'unblocked'")) {
		throw new Error(`UPDATE should set state to unblocked: ${update.text}`);
	}
	if (update.text.includes('since_block_num =')) {
		throw new Error(`UPDATE must NOT move since_block_num on unblock: ${update.text}`);
	}
	if (!update.text.includes('last_action_block_num')) {
		throw new Error(`UPDATE should move last_action_block_num: ${update.text}`);
	}
});

await scenario('accepts account with dots and hyphens', async () => {
	const mock = makeMockClient([
		{ match: 'SELECT state FROM blocks', rows: [] },
		{ match: 'INSERT INTO blocks' }
	]);
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: { blocked: 'bob.v-2', action: 'block' }
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
