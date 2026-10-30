/**
 * Setup-wizard steps (init/steps.ts), driven with scripted answers:
 *
 *  - Homepage SEO: a title over 200 or a description over 500 characters is
 *    refused at the prompt, as `edit` refuses it — the indexer refuses to start
 *    with one (review v1.21.18: init accepted it).
 *  - The hardening checklist outside the wizard reads as a sentence: "locking
 *    down SSH" was broken over two lines ("hardening: locking⏎down SSH").
 *  - Ctrl+C (or the input ending) at the relay-account question "Use this name
 *    anyway?" stops the step; it was caught as a failed chain lookup and asked
 *    another question.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let answers: Array<string | Error> = [];
const asked: string[] = [];
vi.mock('../src/init/prompt.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	const next = (q: string): string => {
		asked.push(q);
		const a = answers.shift();
		if (a === undefined) throw new Error(`no answer scripted for: ${q}`);
		if (a instanceof Error) throw a;
		return a;
	};
	return {
		...real,
		ask: vi.fn(async (q: string, d?: string) => {
			const a = next(q);
			return a === '' ? (d ?? '') : a;
		}),
		askYesNo: vi.fn(async (q: string, d: boolean) => {
			const a = next(q);
			return a === '' ? d : /^y/i.test(a);
		})
	};
});
vi.mock('../src/init/chainCheck.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	// The account is not on chain: the step asks "Use this name anyway?".
	return { ...real, lookupBlurtAccount: vi.fn(async () => null) };
});

const { stepSeo, stepHardening, stepRelayAccount } = await import('../src/init/steps.ts');
const { abortError, isAbortError } = await import('../src/init/prompt.ts');

let printed: string[] = [];
beforeEach(() => {
	answers = [];
	asked.length = 0;
	printed = [];
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		printed.push(a.map(String).join(' '));
	});
});
afterEach(() => vi.restoreAllMocks());

describe('init → homepage SEO: the indexer’s limits', () => {
	it('a 201-character title and a 501-character description are refused and asked again', async () => {
		answers = ['y', 'T'.repeat(201), 'A fine title', 'D'.repeat(501), 'A fine description', ''];
		const r = await stepSeo();
		expect(r).toEqual({ title: 'A fine title', description: 'A fine description', keywords: null });
		expect(printed.join('\n')).toMatch(/too long — 201 characters, at most 200 fit/);
		expect(printed.join('\n')).toMatch(/too long — 501 characters, at most 500 fit/);
	});

	it('exactly at the limits: accepted', async () => {
		answers = ['y', 'T'.repeat(200), 'D'.repeat(500), 'K'.repeat(500)];
		const r = await stepSeo();
		expect(r.title).toHaveLength(200);
		expect(r.description).toHaveLength(500);
		expect(r.keywords).toHaveLength(500);
	});
});

describe('the hardening checklist outside the wizard', () => {
	it('"locking down SSH" is on one line', async () => {
		answers = ['', '', '', '', '', 'n'];
		await stepHardening(false, { standalone: true });
		const out = printed.join('\n');
		expect(out).toMatch(/locking down SSH/);
		expect(out).not.toMatch(/locking\n/);
	});
});

describe('the relay account step', () => {
	it('Ctrl+C at "Use this name anyway?" stops the step (not taken for a failed lookup)', async () => {
		answers = ['example-relay', abortError(), 'y'];
		let err: unknown = null;
		await stepRelayAccount().catch((e: unknown) => (err = e));
		expect(isAbortError(err)).toBe(true);
		expect(asked.filter((q) => /Use this name anyway/.test(q))).toHaveLength(1);
	});
});
