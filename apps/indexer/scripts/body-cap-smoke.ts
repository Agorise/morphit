/**
 * Morphit smoke — bodyCap middleware (NEW-9-9 hardening).
 *
 * Verifies that the indexer's bodyCap middleware:
 *   - allows GET requests with no Content-Length (pass-through)
 *   - allows body-bearing requests with Content-Length under cap
 *   - rejects body-bearing requests with Content-Length over cap (413)
 *   - rejects body-bearing requests with chunked transfer-encoding (411)
 *   - rejects malformed Content-Length (400)
 *   - allows body-bearing requests without Content-Length AND without
 *     Transfer-Encoding (the "no body" case)
 *
 * The middleware is a pure function over Hono's Context interface;
 * the smoke uses minimal stand-in objects to exercise its branches
 * without booting Hono.
 */

import { bodyCap } from '../src/api/middleware/bodyCap.ts';

let scenarios = 0;
let failures = 0;
function scenario(name: string, fn: () => Promise<void> | void): Promise<void> {
	scenarios++;
	return Promise.resolve()
		.then(fn)
		.then(() => {
			console.log(`  ✓ ${name}`);
		})
		.catch((err) => {
			failures++;
			console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
		});
}

console.log('\n── bodyCap middleware smoke ──────────────────────────────\n');

interface FakeContext {
	req: {
		method: string;
		header: (name: string) => string | undefined;
	};
	json: (body: unknown, status?: number) => { __body: unknown; __status: number };
}

function mkCtx(method: string, headers: Record<string, string | undefined>): FakeContext {
	return {
		req: {
			method,
			header: (name: string): string | undefined => headers[name.toLowerCase()]
		},
		json: (body: unknown, status?: number) => ({
			__body: body,
			__status: status ?? 200
		})
	};
}

const cap = 4096;
const middleware = bodyCap(cap);

await scenario('GET with no Content-Length passes through', async () => {
	const c = mkCtx('GET', {});
	let nextCalled = false;
	const result = await middleware(c as unknown as Parameters<typeof middleware>[0], async () => {
		nextCalled = true;
	});
	if (!nextCalled) throw new Error('next() was not called');
	if (result !== undefined) throw new Error('middleware returned a response');
});

await scenario('POST with Content-Length under cap passes through', async () => {
	const c = mkCtx('POST', { 'content-length': '1024' });
	let nextCalled = false;
	await middleware(c as unknown as Parameters<typeof middleware>[0], async () => {
		nextCalled = true;
	});
	if (!nextCalled) throw new Error('next() was not called');
});

await scenario('POST with Content-Length over cap rejects 413', async () => {
	const c = mkCtx('POST', { 'content-length': '99999' });
	let nextCalled = false;
	const result = (await middleware(c as unknown as Parameters<typeof middleware>[0], async () => {
		nextCalled = true;
	})) as unknown as { __status: number };
	if (nextCalled) throw new Error('next() should not have been called');
	if (result.__status !== 413) throw new Error(`expected 413, got ${result.__status}`);
});

await scenario('POST with Transfer-Encoding: chunked rejects 411', async () => {
	const c = mkCtx('POST', { 'transfer-encoding': 'chunked' });
	let nextCalled = false;
	const result = (await middleware(c as unknown as Parameters<typeof middleware>[0], async () => {
		nextCalled = true;
	})) as unknown as { __status: number };
	if (nextCalled) throw new Error('next() should not have been called');
	if (result.__status !== 411) throw new Error(`expected 411, got ${result.__status}`);
});

await scenario('PUT with Transfer-Encoding: chunked rejects 411', async () => {
	const c = mkCtx('PUT', { 'transfer-encoding': 'chunked' });
	let nextCalled = false;
	const result = (await middleware(c as unknown as Parameters<typeof middleware>[0], async () => {
		nextCalled = true;
	})) as unknown as { __status: number };
	if (nextCalled) throw new Error('next() should not have been called');
	if (result.__status !== 411) throw new Error(`expected 411, got ${result.__status}`);
});

await scenario('PATCH with Transfer-Encoding: chunked rejects 411', async () => {
	const c = mkCtx('PATCH', { 'transfer-encoding': 'chunked' });
	let nextCalled = false;
	const result = (await middleware(c as unknown as Parameters<typeof middleware>[0], async () => {
		nextCalled = true;
	})) as unknown as { __status: number };
	if (nextCalled) throw new Error('next() should not have been called');
	if (result.__status !== 411) throw new Error(`expected 411, got ${result.__status}`);
});

await scenario(
	'GET with Transfer-Encoding: chunked passes through (not body-bearing)',
	async () => {
		const c = mkCtx('GET', { 'transfer-encoding': 'chunked' });
		let nextCalled = false;
		await middleware(c as unknown as Parameters<typeof middleware>[0], async () => {
			nextCalled = true;
		});
		if (!nextCalled) throw new Error('next() should have been called');
	}
);

await scenario('POST with malformed Content-Length rejects 400', async () => {
	const c = mkCtx('POST', { 'content-length': 'abc' });
	let nextCalled = false;
	const result = (await middleware(c as unknown as Parameters<typeof middleware>[0], async () => {
		nextCalled = true;
	})) as unknown as { __status: number };
	if (nextCalled) throw new Error('next() should not have been called');
	if (result.__status !== 400) throw new Error(`expected 400, got ${result.__status}`);
});

await scenario('POST with negative Content-Length rejects 400', async () => {
	const c = mkCtx('POST', { 'content-length': '-1' });
	let nextCalled = false;
	const result = (await middleware(c as unknown as Parameters<typeof middleware>[0], async () => {
		nextCalled = true;
	})) as unknown as { __status: number };
	if (nextCalled) throw new Error('next() should not have been called');
	if (result.__status !== 400) throw new Error(`expected 400, got ${result.__status}`);
});

await scenario('POST with no Content-Length and no Transfer-Encoding passes through', async () => {
	const c = mkCtx('POST', {});
	let nextCalled = false;
	await middleware(c as unknown as Parameters<typeof middleware>[0], async () => {
		nextCalled = true;
	});
	if (!nextCalled) throw new Error('next() should have been called');
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
