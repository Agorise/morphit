/**
 * `morphit-ops alt-address` says "Reload your site; the new pill appears" only
 * when the running indexer was CHECKED to have the new address — not when the
 * check after the restart found it not running, or still on the old value
 * (review v1.21.18: it was printed on the restart alone). The re-publish step
 * likewise says "your own instance already uses the new value" only then.
 *
 * The real runAltAddress; the restart-and-check is stubbed to each outcome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let choices: number[] = [];
let asks: string[] = [];
let yes: RegExp = /^$/;
let outcome: { restarted: boolean; live: boolean | null } = { restarted: false, live: null };
vi.mock('../src/init/prompt.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return {
		...real,
		askChoice: vi.fn(async () => {
			const c = choices.shift();
			if (c === undefined) throw new Error('more menus than the test answers');
			return c;
		}),
		ask: vi.fn(async (_q: string, d?: string) => {
			const a = asks.shift() ?? '';
			return a === '' ? (d ?? '') : a;
		}),
		askYesNo: vi.fn(async (q: string) => yes.test(q))
	};
});
vi.mock('../src/lib/laterEnvShadow.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return { ...real, restartAndCheck: vi.fn(async () => outcome) };
});
vi.mock('../src/commands/register.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return { ...real, runRegister: vi.fn(async () => 0) };
});
vi.mock('../src/lib/instanceOrigin.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return { ...real, syncInstanceOrigin: vi.fn(() => ({ detail: '', verified: true })) };
});

const { runAltAddress } = await import('../src/commands/altAddress.ts');

const ONION_NEW = `${'a'.repeat(56)}.onion`;
let root = '';
let printed: string[] = [];
const saved = { ...process.env };
const live = (): string => join(root, 'opt/morphit');
const text = (): string => printed.join('\n');

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'alt-live-'));
	mkdirSync(live(), { recursive: true });
	mkdirSync(join(root, 'etc/morphit'), { recursive: true });
	writeFileSync(
		join(live(), 'morphit.config.env'),
		'MORPHIT_INSTANCE_ORIGIN=https://example-node.org\nMORPHIT_INSTANCE_NAME=Site\n'
	);
	// Tor → set it up: prefix, the address; save; then Done.
	choices = [0, 0, 6];
	asks = ['', ONION_NEW];
	// Save it; decline the broadcast (so the "later" text is shown).
	yes = /save it\?/i;
	printed = [];
	process.env.MORPHIT_ENV_ROOT = root;
	delete process.env.MORPHIT_INSTANCE_TOR_ADDRESS;
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		printed.push(a.map(String).join(' '));
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	process.env = { ...saved };
	rmSync(root, { recursive: true, force: true });
});

const run = (): Promise<number> =>
	runAltAddress({ flags: { out: live() }, positional: [] } as never);

describe('after saving an address and restarting', () => {
	it('checked live: "the new pill appears", and "already uses the new value"', async () => {
		outcome = { restarted: true, live: true };
		expect(await run()).toBe(0);
		expect(text()).toMatch(/Reload your site; the new pill appears in the footer/);
		expect(text()).toMatch(/already uses the new value/);
	});

	it('the check found it down or on the old value: neither claim', async () => {
		outcome = { restarted: true, live: false };
		expect(await run()).toBe(0);
		expect(text()).not.toMatch(/the new pill appears/);
		expect(text()).not.toMatch(/already uses the new value/);
		expect(text()).toMatch(
			/Your footer changes once the indexer runs with it \(see the check above\)/
		);
	});

	it('restarted, nothing could be checked: neither claim', async () => {
		outcome = { restarted: true, live: null };
		expect(await run()).toBe(0);
		expect(text()).not.toMatch(/the new pill appears/);
		expect(text()).not.toMatch(/already uses the new value/);
	});
});
