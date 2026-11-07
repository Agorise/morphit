/**
 * profileSoon (v1.23.3): labels reading their own account's profile on one
 * page share one batch request.
 */
import { describe, expect, it, vi } from 'vitest';

const batch = vi.hoisted(() => ({
	calls: [] as string[][],
	fail: false
}));
vi.mock('./profileCache', () => ({
	getProfilesBatch: async (accounts: readonly string[]) => {
		batch.calls.push([...accounts]);
		if (batch.fail) throw new Error('down');
		return new Map(accounts.map((a) => [a, { account: a } as never]));
	}
}));

const { profileSoon } = await import('./profileSoon');

describe('profileSoon', () => {
	it('a page of labels: one request; each gets its own profile', async () => {
		const [a, b, a2] = await Promise.all([
			profileSoon('alice'),
			profileSoon('bob'),
			profileSoon('alice')
		]);
		expect(batch.calls).toEqual([['alice', 'bob']]);
		expect((a as { account: string }).account).toBe('alice');
		expect((b as { account: string }).account).toBe('bob');
		expect(a2).toBe(a);
	});

	it('the request failing: null for each, never a hang', async () => {
		batch.fail = true;
		expect(await profileSoon('carol')).toBeNull();
		batch.fail = false;
	});
});
