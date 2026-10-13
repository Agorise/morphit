/**
 * `morphit-ops edit` → re-publish the registration: what it says matches what
 * happened (review, 2026-10-12: a decline at register's own question, or a
 * Ctrl+C there, read as "re-published").
 */
import { describe, expect, it } from 'vitest';
import { offerRepublish } from '../src/commands/edit.ts';
import { REGISTER_DECLINED } from '../src/commands/register.ts';
import { abortError } from '../src/init/prompt.ts';

async function run(
	register: (flags: Record<string, string>) => Promise<number>
): Promise<{ r: string; out: string }> {
	const lines: string[] = [];
	const r = await offerRepublish({
		askYesNo: async () => true,
		register,
		print: (s) => void lines.push(s),
		restarted: true
	});
	return { r, out: lines.join('\n') };
}

describe('edit, re-publishing the registration', () => {
	it('declined at register’s question: not published, and how to do it', async () => {
		const { r, out } = await run(async () => REGISTER_DECLINED);
		expect(r).toBe('not-published');
		expect(out).not.toMatch(/re-published/);
		expect(out).toContain('sudo morphit-ops register');
	});
	it('Ctrl+C at register’s question: not published', async () => {
		const { r } = await run(async () => {
			throw abortError();
		});
		expect(r).toBe('not-published');
	});
	it('published', async () => {
		expect((await run(async () => 0)).r).toBe('published');
	});
	it('"broadcast now?" answered yes: register’s own question defaults to yes (one Enter, not two)', async () => {
		let flags: Record<string, string> | null = null;
		await run(async (f) => {
			flags = f;
			return 0;
		});
		// Before: register asked again with default No, so Enter, Enter was "Not published".
		expect(flags).toEqual({ 'default-yes': 'true' });
	});
	it('a failed broadcast says so', async () => {
		const { r, out } = await run(async () => 1);
		expect(r).toBe('failed');
		expect(out).toContain('did not complete');
	});
});
