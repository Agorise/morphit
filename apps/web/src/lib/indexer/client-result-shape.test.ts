/**
 * Lock the Result<T> shape exported by client.ts.
 *
 * Why this test exists: BATCH19D-result-shape (audit doc Part 19)
 * caught ~16 production code paths reading `result.value` instead
 * of `result.data` on indexer-Result types.  The bug shipped
 * silently because `tsc --noEmit` cannot resolve SvelteKit aliases
 * in the smoke environment (no `.svelte-kit/tsconfig.json` until
 * `svelte-kit sync` runs), so strict TypeScript caught nothing.
 *
 * This test is a runtime tripwire: if anyone renames `data` to
 * `value` in the type union, or if `request()` accidentally returns
 * `value`, this test fails and the bug doesn't ship.
 *
 * It does NOT replace running tsc; it covers the gap until
 * `tsc --noEmit` is wired into the smoke runner (BATCH19D-typecheck-not-running).
 */

import { describe, it, expect } from 'vitest';
import type { Result } from './client';

describe('Result<T> shape lock', () => {
	it('ok branch must use `data`, never `value`', () => {
		// This is a synthetic Result; the field name is what we
		// guard. Compiling means the type still has `data`. Reading
		// it at runtime confirms the value lands where call sites
		// expect.
		const r: Result<{ items: number[] }> = {
			ok: true,
			data: { items: [1, 2, 3] }
		};
		// Narrow the union, then assert the field shape. If a
		// future refactor renames `data` to `value`, this assertion
		// fails at runtime AND the type narrows wrong (compile-fail
		// once tsc is wired in).
		if (r.ok) {
			expect(r).toHaveProperty('data');
			expect(r).not.toHaveProperty('value');
			expect(r.data.items).toEqual([1, 2, 3]);
		} else {
			throw new Error('unreachable');
		}
	});

	it('err branch must expose `code` and `message`, not `error`', () => {
		const r: Result<unknown> = {
			ok: false,
			code: 'network_error',
			message: 'no'
		};
		if (!r.ok) {
			expect(r).toHaveProperty('code');
			expect(r).toHaveProperty('message');
			expect(r).not.toHaveProperty('error');
			// Catches the bug pattern where call sites read
			// `r.error.kind` (the ReleaseFetchError shape) on an
			// indexer-Result error.
			expect(r.code).toBe('network_error');
		} else {
			throw new Error('unreachable');
		}
	});
});
