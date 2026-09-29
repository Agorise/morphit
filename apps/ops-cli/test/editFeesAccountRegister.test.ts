/**
 * v1.20.0 (G1) — `morphit-ops edit` → Fees account offers to re-publish the
 * on-chain registration, because other Morphit instances accept the 90 % leg
 * of this instance's users' BLURT fees only at the account in that record.
 * Drives the real runEdit against a scratch config (prompts and the register
 * broadcast are stubbed) and observes: the file written, the offer made, and
 * register run with the NEW account in scope.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const yesNoQuestions: string[] = [];
let registerRuns: Array<string | undefined> = [];

vi.mock('../src/init/prompt.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return {
		...real,
		// The section menu: pick "Fees account".
		askChoice: vi.fn(async (_q: string, choices: readonly string[]) =>
			choices.findIndex((c) => /fees account/i.test(c))
		),
		askYesNo: vi.fn(async (q: string) => {
			yesNoQuestions.push(q);
			return true;
		})
	};
});
vi.mock('../src/init/steps.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return { ...real, stepFeesAccount: vi.fn(async () => nextFees) };
});
vi.mock('../src/lib/restartServices.ts', () => ({ offerRestart: vi.fn(async () => true) }));
vi.mock('../src/commands/register.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return {
		...real,
		runRegister: vi.fn(async () => {
			registerRuns.push(process.env.MORPHIT_INDEXER_FEE_RECIPIENT);
			return 0;
		})
	};
});

let nextFees = 'new-fees';
const { runEdit } = await import('../src/commands/edit.ts');

let dir = '';
const saved = { ...process.env };
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'morphit-edit-fees-'));
	writeFileSync(
		join(dir, 'morphit.config.env'),
		'MORPHIT_INSTANCE_NAME=B\nMORPHIT_INDEXER_FEE_RECIPIENT=old-fees\n'
	);
	yesNoQuestions.length = 0;
	registerRuns = [];
	process.env.MORPHIT_INDEXER_FEE_RECIPIENT = 'old-fees';
	vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	process.env = { ...saved };
	rmSync(dir, { recursive: true, force: true });
});

describe('edit → Fees account', () => {
	it('writes the new account and offers to re-publish the registration with it', async () => {
		nextFees = 'new-fees';
		expect(await runEdit({ flags: { out: dir }, positional: [] } as never)).toBe(0);
		expect(readFileSync(join(dir, 'morphit.config.env'), 'utf8')).toMatch(
			/^MORPHIT_INDEXER_FEE_RECIPIENT=new-fees$/m
		);
		expect(yesNoQuestions.some((q) => /broadcast this change to the chain/i.test(q))).toBe(true);
		expect(registerRuns).toEqual(['new-fees']);
	});

	it('does not offer a re-publish when the account did not change', async () => {
		nextFees = 'old-fees';
		expect(await runEdit({ flags: { out: dir }, positional: [] } as never)).toBe(0);
		expect(registerRuns).toEqual([]);
	});
});
